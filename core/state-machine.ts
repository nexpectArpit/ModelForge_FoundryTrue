/**
 * Migration State Machine
 *
 * Manages the durable lifecycle of a migration session. Every state transition
 * is validated against the allowed transition graph, timestamped, and transactionally
 * committed to the durable SQLite store (Node 22 node:sqlite).
 *
 * Design Invariants:
 *   1. Read durable state → validate transition → transactionally persist transition → append audit event.
 *   2. The process cannot claim a state transition that was not committed to SQLite.
 *   3. Domain artifacts (profile, plan, eval, diagnosis, canary) are durably committed
 *      to SQLite on every setter invocation.
 *   4. State can be reconstructed at any point from SQLite via MigrationStateMachine.fromStore().
 */

import {
  type MigrationSession,
  type MigrationState,
  type SessionEvent,
  type RepositoryProfile,
  type MigrationPlan,
  type EvaluationReport,
  type FailureDiagnosis,
  type CanaryPlan,
  type AuditReceipt,
  type SessionId,
  VALID_TRANSITIONS,
  createSessionId,
  createStepId,
} from './types.js';

import { DurableStateStore } from './durable-state.js';
import crypto from 'node:crypto';
import {
  InvalidTransitionError,
  SessionNotFoundError,
  InvalidStateForOperationError,
} from './errors.js';

// Re-export errors for backward compatibility
export { InvalidTransitionError, SessionNotFoundError } from './errors.js';

// ─── State Machine ───────────────────────────────────────────────────────────

export class MigrationStateMachine {
  private session: MigrationSession;
  private stepStartTime: number | null = null;
  private store: DurableStateStore;

  constructor(opts: {
    repositoryPath: string;
    sourceModel: string;
    targetModel: string;
    maxRemediationRounds?: number;
    sessionId?: SessionId;
    store?: DurableStateStore;
  }) {
    const sessionId = opts.sessionId ?? createSessionId();
    this.store = opts.store ?? new DurableStateStore({ inMemory: true });

    // Ensure session is durably registered in SQLite
    const durableRecord = this.store.createOrGetSession({
      sessionId,
      repositoryPath: opts.repositoryPath,
      sourceModel: opts.sourceModel,
      targetModel: opts.targetModel,
      maxRemediationRounds: opts.maxRemediationRounds ?? 3,
      initialState: 'initialized',
    });

    const transitions = this.store.getTransitions(sessionId);
    const evals = this.store.getEvaluationRuns(sessionId).map(e => JSON.parse(e.report_json) as EvaluationReport);

    this.session = {
      session_id: sessionId,
      state: durableRecord.state,
      created_at: durableRecord.created_at,
      updated_at: durableRecord.updated_at,
      repository_path: durableRecord.repository_path,
      source_model: durableRecord.source_model,
      target_model: durableRecord.target_model,
      profile: durableRecord.profile_json ? JSON.parse(durableRecord.profile_json) : null,
      plan: durableRecord.plan_json ? JSON.parse(durableRecord.plan_json) : null,
      evaluations: evals,
      diagnoses: durableRecord.latest_diagnosis_json ? [JSON.parse(durableRecord.latest_diagnosis_json)] : [],
      canary: durableRecord.canary_json ? JSON.parse(durableRecord.canary_json) : null,
      events: transitions,
      remediation_round: durableRecord.remediation_round,
      max_remediation_rounds: durableRecord.max_remediation_rounds,
    };
  }

  /** Restore directly from authoritative SQLite store */
  static fromStore(store: DurableStateStore, sessionId: SessionId): MigrationStateMachine {
    const record = store.getSession(sessionId);
    if (!record) {
      throw new SessionNotFoundError(sessionId);
    }

    const transitions = store.getTransitions(sessionId);
    const evals = store.getEvaluationRuns(sessionId).map(e => JSON.parse(e.report_json) as EvaluationReport);

    const session: MigrationSession = {
      session_id: record.session_id,
      state: record.state,
      created_at: record.created_at,
      updated_at: record.updated_at,
      repository_path: record.repository_path,
      source_model: record.source_model,
      target_model: record.target_model,
      profile: record.profile_json ? JSON.parse(record.profile_json) : null,
      plan: record.plan_json ? JSON.parse(record.plan_json) : null,
      evaluations: evals,
      diagnoses: record.latest_diagnosis_json ? [JSON.parse(record.latest_diagnosis_json)] : [],
      canary: record.canary_json ? JSON.parse(record.canary_json) : null,
      events: transitions,
      remediation_round: record.remediation_round,
      max_remediation_rounds: record.max_remediation_rounds,
    };

    const machine = Object.create(MigrationStateMachine.prototype) as MigrationStateMachine;
    machine.session = session;
    machine.store = store;
    machine.stepStartTime = null;
    return machine;
  }

  /** Restore from a serialized session (for backwards compatibility) */
  static fromSnapshot(snapshot: MigrationSession, store?: DurableStateStore): MigrationStateMachine {
    const durableStore = store ?? new DurableStateStore({ inMemory: true });
    durableStore.createOrGetSession({
      sessionId: snapshot.session_id,
      repositoryPath: snapshot.repository_path,
      sourceModel: snapshot.source_model,
      targetModel: snapshot.target_model,
      maxRemediationRounds: snapshot.max_remediation_rounds,
      initialState: snapshot.state,
    });

    if (snapshot.profile) {
      durableStore.saveProfile(snapshot.session_id, snapshot.profile);
    }
    if (snapshot.plan) {
      durableStore.savePlan(snapshot.session_id, snapshot.plan);
    }
    if (snapshot.canary) {
      durableStore.saveCanary(snapshot.session_id, snapshot.canary);
    }

    const machine = Object.create(MigrationStateMachine.prototype) as MigrationStateMachine;
    machine.session = { ...snapshot };
    machine.store = durableStore;
    machine.stepStartTime = null;
    return machine;
  }

  // ─── Accessors ───────────────────────────────────────────────────────────

  get sessionId(): SessionId {
    return this.session.session_id;
  }

  get state(): MigrationState {
    return this.session.state;
  }

  get currentSession(): Readonly<MigrationSession> {
    return this.session;
  }

  get events(): readonly SessionEvent[] {
    return this.session.events;
  }

  get durableStore(): DurableStateStore {
    return this.store;
  }

  // ─── State Transitions ──────────────────────────────────────────────────

  /**
   * Transition the session to a new state.
   *
   * Invariant: Reads current durable state from SQLite, validates transition graph,
   * transactionally commits the transition to SQLite, and updates in-memory state.
   *
   * @throws InvalidTransitionError if the transition is not allowed
   */
  transition(
    toState: MigrationState,
    action: string,
    payload: Record<string, unknown> | null = null,
  ): SessionEvent {
    // 1. Read current authoritative durable state from SQLite
    const currentDurable = this.store.getSession(this.session.session_id);
    const fromState = currentDurable ? currentDurable.state : this.session.state;

    // 2. Validate transition against canonical state graph
    const allowed = VALID_TRANSITIONS[fromState];
    if (!allowed.includes(toState)) {
      throw new InvalidTransitionError(fromState, toState);
    }

    const now = new Date().toISOString();
    const durationMs = this.stepStartTime
      ? Date.now() - this.stepStartTime
      : null;
    const stepId = createStepId(toState);

    // 3. Atomically persist transition and audit event to SQLite
    const event = this.store.recordStateTransition({
      sessionId: this.session.session_id,
      fromState,
      toState,
      action,
      payload,
      stepId,
      durationMs,
    });

    // 4. Update in-memory state only after successful SQLite commit
    this.session.state = toState;
    this.session.updated_at = now;
    this.session.events.push(event);
    this.stepStartTime = Date.now();

    return event;
  }

  /** Mark the start of a timed step */
  startTimer(): void {
    this.stepStartTime = Date.now();
  }

  // ─── Domain Data Setters ────────────────────────────────────────────────
  // Each setter validates state and transactionally commits domain artifacts to SQLite.

  setProfile(profile: RepositoryProfile): void {
    if (this.session.state !== 'inspection_complete') {
      throw new InvalidStateForOperationError('setProfile', this.session.state, ['inspection_complete']);
    }
    this.store.saveProfile(this.session.session_id, profile);
    this.session.profile = profile;
  }

  setPlan(plan: MigrationPlan): void {
    if (this.session.state !== 'plan_ready') {
      throw new InvalidStateForOperationError('setPlan', this.session.state, ['plan_ready']);
    }
    this.store.savePlan(this.session.session_id, plan);
    this.session.plan = plan;
  }

  addEvaluation(report: EvaluationReport): void {
    if (
      this.session.state !== 'evaluation_complete' &&
      this.session.state !== 're_evaluation_complete'
    ) {
      throw new InvalidStateForOperationError('addEvaluation', this.session.state, ['evaluation_complete', 're_evaluation_complete']);
    }
    this.store.recordEvaluation(this.session.session_id, report);
    this.session.evaluations.push(report);
  }

  addDiagnosis(diagnosis: FailureDiagnosis): void {
    if (this.session.state !== 'diagnosis_complete') {
      throw new InvalidStateForOperationError('addDiagnosis', this.session.state, ['diagnosis_complete']);
    }
    const nextRound = this.session.remediation_round + 1;
    this.store.recordDiagnosis(this.session.session_id, diagnosis);
    this.store.recordRemediationAttempt({
      sessionId: this.session.session_id,
      round: nextRound,
      strategy: diagnosis.recommended_strategy,
      diagnosis,
    });

    this.session.diagnoses.push(diagnosis);
    this.session.remediation_round = nextRound;
  }

  setCanary(canary: CanaryPlan): void {
    if (this.session.state !== 'canary_ready') {
      throw new InvalidStateForOperationError('setCanary', this.session.state, ['canary_ready']);
    }
    this.store.saveCanary(this.session.session_id, canary);
    this.session.canary = canary;
  }

  // ─── Query Helpers ──────────────────────────────────────────────────────

  /** Whether we've exceeded the allowed remediation rounds */
  isRemediationExhausted(): boolean {
    return this.session.remediation_round >= this.session.max_remediation_rounds;
  }

  /** Get the latest evaluation report */
  latestEvaluation(): EvaluationReport | null {
    const evals = this.session.evaluations;
    return evals.length > 0 ? evals[evals.length - 1] : null;
  }

  /** Get the latest diagnosis */
  latestDiagnosis(): FailureDiagnosis | null {
    const diags = this.session.diagnoses;
    return diags.length > 0 ? diags[diags.length - 1] : null;
  }

  /** Check if the session is in a terminal state */
  isTerminal(): boolean {
    return (
      this.session.state === 'completed' ||
      this.session.state === 'failed' ||
      this.session.state === 'aborted'
    );
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /** Serialize the full session state (for snapshots) */
  toSnapshot(): MigrationSession {
    return JSON.parse(JSON.stringify(this.session));
  }

  /** Generate the final immutable audit receipt */
  generateReceipt(): AuditReceipt {
    if (!this.isTerminal()) {
      throw new InvalidStateForOperationError('generateReceipt', this.session.state, ['completed', 'failed', 'aborted']);
    }

    const lastEval = this.latestEvaluation();
    const s = this.session;

    const receiptData = {
      contract_version: '2.0' as const,
      session_id: s.session_id,
      outcome: s.state as 'completed' | 'failed' | 'aborted',
      started_at: s.created_at,
      ended_at: s.updated_at,
      total_duration_ms: Date.parse(s.updated_at) - Date.parse(s.created_at),
      repository_name: s.profile?.repository_name ?? 'unknown',
      source_model: s.source_model,
      target_model: s.target_model,
      final_strategy: s.plan?.strategy ?? null,
      total_evaluation_rounds: s.evaluations.length,
      total_remediation_rounds: s.remediation_round,
      final_quality_score: lastEval?.quality.score ?? null,
      final_latency_p95_ms: lastEval?.latency.p95_ms ?? null,
      final_cost_savings_pct: lastEval?.cost.savings_pct ?? null,
      canary_id: s.canary?.canary_id ?? null,
      manifest_sha: s.canary?.manifest_sha ?? null,
      events: s.events,
      receipt_sha: '', // Placeholder — filled below
    };

    // Compute tamper-evident SHA of the receipt (excluding receipt_sha itself)
    const { receipt_sha: _, ...hashable } = receiptData;
    receiptData.receipt_sha = crypto
      .createHash('sha256')
      .update(JSON.stringify(hashable))
      .digest('hex');

    // Audit event for receipt creation
    this.store.recordAuditEvent({
      sessionId: s.session_id,
      action: 'audit_receipt_generated',
      actor: 'state_machine',
      details: {
        receipt_sha: receiptData.receipt_sha,
        outcome: receiptData.outcome,
        total_duration_ms: receiptData.total_duration_ms,
      },
    });

    return receiptData;
  }
}
