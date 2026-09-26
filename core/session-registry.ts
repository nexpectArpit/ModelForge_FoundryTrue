/**
 * Session Registry & Durable Persistence
 *
 * Provides a single authoritative store for MigrationStateMachine instances.
 * Backed by Node 22 native node:sqlite (DurableStateStore).
 * Both rehearsal-mcp and gateway-mcp access this registry to inspect and
 * transition the exact same durable session state.
 */

import path from 'node:path';
import { MigrationStateMachine } from './state-machine.js';
import { DurableStateStore } from './durable-state.js';
import {
  type SessionId,
  type RestartReconciliation,
  createSessionId,
} from './types.js';

export class SessionRegistry {
  private store: DurableStateStore;
  private inMemory = new Map<string, MigrationStateMachine>();
  private activeSessionId: SessionId | null = null;

  constructor(opts?: { store?: DurableStateStore; dbPath?: string; inMemory?: boolean }) {
    if (opts?.store) {
      this.store = opts.store;
    } else {
      const isTest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
      const inMemory = opts?.inMemory ?? (opts?.dbPath ? false : (isTest && !process.env.MODELFORGE_STATE_PATH));
      this.store = new DurableStateStore({
        dbPath: opts?.dbPath,
        inMemory,
      });
    }
  }

  getStore(): DurableStateStore {
    return this.store;
  }

  /**
   * Get an existing session from durable SQLite store or create a new one.
   */
  getOrCreate(opts?: {
    sessionId?: SessionId | string;
    repositoryPath?: string;
    sourceModel?: string;
    targetModel?: string;
    maxRemediationRounds?: number;
    forceNew?: boolean;
  }): MigrationStateMachine {
    const rawId = opts?.sessionId as string | undefined;
    const cleaned = (rawId && rawId !== 'None' && rawId !== 'null' && rawId !== 'undefined' && rawId !== 'optional-migration-session-identifier') ? rawId : undefined;
    let targetId = cleaned || (opts?.forceNew ? undefined : (this.activeSessionId as string));

    if (!opts?.forceNew) {
      if (!targetId || !this.store.getSession(targetId)) {
        const latest = this.store.getAllSessions()[0];
        if (latest) {
          targetId = latest.session_id;
        }
      }
    }

    if (targetId && !opts?.forceNew) {
      const isTerminal = (state: string) => ['completed', 'failed', 'aborted'].includes(state);

      // 1. Check if session exists in SQLite
      const durableRecord = this.store.getSession(targetId);
      if (durableRecord && (cleaned || !isTerminal(durableRecord.state))) {
        if (this.inMemory.has(targetId)) {
          const machine = this.inMemory.get(targetId)!;
          if (cleaned || !isTerminal(machine.state)) {
            this.activeSessionId = machine.sessionId;
            return machine;
          }
        } else {
          // Rehydrate machine directly from SQLite
          const machine = MigrationStateMachine.fromStore(this.store, targetId as SessionId);
          this.inMemory.set(targetId, machine);
          this.activeSessionId = machine.sessionId;
          return machine;
        }
      }
    }

    // 2. Create fresh session in SQLite
    const newSessionId = (opts?.sessionId as SessionId) ?? createSessionId();
    const repoPath = opts?.repositoryPath ?? path.resolve(process.cwd(), 'demo-apps/customer-support-app');
    const sourceModel = opts?.sourceModel ?? 'model-a';
    const targetModel = opts?.targetModel ?? 'model-b';

    const machine = new MigrationStateMachine({
      sessionId: newSessionId,
      repositoryPath: repoPath,
      sourceModel,
      targetModel,
      maxRemediationRounds: opts?.maxRemediationRounds,
      store: this.store,
    });

    this.inMemory.set(machine.sessionId, machine);
    this.activeSessionId = machine.sessionId;

    return machine;
  }

  /**
   * Return the current active session.
   */
  getActive(): MigrationStateMachine {
    if (!this.activeSessionId) {
      return this.getOrCreate();
    }
    return this.getOrCreate({ sessionId: this.activeSessionId });
  }

  /**
   * Reconcile an interrupted session after a process crash/restart.
   */
  reconcileRestart(sessionId?: SessionId | string): RestartReconciliation {
    const targetId = (sessionId as string) || (this.activeSessionId as string);
    if (!targetId) {
      return {
        session_id: 'unknown' as SessionId,
        status: 'requires_operator_intervention',
        resumable_state: 'failed',
        reason: 'No session ID specified for restart reconciliation',
        active_sandbox_path: null,
        recommended_action: 'inspect',
      };
    }
    return this.store.reconcileRestart(targetId);
  }

  /**
   * Persist session state — backed directly by SQLite transactions.
   */
  persist(machine: MigrationStateMachine): void {
    // State is automatically persisted to SQLite on every transition
    // and setter call. Retained for API compatibility with callers.
  }

  /**
   * Clear in-memory cache to simulate a process restart.
   * Authoritative state in SQLite remains completely intact.
   */
  clearCache(): void {
    this.inMemory.clear();
  }

  /**
   * Reset registry and wipe database tables (useful for isolated tests).
   */
  reset(): void {
    this.inMemory.clear();
    this.activeSessionId = null;
    try {
      this.store.exec(`
        DELETE FROM domain_audit_events;
        DELETE FROM evaluation_runs;
        DELETE FROM sandbox_operations;
        DELETE FROM remediation_attempts;
        DELETE FROM state_transitions;
        DELETE FROM migration_sessions;
      `);
    } catch {
      // ignore in case of table locks during teardown
    }
  }
}

export const sessionRegistry = new SessionRegistry();
