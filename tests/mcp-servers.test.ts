import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRehearsalToolCall, resetRehearsalState } from '../mcp-servers/rehearsal-mcp/src/server.js';
import {
  prepareCanaryManifest,
  applyProductionRouting,
  verifyGatewayRouting,
  resetGatewayState,
} from '../mcp-servers/gateway-mcp/src/canary-manager.js';
import { issueApprovalArtifact } from '../core/approval-token.js';
import { sessionRegistry } from '../core/session-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('MCP Servers & Privilege Boundaries', () => {
  beforeEach(() => {
    resetRehearsalState();
    resetGatewayState();
  });

  it('inspects customer support app and finds model couplings', async () => {
    const profile = await handleRehearsalToolCall('repo_inspect_ai_usage', {
      repo_path: APP_DIR,
    });
    expect(profile.status).toBe('complete');
    expect(profile.repository_name).toBe('customer-support-app');
    expect(profile.model_references.length).toBeGreaterThan(0);

    const hasConfig = profile.model_references.some(r => r.file_path.includes('config.ts'));
    expect(hasConfig).toBe(true);
  });

  it('prepares canary plan with deterministic SHA, verifies approval, and verifies live routing', async () => {
    const machine = sessionRegistry.getOrCreate();

    // Fast-forward lifecycle to evaluation_complete
    machine.transition('inspecting', 'test');
    machine.transition('inspection_complete', 'test');
    machine.setProfile({ contract_version: '2.0', status: 'complete' } as any);
    machine.transition('planning', 'test');
    machine.transition('plan_ready', 'test');
    machine.setPlan({ contract_version: '2.0' } as any);
    machine.transition('staging', 'test');
    machine.transition('staged', 'test');
    machine.transition('evaluating', 'test');
    machine.transition('evaluation_complete', 'test');
    machine.addEvaluation({
      contract_version: '2.0',
      eval_run_id: 'eval-999',
      overall: 'PASS',
      quality: { score: 1.0, threshold: 0.90, passed: true, by_category: {} },
      latency: { p50_ms: 100, p95_ms: 320, p99_ms: 400, threshold_p95_ms: 600, passed: true },
      cost: { estimated_cost_per_1k_req: 0.5, baseline_cost_per_1k_req: 1.85, savings_pct: 72.5, passed: true },
      regressions: [],
      case_results: [],
      timestamp: new Date().toISOString(),
      candidate_id: 'test-candidate',
      session_id: machine.sessionId,
      test_suite_id: 'standard',
      total_cases: 10,
      passed_cases: 10,
    });

    const plan = prepareCanaryManifest({
      candidateId: 'test-candidate',
      sessionId: machine.sessionId,
      evaluationProof: {
        eval_run_id: 'eval-999',
        quality_score: 1.0,
        p95_ms: 320,
        savings_pct: 72.5,
      },
    });

    expect(plan.canary_id).toBeDefined();
    expect(plan.manifest_sha).toHaveLength(16);
    expect(plan.traffic_split.candidate_pct).toBe(10);
    expect(plan.traffic_split.baseline_pct).toBe(90);

    // Generate valid approval artifact
    const approvalToken = issueApprovalArtifact({
      sessionId: machine.sessionId,
      canaryId: plan.canary_id,
      manifestSha: plan.manifest_sha,
      decision: 'allow',
      operator: 'test-operator',
    });

    // Apply routing with approval
    const applied = applyProductionRouting({
      canaryId: plan.canary_id,
      approvalToken,
      sessionId: machine.sessionId,
    });
    expect(applied.success).toBe(true);
    expect(applied.active_sha).toBe(plan.manifest_sha);

    // Verify routing and get receipt
    const verified = verifyGatewayRouting(plan.canary_id, machine.sessionId);
    expect(verified.verified).toBe(true);
    expect(verified.active_routing_sha).toBe(plan.manifest_sha);
    expect(verified.receipt).toBeDefined();
    expect(verified.receipt?.outcome).toBe('completed');
  });

  it('executes compare_rehearsals via MCP boundary and produces deterministic comparison matrix', async () => {
    const machine = sessionRegistry.getOrCreate();

    // Set up mock baseline evaluation
    const baselineReport = {
      contract_version: '2.0',
      eval_run_id: 'eval-base-1',
      session_id: machine.sessionId,
      candidate_id: 'baseline-model',
      timestamp: new Date().toISOString(),
      test_suite_id: 'standard',
      total_cases: 2,
      passed_cases: 2,
      case_results: [
        { case_id: 'case-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-2', category: 'tool', passed: true, latency_ms: 120, estimated_cost: 0.002, failure_reason: null, raw_response_summary: 'ok' },
      ],
      quality: { score: 1.0, threshold: 0.9, passed: true, by_category: {} },
      latency: { p50_ms: 110, p95_ms: 120, p99_ms: 120, threshold_p95_ms: 500, passed: true },
      cost: { estimated_cost_per_1k_req: 1.85, baseline_cost_per_1k_req: 1.85, savings_pct: 0, passed: true },
      regressions: [],
      overall: 'PASS',
    };
    machine.setBaselineEvaluation(baselineReport as any);

    // Fast-forward to evaluation_complete with candidate
    machine.transition('inspecting', 'test');
    machine.transition('inspection_complete', 'test');
    machine.setProfile({ contract_version: '2.0', status: 'complete' } as any);
    machine.transition('planning', 'test');
    machine.transition('plan_ready', 'test');
    machine.setPlan({ contract_version: '2.0' } as any);
    machine.transition('staging', 'test');
    machine.transition('staged', 'test');
    machine.transition('evaluating', 'test');
    machine.transition('evaluation_complete', 'test');

    const candidateReport = {
      ...baselineReport,
      eval_run_id: 'eval-cand-1',
      candidate_id: 'candidate-model',
      passed_cases: 1,
      overall: 'FAIL',
      quality: { score: 0.5, threshold: 0.9, passed: false, by_category: {} },
      case_results: [
        { case_id: 'case-1', category: 'qa', passed: true, latency_ms: 50, estimated_cost: 0.0001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-2', category: 'tool', passed: false, latency_ms: 60, estimated_cost: 0.0001, failure_reason: 'Schema error', raw_response_summary: 'err' },
      ],
      cost: { estimated_cost_per_1k_req: 0.1, baseline_cost_per_1k_req: 1.85, savings_pct: 94, passed: true },
    };
    machine.addEvaluation(candidateReport as any);

    const comparison = await handleRehearsalToolCall('compare_rehearsals', {
      session_id: machine.sessionId,
    });

    expect(comparison.verdict).toBe('FAIL');
    expect(comparison.regressions_count).toBe(1);
    expect(comparison.recommendation).toBe('needs_remediation');
    expect(comparison.cost_savings_pct).toBe(94);
  });
});

