/**
 * Approval Verification Tests
 *
 * Validates the core security invariant:
 * NO VALID APPROVAL -> NO PRODUCTION MUTATION.
 *
 * Tests all 7 required cases:
 *   1. missing approval -> rejected
 *   2. invalid approval (tampered signature/payload) -> rejected
 *   3. wrong migration (session ID mismatch) -> rejected
 *   4. wrong canary (canary ID mismatch) -> rejected
 *   5. denied approval (decision === 'deny') -> rejected
 *   6. expired approval (expires_at in the past) -> rejected
 *   7. valid approval -> production mutation allowed
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  prepareCanaryManifest,
  applyProductionRouting,
  resetGatewayState,
  getLiveRoutingTable,
} from '../mcp-servers/gateway-mcp/src/canary-manager.js';
import {
  issueApprovalArtifact,
  verifyApprovalArtifact,
  type ApprovalArtifact,
} from '../core/approval-token.js';
import { sessionRegistry } from '../core/session-registry.js';
import { createSessionId } from '../core/types.js';

describe('Production Approval Gate & Verification', () => {
  let sessionId: string;
  let canaryPlan: any;

  beforeEach(() => {
    resetGatewayState();
    sessionRegistry.reset();

    const machine = sessionRegistry.getOrCreate();
    sessionId = machine.sessionId;

    // Fast-forward machine to evaluation_complete so canary preparation is legal
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
      eval_run_id: 'eval-ok',
      overall: 'PASS',
      quality: { score: 1.0, threshold: 0.90, passed: true, by_category: {} },
      latency: { p50_ms: 100, p95_ms: 200, p99_ms: 300, threshold_p95_ms: 600, passed: true },
      cost: { estimated_cost_per_1k_req: 0.5, baseline_cost_per_1k_req: 1.85, savings_pct: 73, passed: true },
      regressions: [],
      case_results: [],
      timestamp: new Date().toISOString(),
      candidate_id: 'candidate-round-1',
      session_id: sessionId as any,
      test_suite_id: 'standard',
      total_cases: 10,
      passed_cases: 10,
    });

    canaryPlan = prepareCanaryManifest({
      candidateId: 'candidate-round-1',
      sessionId,
      evaluationProof: {
        eval_run_id: 'eval-ok',
        quality_score: 1.0,
        p95_ms: 200,
        savings_pct: 73,
      },
    });
  });

  it('1. missing approval token -> rejected', () => {
    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: undefined,
        sessionId,
      });
    }).toThrow(/Production mutation rejected by Gateway: Missing or malformed approval artifact/);

    // Verify routing table was NOT mutated
    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('2. invalid approval (tampered signature) -> rejected', () => {
    const valid = issueApprovalArtifact({
      sessionId: sessionId as any,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
    });

    const tampered: ApprovalArtifact = {
      payload: valid.payload,
      signature: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: tampered,
        sessionId,
      });
    }).toThrow(/Cryptographic signature mismatch/);

    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('3. wrong migration (session ID mismatch) -> rejected', () => {
    const wrongSessionId = createSessionId();
    const artifact = issueApprovalArtifact({
      sessionId: wrongSessionId,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
    });

    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: artifact,
        sessionId,
      });
    }).toThrow(/Session ID mismatch/);

    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('4. wrong canary (canary ID mismatch) -> rejected', () => {
    const artifact = issueApprovalArtifact({
      sessionId: sessionId as any,
      canaryId: 'canary-completely-different-id',
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
    });

    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: artifact,
        sessionId,
      });
    }).toThrow(/Canary ID mismatch/);

    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('5. denied approval (decision === "deny") -> rejected', () => {
    const deniedArtifact = issueApprovalArtifact({
      sessionId: sessionId as any,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'deny',
    });

    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: deniedArtifact,
        sessionId,
      });
    }).toThrow(/Approval decision was 'deny', not 'allow'/);

    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('6. expired approval (expires_at in the past) -> rejected', () => {
    const expiredArtifact = issueApprovalArtifact({
      sessionId: sessionId as any,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
      ttlSeconds: -10, // Expired 10 seconds ago
    });

    expect(() => {
      applyProductionRouting({
        canaryId: canaryPlan.canary_id,
        approvalToken: expiredArtifact,
        sessionId,
      });
    }).toThrow(/Approval artifact has expired/);

    expect(getLiveRoutingTable().active_sha).toBe('baseline-sha-000000000000');
  });

  it('7. valid approval -> production mutation allowed', () => {
    const validArtifact = issueApprovalArtifact({
      sessionId: sessionId as any,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
      operator: 'staff-lead-engineer',
    });

    const result = applyProductionRouting({
      canaryId: canaryPlan.canary_id,
      approvalToken: validArtifact,
      sessionId,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('MUTATED_CANARY_ACTIVE');
    expect(result.active_sha).toBe(canaryPlan.manifest_sha);
    expect(result.approved_by).toBe('staff-lead-engineer');

    // Confirm live routing table on the gateway was genuinely mutated
    const liveTable = getLiveRoutingTable();
    expect(liveTable.active_sha).toBe(canaryPlan.manifest_sha);
    expect(liveTable.last_approved_by).toBe('staff-lead-engineer');
    expect(liveTable.routes.some(r => r.target === 'model-b' && r.weight_pct === 10)).toBe(true);
  });
});
