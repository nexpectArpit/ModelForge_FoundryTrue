import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateTicketSchema, QueryRefundStatusSchema } from '../demo-apps/customer-support-app/src/tools.js';
export async function runDeterministicEvaluation({ endpointUrl, candidateId, testSuitePath, }) {
    const filePath = testSuitePath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'benchmark-cases.json');
    const cases = JSON.parse(readFileSync(filePath, 'utf8'));
    const latencies = [];
    const regressions = [];
    let passedCount = 0;
    let totalCostSum = 0;
    for (const bCase of cases) {
        const start = performance.now();
        try {
            const resp = await fetch(endpointUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: bCase.input, task_hint: bCase.category }),
            });
            const elapsed = Math.round(performance.now() - start);
            latencies.push(elapsed);
            if (!resp.ok) {
                regressions.push({
                    case_id: bCase.id,
                    category: bCase.category,
                    error: `HTTP ${resp.status}: ${await resp.text()}`,
                });
                continue;
            }
            const data = await resp.json();
            totalCostSum += data.usage?.estimated_cost ?? 0.0001;
            // Category-specific deterministic assertions
            let casePassed = true;
            let failureReason = '';
            if (bCase.category === 'qa') {
                const text = (data.response ?? '').toLowerCase();
                if (bCase.assertions.contains_any && !bCase.assertions.contains_any.some(k => text.includes(k.toLowerCase()))) {
                    casePassed = false;
                    failureReason = `Response did not contain any expected keywords: [${bCase.assertions.contains_any.join(', ')}]`;
                }
            }
            else if (bCase.category === 'summarize') {
                const text = (data.response ?? '');
                if (bCase.assertions.contains_all && !bCase.assertions.contains_all.every(k => text.includes(k))) {
                    casePassed = false;
                    failureReason = `Summary missing mandatory entities: [${bCase.assertions.contains_all.join(', ')}]`;
                }
            }
            else if (bCase.category === 'extract') {
                const extracted = data.structured_data ?? {};
                const expected = bCase.assertions.structured_schema ?? {};
                for (const [key, val] of Object.entries(expected)) {
                    if (extracted[key] !== val) {
                        casePassed = false;
                        failureReason = `Extraction mismatch for key "${key}": expected "${val}", got "${extracted[key]}"`;
                        break;
                    }
                }
            }
            else if (bCase.category === 'tool') {
                const tools = data.tool_calls ?? [];
                if (tools.length === 0) {
                    casePassed = false;
                    failureReason = 'Model failed to emit tool call';
                }
                else {
                    const firstTool = tools[0];
                    if (firstTool.name !== bCase.assertions.expected_tool) {
                        casePassed = false;
                        failureReason = `Expected tool "${bCase.assertions.expected_tool}", got "${firstTool.name}"`;
                    }
                    else {
                        // Strict Schema Validation
                        const schema = firstTool.name === 'create_ticket' ? CreateTicketSchema : QueryRefundStatusSchema;
                        const parseResult = schema.safeParse(firstTool.arguments);
                        if (!parseResult.success) {
                            casePassed = false;
                            failureReason = `Tool argument schema validation failed: ${parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
                        }
                        else if (bCase.assertions.required_args) {
                            for (const [k, v] of Object.entries(bCase.assertions.required_args)) {
                                if (firstTool.arguments[k] !== v) {
                                    casePassed = false;
                                    failureReason = `Tool argument value mismatch for "${k}": expected ${v}, got ${firstTool.arguments[k]}`;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            if (casePassed) {
                passedCount++;
            }
            else {
                regressions.push({
                    case_id: bCase.id,
                    category: bCase.category,
                    error: failureReason,
                });
            }
        }
        catch (err) {
            regressions.push({
                case_id: bCase.id,
                category: bCase.category,
                error: `Network/Fetch error: ${err.message}`,
            });
        }
    }
    // Calculate statistics
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
    const qualityScore = Number((passedCount / cases.length).toFixed(2));
    const qualityThreshold = 0.90;
    const qualityPassed = qualityScore >= qualityThreshold;
    const latencyThreshold = 600;
    const latencyPassed = p95 <= latencyThreshold;
    const baselineCostPer1k = 1.85; // Baseline Model A cost
    const estimatedCostPer1k = Number(((totalCostSum / cases.length) * 1000).toFixed(2));
    const savingsPct = Number((((baselineCostPer1k - estimatedCostPer1k) / baselineCostPer1k) * 100).toFixed(1));
    const overall = (qualityPassed && latencyPassed) ? "PASS" : "FAIL";
    return {
        contract_version: "1.0",
        eval_run_id: `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        candidate_id: candidateId,
        timestamp: new Date().toISOString(),
        test_suite_id: "eval-support-v1",
        total_cases: cases.length,
        passed_cases: passedCount,
        quality: {
            score: qualityScore,
            threshold: qualityThreshold,
            passed: qualityPassed,
        },
        latency: {
            p50_ms: p50,
            p95_ms: p95,
            p99_ms: p99,
            threshold_p95_ms: latencyThreshold,
            passed: latencyPassed,
        },
        cost: {
            estimated_cost_per_1k_req: estimatedCostPer1k,
            baseline_cost_per_1k_req: baselineCostPer1k,
            savings_pct: savingsPct,
            passed: true,
        },
        regressions,
        overall,
    };
}
