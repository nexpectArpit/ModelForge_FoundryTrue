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

    const state: any = await handleRehearsalToolCall('get_session_state', {});
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

    const state: any = await handleRehearsalToolCall('get_session_state', {});
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
    const profile: any = await handleRehearsalToolCall('repo_inspect_ai_usage', {
      repo_path: DEMO_APP,
    });
    expect(profile.status).toBe('complete');

    let state: any = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('inspection_complete');

    // 2. Plan
    const plan: any = await handleRehearsalToolCall('generate_migration_plan', {
      source_model: 'model-a',
      target_model: 'model-b',
    });
    expect(plan.strategy).toBe('direct_replacement');

    state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('plan_ready');

    // 3. Stage in sandbox
    const staged: any = await handleRehearsalToolCall('stage_code_migration', {
      repo_path: DEMO_APP,
      active_model: 'model-b',
    });
    expect(staged.sandbox_id).toBeDefined();

    state = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('staged');
  });

  it('6. generate plan before inspection is rejected', async () => {
    // Session is freshly initialized; calling generate_migration_plan without inspection must fail
    await expect(
      handleRehearsalToolCall('generate_migration_plan', {
        source_model: 'model-a',
        target_model: 'model-b',
      }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('7. compare_rehearsals before baseline is rejected with clear error', async () => {
    // Inspect, plan, stage, and evaluate candidate without ever establishing baseline
    await handleRehearsalToolCall('repo_inspect_ai_usage', { repo_path: DEMO_APP });
    await handleRehearsalToolCall('generate_migration_plan', { source_model: 'model-a', target_model: 'model-b' });
    await handleRehearsalToolCall('stage_code_migration', { repo_path: DEMO_APP, active_model: 'model-b' });

    // Mock an evaluation run
    await handleRehearsalToolCall('run_deterministic_benchmark', {
      endpoint_url: 'http://127.0.0.1:8955/api/chat',
      candidate_id: 'candidate-run-1',
    });

    // Calling compare_rehearsals must fail because baseline was never established
    await expect(
      handleRehearsalToolCall('compare_rehearsals', {
        candidate_id: 'candidate-run-1',
      }),
    ).rejects.toThrow(/Cannot compare: no baseline evaluation exists/);
  });

  it('8. prepare_canary_manifest is rejected unless comparison is PASS', async () => {
    // Calling prepare_canary_manifest without a valid PASS comparison must fail
    await expect(
      handleGatewayToolCall('prepare_canary_manifest', {
        candidate_id: 'unverified-candidate',
        evaluation_proof: {
          eval_id: 'eval-1',
          quality_score: 0.5,
          regressions_count: 5,
          differential_matrix_sha: 'some-sha',
        },
      }),
    ).rejects.toThrow();
  });

  it('9. apply_production_routing fails closed without valid cryptographic approval artifact', async () => {
    const machine = sessionRegistry.getActive();
    machine.transition('inspecting', 'test');
    machine.transition('inspection_complete', 'test');
    machine.transition('planning', 'test');
    machine.transition('plan_ready', 'test');
    machine.transition('staging', 'test');
    machine.transition('staged', 'test');
    machine.transition('evaluating', 'test');
    machine.transition('evaluation_complete', 'test');
    machine.transition('preparing_canary', 'test');
    machine.transition('canary_ready', 'test');

    await expect(
      handleGatewayToolCall('apply_production_routing', {
        canary_id: 'canary-test-123',
        approval_token: undefined,
      }),
    ).rejects.toThrow(/Missing or malformed approval artifact/);
  });

  it('10. apply_sandbox_remediation with unsupported strategy fails closed', async () => {
    await handleRehearsalToolCall('repo_inspect_ai_usage', { repo_path: DEMO_APP });
    await handleRehearsalToolCall('generate_migration_plan', { source_model: 'model-a', target_model: 'model-b' });
    await handleRehearsalToolCall('stage_code_migration', { repo_path: DEMO_APP, active_model: 'model-b' });
    await handleRehearsalToolCall('run_deterministic_benchmark', {
      endpoint_url: 'http://127.0.0.1:8955/api/chat',
      candidate_id: 'candidate-run-1',
    });
    await handleRehearsalToolCall('diagnose_failures', {});

    await expect(
      handleRehearsalToolCall('apply_sandbox_remediation', {
        strategy: 'schema_simplification',
      }),
    ).rejects.toThrow(/Remediation strategy "schema_simplification" cannot be automatically synthesized/);
  });

  it('11. abort_migration cleanly transitions session to aborted state', async () => {
    await handleRehearsalToolCall('repo_inspect_ai_usage', { repo_path: DEMO_APP });
    
    const abortResult: any = await handleRehearsalToolCall('abort_migration', {
      reason: 'Target model does not satisfy critical safety criteria',
    });

    expect(abortResult.status).toBe('aborted');
    expect(abortResult.reason).toContain('Target model does not satisfy critical safety criteria');

    const state: any = await handleRehearsalToolCall('get_session_state', {});
    expect(state.state).toBe('aborted');
  });
});

