/**
 * ModelForge Core Domain Types
 *
 * These types define the data contracts that flow through the entire migration
 * pipeline. Every module — inspector, planner, sandbox, evaluator, canary —
 * reads and writes instances of these types.
 *
 * Design decisions:
 *   - Discriminated unions for migration step states (allows exhaustive matching)
 *   - Branded IDs to prevent accidental mixing of different identifier domains
 *   - Immutable evaluation receipts (once created, never mutated)
 *   - ISO 8601 timestamps everywhere (no epoch-ms ambiguity)
 */

// ─── Branded Identifiers ─────────────────────────────────────────────────────

/** Opaque brand for compile-time safety */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, 'SessionId'>;
export type EvalRunId = Brand<string, 'EvalRunId'>;
export type CanaryId = Brand<string, 'CanaryId'>;
export type MigrationStepId = Brand<string, 'MigrationStepId'>;
export type PatchId = Brand<string, 'PatchId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ComparisonId = Brand<string, 'ComparisonId'>;

export function createSessionId(): SessionId {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as SessionId;
}

export function createEvalRunId(): EvalRunId {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as EvalRunId;
}

export function createCanaryId(): CanaryId {
  return `canary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as CanaryId;
}

export function createComparisonId(): ComparisonId {
  return `comp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as ComparisonId;
}

export function createStepId(stepName: string): MigrationStepId {
  return `step-${stepName}-${Date.now().toString(36)}` as MigrationStepId;
}

export function createPatchId(type: string): PatchId {
  return `patch-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as PatchId;
}

export function createOperationId(name: string): OperationId {
  return `op-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` as OperationId;
}

// ─── Repository Profile ──────────────────────────────────────────────────────

/** Classification of how a model identifier is referenced in source code */
export type ReferenceType =
  | 'model_name_literal'
  | 'client_init'
  | 'prompt_template'
  | 'tool_definition'
  | 'env_variable'
  | 'config_file'
  | 'import_statement';

/** A single location in source code where a model dependency is observed */
export interface ModelReference {
  /** Path relative to repository root */
  file_path: string;
  /** 1-indexed line numbers where the reference occurs */
  line_numbers: number[];
  /** Classification of this reference */
  reference_type: ReferenceType;
  /** Verbatim code at the reference site (trimmed) */
  code_snippet: string;
  /** Confidence that this reference is correctly classified (0.0–1.0) */
  confidence: number;
}

/** Detected AI framework / SDK in the repository */
export interface DetectedFramework {
  /** Framework identifier (e.g. 'openai-sdk', 'langchain', 'ai-sdk') */
  name: string;
  /** Semver version if detectable from package.json/requirements.txt */
  version: string | null;
  /** Import paths observed (e.g. ['openai', '@ai-sdk/openai']) */
  import_paths: string[];
}

/** Complete profile of a repository's AI model usage — the ground truth input
 *  that drives migration planning. */
export interface RepositoryProfile {
  contract_version: '2.0';
  status: 'complete' | 'incomplete' | 'error';
  /** Absolute path to the inspected repository */
  repository_path: string;
  /** Short repository name (basename) */
  repository_name: string;
  /** Primary programming language */
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  /** Package manager detected (npm, pnpm, yarn, pip, poetry, unknown) */
  package_manager: string;
  /** All detected AI frameworks */
  detected_frameworks: DetectedFramework[];
  /** The current baseline model identifier */
  current_model: string;
  /** Every location in the codebase that references the model */
  model_references: ModelReference[];
  /** Tool/function definitions exposed to the model */
  tool_schemas: ToolSchema[];
  /** Environment variables that affect model behavior */
  env_dependencies: string[];
  /** Issues the inspector could not resolve */
  unknowns: string[];
  /** When this profile was generated */
  inspected_at: string;
  /** Optional complexity classification (populated by v2 analyzer) */
  complexity?: {
    level: 'trivial' | 'standard' | 'complex' | 'advanced';
    score: number;
    factors: Array<{ name: string; weight: number; description: string }>;
  };
}

/** A tool/function schema exposed to the LLM */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema of the parameters object */
  parameters_schema: Record<string, unknown>;
  /** Source file where this tool is defined */
  source_file: string;
  source_line: number;
}

/** Source code location boundary for precision patching and evidence */
export interface SourceLocation {
  file_path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  snippet?: string;
}

/** Executable precondition required before a patch can be applied safely */
export interface PatchPrecondition {
  type: 'file_exists' | 'content_matches' | 'env_defined';
  target: string;
  expected?: string;
}

/** Specific patch mutation type */
export type PatchType =
  | 'model_literal'
  | 'config_setting'
  | 'routing_mode'
  | 'prompt_adaptation'
  | 'schema_simplification';

/** Concrete executable patch operation in a sandbox workspace */
export interface PatchOperation {
  id: PatchId;
  type: PatchType;
  target_file: string;
  location?: SourceLocation;
  preconditions: PatchPrecondition[];
  action: {
    operation: 'replace' | 'insert' | 'delete' | 'append';
    pattern?: string;
    replacement?: string;
    key?: string;
    value?: unknown;
  };
  description: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
}

/** Execution topology descriptor for running the application under test */
export interface ExecutionDescriptor {
  runtime: 'node' | 'python' | 'custom';
  entrypoint: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  port?: number;
  health_check?: {
    path: string;
    timeout_ms: number;
    expected_status?: number;
  };
}

/** Configuration for pluggable evaluation adapters */
export interface EvaluationAdapterConfig {
  adapter_type: 'openai_chat' | 'custom_rest' | 'direct_function';
  endpoint_url?: string;
  headers?: Record<string, string>;
  request_template?: Record<string, unknown>;
  response_mapping?: {
    response_field?: string;
    tool_calls_field?: string;
    structured_data_field?: string;
    usage_cost_field?: string;
  };
}

/** Structured specialist tool evidence record */
export interface SpecialistToolEvidence {
  tool: string;
  arguments: Record<string, unknown>;
  observations: string[];
}

// ─── Migration Plan ──────────────────────────────────────────────────────────

/** The routing strategy the migration will employ */
export type RoutingStrategy =
  | 'direct_replacement'     // Swap baseline → candidate everywhere
  | 'hybrid_routing'         // Route some tasks to baseline, others to candidate
  | 'prompt_adaptation'      // Keep candidate, but modify prompts/system messages
  | 'schema_simplification'  // Simplify tool schemas for candidate compatibility
  | 'abort';                 // Migration is not viable

/** A single code change the planner intends to make */
export interface PlannedChange {
  /** File to modify (relative to repo root) */
  file_path: string;
  /** Human-readable description of the change */
  description: string;
  /** What the change achieves */
  rationale: string;
  /** Lines affected (for audit trail) */
  line_range: { start: number; end: number } | null;
  /** Risk level of this change */
  risk: 'low' | 'medium' | 'high';
  /** Optional concrete patch operation representation */
  patch_operation?: PatchOperation;
}

/** An acceptance criterion that will be checked after the migration */
export interface AcceptanceCriterion {
  id: string;
  description: string;
  category: 'quality' | 'latency' | 'cost' | 'tool_calling' | 'structured_output';
  /** Threshold expression (e.g. ">= 0.90", "< 600ms") */
  threshold: string;
  /** Whether this criterion must pass for migration to proceed */
  required: boolean;
}

/** Complete migration plan — the planner's output before any code is changed */
export interface MigrationPlan {
  contract_version: '2.0';
  session_id: SessionId;
  /** Human-readable plan title */
  title: string;
  /** Source model being replaced */
  source_model: string;
  /** Target model to migrate to */
  target_model: string;
  /** The routing strategy selected after analysis */
  strategy: RoutingStrategy;
  /** Rationale for the selected strategy */
  strategy_rationale: string;
  /** Ordered list of code changes to apply */
  changes: PlannedChange[];
  /** Acceptance criteria that must pass in evaluation */
  acceptance_criteria: AcceptanceCriterion[];
  /** Estimated risk level of the overall migration */
  risk_assessment: 'low' | 'medium' | 'high' | 'critical';
  /** When this plan was generated */
  planned_at: string;
}

// ─── Evaluation Report ───────────────────────────────────────────────────────

/** Result of a single benchmark test case */
export interface TestCaseResult {
  case_id: string;
  category: 'qa' | 'summarize' | 'extract' | 'tool';
  passed: boolean;
  /** Latency in milliseconds */
  latency_ms: number;
  /** Estimated cost of this single invocation */
  estimated_cost: number;
  /** If failed, the specific failure reason */
  failure_reason: string | null;
  /** Raw model output (for audit) */
  raw_response_summary: string;
}

/** Aggregate quality metrics for an evaluation run */
export interface QualityMetrics {
  score: number;
  threshold: number;
  passed: boolean;
  /** Per-category breakdown */
  by_category: Record<string, { passed: number; total: number; score: number }>;
}

/** Aggregate latency metrics */
export interface LatencyMetrics {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  threshold_p95_ms: number;
  passed: boolean;
}

/** Aggregate cost metrics */
export interface CostMetrics {
  estimated_cost_per_1k_req: number;
  baseline_cost_per_1k_req: number;
  savings_pct: number;
  passed: boolean;
}

/** A regression detected during evaluation */
export interface Regression {
  case_id: string;
  category: string;
  error: string;
  /** Severity classification */
  severity: 'critical' | 'major' | 'minor';
}

/** Complete evaluation report — immutable once generated */
export interface EvaluationReport {
  contract_version: '2.0';
  eval_run_id: EvalRunId;
  session_id: SessionId;
  candidate_id: string;
  timestamp: string;
  test_suite_id: string;
  total_cases: number;
  passed_cases: number;
  /** Detailed per-case results */
  case_results: TestCaseResult[];
  quality: QualityMetrics;
  latency: LatencyMetrics;
  cost: CostMetrics;
  regressions: Regression[];
  overall: 'PASS' | 'FAIL';
}

// ─── Rehearsal Comparison Matrix ─────────────────────────────────────────────

/** Comparative status of a single benchmark test case between baseline and candidate */
export type CaseComparisonStatus =
  | 'maintained_pass' // Passed in both baseline and candidate
  | 'maintained_fail' // Failed in both baseline and candidate
  | 'regression'      // Passed in baseline, but failed in candidate
  | 'improvement';    // Failed in baseline, but passed in candidate

/** Detailed differential for a single benchmark test case */
export interface CaseComparison {
  case_id: string;
  category: 'qa' | 'summarize' | 'extract' | 'tool';
  baseline_passed: boolean;
  candidate_passed: boolean;
  status: CaseComparisonStatus;
  baseline_latency_ms: number;
  candidate_latency_ms: number;
  latency_delta_ms: number;
  failure_reason?: string | null;
}

/** Pure deterministic comparison matrix evaluating candidate against baseline */
export interface RehearsalComparisonMatrix {
  contract_version: '2.0';
  comparison_id: ComparisonId;
  session_id: SessionId;
  baseline_eval_id: EvalRunId;
  candidate_eval_id: EvalRunId;
  baseline_model: string;
  candidate_model: string;
  timestamp: string;
  total_cases: number;
  baseline_passed: number;
  candidate_passed: number;
  /** Candidate quality score minus baseline quality score */
  accuracy_delta: number;
  /** Candidate latency p50 minus baseline latency p50 in ms */
  latency_p50_shift_ms: number;
  /** Candidate latency p95 minus baseline latency p95 in ms */
  latency_p95_shift_ms: number;
  /** Cost savings percentage compared to baseline */
  cost_savings_pct: number;
  /** Count of true regressions (cases baseline passed but candidate failed) */
  regressions_count: number;
  /** Count of improvements */
  improvements_count: number;
  /** Per-case comparison details */
  case_comparisons: CaseComparison[];
  /** Pure deterministic evaluation verdict */
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  /** Recommended lifecycle action based strictly on evidence */
  recommendation: 'ready_for_approval' | 'needs_remediation' | 'abort_migration';
  /** Human-readable explanation of comparison findings */
  summary: string;
}

// ─── Failure Diagnosis ───────────────────────────────────────────────────────

/** Taxonomy of failure categories that ModelForge can diagnose */
export type FailureCategory =
  | 'tool_calling'          // Model can't produce valid tool call schemas
  | 'structured_extraction' // Model can't produce valid structured output
  | 'prompt_drift'          // Model interprets prompts differently
  | 'latency_regression'    // Model is too slow
  | 'cost_regression'       // Model is more expensive than baseline
  | 'hallucination'         // Model fabricates information
  | 'refusal'               // Model refuses to perform the task
  | 'format_violation'      // Model doesn't follow output format
  | 'context_overflow';     // Input exceeds model context window

/** Remediation strategy the diagnostician can recommend */
export type RemediationStrategy =
  | 'hybrid_routing'
  | 'prompt_adaptation'
  | 'schema_simplification'
  | 'temperature_tuning'
  | 'few_shot_examples'
  | 'abort_migration';

/** Complete failure diagnosis report */
export interface FailureDiagnosis {
  contract_version: '2.0';
  session_id: SessionId;
  eval_run_id: EvalRunId;
  /** The primary category of failure observed */
  primary_failure_category: FailureCategory;
  /** Which specific test categories failed */
  affected_categories: string[];
  /** Root cause analysis (human-readable) */
  root_cause_analysis: string;
  /** The remediation the diagnostician recommends */
  recommended_strategy: RemediationStrategy;
  /** Details of how to implement the remediation */
  strategy_details: Record<string, unknown>;
  /** Confidence in the diagnosis (0.0–1.0) */
  confidence: number;
  diagnosed_at: string;
}

// ─── Canary Deployment ───────────────────────────────────────────────────────

export interface TrafficSplit {
  baseline_pct: number;
  candidate_pct: number;
}

export interface CircuitBreaker {
  error_rate_threshold_pct: number;
  p95_latency_threshold_ms: number;
  auto_rollback: boolean;
}

export interface EvaluationProof {
  eval_run_id: EvalRunId;
  quality_score: number;
  p95_ms: number;
  savings_pct: number;
}

/** Immutable canary deployment plan */
export interface CanaryPlan {
  contract_version: '2.0';
  canary_id: CanaryId;
  session_id: SessionId;
  created_at: string;
  baseline_model: string;
  candidate_model: string;
  routing_architecture: 'single_candidate' | 'hybrid_routed';
  traffic_split: TrafficSplit;
  evaluation_proof: EvaluationProof;
  circuit_breakers: CircuitBreaker;
  manifest_sha: string;
}

/** Live routing table state */
export interface RoutingTable {
  active_sha: string;
  baseline_model: string;
  routes: Array<{
    target: string;
    weight_pct: number;
    architecture: string;
  }>;
  last_mutated_at: string;
  last_approved_by: string | null;
  status: 'active' | 'rollback' | 'pending';
}

// ─── Migration Session State Machine ─────────────────────────────────────────

/** Discriminated union of all possible migration session states */
export type MigrationState =
  | 'initialized'
  | 'inspecting'
  | 'inspection_complete'
  | 'planning'
  | 'plan_ready'
  | 'staging'
  | 'staged'
  | 'evaluating'
  | 'evaluation_complete'
  | 'diagnosing'
  | 'diagnosis_complete'
  | 'remediating'
  | 'remediation_staged'
  | 're_evaluating'
  | 're_evaluation_complete'
  | 'preparing_canary'
  | 'canary_ready'
  | 'awaiting_approval'
  | 'applying'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'aborted';

/** Valid state transitions — the only allowed mutations */
export const VALID_TRANSITIONS: Record<MigrationState, MigrationState[]> = {
  initialized:            ['inspecting', 'aborted'],
  inspecting:             ['inspection_complete', 'failed'],
  inspection_complete:    ['planning', 'aborted'],
  planning:               ['plan_ready', 'failed'],
  plan_ready:             ['staging', 'aborted'],
  staging:                ['staged', 'failed'],
  staged:                 ['evaluating', 'aborted'],
  evaluating:             ['evaluation_complete', 'failed'],
  evaluation_complete:    ['diagnosing', 'preparing_canary', 'aborted'],
  diagnosing:             ['diagnosis_complete', 'failed'],
  diagnosis_complete:     ['remediating', 'aborted'],
  remediating:            ['remediation_staged', 'failed'],
  remediation_staged:     ['re_evaluating', 'aborted'],
  re_evaluating:          ['re_evaluation_complete', 'failed'],
  re_evaluation_complete: ['preparing_canary', 'diagnosing', 'aborted'],
  preparing_canary:       ['canary_ready', 'failed'],
  canary_ready:           ['awaiting_approval', 'aborted'],
  awaiting_approval:      ['applying', 'aborted'],
  applying:               ['verifying', 'failed'],
  verifying:              ['completed', 'failed'],
  completed:              [],
  failed:                 ['initialized'], // Allow restart from failed
  aborted:                ['initialized'], // Allow restart from aborted
};

/** A single event in the session's audit trail */
export interface SessionEvent {
  step_id: MigrationStepId;
  timestamp: string;
  from_state: MigrationState;
  to_state: MigrationState;
  /** The tool or action that triggered this transition */
  action: string;
  /** Payload or result associated with this transition */
  payload: Record<string, unknown> | null;
  /** Duration of the step in milliseconds */
  duration_ms: number | null;
}

/** Complete session — the top-level durable object */
export interface MigrationSession {
  session_id: SessionId;
  state: MigrationState;
  created_at: string;
  updated_at: string;
  /** Source repository path */
  repository_path: string;
  /** Baseline model */
  source_model: string;
  /** Target model */
  target_model: string;
  /** Repository profile (populated after inspection) */
  profile: RepositoryProfile | null;
  /** Baseline evaluation report on incumbent model (populated after baseline rehearsal) */
  baseline_evaluation: EvaluationReport | null;
  /** Migration plan (populated after planning) */
  plan: MigrationPlan | null;
  /** Evaluation reports (one per candidate round) */
  evaluations: EvaluationReport[];
  /** Latest comparison between baseline and candidate evaluation */
  latest_comparison: RehearsalComparisonMatrix | null;
  /** Failure diagnoses (one per diagnosis cycle) */
  diagnoses: FailureDiagnosis[];
  /** Canary plan (populated before deployment) */
  canary: CanaryPlan | null;
  /** Ordered audit trail of state transitions */
  events: SessionEvent[];
  /** Current remediation round (0 = first attempt) */
  remediation_round: number;
  /** Maximum allowed remediation rounds before abort */
  max_remediation_rounds: number;
}

// ─── Audit Receipt ───────────────────────────────────────────────────────────

/** Final immutable receipt of a completed (or failed/aborted) migration */
export interface AuditReceipt {
  contract_version: '2.0';
  session_id: SessionId;
  outcome: 'completed' | 'failed' | 'aborted';
  started_at: string;
  ended_at: string;
  total_duration_ms: number;
  repository_name: string;
  source_model: string;
  target_model: string;
  final_strategy: RoutingStrategy | null;
  total_evaluation_rounds: number;
  total_remediation_rounds: number;
  final_quality_score: number | null;
  final_latency_p95_ms: number | null;
  final_cost_savings_pct: number | null;
  canary_id: CanaryId | null;
  manifest_sha: string | null;
  /** Complete event trail */
  events: SessionEvent[];
  /** SHA-256 hash of this receipt for tamper detection */
  receipt_sha: string;
}

// ─── Durable SQLite Persistence Records ─────────────────────────────────────

export interface DurableSessionRecord {
  session_id: string;
  state: MigrationState;
  source_model: string;
  target_model: string;
  repository_path: string;
  remediation_round: number;
  max_remediation_rounds: number;
  profile_json: string | null;
  plan_json: string | null;
  latest_eval_id: string | null;
  latest_diagnosis_json: string | null;
  canary_id: string | null;
  canary_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface DurableSandboxOperation {
  operation_id: string;
  session_id: string;
  status: 'reserved' | 'prepared' | 'applied' | 'conflict' | 'failed';
  owner_pid: number;
  attempt: number;
  sandbox_path: string;
  source_path: string;
  modified_files_json: string;
  file_hashes_json: string;
  preconditions_json: string;
  diffs_json: string;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DurableEvaluationRecord {
  eval_run_id: string;
  session_id: string;
  candidate_id: string;
  test_suite_id: string;
  overall: 'PASS' | 'FAIL';
  quality_score: number;
  latency_p95_ms: number;
  cost_per_1k: number;
  passed_cases: number;
  total_cases: number;
  regressions_json: string;
  report_json: string;
  created_at: string;
}

export interface DurableAuditEvent {
  sequence: number;
  session_id: string;
  timestamp: string;
  action: string;
  actor: string;
  details_json: string;
}

/** Restart recovery reconciliation classification */
export type ReconciliationStatus =
  | 'safely_resumable'
  | 'already_completed'
  | 'incomplete_ambiguous'
  | 'requires_operator_intervention';

export interface RestartReconciliation {
  session_id: string;
  status: ReconciliationStatus;
  resumable_state: MigrationState;
  reason: string;
  active_sandbox_path: string | null;
  recommended_action: 'resume' | 're_stage' | 'abort' | 'inspect';
}
