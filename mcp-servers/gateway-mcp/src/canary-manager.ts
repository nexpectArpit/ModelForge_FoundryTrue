/**
 * Gateway Canary Manager
 *
 * Manages canary manifests, live gateway routing tables, and independent
 * cryptographic verification of operator approval artifacts.
 *
 * Invariant: NO VALID APPROVAL -> NO PRODUCTION MUTATION.
 */

import crypto from 'node:crypto';
import {
  verifyApprovalArtifact,
  getRegisteredApprovalArtifact,
  type ApprovalArtifact,
} from '../../../core/approval-token.js';
import { sessionRegistry } from '../../../core/session-registry.js';
import type { SessionId, CanaryPlan as CoreCanaryPlan, AuditReceipt } from '../../../core/types.js';

export interface CanaryPlan {
  contract_version: '2.0';
  canary_id: string;
  session_id: SessionId;
  created_at: string;
  baseline_model: string;
  candidate_model: string;
  routing_architecture: 'single_candidate' | 'hybrid_routed';
  traffic_split: {
    baseline_pct: number;
    candidate_pct: number;
  };
  evaluation_proof: {
    eval_run_id: string;
    quality_score: number;
    p95_ms: number;
    savings_pct: number;
  };
  circuit_breakers: {
    error_rate_threshold_pct: number;
    p95_latency_threshold_ms: number;
    auto_rollback: true;
  };
  manifest_sha: string;
}

export interface LiveRoutingTable {
  active_sha: string;
  baseline_model: string;
  routes: Array<{
    target: string;
    weight_pct: number;
    architecture: string;
  }>;
  last_mutated_at: string;
  last_approved_by?: string;
  approval_artifact_sha?: string;
  status: 'active' | 'rollback';
}

const INITIAL_BASELINE_SHA = 'baseline-sha-000000000000';

let activeRoutingTable: LiveRoutingTable = {
  active_sha: INITIAL_BASELINE_SHA,
  baseline_model: 'model-a',
  routes: [
    { target: 'model-a', weight_pct: 100, architecture: 'baseline' },
  ],
  last_mutated_at: new Date().toISOString(),
  status: 'active',
};

const preparedCanaryPlans = new Map<string, CanaryPlan>();

export function resetGatewayState(): void {
  activeRoutingTable = {
    active_sha: INITIAL_BASELINE_SHA,
    baseline_model: 'model-a',
    routes: [
      { target: 'model-a', weight_pct: 100, architecture: 'baseline' },
    ],
    last_mutated_at: new Date().toISOString(),
    status: 'active',
  };
  preparedCanaryPlans.clear();
}

export function getPreparedCanaryPlan(canaryId: string): CanaryPlan | undefined {
  return preparedCanaryPlans.get(canaryId);
}

export function getLiveRoutingTable(): Readonly<LiveRoutingTable> {
  return activeRoutingTable;
}

/**
 * Prepare an immutable canary rollout manifest based on verified evaluation evidence.
 */
export function prepareCanaryManifest({
  candidateId,
  sessionId,
  baselineModel = 'model-a',
  candidateModel = 'model-b',
  routingArchitecture = 'hybrid_routed',
  trafficSplitCandidatePct = 10,
  evaluationProof,
}: {
  candidateId: string;
  sessionId?: string;
  baselineModel?: string;
  candidateModel?: string;
  routingArchitecture?: 'single_candidate' | 'hybrid_routed';
  trafficSplitCandidatePct?: number;
  evaluationProof: {
    eval_run_id: string;
    quality_score: number;
    p95_ms: number;
    savings_pct: number;
  };
}): CanaryPlan {
  const machine = sessionRegistry.getOrCreate({ sessionId });

  // State machine transition: evaluation_complete/re_evaluation_complete -> preparing_canary
  machine.startTimer();
  machine.transition('preparing_canary', 'prepare_canary_manifest', {
    candidate_id: candidateId,
    routing_architecture: routingArchitecture,
  });

  const canaryId = `canary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const baselinePct = 100 - trafficSplitCandidatePct;

  const raw = `${canaryId}:${machine.sessionId}:${baselineModel}:${candidateModel}:${routingArchitecture}:${baselinePct}:${trafficSplitCandidatePct}:${evaluationProof.eval_run_id}`;
  const sha = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

  const plan: CanaryPlan = {
    contract_version: '2.0',
    canary_id: canaryId,
    session_id: machine.sessionId,
    created_at: new Date().toISOString(),
    baseline_model: baselineModel,
    candidate_model: candidateModel,
    routing_architecture: routingArchitecture,
    traffic_split: {
      baseline_pct: baselinePct,
      candidate_pct: trafficSplitCandidatePct,
    },
    evaluation_proof: evaluationProof,
    circuit_breakers: {
      error_rate_threshold_pct: 2.0,
      p95_latency_threshold_ms: 600,
      auto_rollback: true,
    },
    manifest_sha: sha,
  };

  // State machine transition: preparing_canary -> canary_ready
  machine.transition('canary_ready', 'canary_prepared', {
    canary_id: plan.canary_id,
    manifest_sha: plan.manifest_sha,
  });
  machine.setCanary(plan as any);
  sessionRegistry.persist(machine);

  preparedCanaryPlans.set(canaryId, plan);
  return plan;
}

/**
 * Apply the prepared canary routing configuration to the live production gateway.
 *
 * CRITICAL SECURITY INVARIANT:
 * This method independently verifies the cryptographic approval artifact.
 * Any missing, forged, expired, mismatched, or denied approval artifact
 * will throw an error and PREVENT any mutation of the live routing table.
 */
export function applyProductionRouting({
  canaryId,
  approvalToken,
  sessionId,
  secretKey,
}: {
  canaryId: string;
  approvalToken: unknown;
  sessionId?: string;
  secretKey?: string;
}) {
  const plan = preparedCanaryPlans.get(canaryId);
  if (!plan) {
    throw new Error(`Canary plan ${canaryId} was not found or has not been prepared`);
  }

  const machine = sessionRegistry.getOrCreate({ sessionId: sessionId ?? plan.session_id });

  // 1. Independently verify the approval artifact (from argument or registered store)
  const tokenToVerify = approvalToken ?? getRegisteredApprovalArtifact(canaryId);
  const verification = verifyApprovalArtifact(
    tokenToVerify,
    {
      sessionId: machine.sessionId,
      canaryId: plan.canary_id,
      manifestSha: plan.manifest_sha,
    },
    secretKey,
  );

  if (!verification.valid || !verification.artifact) {
    throw new Error(`Production mutation rejected by Gateway: ${verification.reason}`);
  }

  const artifact = verification.artifact;

  // 2. Validate state machine transition: canary_ready -> awaiting_approval -> applying
  machine.startTimer();
  machine.transition('awaiting_approval', 'operator_approval_verified', {
    operator: artifact.payload.operator,
    issued_at: artifact.payload.issued_at,
  });

  machine.transition('applying', 'apply_production_routing', {
    canary_id: canaryId,
    manifest_sha: plan.manifest_sha,
  });

  // 3. Mutate live routing table (ONLY REACHED IF VERIFICATION SUCCEEDED)
  const artifactSha = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16);
  activeRoutingTable = {
    active_sha: plan.manifest_sha,
    baseline_model: plan.baseline_model,
    routes: [
      { target: plan.baseline_model, weight_pct: plan.traffic_split.baseline_pct, architecture: 'baseline' },
      { target: plan.candidate_model, weight_pct: plan.traffic_split.candidate_pct, architecture: plan.routing_architecture },
    ],
    last_mutated_at: new Date().toISOString(),
    last_approved_by: artifact.payload.operator,
    approval_artifact_sha: artifactSha,
    status: 'active',
  };

  // 4. Transition state machine to verifying
  machine.transition('verifying', 'routing_applied', {
    active_sha: activeRoutingTable.active_sha,
  });
  sessionRegistry.persist(machine);

  return {
    success: true,
    canary_id: canaryId,
    active_sha: activeRoutingTable.active_sha,
    traffic_split: plan.traffic_split,
    applied_at: activeRoutingTable.last_mutated_at,
    approved_by: artifact.payload.operator,
    approval_artifact_sha: artifactSha,
    status: 'MUTATED_CANARY_ACTIVE',
  };
}

/**
 * Verify authoritative live routing table on the production gateway and emit receipt.
 */
export function verifyGatewayRouting(expectedCanaryId?: string, sessionId?: string) {
  let expectedSha: string | null = null;
  if (expectedCanaryId) {
    const plan = preparedCanaryPlans.get(expectedCanaryId);
    if (plan) expectedSha = plan.manifest_sha;
  }

  const shaMatches = expectedSha ? activeRoutingTable.active_sha === expectedSha : activeRoutingTable.active_sha !== INITIAL_BASELINE_SHA;

  let receipt: AuditReceipt | null = null;
  if (shaMatches) {
    const machine = sessionRegistry.getOrCreate({ sessionId });
    if (machine.state === 'verifying') {
      machine.transition('completed', 'routing_verified', {
        active_sha: activeRoutingTable.active_sha,
      });
      receipt = machine.generateReceipt();
      sessionRegistry.persist(machine);
    }
  }

  return {
    contract_version: '2.0',
    verified_at: new Date().toISOString(),
    active_routing_sha: activeRoutingTable.active_sha,
    expected_routing_sha: expectedSha ?? activeRoutingTable.active_sha,
    live_routes: activeRoutingTable.routes,
    status: activeRoutingTable.status,
    verified: shaMatches,
    receipt,
  };
}

/**
 * Emergency rollback immediately reverts production routing to 100% baseline.
 */
export function emergencyRollback(reason: string, sessionId?: string) {
  activeRoutingTable = {
    active_sha: 'rollback-sha-baseline-100',
    baseline_model: 'model-a',
    routes: [
      { target: 'model-a', weight_pct: 100, architecture: 'baseline' },
    ],
    last_mutated_at: new Date().toISOString(),
    last_approved_by: `emergency-rollback: ${reason}`,
    status: 'rollback',
  };

  const machine = sessionRegistry.getOrCreate({ sessionId });
  if (!machine.isTerminal()) {
    machine.transition('aborted', 'emergency_rollback', { reason });
    sessionRegistry.persist(machine);
  }

  return {
    status: 'ROLLED_BACK',
    reason,
    active_routing_sha: activeRoutingTable.active_sha,
    timestamp: activeRoutingTable.last_mutated_at,
  };
}
