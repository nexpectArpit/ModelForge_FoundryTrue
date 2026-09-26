/**
 * Evaluation Engine (Architecture v2)
 *
 * Architectural Principle #5: Deterministic core / nondeterministic edge
 *   - The edge (EvaluationAdapter) performs I/O and HTTP execution.
 *   - The core (evaluateBenchmarkCaseAssertion, computeEvaluationMetrics) is pure and deterministic.
 * Architectural Principle #7: Typed domain error taxonomy (EvaluationConfigError)
 * Architectural Principle #12: Strategy + adapter patterns (EvaluationAdapterRegistry)
 * Architectural Principle #18: Immutable/auditable artifacts (EvaluationReport v2.0)
 *
 * Coordinates pluggable adapters (DemoAdapter, OpenAICompatibleAdapter, CustomRestAdapter),
 * executes test assertions, and produces strictly typed Architecture v2 EvaluationReport artifacts.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EvaluationAdapter, BenchmarkCase, AdapterExecutionResult } from './evaluation-adapter.js';
import { DemoAdapter } from './adapters/demo-adapter.js';
import { OpenAICompatibleAdapter } from './adapters/openai-adapter.js';
import { CustomRestAdapter } from './adapters/custom-rest-adapter.js';
import {
  type EvaluationReport,
  type EvalRunId,
  type SessionId,
  createEvalRunId,
  createSessionId,
  type EvaluationAdapterConfig,
} from '../types.js';
import { EvaluationConfigError } from '../errors.js';

// Schemas for deterministic tool evaluation
export const CreateTicketSchema = z.object({
  order_id: z.number().int().positive({ message: 'order_id must be an integer' }),
  user_id: z.string().min(3),
  issue_type: z.enum(['billing', 'shipping', 'technical', 'other']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});

export const QueryRefundStatusSchema = z.object({
  order_id: z.number().int().positive({ message: 'order_id must be an integer' }),
  reason: z.string().min(5),
});

export interface RunEvaluationOptions {
  adapter?: EvaluationAdapter;
  endpointUrl?: string;
  candidateId: string;
  sessionId?: SessionId;
  testSuitePath?: string;
  cases?: BenchmarkCase[];
  adapterConfig?: EvaluationAdapterConfig;
  baselineCostPer1k?: number;
  qualityThreshold?: number;
  latencyThresholdMs?: number;
}

// ─── Principle #5: Pure Deterministic Core ───────────────────────────────────

export interface CaseAssertionResult {
  passed: boolean;
  failureReason: string;
}

/**
 * Pure deterministic assertion evaluator for a single benchmark case.
 * Given a case and an adapter execution result, produces a pass/fail determination
 * with zero side effects or I/O.
 */
export function evaluateBenchmarkCaseAssertion(
  bCase: BenchmarkCase,
  res: AdapterExecutionResult,
): CaseAssertionResult {
  if (!res.ok) {
    return {
      passed: false,
      failureReason: res.error ?? `Adapter returned status ${res.status}`,
    };
  }

  if (bCase.category === 'qa') {
    const text = (res.response_text ?? '').toLowerCase();
    if (
      bCase.assertions.contains_any &&
      !bCase.assertions.contains_any.some(k => text.includes(k.toLowerCase()))
    ) {
      return {
        passed: false,
        failureReason: `Response did not contain any expected keywords: [${bCase.assertions.contains_any.join(', ')}]`,
      };
    }
  } else if (bCase.category === 'summarize') {
    const text = res.response_text ?? '';
    if (
      bCase.assertions.contains_all &&
      !bCase.assertions.contains_all.every(k => text.includes(k))
    ) {
      return {
        passed: false,
        failureReason: `Summary missing mandatory entities: [${bCase.assertions.contains_all.join(', ')}]`,
      };
    }
  } else if (bCase.category === 'extract') {
    const extracted = res.structured_data ?? {};
    const expected = bCase.assertions.structured_schema ?? {};
    for (const [key, val] of Object.entries(expected)) {
      if (extracted[key] !== val) {
        return {
          passed: false,
          failureReason: `Extraction mismatch for key "${key}": expected "${val}", got "${extracted[key]}"`,
        };
      }
    }
  } else if (bCase.category === 'tool') {
    const tools = res.tool_calls ?? [];
    if (tools.length === 0) {
      return {
        passed: false,
        failureReason: 'Model failed to emit tool call',
      };
    }

    const firstTool = tools[0];
    if (firstTool.name !== bCase.assertions.expected_tool) {
      return {
        passed: false,
        failureReason: `Expected tool "${bCase.assertions.expected_tool}", got "${firstTool.name}"`,
      };
    }

    // Strict Schema Validation
    const schema =
      firstTool.name === 'create_ticket'
        ? CreateTicketSchema
        : QueryRefundStatusSchema;
    const parseResult = schema.safeParse(firstTool.arguments);
    if (!parseResult.success) {
      return {
        passed: false,
        failureReason: `Tool argument schema validation failed: ${parseResult.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    if (bCase.assertions.required_args) {
      for (const [k, v] of Object.entries(bCase.assertions.required_args)) {
        if (firstTool.arguments[k] !== v) {
          return {
            passed: false,
            failureReason: `Tool argument value mismatch for "${k}": expected ${v}, got ${firstTool.arguments[k]}`,
          };
        }
      }
    }
  }

  return { passed: true, failureReason: '' };
}

export interface MetricCalculationInput {
  cases: BenchmarkCase[];
  latencies: number[];
  totalCostSum: number;
  passedCount: number;
  regressions: Array<{ case_id: string; category: string; error: string }>;
  caseResults: Array<{
    case_id: string;
    category: string;
    passed: boolean;
    latency_ms: number;
    error?: string;
  }>;
  candidateId: string;
  sessionId?: SessionId;
  qualityThreshold?: number;
  latencyThresholdMs?: number;
  baselineCostPer1k?: number;
}

/**
 * Pure deterministic metrics compiler. Calculates percentiles, score thresholds,
 * cost savings, and returns the immutable Architecture v2 EvaluationReport.
 */
export function computeEvaluationMetrics(input: MetricCalculationInput): EvaluationReport {
  const sortedLatencies = [...input.latencies].sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0;
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ?? 0;
  const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] ?? 0;

  const qualityThreshold = input.qualityThreshold ?? 0.90;
  const totalCases = input.cases.length;
  const qualityScore = totalCases > 0 ? Number((input.passedCount / totalCases).toFixed(2)) : 0;
  const qualityPassed = qualityScore >= qualityThreshold;

  const latencyThreshold = input.latencyThresholdMs ?? 600;
  const latencyPassed = p95 <= latencyThreshold;

  const baselineCost = input.baselineCostPer1k ?? 1.85;
  const estimatedCost = totalCases > 0 ? Number(((input.totalCostSum / totalCases) * 1000).toFixed(2)) : 0;
  const savingsPct = Number((((baselineCost - estimatedCost) / baselineCost) * 100).toFixed(1));

  const overall = qualityPassed && latencyPassed ? 'PASS' : 'FAIL';

  return {
    contract_version: '2.0',
    eval_run_id: createEvalRunId(),
    session_id: input.sessionId ?? createSessionId(),
    candidate_id: input.candidateId,
    timestamp: new Date().toISOString(),
    test_suite_id: 'eval-support-v1',
    total_cases: totalCases,
    passed_cases: input.passedCount,
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
      estimated_cost_per_1k_req: estimatedCost,
      baseline_cost_per_1k_req: baselineCost,
      savings_pct: savingsPct,
      passed: true,
    },
    regressions: input.regressions,
    overall,
    case_results: input.caseResults,
  };
}

// ─── Principle #12: Evaluation Strategy Registry ─────────────────────────────

export type EvaluationAdapterFactory = (options: RunEvaluationOptions) => EvaluationAdapter | null;

export class EvaluationAdapterRegistry {
  private factories: EvaluationAdapterFactory[] = [];

  register(factory: EvaluationAdapterFactory): void {
    this.factories.unshift(factory); // Prepend to allow overrides
  }

  resolve(options: RunEvaluationOptions): EvaluationAdapter {
    if (options.adapter) return options.adapter;

    for (const factory of this.factories) {
      const adapter = factory(options);
      if (adapter) return adapter;
    }

    if (options.adapterConfig) {
      if (options.adapterConfig.adapter_type === 'custom_rest') {
        return new CustomRestAdapter(options.adapterConfig);
      }
      if (options.adapterConfig.adapter_type === 'openai_chat') {
        return new OpenAICompatibleAdapter({
          baseUrl: options.adapterConfig.endpoint_url ?? options.endpointUrl ?? 'http://127.0.0.1:8000',
          model: options.candidateId,
          customHeaders: options.adapterConfig.headers,
        });
      }
    }

    if (options.endpointUrl) {
      return new DemoAdapter({ endpointUrl: options.endpointUrl });
    }

    throw new EvaluationConfigError(
      'Cannot run evaluation: no adapter, adapterConfig, or endpointUrl provided',
    );
  }
}

// ─── Evaluation Engine Orchestration Service ─────────────────────────────────

export class EvaluationEngine {
  private defaultCasesPath: string;
  private adapterRegistry = new EvaluationAdapterRegistry();

  constructor(defaultCasesPath?: string) {
    if (defaultCasesPath) {
      this.defaultCasesPath = defaultCasesPath;
    } else {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [
        path.resolve(__dirname, '../../mcp-servers/rehearsal-mcp/src/evaluation/benchmark-cases.json'),
        path.resolve(__dirname, '../../evaluation/benchmark-cases.json'),
      ];
      this.defaultCasesPath = candidates.find(c => existsSync(c)) ?? candidates[0];
    }
  }

  /**
   * Resolve appropriate adapter from options using strategy registry.
   */
  resolveAdapter(options: RunEvaluationOptions): EvaluationAdapter {
    return this.adapterRegistry.resolve(options);
  }

  /**
   * Register a custom adapter factory.
   */
  registerAdapterFactory(factory: EvaluationAdapterFactory): void {
    this.adapterRegistry.register(factory);
  }

  /**
   * Load benchmark cases from options or default disk file.
   */
  loadCases(options: RunEvaluationOptions): BenchmarkCase[] {
    if (options.cases && options.cases.length > 0) {
      return options.cases;
    }
    const filePath = options.testSuitePath ?? this.defaultCasesPath;
    if (!existsSync(filePath)) {
      throw new EvaluationConfigError(`Benchmark cases file not found at: ${filePath}`);
    }
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  /**
   * Execute evaluation run coordinating adapter edge with deterministic core.
   */
  async run(options: RunEvaluationOptions): Promise<EvaluationReport> {
    const adapter = this.resolveAdapter(options);
    const cases = this.loadCases(options);

    const latencies: number[] = [];
    const regressions: Array<{ case_id: string; category: string; error: string }> = [];
    const caseResults: Array<{
      case_id: string;
      category: string;
      passed: boolean;
      latency_ms: number;
      error?: string;
    }> = [];

    let passedCount = 0;
    let totalCostSum = 0;

    for (const bCase of cases) {
      // Nondeterministic Edge: Network / HTTP Execution
      const res = await adapter.executeCase(bCase);
      latencies.push(res.latency_ms);
      totalCostSum += res.usage_cost ?? 0.0001;

      // Deterministic Core: Pure Assertion Evaluation
      const assertion = evaluateBenchmarkCaseAssertion(bCase, res);

      if (assertion.passed) {
        passedCount++;
        caseResults.push({
          case_id: bCase.id,
          category: bCase.category,
          passed: true,
          latency_ms: res.latency_ms,
        });
      } else {
        regressions.push({
          case_id: bCase.id,
          category: bCase.category,
          error: assertion.failureReason,
        });
        caseResults.push({
          case_id: bCase.id,
          category: bCase.category,
          passed: false,
          latency_ms: res.latency_ms,
          error: assertion.failureReason,
        });
      }
    }

    // Deterministic Core: Metrics Compilation
    return computeEvaluationMetrics({
      cases,
      latencies,
      totalCostSum,
      passedCount,
      regressions,
      caseResults,
      candidateId: options.candidateId,
      sessionId: options.sessionId,
      qualityThreshold: options.qualityThreshold,
      latencyThresholdMs: options.latencyThresholdMs,
      baselineCostPer1k: options.baselineCostPer1k,
    });
  }
}

// Canonical convenience function
export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationReport> {
  const engine = new EvaluationEngine();
  return engine.run(options);
}
