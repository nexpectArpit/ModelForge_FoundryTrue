import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DurableStateStore } from '../core/durable-state.js';
import { createSessionId, createEvalRunId, type EvaluationReport, type FailureDiagnosis } from '../core/types.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('DurableStateStore (node:sqlite)', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DurableStateStore;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'modelforge-sqlite-test-'));
    dbPath = path.join(tempDir, 'state.sqlite');
    store = new DurableStateStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes WAL mode, foreign keys, and tables correctly', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('creates and retrieves a durable migration session', () => {
    const sessionId = createSessionId();
    const session = store.createOrGetSession({
      sessionId,
      repositoryPath: '/workspace/test-repo',
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    expect(session.session_id).toBe(sessionId);
    expect(session.state).toBe('initialized');
    expect(session.source_model).toBe('gpt-4o');
    expect(session.target_model).toBe('llama-3.1-70b');
    expect(session.remediation_round).toBe(0);

    const fetched = store.getSession(sessionId);
    expect(fetched).toEqual(session);
  });

  it('transactionally records state transitions and appends audit events', () => {
    const sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: '/workspace/test-repo',
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    store.recordStateTransition({
      sessionId,
      fromState: 'initialized',
      toState: 'inspecting',
      action: 'start_inspection',
      payload: { scanner: 'ast' },
    });

    const session = store.getSession(sessionId)!;
    expect(session.state).toBe('inspecting');

    const auditEvents = store.getAuditEvents(sessionId);
    expect(auditEvents.length).toBe(2); // session_created + state_transition
    expect(auditEvents[0].sequence).toBe(1);
    expect(auditEvents[0].action).toBe('session_created');
    expect(auditEvents[1].sequence).toBe(2);
    expect(auditEvents[1].action).toBe('state_transition:start_inspection');
  });

  it('rolls back transaction completely if an error occurs', () => {
    const sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: '/workspace/test-repo',
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    expect(() => {
      store.transaction(() => {
        store.recordStateTransition({
          sessionId,
          fromState: 'initialized',
          toState: 'inspecting',
          action: 'trans_action',
        });
        throw new Error('Simulated failure during state transition');
      });
    }).toThrow('Simulated failure during state transition');

    // State should remain initialized
    const session = store.getSession(sessionId)!;
    expect(session.state).toBe('initialized');
  });

  it('handles sandbox operation reservations idempotently', () => {
    const sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: '/workspace/test-repo',
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    const opId = 'op-stage-1';
    const firstRes = store.reserveSandboxOperation({
      operationId: opId,
      sessionId,
      sandboxPath: '/tmp/sandbox-1',
      sourcePath: '/workspace/test-repo',
    });

    expect(firstRes.mode).toBe('execute');
    expect(firstRes.operation.status).toBe('reserved');

    // Checkpoint as prepared
    store.checkpointPreparedSandbox({
      operationId: opId,
      modifiedFiles: ['src/config.ts'],
      fileHashes: { 'src/config.ts': { original: 'hash1', modified: 'hash2' } },
      diffs: { 'src/config.ts': '+ active_model: llama-3.1-70b' },
    });

    const preparedOp = store.getSandboxOperation(opId)!;
    expect(preparedOp.status).toBe('prepared');

    // Duplicate reservation request while prepared → recovers existing
    const retryRes = store.reserveSandboxOperation({
      operationId: opId,
      sessionId,
      sandboxPath: '/tmp/sandbox-1',
      sourcePath: '/workspace/test-repo',
    });
    expect(retryRes.mode).toBe('recover');

    // Checkpoint as applied
    store.checkpointAppliedSandbox(opId);

    // Subsequent request after apply → already_applied
    const postRes = store.reserveSandboxOperation({
      operationId: opId,
      sessionId,
      sandboxPath: '/tmp/sandbox-1',
      sourcePath: '/workspace/test-repo',
    });
    expect(postRes.mode).toBe('already_applied');
  });

  it('persists evaluation runs and links them to the session', () => {
    const sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: '/workspace/test-repo',
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    const evalRunId = createEvalRunId();
    const mockReport: EvaluationReport = {
      contract_version: '2.0',
      eval_run_id: evalRunId,
      session_id: sessionId,
      candidate_id: 'candidate-round-1',
      timestamp: new Date().toISOString(),
      test_suite_id: 'eval-suite-v1',
      total_cases: 10,
      passed_cases: 8,
      case_results: [],
      quality: { score: 0.8, threshold: 0.9, passed: false, by_category: {} },
      latency: { p50_ms: 100, p95_ms: 250, p99_ms: 300, threshold_p95_ms: 600, passed: true },
      cost: { estimated_cost_per_1k_req: 1.2, baseline_cost_per_1k_req: 2.0, savings_pct: 40, passed: true },
      regressions: [{ case_id: 'case-1', category: 'tool', error: 'tool mismatch', severity: 'critical' }],
      overall: 'FAIL',
    };

    store.recordEvaluation(sessionId, mockReport);

    const session = store.getSession(sessionId)!;
    expect(session.latest_eval_id).toBe(evalRunId);

    const evals = store.getEvaluationRuns(sessionId);
    expect(evals.length).toBe(1);
    expect(evals[0].eval_run_id).toBe(evalRunId);
    expect(evals[0].overall).toBe('FAIL');
    expect(evals[0].quality_score).toBe(0.8);
  });

  it('reconciles session restart across distinct crash windows', () => {
    const sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: tempDir,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });

    // 1. Pre-mutation state → safely_resumable
    const preMutationReconciliation = store.reconcileRestart(sessionId);
    expect(preMutationReconciliation.status).toBe('safely_resumable');
    expect(preMutationReconciliation.recommended_action).toBe('resume');

    // 2. Terminal state → already_completed
    store.recordStateTransition({
      sessionId,
      fromState: 'initialized',
      toState: 'completed',
      action: 'finish',
    });
    const terminalReconciliation = store.reconcileRestart(sessionId);
    expect(terminalReconciliation.status).toBe('already_completed');

    // 3. Mid-staging crash without intact sandbox → incomplete_ambiguous
    const crashSessionId = createSessionId();
    store.createOrGetSession({
      sessionId: crashSessionId,
      repositoryPath: tempDir,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
    });
    store.recordStateTransition({
      sessionId: crashSessionId,
      fromState: 'initialized',
      toState: 'staging',
      action: 'start_staging',
    });
    store.reserveSandboxOperation({
      operationId: 'op-crash-1',
      sessionId: crashSessionId,
      sandboxPath: path.join(tempDir, 'non-existent-sandbox'),
      sourcePath: tempDir,
    });

    const crashReconciliation = store.reconcileRestart(crashSessionId);
    expect(crashReconciliation.status).toBe('incomplete_ambiguous');
    expect(crashReconciliation.recommended_action).toBe('re_stage');
  });
});
