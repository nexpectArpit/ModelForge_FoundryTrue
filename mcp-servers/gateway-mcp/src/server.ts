import {
  prepareCanaryManifest,
  applyProductionRouting,
  verifyGatewayRouting,
  emergencyRollback,
  resetGatewayState,
} from './canary-manager.js';

export { resetGatewayState };

export const GATEWAY_TOOLS = [
  {
    name: 'prepare_canary_manifest',
    description: 'Prepare an immutable canary deployment plan and routing manifest from verified evaluation receipts.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'Evaluated candidate identifier' },
        baseline_model: { type: 'string', description: 'Baseline model name' },
        candidate_model: { type: 'string', description: 'Candidate model name' },
        routing_architecture: { type: 'string', enum: ['single_candidate', 'hybrid_routed'] },
        traffic_split_candidate_pct: { type: 'number', description: 'Canary traffic percentage (default 10)' },
        evaluation_proof: {
          type: 'object',
          properties: {
            eval_run_id: { type: 'string' },
            quality_score: { type: 'number' },
            p95_ms: { type: 'number' },
            savings_pct: { type: 'number' },
          },
          required: ['eval_run_id', 'quality_score', 'p95_ms', 'savings_pct'],
        },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['candidate_id', 'evaluation_proof'],
    },
  },
  {
    name: 'apply_production_routing',
    description: 'APPROVAL REQUIRED: Apply the prepared canary routing configuration to the live production AI Gateway. Requires an independently verifiable operator approval artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        canary_id: { type: 'string', description: 'ID of the prepared and approved canary plan' },
        approval_token: {
          type: ['object', 'null'],
          description: 'Cryptographically signed approval artifact produced by operator sign-off',
        },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['canary_id'],
    },
  },
  {
    name: 'verify_gateway_routing',
    description: 'Query authoritative live routing table on the production AI Gateway to verify active SHA.',
    inputSchema: {
      type: 'object',
      properties: {
        expected_canary_id: { type: 'string', description: 'Optional expected canary ID to verify against' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
  {
    name: 'emergency_rollback',
    description: 'Immediately revert production gateway routing to 100% baseline model.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for triggering emergency rollback' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['reason'],
    },
  },
];

export async function handleGatewayToolCall(name: string, args: Record<string, any>) {
  if (name === 'prepare_canary_manifest') {
    return prepareCanaryManifest({
      candidateId: args.candidate_id,
      sessionId: args.session_id,
      baselineModel: args.baseline_model ?? 'model-a',
      candidateModel: args.candidate_model ?? 'model-b',
      routingArchitecture: args.routing_architecture ?? 'hybrid_routed',
      trafficSplitCandidatePct: args.traffic_split_candidate_pct ?? 10,
      evaluationProof: args.evaluation_proof,
    });
  }

  if (name === 'apply_production_routing') {
    return applyProductionRouting({
      canaryId: args.canary_id,
      approvalToken: args.approval_token,
      sessionId: args.session_id,
    });
  }

  if (name === 'verify_gateway_routing') {
    return verifyGatewayRouting(args.expected_canary_id, args.session_id);
  }

  if (name === 'emergency_rollback') {
    return emergencyRollback(args.reason, args.session_id);
  }

  throw new Error(`Unknown gateway tool: ${name}`);
}
