import type {
  EvaluationReport,
  FailureDiagnosis,
  FailureCategory,
  RemediationStrategy,
  SessionId,
  EvalRunId,
  MigrationSession,
} from './types.js';

interface FailurePattern {
  category: FailureCategory;
  recommendedStrategy: RemediationStrategy;
  minFailures: number;
  confidence: number;
  match: (report: EvaluationReport) => boolean;
  rootCause: (report: EvaluationReport) => string;
}

const FAILURE_PATTERNS: FailurePattern[] = [
  {
    category: 'tool_calling_regression',
    recommendedStrategy: 'hybrid_routing',
    minFailures: 1,
    confidence: 0.95,
    match: (r) => r.regressions.some((reg) => reg.category === 'tool'),
    rootCause: (r) => `Model failed tool-calling schema validation in ${r.regressions.filter(x => x.category === 'tool').length} cases.`,
  },
  {
    category: 'format_violation',
    recommendedStrategy: 'prompt_adaptation',
    minFailures: 1,
    confidence: 0.85,
    match: (r) => r.regressions.some((reg) => reg.category === 'extract'),
    rootCause: (r) => 'Model produced malformed JSON or violated structured output schema.',
  },
  {
    category: 'quality_degradation',
    recommendedStrategy: 'few_shot_prompting',
    minFailures: 2,
    confidence: 0.8,
    match: (r) => (r.quality.score ?? 1) < (r.quality.threshold ?? 0.9),
    rootCause: (r) => `Quality score (${r.quality.score}) dropped below acceptable threshold.`,
  },
];

export function diagnoseFailures(options: {
  sessionId?: SessionId;
  evaluationReport: EvaluationReport;
  session?: MigrationSession;
}): FailureDiagnosis {
  const { evaluationReport } = options;
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.match(evaluationReport)) {
      return {
        contract_version: '2.0',
        diagnosis_id: `diag-${Date.now().toString(36)}`,
        eval_run_id: evaluationReport.eval_run_id,
        session_id: options.sessionId ?? 'session-default',
        timestamp: new Date().toISOString(),
        primary_failure_category: pattern.category,
        affected_categories: [pattern.category],
        confidence: pattern.confidence,
        recommended_strategy: pattern.recommendedStrategy,
        root_cause_analysis: pattern.rootCause(evaluationReport),
        remediation_payload: { strategy: pattern.recommendedStrategy },
      };
    }
  }
  return {
    contract_version: '2.0',
    diagnosis_id: `diag-${Date.now().toString(36)}`,
    eval_run_id: evaluationReport.eval_run_id,
    session_id: options.sessionId ?? 'session-default',
    timestamp: new Date().toISOString(),
    primary_failure_category: 'quality_degradation',
    affected_categories: ['quality_degradation'],
    confidence: 0.5,
    recommended_strategy: 'abort_migration',
    root_cause_analysis: 'Unclassified regression across benchmark cases.',
    remediation_payload: { strategy: 'abort_migration' },
  };
}
