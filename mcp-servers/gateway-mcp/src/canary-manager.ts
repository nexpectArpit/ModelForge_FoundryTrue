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
  issueApprovalArtifact,
  registerApprovalArtifact,
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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const INITIAL_BASELINE_SHA = 'baseline-sha-000000000000';
const CANARIES_DIR = path.resolve(process.cwd(), '.modelforge-canaries');
const GATEWAY_STATE_FILE = path.join(CANARIES_DIR, 'gateway-routing-table.json');
const preparedCanaryPlans = new Map<string, CanaryPlan>();

function saveRoutingTable(table: LiveRoutingTable): void {
  try {
    if (!existsSync(CANARIES_DIR)) mkdirSync(CANARIES_DIR, { recursive: true });
    writeFileSync(GATEWAY_STATE_FILE, JSON.stringify(table, null, 2), 'utf8');
  } catch { }
}

function loadRoutingTable(): LiveRoutingTable {
  try {
    if (existsSync(GATEWAY_STATE_FILE)) {
      return JSON.parse(readFileSync(GATEWAY_STATE_FILE, 'utf8'));
    }
  } catch { }
  return {
    active_sha: INITIAL_BASELINE_SHA,
    baseline_model: 'model-a',
    routes: [
      { target: 'model-a', weight_pct: 100, architecture: 'baseline' },
    ],
    last_mutated_at: new Date().toISOString(),
    status: 'active',
  };
}

let activeRoutingTable: LiveRoutingTable = loadRoutingTable();

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
  saveRoutingTable(activeRoutingTable);
  preparedCanaryPlans.clear();
}

export function getPreparedCanaryPlan(canaryId: string): CanaryPlan | undefined {
  if (preparedCanaryPlans.has(canaryId)) {
    return preparedCanaryPlans.get(canaryId);
  }
  try {
    const filePath = path.join(CANARIES_DIR, `${canaryId}.json`);
    if (existsSync(filePath)) {
      const plan = JSON.parse(readFileSync(filePath, 'utf8'));
      preparedCanaryPlans.set(canaryId, plan);
      return plan;
    }
  } catch { }
  return undefined;
}

export function getLatestPreparedCanaryPlan(): CanaryPlan | undefined {
  const memPlans = Array.from(preparedCanaryPlans.values());
  if (memPlans.length > 0) return memPlans[memPlans.length - 1];

  try {
    if (existsSync(CANARIES_DIR)) {
      const files = readdirSync(CANARIES_DIR).filter(f => f.endsWith('.json'));
      if (files.length > 0) {
        const latest = files
          .map(f => ({ name: f, mtime: statSync(path.join(CANARIES_DIR, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0];
        const plan = JSON.parse(readFileSync(path.join(CANARIES_DIR, latest.name), 'utf8'));
        preparedCanaryPlans.set(plan.canary_id, plan);
        return plan;
      }
    }
  } catch { }

  const machine = sessionRegistry.getOrCreate();
  if (machine.currentSession?.canary) {
    const plan = machine.currentSession.canary as unknown as CanaryPlan;
    preparedCanaryPlans.set(plan.canary_id, plan);
    return plan;
  }
  return undefined;
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
  try {
    mkdirSync(CANARIES_DIR, { recursive: true });
    writeFileSync(path.join(CANARIES_DIR, `${canaryId}.json`), JSON.stringify(plan, null, 2), 'utf8');
  } catch { }
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
export function issueOperatorApproval({
  canaryId,
  decision,
  operator = 'trueforge-ui-operator',
  sessionId,
}: {
  canaryId?: string;
  decision: 'allow' | 'deny';
  operator?: string;
  sessionId?: string;
}) {
  const plan = (canaryId ? getPreparedCanaryPlan(canaryId) : null) ?? getLatestPreparedCanaryPlan();
  if (!plan) {
    throw new Error('No prepared canary plan found to approve');
  }
  const artifact = issueApprovalArtifact({
    sessionId: plan.session_id,
    canaryId: plan.canary_id,
    manifestSha: plan.manifest_sha,
    decision,
    operator,
  });
  registerApprovalArtifact(artifact);
  return {
    status: 'approval_artifact_registered',
    canary_id: plan.canary_id,
    decision,
    operator,
    manifest_sha: plan.manifest_sha,
    artifact,
  };
}

export function applyProductionRouting({
  canaryId,
  approvalToken,
  sessionId,
  secretKey,
}: {
  canaryId?: string;
  approvalToken?: unknown;
  sessionId?: string;
  secretKey?: string;
}) {
  let tokenToVerify: any = approvalToken;
  if (typeof tokenToVerify === 'string') {
    try {
      tokenToVerify = JSON.parse(tokenToVerify);
    } catch { }
  }

  const plan = (canaryId ? getPreparedCanaryPlan(canaryId) : null) ?? getLatestPreparedCanaryPlan();

  if (!tokenToVerify || typeof tokenToVerify !== 'object' || !tokenToVerify.payload || !tokenToVerify.signature) {
    const lookupId = canaryId ?? plan?.canary_id;
    const registered = lookupId ? getRegisteredApprovalArtifact(lookupId) : null;
    if (registered) {
      tokenToVerify = registered;
    } else {
      throw new Error(
        'Production mutation rejected by Gateway: Missing or malformed approval artifact. ' +
        'This tool requires a signed approval artifact from TrueForge\'s native approval gate.'
      );
    }
  }

  if (!plan) {
    throw new Error(`Canary plan was not found or has not been prepared`);
  }

  const machine = sessionRegistry.getOrCreate({ sessionId: sessionId ?? plan.session_id });


  const verification = verifyApprovalArtifact(
    tokenToVerify,
    {
      sessionId: plan.session_id,
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
    canary_id: plan.canary_id,
    manifest_sha: plan.manifest_sha,
  });

  // 3. Mutate live routing table (ONLY REACHED IF VERIFICATION SUCCEEDED)
  const artifactSha = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16);
  const split = plan.traffic_split ?? { baseline_pct: 90, candidate_pct: 10 };
  activeRoutingTable = {
    active_sha: plan.manifest_sha,
    baseline_model: plan.baseline_model ?? 'model-a',
    routes: [
      { target: plan.baseline_model ?? 'model-a', weight_pct: split.baseline_pct, architecture: 'baseline' },
      { target: plan.candidate_model ?? 'model-b', weight_pct: split.candidate_pct, architecture: plan.routing_architecture ?? 'hybrid_routed' },
    ],
    last_mutated_at: new Date().toISOString(),
    last_approved_by: artifact.payload.operator,
    approval_artifact_sha: artifactSha,
    status: 'active',
  };
  saveRoutingTable(activeRoutingTable);

  // 4. Transition state machine to verifying
  machine.transition('verifying', 'routing_applied', {
    active_sha: activeRoutingTable.active_sha,
  });
  sessionRegistry.persist(machine);

  return {
    success: true,
    canary_id: plan.canary_id,
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
  const canaryId = expectedCanaryId || getLatestPreparedCanaryPlan()?.canary_id;
  if (canaryId) {
    const plan = getPreparedCanaryPlan(canaryId);
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
  saveRoutingTable(activeRoutingTable);

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
