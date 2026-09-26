/**
 * ModelForge Port Interfaces
 *
 * Architectural Principle #2: Ports & Adapters / Hexagonal Architecture
 * Architectural Principle #3: Dependency Inversion
 *
 * These port interfaces define the boundaries of the core domain.
 * The domain depends ONLY on these interfaces — never on concrete implementations.
 *
 * Adapters (implementations) are injected at construction time, not imported directly.
 *
 * Ports:
 *   - StatePort: durable session state operations
 *   - SandboxPort: workspace isolation operations
 *   - AnalyzerPort: repository analysis
 *   - PlannerPort: migration plan generation
 *   - PatcherPort: code mutation in sandbox
 *   - EvaluatorPort: deterministic benchmark execution
 *   - DiagnosticsPort: failure classification and remediation recommendation
 *   - ApprovalPort: production gating verification
 *   - ObservabilityPort: structured event logging
 */

import type {
  SessionId,
  MigrationState,
  MigrationSession,
  RepositoryProfile,
  MigrationPlan,
  EvaluationReport,
  FailureDiagnosis,
  CanaryPlan,
  SessionEvent,
  AuditReceipt,
  RestartReconciliation,
  ModelReference,
} from './types.js';

// ─── State Port ──────────────────────────────────────────────────────────────

/**
 * Port for durable session state persistence.
 * The state machine and orchestrator depend on this interface,
 * not on DurableStateStore directly.
 */
export interface StatePort {
  createOrGetSession(params: {
    sessionId: string;
    repositoryPath: string;
    sourceModel: string;
    targetModel: string;
    maxRemediationRounds?: number;
    initialState?: MigrationState;
  }): { session_id: string; state: MigrationState; [key: string]: unknown };

  getSession(sessionId: string): { session_id: string; state: MigrationState; [key: string]: unknown } | null;

  recordStateTransition(params: {
    sessionId: string;
    fromState: MigrationState;
    toState: MigrationState;
    action: string;
    payload?: Record<string, unknown> | null;
    stepId?: string;
    durationMs?: number | null;
  }): SessionEvent;

  saveProfile(sessionId: string, profile: RepositoryProfile): void;
  savePlan(sessionId: string, plan: MigrationPlan): void;
  saveCanary(sessionId: string, canary: CanaryPlan): void;
  recordEvaluation(sessionId: string, report: EvaluationReport): void;
  recordDiagnosis(sessionId: string, diagnosis: FailureDiagnosis): void;
  recordAuditEvent(params: {
    sessionId: string;
    action: string;
    actor: string;
    details: Record<string, unknown>;
  }): void;

  reconcileRestart(sessionId: string): RestartReconciliation;
}

// ─── Sandbox Port ────────────────────────────────────────────────────────────

/**
 * Port for workspace sandbox lifecycle.
 */
export interface SandboxPort {
  readonly sandboxPath: string;

  initialize(): void;
  readFile(relativePath: string): string;
  writeFile(relativePath: string, content: string): void;
  replaceInFile(
    relativePath: string,
    searchPattern: string | RegExp,
    replacement: string,
  ): { matched: boolean; file_path: string };
  hasModifications(): boolean;
  getDiffs(): Array<{
    file_path: string;
    original_content: string;
    modified_content: string;
    original_sha: string;
    modified_sha: string;
  }>;
  getManifest(): {
    sandbox_id: string;
    session_id: SessionId;
    source_path: string;
    sandbox_path: string;
    created_at: string;
    modified_files: string[];
    file_hashes: Record<string, { original: string; modified: string }>;
    status: 'active' | 'committed' | 'discarded';
  };
  discard(): void;
  commit(): { committed_files: string[] };
}

// ─── Analyzer Port ───────────────────────────────────────────────────────────

/**
 * Port for repository analysis.
 * Implementations may use AST, regex, or hybrid approaches.
 */
export interface AnalyzerPort {
  analyze(repositoryPath: string): RepositoryProfile;
}

// ─── Planner Port ────────────────────────────────────────────────────────────

/**
 * Port for migration plan generation.
 */
export interface PlannerPort {
  generatePlan(input: {
    sessionId: SessionId;
    profile: RepositoryProfile;
    sourceModel: string;
    targetModel: string;
    previousDiagnosis?: FailureDiagnosis;
  }): MigrationPlan;
}

// ─── Patcher Port ────────────────────────────────────────────────────────────

/**
 * Port for applying migration patches to a sandbox.
 */
export interface PatcherPort {
  applyMigrationPlan(
    sandbox: SandboxPort,
    plan: MigrationPlan,
    profile: RepositoryProfile,
  ): {
    total_files_patched: number;
    total_replacements: number;
    strategy_applied: string;
  };
}

// ─── Evaluator Port ──────────────────────────────────────────────────────────

/**
 * Port for deterministic benchmark evaluation.
 */
export interface EvaluatorPort {
  evaluate(options: {
    endpointUrl?: string;
    candidateId: string;
    sessionId?: SessionId;
    qualityThreshold?: number;
    latencyThresholdMs?: number;
    baselineCostPer1k?: number;
  }): Promise<EvaluationReport>;
}

// ─── Diagnostics Port ────────────────────────────────────────────────────────

/**
 * Port for failure diagnosis.
 */
export interface DiagnosticsPort {
  diagnose(input: {
    sessionId: SessionId;
    evaluationReport: EvaluationReport;
    sourceModel?: string;
    targetModel?: string;
  }): FailureDiagnosis;
}

// ─── Approval Port ───────────────────────────────────────────────────────────

/**
 * Port for production approval gating.
 */
export interface ApprovalPort {
  verify(
    artifact: unknown,
    expected: {
      sessionId: string;
      canaryId: string;
      manifestSha: string;
    },
  ): { valid: boolean; reason?: string };
}

// ─── Observability Port ──────────────────────────────────────────────────────

/**
 * Port for structured event emission.
 * Principle #10: Structured observability
 */
export interface ObservabilityPort {
  emit(event: {
    level: 'info' | 'warn' | 'error';
    category: string;
    action: string;
    sessionId?: string;
    context?: Record<string, unknown>;
  }): void;
}

// ─── Sandbox Factory ─────────────────────────────────────────────────────────

/**
 * Factory port for creating sandbox instances.
 * Separates construction from usage.
 */
export interface SandboxFactory {
  create(opts: {
    sessionId: SessionId;
    sourcePath: string;
    sandboxRoot?: string;
  }): SandboxPort;
}
