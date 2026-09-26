import { canonicalEvaluationEngine, CreateTicketSchema, QueryRefundStatusSchema } from '../../../../core/evaluation/index.js';

export { CreateTicketSchema, QueryRefundStatusSchema };

export interface EvaluationResult {
  contract_version: "1.0";
  eval_run_id: string;
  candidate_id: string;
  timestamp: string;
  test_suite_id: string;
  total_cases: number;
  passed_cases: number;
  quality: {
    score: number;
    threshold: number;
    passed: boolean;
  };
  latency: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    threshold_p95_ms: number;
    passed: boolean;
  };
  cost: {
    estimated_cost_per_1k_req: number;
    baseline_cost_per_1k_req: number;
    savings_pct: number;
    passed: boolean;
  };
  regressions: Array<{
    case_id: string;
    category: string;
    error: string;
  }>;
  overall: "PASS" | "FAIL";
}

export async function runDeterministicEvaluation({
  endpointUrl,
  candidateId,
  testSuitePath,
}: {
  endpointUrl: string;
  candidateId: string;
  testSuitePath?: string;
}): Promise<EvaluationResult> {
  const report = await canonicalEvaluationEngine.run({
    endpointUrl,
    candidateId,
    testSuitePath,
  });

  return {
    contract_version: "1.0",
    eval_run_id: report.eval_run_id,
    candidate_id: report.candidate_id,
    timestamp: report.timestamp,
    test_suite_id: report.test_suite_id,
    total_cases: report.total_cases,
    passed_cases: report.passed_cases,
    quality: report.quality,
    latency: report.latency,
    cost: report.cost,
    regressions: report.regressions,
    overall: report.overall,
  };
}
