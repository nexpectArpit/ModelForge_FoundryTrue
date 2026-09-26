/**
 * State Enforcement Tests
 *
 * Verifies that the MigrationStateMachine strictly governs every MCP tool call
 * and that out-of-order operations fail with real InvalidTransitionErrors.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { handleRehearsalToolCall, resetRehearsalState } from '../mcp-servers/rehearsal-mcp/src/server.js';
import { handleGatewayToolCall } from '../mcp-servers/gateway-mcp/src/server.js';
import { sessionRegistry } from '../core/session-registry.js';
import { InvalidTransitionError } from '../core/state-machine.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_APP = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('MCP Lifecycle State Enforcement', () => {
  beforeEach(() => {
    resetRehearsalState();
  });

  it('1. stage before inspection is rejected', async () => {
    // Session is initialized, but inspection has not run
    await expect(
      handleRehearsalToolCall('stage_code_migration', {
        repo_path: DEMO_APP,
        active_model: 'model-b',
      }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('2. stage before plan is rejected', async () => {
    // Run inspection
    await handleRehearsalToolCall('repo_inspect_ai_usage', {
      repo_path: DEMO_APP,
    });

    const state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('inspection_complete');

    // Attempting to stage immediately without planning must fail
    await expect(
      handleRehearsalToolCall('stage_code_migration', {
        repo_path: DEMO_APP,
        active_model: 'model-b',
      }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('3. evaluate before sandbox staging is rejected', async () => {
    // Run inspection and planning
    await handleRehearsalToolCall('repo_inspect_ai_usage', {
      repo_path: DEMO_APP,
    });
    await handleRehearsalToolCall('generate_migration_plan', {
      source_model: 'model-a',
      target_model: 'model-b',
    });

    const state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('plan_ready');

    // Attempting to evaluate without staging must fail
    await expect(
      handleRehearsalToolCall('run_deterministic_benchmark', {
        endpoint_url: 'http://127.0.0.1:8955/api/chat',
        candidate_id: 'premature-candidate',
      }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('4. production mutation before approval is rejected', async () => {
    // Attempting to call apply_production_routing without preparing canary or getting approval
    await expect(
      handleGatewayToolCall('apply_production_routing', {
        canary_id: 'non-existent-canary',
        approval_token: undefined,
      }),
    ).rejects.toThrow();
  });

  it('5. legal sequential lifecycle succeeds and advances states', async () => {
    // 1. Inspect
    const profile = await handleRehearsalToolCall('repo_inspect_ai_usage', {
      repo_path: DEMO_APP,
    });
    expect(profile.status).toBe('complete');

    let state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('inspection_complete');

    // 2. Plan
    const plan = await handleRehearsalToolCall('generate_migration_plan', {
      source_model: 'model-a',
      target_model: 'model-b',
    });
    expect(plan.strategy).toBe('direct_replacement');

    state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('plan_ready');

    // 3. Stage in sandbox
    const staged = await handleRehearsalToolCall('stage_code_migration', {
      repo_path: DEMO_APP,
      active_model: 'model-b',
    });
    expect(staged.sandbox_id).toBeDefined();

    state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('staged');
  });
});
