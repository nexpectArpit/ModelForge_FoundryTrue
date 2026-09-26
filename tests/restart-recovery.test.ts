/**
 * Restart Recovery & Durable Persistence Integration Tests
 *
 * Verifies Phase A acceptance criteria 3, 4, and 5:
 *   3. A process restart cannot lose migration state.
 *   4. MCP tools resolve migration state from SQLite, not an in-memory Map.
 *   5. Audit events survive process restart.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { SessionRegistry } from '../core/session-registry.js';
import { DurableStateStore } from '../core/durable-state.js';
import { createSessionId, type RepositoryProfile } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('Process Restart & SQLite Durability', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(__dirname, '../.test-restart-'));
    dbPath = path.join(tempDir, 'state.sqlite');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves complete migration state, events, and profile across process restarts', () => {
    const sessionId = createSessionId();

    // ── Process 1: Starts session, transitions, saves profile ──
    {
      const registry1 = new SessionRegistry({ dbPath });
      const machine1 = registry1.getOrCreate({
        sessionId,
        repositoryPath: APP_DIR,
        sourceModel: 'model-a',
        targetModel: 'model-b',
      });

      machine1.transition('inspecting', 'repo_inspect_ai_usage', { repo_path: APP_DIR });
      machine1.transition('inspection_complete', 'inspection_complete', { frameworks: 1 });

      const profile: RepositoryProfile = {
        contract_version: '2.0',
        status: 'complete',
        repository_path: APP_DIR,
        repository_name: 'customer-support-app',
        language: 'typescript',
        package_manager: 'pnpm',
        detected_frameworks: [{ name: 'openai', version: '4.0.0', import_paths: ['openai'] }],
        current_model: 'model-a',
        model_references: [
          {
            file_path: 'src/config.ts',
            line_numbers: [1],
            reference_type: 'model_name_literal',
            code_snippet: 'active_model',
            confidence: 0.95,
          },
        ],
        tool_schemas: [],
        env_dependencies: ['APP_MODEL'],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      };

      machine1.setProfile(profile);

      // Verify Process 1 state
      expect(machine1.state).toBe('inspection_complete');
      expect(machine1.events).toHaveLength(2);

      // Close / Terminate Process 1
      registry1.getStore().close();
    }

    // ── Process 2 (Restart): Brand new process instance pointing to the same SQLite file ──
    {
      const registry2 = new SessionRegistry({ dbPath });

      // In-memory cache is initially empty
      const rehydratedMachine = registry2.getOrCreate({ sessionId });

      // State is resolved 100% from SQLite
      expect(rehydratedMachine.state).toBe('inspection_complete');
      expect(rehydratedMachine.sessionId).toBe(sessionId);
      expect(rehydratedMachine.currentSession.source_model).toBe('model-a');
      expect(rehydratedMachine.currentSession.target_model).toBe('model-b');

      // Profile was restored from SQLite
      expect(rehydratedMachine.currentSession.profile).toBeDefined();
      expect(rehydratedMachine.currentSession.profile?.repository_name).toBe('customer-support-app');
      expect(rehydratedMachine.currentSession.profile?.detected_frameworks[0].name).toBe('openai');

      // State transitions and audit trail survived restart
      expect(rehydratedMachine.events).toHaveLength(2);
      expect(rehydratedMachine.events[0].from_state).toBe('initialized');
      expect(rehydratedMachine.events[0].to_state).toBe('inspecting');
      expect(rehydratedMachine.events[1].from_state).toBe('inspecting');
      expect(rehydratedMachine.events[1].to_state).toBe('inspection_complete');

      // Domain audit events in SQLite survived restart with monotonic sequence numbers
      const auditEvents = registry2.getStore().getAuditEvents(sessionId);
      expect(auditEvents.length).toBeGreaterThanOrEqual(4); // session_created + 2 transitions + profile_saved
      expect(auditEvents[0].sequence).toBe(1);
      expect(auditEvents[0].action).toBe('session_created');

      // Subsequent transitions work seamlessly after restart
      rehydratedMachine.transition('planning', 'generate_migration_plan');
      expect(rehydratedMachine.state).toBe('planning');

      registry2.getStore().close();
    }
  });

  it('reconciles incomplete operations on restart without resetting state', () => {
    const sessionId = createSessionId();
    const sandboxDir = path.join(tempDir, 'active-sandbox-dir');
    fs.mkdirSync(sandboxDir, { recursive: true });

    // ── Process 1: Staged sandbox and began evaluating before crash ──
    {
      const store1 = new DurableStateStore({ dbPath });
      store1.createOrGetSession({
        sessionId,
        repositoryPath: APP_DIR,
        sourceModel: 'model-a',
        targetModel: 'model-b',
      });

      store1.recordStateTransition({
        sessionId,
        fromState: 'initialized',
        toState: 'staging',
        action: 'start_staging',
      });

      store1.reserveSandboxOperation({
        operationId: 'op-stage-101',
        sessionId,
        sandboxPath: sandboxDir,
        sourcePath: APP_DIR,
      });

      store1.checkpointAppliedSandbox('op-stage-101');

      store1.recordStateTransition({
        sessionId,
        fromState: 'staging',
        toState: 'staged',
        action: 'stage_complete',
      });

      store1.recordStateTransition({
        sessionId,
        fromState: 'staged',
        toState: 'evaluating',
        action: 'run_benchmark',
      });

      // Simulate crash: process terminates while state is 'evaluating'
      store1.close();
    }

    // ── Process 2 (Restart): Performs explicit restart reconciliation ──
    {
      const registry2 = new SessionRegistry({ dbPath });
      const reconciliation = registry2.reconcileRestart(sessionId);

      expect(reconciliation.session_id).toBe(sessionId);
      expect(reconciliation.status).toBe('safely_resumable');
      expect(reconciliation.resumable_state).toBe('evaluating');
      expect(reconciliation.recommended_action).toBe('resume');
      expect(reconciliation.active_sandbox_path).toBe(sandboxDir);

      registry2.getStore().close();
    }
  });
});
