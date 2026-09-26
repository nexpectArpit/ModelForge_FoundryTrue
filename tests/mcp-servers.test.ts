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
});
