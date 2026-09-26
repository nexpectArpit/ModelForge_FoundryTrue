/**
 * Durable SQLite State Store for ModelForge
 *
 * Implements crash-resilient persistence architecture for the migration lifecycle.
 *
 * Design Invariants:
 *   1. Built on Node 22 native `node:sqlite` (DatabaseSync). Zero external native deps.
 *   2. Write-Ahead Logging (WAL mode) with FULL synchronous commits and foreign keys.
 *   3. All state transitions, sandbox staging, and audit logging happen within
 *      atomic SQLite transactions (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`).
 *   4. Operations have deterministic/idempotent identifiers to prevent competing
 *      mutations during retries.
 *   5. Restarts reconcile incomplete/in-flight operations rather than blindly resetting.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  type SessionId,
  type MigrationState,
  type RepositoryProfile,
  type MigrationPlan,
  type EvaluationReport,
  type FailureDiagnosis,
  type CanaryPlan,
  type SessionEvent,
  type MigrationStepId,
  type DurableSessionRecord,
  type DurableSandboxOperation,
  type DurableEvaluationRecord,
  type DurableAuditEvent,
  type RestartReconciliation,
  type ReconciliationStatus,
  createStepId,
} from './types.js';

export interface DurableStateOptions {
  /** Database file path. Defaults to .modelforge/state.sqlite in CWD */
  dbPath?: string;
  /** In-memory mode (primarily for tests) */
  inMemory?: boolean;
}

export class DurableStateStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(options: DurableStateOptions = {}) {
    if (options.inMemory) {
      this.dbPath = ':memory:';
      this.db = new DatabaseSync(':memory:');
    } else {
      const defaultPath = path.resolve(
        process.env.MODELFORGE_STATE_PATH ?? path.join(process.cwd(), '.modelforge', 'state.sqlite'),
      );
      this.dbPath = options.dbPath ?? defaultPath;
      const dir = path.dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(this.dbPath);
    }

    this.initializePragmasAndSchema();
  }

  get databasePath(): string {
    return this.dbPath;
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  private initializePragmasAndSchema(): void {
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = FULL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    // 1. Migration Sessions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_model TEXT NOT NULL,
        target_model TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        remediation_round INTEGER NOT NULL DEFAULT 0,
        max_remediation_rounds INTEGER NOT NULL DEFAULT 3,
        profile_json TEXT,
        plan_json TEXT,
        latest_eval_id TEXT,
        latest_diagnosis_json TEXT,
        canary_id TEXT,
        canary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // 2. State Transitions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        step_id TEXT,
        FOREIGN KEY (session_id) REFERENCES migration_sessions(session_id) ON DELETE CASCADE
      );
    `);

    // 3. Sandbox Operations (Prepare-Before-Apply tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        sandbox_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        modified_files_json TEXT NOT NULL DEFAULT '[]',
        file_hashes_json TEXT NOT NULL DEFAULT '{}',
        preconditions_json TEXT NOT NULL DEFAULT '[]',
        diffs_json TEXT NOT NULL DEFAULT '{}',
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES migration_sessions(session_id) ON DELETE CASCADE
      );
    `);

    // 4. Evaluation Runs (Deterministic benchmark evidence)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        eval_run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        test_suite_id TEXT NOT NULL,
        overall TEXT NOT NULL,
        quality_score REAL NOT NULL,
        latency_p95_ms INTEGER NOT NULL,
        cost_per_1k REAL NOT NULL,
        passed_cases INTEGER NOT NULL,
        total_cases INTEGER NOT NULL,
        regressions_json TEXT NOT NULL DEFAULT '[]',
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES migration_sessions(session_id) ON DELETE CASCADE
      );
    `);

    // 5. Remediation Attempts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remediation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        diagnosis_json TEXT NOT NULL,
        plan_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES migration_sessions(session_id) ON DELETE CASCADE
      );
    `);

    // 6. Domain Audit Events (Strict sequence-numbered ledger)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES migration_sessions(session_id) ON DELETE CASCADE
      );
    `);
  }

  // ─── Transaction Helper ──────────────────────────────────────────────────────

  private inTx = false;

  transaction<T>(fn: () => T): T {
    if (this.inTx) {
      return fn();
    }

    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback errors if already aborted
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // ─── Session Operations ──────────────────────────────────────────────────────

  createOrGetSession(params: {
    sessionId: string;
    repositoryPath: string;
    sourceModel: string;
    targetModel: string;
    maxRemediationRounds?: number;
    initialState?: MigrationState;
  }): DurableSessionRecord {
    return this.transaction(() => {
      const existing = this.getSession(params.sessionId);
      if (existing) return existing;

      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO migration_sessions (
          session_id, state, source_model, target_model, repository_path,
          remediation_round, max_remediation_rounds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      `);

      const initState = params.initialState ?? 'initialized';
      stmt.run(
        params.sessionId,
        initState,
        params.sourceModel,
        params.targetModel,
        params.repositoryPath,
        params.maxRemediationRounds ?? 3,
        now,
        now,
      );

      this.recordAuditEvent({
        sessionId: params.sessionId,
        action: 'session_created',
        actor: 'modelforge_system',
        details: {
          repository_path: params.repositoryPath,
          source_model: params.sourceModel,
          target_model: params.targetModel,
          initial_state: initState,
        },
      });

      return this.getSession(params.sessionId)!;
    });
  }

  getSession(sessionId: string): DurableSessionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM migration_sessions WHERE session_id = ?
    `);
    const row = stmt.get(sessionId) as any;
    if (!row) return null;

    return {
      session_id: row.session_id,
      state: row.state as MigrationState,
      source_model: row.source_model,
      target_model: row.target_model,
      repository_path: row.repository_path,
      remediation_round: Number(row.remediation_round),
      max_remediation_rounds: Number(row.max_remediation_rounds),
      profile_json: row.profile_json,
      plan_json: row.plan_json,
      latest_eval_id: row.latest_eval_id,
      latest_diagnosis_json: row.latest_diagnosis_json,
      canary_id: row.canary_id,
      canary_json: row.canary_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getAllSessions(): DurableSessionRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM migration_sessions ORDER BY created_at DESC`);
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      session_id: row.session_id,
      state: row.state as MigrationState,
      source_model: row.source_model,
      target_model: row.target_model,
      repository_path: row.repository_path,
      remediation_round: Number(row.remediation_round),
      max_remediation_rounds: Number(row.max_remediation_rounds),
      profile_json: row.profile_json,
      plan_json: row.plan_json,
      latest_eval_id: row.latest_eval_id,
      latest_diagnosis_json: row.latest_diagnosis_json,
      canary_id: row.canary_id,
      canary_json: row.canary_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  // ─── State Transitions (Atomic Unit of Work) ─────────────────────────────────

  recordStateTransition(params: {
    sessionId: string;
    fromState: MigrationState;
    toState: MigrationState;
    action: string;
    payload?: Record<string, unknown> | null;
    stepId?: string;
    durationMs?: number | null;
  }): SessionEvent {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const payloadStr = params.payload ? JSON.stringify(params.payload) : null;
      const stepId = params.stepId ?? createStepId(params.toState);

      // 1. Update session state
      const updateStmt = this.db.prepare(`
        UPDATE migration_sessions
        SET state = ?, updated_at = ?
        WHERE session_id = ?
      `);
      updateStmt.run(params.toState, now, params.sessionId);

      // 2. Append transition
      const transitionStmt = this.db.prepare(`
        INSERT INTO state_transitions (
          session_id, from_state, to_state, action, payload_json, timestamp, duration_ms, step_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      transitionStmt.run(
        params.sessionId,
        params.fromState,
        params.toState,
        params.action,
        payloadStr,
        now,
        params.durationMs ?? null,
        stepId,
      );

      // 3. Append audit event
      this.recordAuditEvent({
        sessionId: params.sessionId,
        action: `state_transition:${params.action}`,
        actor: 'state_machine',
        details: {
          from_state: params.fromState,
          to_state: params.toState,
          step_id: stepId,
          duration_ms: params.durationMs ?? null,
          payload: params.payload ?? null,
        },
      });

      return {
        step_id: stepId as MigrationStepId,
        timestamp: now,
        from_state: params.fromState,
        to_state: params.toState,
        action: params.action,
        payload: params.payload ?? null,
        duration_ms: params.durationMs ?? null,
      };
    });
  }

  getTransitions(sessionId: string): SessionEvent[] {
    const stmt = this.db.prepare(`
      SELECT step_id, timestamp, from_state, to_state, action, payload_json, duration_ms
      FROM state_transitions
      WHERE session_id = ?
      ORDER BY id ASC
    `);
    const rows = stmt.all(sessionId) as any[];
    return rows.map(r => ({
      step_id: (r.step_id || createStepId(r.to_state)) as MigrationStepId,
      timestamp: r.timestamp,
      from_state: r.from_state as MigrationState,
      to_state: r.to_state as MigrationState,
      action: r.action,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      duration_ms: r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : null,
    }));
  }

  saveProfile(sessionId: string, profile: RepositoryProfile): void {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE migration_sessions
        SET profile_json = ?, updated_at = ?
        WHERE session_id = ?
      `);
      stmt.run(JSON.stringify(profile), new Date().toISOString(), sessionId);

      this.recordAuditEvent({
        sessionId,
        action: 'repository_profile_saved',
        actor: 'repository_analyzer',
        details: {
          status: profile.status,
          frameworks: profile.detected_frameworks?.map(f => f.name) ?? [],
          references_count: profile.model_references?.length ?? 0,
          tool_schemas_count: profile.tool_schemas?.length ?? 0,
        },
      });
    });
  }

  savePlan(sessionId: string, plan: MigrationPlan): void {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE migration_sessions
        SET plan_json = ?, updated_at = ?
        WHERE session_id = ?
      `);
      stmt.run(JSON.stringify(plan), new Date().toISOString(), sessionId);

      this.recordAuditEvent({
        sessionId,
        action: 'migration_plan_saved',
        actor: 'migration_planner',
        details: {
          strategy: plan.strategy,
          changes_count: plan.changes?.length ?? 0,
          risk: plan.risk_assessment,
        },
      });
    });
  }

  // ─── Sandbox Operations (Prepare-Before-Apply Invariant) ──────────────────────

  reserveSandboxOperation(params: {
    operationId: string;
    sessionId: string;
    sandboxPath: string;
    sourcePath: string;
  }): { mode: 'execute' | 'recover' | 'already_applied'; operation: DurableSandboxOperation } {
    return this.transaction(() => {
      const existingStmt = this.db.prepare(`
        SELECT * FROM sandbox_operations WHERE operation_id = ?
      `);
      const existing = existingStmt.get(params.operationId) as any;

      if (existing) {
        const op = this.hydrateSandboxOperation(existing);
        if (op.status === 'applied') {
          return { mode: 'already_applied', operation: op };
        }
        if (op.status === 'prepared' || op.status === 'reserved') {
          return { mode: 'recover', operation: op };
        }
        return { mode: 'execute', operation: op };
      }

      // Check if there is already an active operation for this session
      const activeStmt = this.db.prepare(`
        SELECT * FROM sandbox_operations
        WHERE session_id = ? AND status IN ('reserved', 'prepared')
      `);
      const active = activeStmt.get(params.sessionId) as any;
      if (active) {
        return { mode: 'recover', operation: this.hydrateSandboxOperation(active) };
      }

      const now = new Date().toISOString();
      const insertStmt = this.db.prepare(`
        INSERT INTO sandbox_operations (
          operation_id, session_id, status, owner_pid, attempt,
          sandbox_path, source_path, created_at, updated_at
        ) VALUES (?, ?, 'reserved', ?, 1, ?, ?, ?, ?)
      `);

      insertStmt.run(
        params.operationId,
        params.sessionId,
        process.pid,
        params.sandboxPath,
        params.sourcePath,
        now,
        now,
      );

      this.recordAuditEvent({
        sessionId: params.sessionId,
        action: 'sandbox_operation_reserved',
        actor: 'sandbox_manager',
        details: {
          operation_id: params.operationId,
          sandbox_path: params.sandboxPath,
        },
      });

      return {
        mode: 'execute',
        operation: this.getSandboxOperation(params.operationId)!,
      };
    });
  }

  checkpointPreparedSandbox(params: {
    operationId: string;
    modifiedFiles: string[];
    fileHashes: Record<string, { original: string; modified: string }>;
    diffs?: Record<string, string>;
  }): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE sandbox_operations
        SET status = 'prepared',
            modified_files_json = ?,
            file_hashes_json = ?,
            diffs_json = ?,
            updated_at = ?
        WHERE operation_id = ?
      `);

      stmt.run(
        JSON.stringify(params.modifiedFiles),
        JSON.stringify(params.fileHashes),
        JSON.stringify(params.diffs ?? {}),
        now,
        params.operationId,
      );

      const op = this.getSandboxOperation(params.operationId);
      if (op) {
        this.recordAuditEvent({
          sessionId: op.session_id,
          action: 'sandbox_operation_prepared',
          actor: 'sandbox_manager',
          details: {
            operation_id: params.operationId,
            modified_count: params.modifiedFiles.length,
          },
        });
      }
    });
  }

  checkpointAppliedSandbox(operationId: string): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE sandbox_operations
        SET status = 'applied', updated_at = ?
        WHERE operation_id = ?
      `);
      stmt.run(now, operationId);

      const op = this.getSandboxOperation(operationId);
      if (op) {
        this.recordAuditEvent({
          sessionId: op.session_id,
          action: 'sandbox_operation_applied',
          actor: 'sandbox_manager',
          details: { operation_id: operationId },
        });
      }
    });
  }

  getSandboxOperation(operationId: string): DurableSandboxOperation | null {
    const stmt = this.db.prepare(`SELECT * FROM sandbox_operations WHERE operation_id = ?`);
    const row = stmt.get(operationId) as any;
    if (!row) return null;
    return this.hydrateSandboxOperation(row);
  }

  private hydrateSandboxOperation(row: any): DurableSandboxOperation {
    return {
      operation_id: row.operation_id,
      session_id: row.session_id,
      status: row.status,
      owner_pid: Number(row.owner_pid),
      attempt: Number(row.attempt),
      sandbox_path: row.sandbox_path,
      source_path: row.source_path,
      modified_files_json: row.modified_files_json,
      file_hashes_json: row.file_hashes_json,
      preconditions_json: row.preconditions_json,
      diffs_json: row.diffs_json,
      failure_message: row.failure_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ─── Evaluation Runs (Immutable Evidence Ledger) ─────────────────────────────

  recordEvaluation(sessionId: string, report: EvaluationReport): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO evaluation_runs (
          eval_run_id, session_id, candidate_id, test_suite_id, overall,
          quality_score, latency_p95_ms, cost_per_1k, passed_cases, total_cases,
          regressions_json, report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const evalRunId = report.eval_run_id ?? `eval-${Date.now()}`;
      stmt.run(
        evalRunId,
        sessionId,
        report.candidate_id ?? 'candidate',
        report.test_suite_id ?? 'suite',
        report.overall ?? 'FAIL',
        report.quality?.score ?? 0,
        report.latency?.p95_ms ?? 0,
        report.cost?.estimated_cost_per_1k_req ?? 0,
        report.passed_cases ?? 0,
        report.total_cases ?? 0,
        JSON.stringify(report.regressions ?? []),
        JSON.stringify(report),
        now,
      );

      // Update session pointer
      const sessionStmt = this.db.prepare(`
        UPDATE migration_sessions
        SET latest_eval_id = ?, updated_at = ?
        WHERE session_id = ?
      `);
      sessionStmt.run(evalRunId, now, sessionId);

      this.recordAuditEvent({
        sessionId,
        action: 'evaluation_run_recorded',
        actor: 'evaluation_engine',
        details: {
          eval_run_id: evalRunId,
          candidate_id: report.candidate_id ?? 'candidate',
          overall: report.overall ?? 'FAIL',
          quality_score: report.quality?.score ?? 0,
          latency_p95_ms: report.latency?.p95_ms ?? 0,
          regressions_count: report.regressions?.length ?? 0,
        },
      });
    });
  }

  getEvaluationRuns(sessionId: string): DurableEvaluationRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM evaluation_runs WHERE session_id = ? ORDER BY created_at ASC
    `);
    const rows = stmt.all(sessionId) as any[];
    return rows.map(r => ({
      eval_run_id: r.eval_run_id,
      session_id: r.session_id,
      candidate_id: r.candidate_id,
      test_suite_id: r.test_suite_id,
      overall: r.overall,
      quality_score: Number(r.quality_score),
      latency_p95_ms: Number(r.latency_p95_ms),
      cost_per_1k: Number(r.cost_per_1k),
      passed_cases: Number(r.passed_cases),
      total_cases: Number(r.total_cases),
      regressions_json: r.regressions_json,
      report_json: r.report_json,
      created_at: r.created_at,
    }));
  }

  // ─── Diagnosis & Remediation ─────────────────────────────────────────────────

  recordDiagnosis(sessionId: string, diagnosis: FailureDiagnosis): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE migration_sessions
        SET latest_diagnosis_json = ?, updated_at = ?
        WHERE session_id = ?
      `);
      stmt.run(JSON.stringify(diagnosis), now, sessionId);

      this.recordAuditEvent({
        sessionId,
        action: 'failure_diagnosis_recorded',
        actor: 'failure_diagnostician',
        details: {
          category: diagnosis.primary_failure_category,
          recommended_strategy: diagnosis.recommended_strategy,
          confidence: diagnosis.confidence,
        },
      });
    });
  }

  recordRemediationAttempt(params: {
    sessionId: string;
    round: number;
    strategy: string;
    diagnosis: FailureDiagnosis;
    plan?: MigrationPlan;
  }): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO remediation_attempts (
          session_id, round, strategy, diagnosis_json, plan_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        params.sessionId,
        params.round,
        params.strategy,
        JSON.stringify(params.diagnosis),
        params.plan ? JSON.stringify(params.plan) : null,
        now,
      );

      // Increment round on session
      const sessionStmt = this.db.prepare(`
        UPDATE migration_sessions
        SET remediation_round = ?, updated_at = ?
        WHERE session_id = ?
      `);
      sessionStmt.run(params.round, now, params.sessionId);

      this.recordAuditEvent({
        sessionId: params.sessionId,
        action: 'remediation_attempt_recorded',
        actor: 'remediation_engine',
        details: {
          round: params.round,
          strategy: params.strategy,
        },
      });
    });
  }

  // ─── Audit Events (Strict Sequence-Numbered Ledger) ──────────────────────────

  recordAuditEvent(params: {
    sessionId: string;
    action: string;
    actor: string;
    details: Record<string, unknown>;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO domain_audit_events (session_id, timestamp, action, actor, details_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      params.sessionId,
      new Date().toISOString(),
      params.action,
      params.actor,
      JSON.stringify(params.details),
    );
  }

  getAuditEvents(sessionId: string): DurableAuditEvent[] {
    const stmt = this.db.prepare(`
      SELECT sequence, session_id, timestamp, action, actor, details_json
      FROM domain_audit_events
      WHERE session_id = ?
      ORDER BY sequence ASC
    `);
    const rows = stmt.all(sessionId) as any[];
    return rows.map(r => ({
      sequence: Number(r.sequence),
      session_id: r.session_id,
      timestamp: r.timestamp,
      action: r.action,
      actor: r.actor,
      details_json: r.details_json,
    }));
  }

  saveCanary(sessionId: string, canary: CanaryPlan): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE migration_sessions
        SET canary_id = ?, canary_json = ?, updated_at = ?
        WHERE session_id = ?
      `);
      stmt.run(canary.canary_id, JSON.stringify(canary), now, sessionId);

      this.recordAuditEvent({
        sessionId,
        action: 'canary_plan_saved',
        actor: 'canary_manager',
        details: {
          canary_id: canary.canary_id,
          manifest_sha: canary.manifest_sha,
        },
      });
    });
  }

  // ─── Direct SQL Execution (for test resets / maintenance) ───────────────────

  exec(sql: string): void {
    this.db.exec(sql);
  }

  // ─── A4. Restart Recovery & Reconciliation ───────────────────────────────────

  /**
   * Reconcile an interrupted session after a process crash or restart.
   *
   * Traces durable session state and active sandbox operations to determine:
   *   - `safely_resumable`: sandbox is intact and ready to continue
   *   - `already_completed`: terminal success state reached
   *   - `incomplete_ambiguous`: mid-mutation crash needing re-staging
   *   - `requires_operator_intervention`: destructive anomaly
   */
  reconcileRestart(sessionId: string): RestartReconciliation {
    const session = this.getSession(sessionId);
    if (!session) {
      return {
        session_id: sessionId,
        status: 'requires_operator_intervention',
        resumable_state: 'failed',
        reason: `Session "${sessionId}" not found in durable store`,
        active_sandbox_path: null,
        recommended_action: 'inspect',
      };
    }

    // Terminal states
    if (session.state === 'completed') {
      return {
        session_id: sessionId,
        status: 'already_completed',
        resumable_state: session.state,
        reason: `Session already reached terminal state "${session.state}"`,
        active_sandbox_path: null,
        recommended_action: 'inspect',
      };
    }

    if (session.state === 'aborted' || session.state === 'failed') {
      return {
        session_id: sessionId,
        status: 'already_completed',
        resumable_state: session.state,
        reason: `Session concluded in terminal failure state "${session.state}"`,
        active_sandbox_path: null,
        recommended_action: 'inspect',
      };
    }

    // Check active sandbox operations
    const opStmt = this.db.prepare(`
      SELECT * FROM sandbox_operations
      WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
    `);
    const lastOpRow = opStmt.get(sessionId) as any;

    if (!lastOpRow) {
      // No sandbox mutation started yet
      if (session.state === 'initialized' || session.state === 'inspecting' || session.state === 'inspection_complete' || session.state === 'planning' || session.state === 'plan_ready') {
        return {
          session_id: sessionId,
          status: 'safely_resumable',
          resumable_state: session.state,
          reason: `Session was in pre-mutation state "${session.state}" with zero sandbox side-effects`,
          active_sandbox_path: null,
          recommended_action: 'resume',
        };
      }
    }

    const lastOp = lastOpRow ? this.hydrateSandboxOperation(lastOpRow) : null;
    const sandboxExists = lastOp && existsSync(lastOp.sandbox_path);

    // If session was evaluating or diagnosing and sandbox is intact
    if (
      (session.state === 'evaluating' ||
       session.state === 'evaluation_complete' ||
       session.state === 'diagnosing' ||
       session.state === 'diagnosis_complete' ||
       session.state === 'staged' ||
       session.state === 'remediation_staged') &&
      sandboxExists
    ) {
      return {
        session_id: sessionId,
        status: 'safely_resumable',
        resumable_state: session.state,
        reason: `Sandbox at "${lastOp!.sandbox_path}" is intact and session state "${session.state}" can resume`,
        active_sandbox_path: lastOp!.sandbox_path,
        recommended_action: 'resume',
      };
    }

    // Mid-staging crash or sandbox deleted
    if (!sandboxExists && (session.state === 'staging' || session.state === 'remediating')) {
      return {
        session_id: sessionId,
        status: 'incomplete_ambiguous',
        resumable_state: session.state === 'remediating' ? 'diagnosis_complete' : 'plan_ready',
        reason: `Process crashed during sandbox mutation and sandbox directory is missing or unverified`,
        active_sandbox_path: null,
        recommended_action: 're_stage',
      };
    }

    return {
      session_id: sessionId,
      status: 'requires_operator_intervention',
      resumable_state: session.state,
      reason: `Ambiguous state "${session.state}" requires operator review`,
      active_sandbox_path: lastOp?.sandbox_path ?? null,
      recommended_action: 'inspect',
    };
  }

  // ─── Lifecycle / Cleanup ─────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
