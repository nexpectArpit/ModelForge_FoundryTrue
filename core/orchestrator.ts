/**
 * Migration Orchestrator
 *
 * Architectural Principle #1: Separation of concerns
 * Architectural Principle #3: Dependency inversion
 * Architectural Principle #5: Deterministic core / nondeterministic edge
 * Architectural Principle #7: Typed domain error taxonomy
 * Architectural Principle #20: No hidden procedural orchestration
 *
 * The orchestrator coordinates the migration lifecycle through the state machine.
 * All domain operations are injected via port interfaces or concrete defaults.
 *
 * The orchestrator:
 *   1. Uses the state machine for lifecycle management
 *   2. Creates an isolated workspace sandbox
 *   3. Runs analysis → planning → staging → evaluation → diagnosis loops
 *   4. Produces audit receipts
 *   5. Never touches production without approval
 */

import { applyMigrationPlan, type PatchReport } from './patching-engine.js';
import { MigrationStateMachine } from './state-machine.js';
import { WorkspaceSandbox } from './workspace-sandbox.js';
import { analyzeRepository } from './repository-analyzer.js';
import { generateMigrationPlan } from './migration-planner.js';
import { runEvaluation } from './evaluation/index.js';
import { diagnoseFailures } from './failure-diagnostician.js';
import {
  InvalidTransitionError,
  NoPrecedingProfileError,
  NoPrecedingEvaluationError,
  RemediationExhaustedError,
} from './errors.js';
import type {
  SessionId,
  MigrationSession,
  RepositoryProfile,
  MigrationPlan,
  EvaluationReport,
  FailureDiagnosis,
  AuditReceipt,
} from './types.js';
import type {
  AnalyzerPort,
  PlannerPort,
  EvaluatorPort,
  DiagnosticsPort,
  SandboxPort,
  ObservabilityPort,
} from './ports.js';

// ─── Orchestrator Events ─────────────────────────────────────────────────────

export type OrchestratorEvent =
  | { type: 'state_change'; from: string; to: string; action: string }
  | { type: 'inspection_complete'; profile: RepositoryProfile }
  | { type: 'plan_ready'; plan: MigrationPlan }
  | { type: 'sandbox_created'; sandboxPath: string }
  | { type: 'evaluation_complete'; report: EvaluationReport }
  | { type: 'diagnosis_complete'; diagnosis: FailureDiagnosis }
  | { type: 'approval_required'; canaryId: string; details: Record<string, unknown> }
  | { type: 'migration_complete'; receipt: AuditReceipt }
  | { type: 'migration_failed'; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type EventHandler = (event: OrchestratorEvent) => void;

// ─── Orchestrator Ports (Principle #3: Dependency Inversion) ─────────────────

/** Injectable dependencies for the orchestrator */
export interface OrchestratorPorts {
  /** Repository analyzer (default: built-in analyzeRepository) */
  analyzer?: AnalyzerPort;
  /** Migration planner (default: built-in generateMigrationPlan) */
  planner?: PlannerPort;
  /** Evaluation engine (default: built-in runEvaluation) */
  evaluator?: EvaluatorPort;
  /** Failure diagnostician (default: built-in diagnoseFailures) */
  diagnostician?: DiagnosticsPort;
  /** Observability sink */
  observer?: ObservabilityPort;
}

// ─── Orchestrator Options ────────────────────────────────────────────────────

export interface OrchestratorOptions {
  repositoryPath: string;
  sourceModel: string;
  targetModel: string;
  /** Port for the sandboxed application */
  sandboxPort?: number;
  /** Maximum remediation rounds before abort */
  maxRemediationRounds?: number;
  /** Quality threshold for evaluation pass */
  qualityThreshold?: number;
  /** Latency p95 threshold in ms */
  latencyThresholdMs?: number;
  /** Baseline cost per 1k requests */
  baselineCostPer1k?: number;
  /** Optional schema validator */
  schemaValidator?: (schema: Record<string, unknown>, payload: unknown) => boolean;
  /** Event handler for progress reporting */
  onEvent?: EventHandler;
  /** Sandbox root directory */
  sandboxRoot?: string;
  /** Whether to auto-approve production changes (test/demo mode only) */
  autoApprove?: boolean;
  /** Application startup command (default: node --import tsx src/index.ts) */
  appStartCommand?: string;
  /** Application health check path */
  healthCheckPath?: string;
  /** Injectable port implementations (Principle #3) */
  ports?: OrchestratorPorts;
}

// ─── Default Port Adapters (Principle #2: Ports & Adapters) ──────────────────

const defaultAnalyzer: AnalyzerPort = {
  analyze: (repoPath) => analyzeRepository(repoPath),
};

const defaultPlanner: PlannerPort = {
  generatePlan: (input) => generateMigrationPlan(input),
};

const defaultEvaluator: EvaluatorPort = {
  evaluate: (opts) => runEvaluation(opts),
};

const defaultDiagnostician: DiagnosticsPort = {
  diagnose: (input) => diagnoseFailures(input),
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class MigrationOrchestrator {
  private machine: MigrationStateMachine;
  private sandbox: WorkspaceSandbox | null = null;
  private options: Required<OrchestratorOptions>;

  // Resolved port implementations
  private readonly analyzer: AnalyzerPort;
  private readonly planner: PlannerPort;
  private readonly evaluator: EvaluatorPort;
  private readonly diagnostician: DiagnosticsPort;

  constructor(opts: OrchestratorOptions) {
    this.options = {
      repositoryPath: opts.repositoryPath,
      sourceModel: opts.sourceModel,
      targetModel: opts.targetModel,
      sandboxPort: opts.sandboxPort ?? 8955,
      maxRemediationRounds: opts.maxRemediationRounds ?? 3,
      qualityThreshold: opts.qualityThreshold ?? 0.90,
      latencyThresholdMs: opts.latencyThresholdMs ?? 600,
      baselineCostPer1k: opts.baselineCostPer1k ?? 1.85,
      schemaValidator: opts.schemaValidator ?? undefined as any,
      onEvent: opts.onEvent ?? (() => {}),
      sandboxRoot: opts.sandboxRoot ?? '',
      autoApprove: opts.autoApprove ?? false,
      appStartCommand: opts.appStartCommand ?? 'node --import tsx src/index.ts',
      healthCheckPath: opts.healthCheckPath ?? '/health',
      ports: opts.ports ?? {},
    };

    // Resolve ports: injected or default (Principle #3)
    this.analyzer = opts.ports?.analyzer ?? defaultAnalyzer;
    this.planner = opts.ports?.planner ?? defaultPlanner;
    this.evaluator = opts.ports?.evaluator ?? defaultEvaluator;
    this.diagnostician = opts.ports?.diagnostician ?? defaultDiagnostician;

    this.machine = new MigrationStateMachine({
      repositoryPath: opts.repositoryPath,
      sourceModel: opts.sourceModel,
      targetModel: opts.targetModel,
      maxRemediationRounds: this.options.maxRemediationRounds,
    });
  }

  get sessionId(): SessionId {
    return this.machine.sessionId;
  }

  get session(): Readonly<MigrationSession> {
    return this.machine.currentSession;
  }

  // ─── Step 1: Inspect ──────────────────────────────────────────────────

  async inspect(): Promise<RepositoryProfile> {
    this.emit({ type: 'log', level: 'info', message: 'Starting repository inspection...' });
    this.machine.startTimer();

    const event = this.machine.transition('inspecting', 'inspect_repository');
    this.emitStateChange(event);

    try {
      // Delegates to injected analyzer port (Principle #3)
      const profile = this.analyzer.analyze(this.options.repositoryPath);

      const completeEvent = this.machine.transition(
        'inspection_complete',
        'inspection_complete',
        { status: profile.status, references: profile.model_references.length },
      );
      this.emitStateChange(completeEvent);

      this.machine.setProfile(profile);

      this.emit({ type: 'inspection_complete', profile });
      this.emit({
        type: 'log',
        level: 'info',
        message: `Inspection complete: ${profile.detected_frameworks.map(f => f.name).join(', ')} | ${profile.model_references.length} references`,
      });

      return profile;
    } catch (err) {
      this.machine.transition('failed', 'inspection_failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ─── Step 2: Plan ─────────────────────────────────────────────────────

  async plan(previousDiagnosis?: FailureDiagnosis): Promise<MigrationPlan> {
    this.emit({ type: 'log', level: 'info', message: 'Generating migration plan...' });
    this.machine.startTimer();

    const event = this.machine.transition('planning', 'generate_plan');
    this.emitStateChange(event);

    try {
      const profile = this.machine.currentSession.profile;
      if (!profile) {
        throw new NoPrecedingProfileError(this.machine.sessionId);
      }

      // Delegates to injected planner port (Principle #3)
      const plan = this.planner.generatePlan({
        sessionId: this.machine.sessionId,
        profile,
        sourceModel: this.options.sourceModel,
        targetModel: this.options.targetModel,
        previousDiagnosis,
      });

      const readyEvent = this.machine.transition(
        'plan_ready',
        'plan_generated',
        { strategy: plan.strategy, changes: plan.changes.length },
      );
      this.emitStateChange(readyEvent);

      this.machine.setPlan(plan);

      this.emit({ type: 'plan_ready', plan });
      return plan;
    } catch (err) {
      if (!(err instanceof NoPrecedingProfileError)) {
        this.machine.transition('failed', 'planning_failed', { error: (err as Error).message });
      }
      throw err;
    }
  }

  // ─── Step 3: Stage in Sandbox ─────────────────────────────────────────

  async stage(): Promise<{ sandboxPath: string }> {
    this.emit({ type: 'log', level: 'info', message: 'Creating isolated workspace sandbox...' });
    this.machine.startTimer();

    const event = this.machine.transition('staging', 'create_sandbox');
    this.emitStateChange(event);

    try {
      const plan = this.machine.currentSession.plan;
      if (!plan) {
        throw new Error('Cannot stage without a migration plan');
      }

      // Create sandbox
      const sandboxOpts: any = {
        sessionId: this.machine.sessionId,
        sourcePath: this.options.repositoryPath,
      };
      if (this.options.sandboxRoot) {
        sandboxOpts.sandboxRoot = this.options.sandboxRoot;
      }
      this.sandbox = new WorkspaceSandbox(sandboxOpts);
      this.sandbox.initialize();

      // Apply code changes based on the plan
      this.applyPlanChanges(plan);

      const stagedEvent = this.machine.transition(
        'staged',
        'sandbox_staged',
        {
          sandbox_path: this.sandbox.sandboxPath,
          modified_files: this.sandbox.getManifest().modified_files,
        },
      );
      this.emitStateChange(stagedEvent);

      this.emit({ type: 'sandbox_created', sandboxPath: this.sandbox.sandboxPath });
      return { sandboxPath: this.sandbox.sandboxPath };
    } catch (err) {
      this.machine.transition('failed', 'staging_failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ─── Step 4: Evaluate ─────────────────────────────────────────────────

  async evaluate(candidateId: string): Promise<EvaluationReport> {
    this.emit({ type: 'log', level: 'info', message: `Running evaluation: ${candidateId}...` });
    this.machine.startTimer();

    const currentState = this.machine.state;
    const targetState = currentState === 'remediation_staged' ? 're_evaluating' : 'evaluating';

    const event = this.machine.transition(targetState, 'start_evaluation');
    this.emitStateChange(event);

    try {
      const endpointUrl = `http://127.0.0.1:${this.options.sandboxPort}/api/chat`;

      // Delegates to injected evaluator port (Principle #3)
      const report = await this.evaluator.evaluate({
        endpointUrl,
        candidateId,
        sessionId: this.machine.sessionId,
        qualityThreshold: this.options.qualityThreshold,
        latencyThresholdMs: this.options.latencyThresholdMs,
        baselineCostPer1k: this.options.baselineCostPer1k,
      });

      const completeState = targetState === 're_evaluating' ? 're_evaluation_complete' : 'evaluation_complete';
      const completeEvent = this.machine.transition(
        completeState,
        'evaluation_complete',
        { overall: report.overall, quality: report.quality.score, regressions: report.regressions.length },
      );
      this.emitStateChange(completeEvent);

      this.machine.addEvaluation(report);

      this.emit({ type: 'evaluation_complete', report });
      return report;
    } catch (err) {
      this.machine.transition('failed', 'evaluation_failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ─── Step 5: Diagnose ─────────────────────────────────────────────────

  async diagnose(): Promise<FailureDiagnosis> {
    this.emit({ type: 'log', level: 'info', message: 'Diagnosing evaluation failures...' });
    this.machine.startTimer();

    const event = this.machine.transition('diagnosing', 'start_diagnosis');
    this.emitStateChange(event);

    try {
      const latestEval = this.machine.latestEvaluation();
      if (!latestEval) {
        throw new NoPrecedingEvaluationError(this.machine.sessionId);
      }

      // Delegates to injected diagnostician port (Principle #3)
      const diagnosis = this.diagnostician.diagnose({
        sessionId: this.machine.sessionId,
        evaluationReport: latestEval,
      });

      const completeEvent = this.machine.transition(
        'diagnosis_complete',
        'diagnosis_complete',
        {
          category: diagnosis.primary_failure_category,
          strategy: diagnosis.recommended_strategy,
          confidence: diagnosis.confidence,
        },
      );
      this.emitStateChange(completeEvent);

      this.machine.addDiagnosis(diagnosis);

      this.emit({ type: 'diagnosis_complete', diagnosis });
      return diagnosis;
    } catch (err) {
      if (!(err instanceof NoPrecedingEvaluationError)) {
        this.machine.transition('failed', 'diagnosis_failed', { error: (err as Error).message });
      }
      throw err;
    }
  }

  // ─── Step 6: Remediate ────────────────────────────────────────────────

  async remediate(diagnosis: FailureDiagnosis): Promise<{ sandboxPath: string }> {
    this.emit({ type: 'log', level: 'info', message: `Applying remediation: ${diagnosis.recommended_strategy}...` });
    this.machine.startTimer();

    if (this.machine.isRemediationExhausted()) {
      const session = this.machine.currentSession;
      this.machine.transition('aborted', 'remediation_exhausted', {
        rounds: session.remediation_round,
        max: session.max_remediation_rounds,
      });
      throw new RemediationExhaustedError(
        this.machine.sessionId,
        session.remediation_round,
        session.max_remediation_rounds,
      );
    }

    const event = this.machine.transition('remediating', 'start_remediation');
    this.emitStateChange(event);

    try {
      // Re-plan with diagnosis via injected planner (Principle #3)
      const plan = this.planner.generatePlan({
        sessionId: this.machine.sessionId,
        profile: this.machine.currentSession.profile!,
        sourceModel: this.options.sourceModel,
        targetModel: this.options.targetModel,
        previousDiagnosis: diagnosis,
      });

      // Apply remediation changes to existing sandbox
      if (this.sandbox) {
        this.applyPlanChanges(plan);
      }

      const stagedEvent = this.machine.transition(
        'remediation_staged',
        'remediation_staged',
        { strategy: plan.strategy, changes: plan.changes.length },
      );
      this.emitStateChange(stagedEvent);

      return { sandboxPath: this.sandbox?.sandboxPath ?? '' };
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) {
        this.machine.transition('failed', 'remediation_failed', { error: (err as Error).message });
      }
      throw err;
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.sandbox) {
      this.sandbox.discard();
      this.sandbox = null;
    }
  }

  // ─── Receipt ──────────────────────────────────────────────────────────

  generateReceipt(): AuditReceipt {
    return this.machine.generateReceipt();
  }

  // ─── State Access ─────────────────────────────────────────────────────

  getSnapshot(): MigrationSession {
    return this.machine.toSnapshot();
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private applyPlanChanges(plan: MigrationPlan): PatchReport | null {
    if (!this.sandbox) return null;

    const profile = this.machine.currentSession.profile;
    if (!profile) return null;

    return applyMigrationPlan(this.sandbox, plan, profile);
  }

  private emit(event: OrchestratorEvent): void {
    this.options.onEvent(event);
  }

  private emitStateChange(event: { from_state: string; to_state: string; action: string }): void {
    this.emit({
      type: 'state_change',
      from: event.from_state,
      to: event.to_state,
      action: event.action,
    });
  }
}
