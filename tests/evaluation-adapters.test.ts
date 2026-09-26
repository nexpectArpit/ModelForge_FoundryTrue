/**
 * Evaluation Engine & Pluggable Adapters Tests (Phase C)
 *
 * Verifies Phase C requirements:
 *   - EvaluationEngine coordinating pluggable adapters
 *   - DemoAdapter
 *   - OpenAICompatibleAdapter protocol compliance
 *   - CustomRestAdapter with configurable mapping
 *   - Truly executable remediation strategies (no paper strategies)
 */

import { describe, expect, it } from 'vitest';
import {
  EvaluationEngine,
  DemoAdapter,
  OpenAICompatibleAdapter,
  CustomRestAdapter,
  type BenchmarkCase,
  type EvaluationAdapter,
} from '../core/evaluation/index.js';
import { diagnoseFailures } from '../core/failure-diagnostician.js';
import { generateMigrationPlan } from '../core/migration-planner.js';
import { applyMigrationPlan } from '../core/patching/index.js';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import { createSessionId, type RepositoryProfile } from '../core/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('Evaluation Adapters (Phase C)', () => {
  it('OpenAICompatibleAdapter serializes tool requests and parses tool calls', async () => {
    // Mock fetch for OpenAI endpoint
    const originalFetch = global.fetch;
    let sentBody: any = null;
    let sentHeaders: any = null;

    global.fetch = async (url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      sentHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_123',
                    type: 'function',
                    function: {
                      name: 'create_ticket',
                      arguments: JSON.stringify({
                        order_id: 9948,
                        user_id: 'usr_883',
                        issue_type: 'billing',
                        priority: 'high',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 45,
          },
        }),
      } as any;
    };

    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key-123',
        model: 'gpt-4o-mini',
      });

      const bCase: BenchmarkCase = {
        id: 'case-tool-1',
        category: 'tool',
        input: 'Please file a billing ticket for order 9948',
        assertions: {
          expected_tool: 'create_ticket',
        },
      };

      const result = await adapter.executeCase(bCase);

      expect(sentHeaders['Authorization']).toBe('Bearer test-key-123');
      expect(sentBody.model).toBe('gpt-4o-mini');
      expect(sentBody.tools).toBeDefined();
      expect(sentBody.tools[0].function.name).toBe('create_ticket');

      expect(result.ok).toBe(true);
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls![0].name).toBe('create_ticket');
      expect(result.tool_calls![0].arguments.order_id).toBe(9948);
      expect(result.usage_cost).toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('CustomRestAdapter interpolates request templates and maps custom response fields', async () => {
    const originalFetch = global.fetch;
    let sentPayload: any = null;

    global.fetch = async (url: any, init: any) => {
      sentPayload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          custom_output: {
            generated_answer: 'Your refund for order 100 has been initiated.',
            cost_cents: 0.05,
          },
          meta: {
            detected_intent: 'refund',
          },
        }),
      } as any;
    };

    try {
      const adapter = new CustomRestAdapter({
        adapter_type: 'custom_rest',
        endpoint_url: 'https://internal.company.ai/generate',
        headers: { 'X-Internal-Tenant': 'finance-app' },
        request_template: {
          query_text: '{{input}}',
          task_type: '{{category}}',
        },
        response_mapping: {
          response_field: 'custom_output.generated_answer',
          usage_cost_field: 'custom_output.cost_cents',
        },
      });

      const bCase: BenchmarkCase = {
        id: 'case-qa-custom',
        category: 'qa',
        input: 'Status of refund 100',
        assertions: {
          contains_any: ['refund'],
        },
      };

      const result = await adapter.executeCase(bCase);

      expect(sentPayload.query_text).toBe('Status of refund 100');
      expect(sentPayload.task_type).toBe('qa');
      expect(result.ok).toBe(true);
      expect(result.response_text).toContain('Your refund for order 100');
      expect(result.usage_cost).toBe(0.05);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('EvaluationEngine executes synthetic benchmark and computes statistics', async () => {
    // Mock adapter that returns valid QA and tool responses
    const mockAdapter: EvaluationAdapter = {
      name: 'MockAdapter',
      async executeCase(bCase: BenchmarkCase) {
        if (bCase.category === 'qa') {
          return {
            ok: true,
            status: 200,
            response_text: 'We offer a 30-day refund policy for all standard orders.',
            latency_ms: 120,
            usage_cost: 0.0002,
          };
        }
        if (bCase.category === 'tool') {
          return {
            ok: true,
            status: 200,
            tool_calls: [
              {
                name: 'create_ticket',
                arguments: {
                  order_id: 12345,
                  user_id: 'usr_abc',
                  issue_type: 'shipping',
                  priority: 'medium',
                },
              },
            ],
            latency_ms: 180,
            usage_cost: 0.0005,
          };
        }
        return {
          ok: true,
          status: 200,
          response_text: 'Default mock answer',
          latency_ms: 100,
        };
      },
    };

    const engine = new EvaluationEngine();
    const cases: BenchmarkCase[] = [
      {
        id: 'c1',
        category: 'qa',
        input: 'What is the refund policy?',
        assertions: { contains_any: ['refund', 'policy'] },
      },
      {
        id: 'c2',
        category: 'tool',
        input: 'Order 12345 lost in shipping',
        assertions: { expected_tool: 'create_ticket' },
      },
    ];

    const report = await engine.run({
      adapter: mockAdapter,
      candidateId: 'test-mock-candidate',
      cases,
    });

    expect(report.contract_version).toBe('2.0');
    expect(report.total_cases).toBe(2);
    expect(report.passed_cases).toBe(2);
    expect(report.quality.score).toBe(1.0);
    expect(report.quality.passed).toBe(true);
    expect(report.latency.passed).toBe(true);
    expect(report.overall).toBe('PASS');
    expect(report.case_results).toHaveLength(2);
  });
});

describe('Executable Remediation Pipeline (Phase C)', () => {
  it('executes genuine end-to-end remediation: diagnosis -> hybrid plan -> sandbox patch', () => {
    const testSandboxRoot = fs.mkdtempSync(path.join(__dirname, '../.test-remediation-'));
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: APP_DIR,
      sandboxRoot: testSandboxRoot,
    });
    sandbox.initialize();

    try {
      // 1. Synthesize an EvaluationReport representing a Model B failure with tool regressions
      const failedEval = {
        contract_version: '2.0' as const,
        eval_run_id: 'eval-run-fail-1' as any,
        session_id: 'session-rem-1' as any,
        candidate_id: 'model-b',
        timestamp: new Date().toISOString(),
        test_suite_id: 'eval-support-v1',
        total_cases: 15,
        passed_cases: 11,
        quality: { score: 0.73, threshold: 0.90, passed: false },
        latency: { p50_ms: 120, p95_ms: 280, p99_ms: 310, threshold_p95_ms: 600, passed: true },
        cost: { estimated_cost_per_1k_req: 0.25, baseline_cost_per_1k_req: 1.85, savings_pct: 86.5, passed: true },
        regressions: [
          { case_id: 'case-tool-1', category: 'tool', error: 'Tool argument schema validation failed: order_id: Expected number, received string' },
          { case_id: 'case-tool-2', category: 'tool', error: 'Tool argument schema validation failed: priority: Invalid enum value' },
        ],
        case_results: [
          { case_id: 'q1', category: 'qa', passed: true, latency_ms: 100 },
          { case_id: 's1', category: 'summarize', passed: true, latency_ms: 120 },
          { case_id: 't1', category: 'tool', passed: false, latency_ms: 150 },
        ],
        overall: 'FAIL' as const,
      };

      // 2. Failure diagnostician analyzes actual evaluation failure
      const diagnosis = diagnoseFailures({
        sessionId: 'session-rem-1' as any,
        evaluationReport: failedEval,
      });

      expect(diagnosis.primary_failure_category).toBe('tool_calling');
      expect(diagnosis.recommended_strategy).toBe('hybrid_routing');
      expect(diagnosis.confidence).toBeGreaterThan(0.8);

      // 3. Migration planner ingests diagnosis and produces an executable hybrid routing plan
      const profile: RepositoryProfile = {
        contract_version: '2.0',
        status: 'complete',
        repository_path: APP_DIR,
        repository_name: 'customer-support-app',
        language: 'typescript',
        package_manager: 'npm',
        detected_frameworks: [],
        current_model: 'model-a',
        model_references: [
          { file_path: 'src/config.ts', line_numbers: [63], reference_type: 'config_file', code_snippet: '', confidence: 0.9 },
        ],
        tool_schemas: [],
        env_dependencies: ['APP_MODEL', 'APP_ROUTING_MODE'],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      };

      const plan = generateMigrationPlan({
        sessionId: 'session-rem-1' as any,
        profile,
        sourceModel: 'model-a',
        targetModel: 'model-b',
        previousDiagnosis: diagnosis,
      });

      expect(plan.strategy).toBe('hybrid_routing');
      expect(plan.changes.some(c => c.description.toLowerCase().includes('hybrid'))).toBe(true);

      // 4. Canonical patch engine applies the plan to the sandbox
      const patchReport = applyMigrationPlan(sandbox, plan, profile);
      expect(patchReport.total_files_patched).toBeGreaterThan(0);
      expect(patchReport.total_replacements).toBeGreaterThan(0);
      expect(patchReport.strategy_applied).toBe('hybrid_routing');
      expect(patchReport.verification.verified).toBe(true);

      // Verify concrete config file changes in sandbox
      const patchedConfig = sandbox.readFile('src/config.ts');
      expect(patchedConfig).toContain("'hybrid'");
      expect(patchedConfig).toContain('model-b');
    } finally {
      sandbox.discard();
      if (fs.existsSync(testSandboxRoot)) {
        fs.rmSync(testSandboxRoot, { recursive: true, force: true });
      }
    }
  });
});
