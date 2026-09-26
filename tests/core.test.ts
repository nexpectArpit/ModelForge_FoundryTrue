/**
 * Core Module Tests
 *
 * Tests for the ModelForge core modules:
 *   - Domain types and ID generation
 *   - State machine transitions and invariants
 *   - Workspace sandbox isolation
 *   - Repository analyzer
 *   - Failure diagnostician
 *   - Migration planner
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSessionId,
  createEvalRunId,
  createCanaryId,
  createStepId,
  VALID_TRANSITIONS,
  type MigrationState,
  type SessionId,
  type EvaluationReport,
  type EvalRunId,
} from '../core/types.js';

import {
  MigrationStateMachine,
  InvalidTransitionError,
} from '../core/state-machine.js';

import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import { analyzeRepository } from '../core/repository-analyzer.js';
import { diagnoseFailures } from '../core/failure-diagnostician.js';
import { generateMigrationPlan } from '../core/migration-planner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FIXTURES = path.resolve(__dirname, '../.test-fixtures');
const SANDBOX_ROOT = path.resolve(__dirname, '../.test-sandboxes');

// ─── ID Generation ───────────────────────────────────────────────────────────

describe('Domain Type IDs', () => {
  it('creates unique session IDs', () => {
    const id1 = createSessionId();
    const id2 = createSessionId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^session-/);
  });

  it('creates unique eval run IDs', () => {
    const id1 = createEvalRunId();
    const id2 = createEvalRunId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^eval-/);
  });

  it('creates unique canary IDs', () => {
    const id = createCanaryId();
    expect(id).toMatch(/^canary-/);
  });

  it('creates step IDs with embedded step name', () => {
    const id = createStepId('evaluating');
    expect(id).toMatch(/^step-evaluating-/);
  });
});

// ─── State Machine ───────────────────────────────────────────────────────────

describe('MigrationStateMachine', () => {
  let machine: MigrationStateMachine;

  beforeEach(() => {
    machine = new MigrationStateMachine({
      repositoryPath: '/tmp/test-repo',
      sourceModel: 'model-a',
      targetModel: 'model-b',
    });
  });

  it('initializes in the "initialized" state', () => {
    expect(machine.state).toBe('initialized');
    expect(machine.sessionId).toMatch(/^session-/);
  });

  it('allows valid transitions', () => {
    machine.transition('inspecting', 'test_inspect');
    expect(machine.state).toBe('inspecting');

    machine.transition('inspection_complete', 'test_complete');
    expect(machine.state).toBe('inspection_complete');
  });

  it('rejects invalid transitions', () => {
    expect(() => {
      machine.transition('evaluating', 'invalid_jump');
    }).toThrow(InvalidTransitionError);
  });

  it('records events for every transition', () => {
    machine.transition('inspecting', 'action_1');
    machine.transition('inspection_complete', 'action_2');

    const events = machine.events;
    expect(events).toHaveLength(2);
    expect(events[0].from_state).toBe('initialized');
    expect(events[0].to_state).toBe('inspecting');
    expect(events[0].action).toBe('action_1');
    expect(events[1].from_state).toBe('inspecting');
    expect(events[1].to_state).toBe('inspection_complete');
  });

  it('tracks timestamps', () => {
    machine.transition('inspecting', 'test');
    const event = machine.events[0];
    expect(event.timestamp).toBeTruthy();
    expect(Date.parse(event.timestamp)).not.toBeNaN();
  });

  it('measures step duration when timer is started', async () => {
    machine.startTimer();
    await new Promise(r => setTimeout(r, 10));
    machine.transition('inspecting', 'timed_step');

    const event = machine.events[0];
    expect(event.duration_ms).toBeGreaterThanOrEqual(5); // At least some time passed
  });

  it('reports terminal states correctly', () => {
    expect(machine.isTerminal()).toBe(false);

    machine.transition('inspecting', 'test');
    machine.transition('failed', 'test_fail');

    expect(machine.isTerminal()).toBe(true);
  });

  it('allows restart from failed state', () => {
    machine.transition('inspecting', 'test');
    machine.transition('failed', 'test_fail');
    machine.transition('initialized', 'restart');

    expect(machine.state).toBe('initialized');
  });

  it('serializes and deserializes via snapshot', () => {
    machine.transition('inspecting', 'test');
    machine.transition('inspection_complete', 'test2');

    const snapshot = machine.toSnapshot();
    const restored = MigrationStateMachine.fromSnapshot(snapshot);

    expect(restored.state).toBe('inspection_complete');
    expect(restored.sessionId).toBe(machine.sessionId);
    expect(restored.events).toHaveLength(2);
  });

  it('generates audit receipt only in terminal state', () => {
    expect(() => machine.generateReceipt()).toThrow();

    machine.transition('inspecting', 'test');
    machine.transition('failed', 'test_fail');

    const receipt = machine.generateReceipt();
    expect(receipt.outcome).toBe('failed');
    expect(receipt.receipt_sha).toBeTruthy();
    expect(receipt.receipt_sha.length).toBe(64); // SHA-256 hex
  });

  it('enforces domain data setters require correct state', () => {
    // setProfile requires inspection_complete
    expect(() => {
      machine.setProfile({} as any);
    }).toThrow(/Cannot (perform "setProfile"|set profile)/);
  });

  it('tracks remediation rounds', () => {
    // Walk to diagnosis_complete
    machine.transition('inspecting', 'test');
    machine.transition('inspection_complete', 'test');
    machine.setProfile({ contract_version: '2.0', status: 'complete' } as any);
    machine.transition('planning', 'test');
    machine.transition('plan_ready', 'test');
    machine.setPlan({ contract_version: '2.0' } as any);
    machine.transition('staging', 'test');
    machine.transition('staged', 'test');
    machine.transition('evaluating', 'test');
    machine.transition('evaluation_complete', 'test');
    machine.addEvaluation({ overall: 'FAIL' } as any);
    machine.transition('diagnosing', 'test');
    machine.transition('diagnosis_complete', 'test');
    machine.addDiagnosis({ recommended_strategy: 'hybrid_routing' } as any);

    expect(machine.currentSession.remediation_round).toBe(1);
  });
});

// ─── Transition Graph Completeness ──────────────────────────────────────────

describe('State Transition Graph', () => {
  it('every state has a transition entry', () => {
    const allStates: MigrationState[] = [
      'initialized', 'inspecting', 'inspection_complete',
      'planning', 'plan_ready', 'staging', 'staged',
      'evaluating', 'evaluation_complete',
      'diagnosing', 'diagnosis_complete',
      'remediating', 'remediation_staged',
      're_evaluating', 're_evaluation_complete',
      'preparing_canary', 'canary_ready',
      'awaiting_approval', 'applying', 'verifying',
      'completed', 'failed', 'aborted',
    ];

    for (const state of allStates) {
      expect(VALID_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('terminal states have no or limited outgoing transitions', () => {
    expect(VALID_TRANSITIONS['completed']).toHaveLength(0);
    // Failed and aborted can transition to 'initialized' for restart
    expect(VALID_TRANSITIONS['failed']).toEqual(['initialized']);
    expect(VALID_TRANSITIONS['aborted']).toEqual(['initialized']);
  });
});

// ─── Workspace Sandbox ──────────────────────────────────────────────────────

describe('WorkspaceSandbox', () => {
  const testRepoPath = path.join(TEST_FIXTURES, 'test-repo');

  beforeEach(() => {
    // Create a test fixture repository
    mkdirSync(path.join(testRepoPath, 'src'), { recursive: true });
    writeFileSync(
      path.join(testRepoPath, 'src/config.ts'),
      `export const config = {
  active_model: process.env.APP_MODEL ?? 'model-a',
  routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? 'direct',
};`,
    );
    writeFileSync(
      path.join(testRepoPath, 'package.json'),
      JSON.stringify({ name: 'test-repo', dependencies: { openai: '^4.0.0' } }),
    );
  });

  afterEach(() => {
    rmSync(TEST_FIXTURES, { recursive: true, force: true });
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  });

  it('creates a sandbox copy of the source', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    expect(existsSync(sandbox.sandboxPath)).toBe(true);
    expect(existsSync(path.join(sandbox.sandboxPath, 'src/config.ts'))).toBe(true);
    expect(existsSync(path.join(sandbox.sandboxPath, 'package.json'))).toBe(true);

    sandbox.discard();
  });

  it('reads files from the sandbox', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    const content = sandbox.readFile('src/config.ts');
    expect(content).toContain("'model-a'");

    sandbox.discard();
  });

  it('writes files to the sandbox without modifying the source', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    sandbox.writeFile('src/config.ts', 'export const config = { model: "model-b" };');

    // Sandbox is modified
    const sandboxContent = sandbox.readFile('src/config.ts');
    expect(sandboxContent).toContain('model-b');

    // Source is NOT modified
    const sourceContent = readFileSync(path.join(testRepoPath, 'src/config.ts'), 'utf8');
    expect(sourceContent).toContain('model-a');

    sandbox.discard();
  });

  it('replaces patterns in sandbox files', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    const result = sandbox.replaceInFile(
      'src/config.ts',
      /active_model:\s*process\.env\.APP_MODEL\s*\?\?\s*['"][^'"]+['"]/g,
      `active_model: process.env.APP_MODEL ?? 'model-b'`,
    );

    expect(result.matched).toBe(true);

    const content = sandbox.readFile('src/config.ts');
    expect(content).toContain("'model-b'");

    sandbox.discard();
  });

  it('tracks modified files in the manifest', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    sandbox.writeFile('src/config.ts', 'modified');

    const manifest = sandbox.getManifest();
    expect(manifest.modified_files).toContain('src/config.ts');
    expect(manifest.file_hashes['src/config.ts']).toBeDefined();
    expect(manifest.file_hashes['src/config.ts'].original).not.toBe(
      manifest.file_hashes['src/config.ts'].modified
    );

    sandbox.discard();
  });

  it('generates diffs for modified files', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    sandbox.writeFile('src/config.ts', 'modified content');

    const diffs = sandbox.getDiffs();
    expect(diffs).toHaveLength(1);
    expect(diffs[0].original_content).toContain('model-a');
    expect(diffs[0].modified_content).toBe('modified content');
    expect(diffs[0].original_sha).not.toBe(diffs[0].modified_sha);

    sandbox.discard();
  });

  it('discards sandbox cleanly', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();
    const sandboxPath = sandbox.sandboxPath;

    sandbox.discard();

    expect(existsSync(sandboxPath)).toBe(false);
    expect(sandbox.getManifest().status).toBe('discarded');
  });

  it('commits sandbox changes to source', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    sandbox.writeFile('src/config.ts', 'committed content');
    const result = sandbox.commit();

    expect(result.committed_files).toContain('src/config.ts');

    const sourceContent = readFileSync(path.join(testRepoPath, 'src/config.ts'), 'utf8');
    expect(sourceContent).toBe('committed content');

    sandbox.discard();
  });

  it('prevents modification after discard', () => {
    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: testRepoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();
    sandbox.discard();

    expect(() => {
      sandbox.writeFile('src/config.ts', 'should fail');
    }).toThrow(/discarded/);
  });
});

// ─── Repository Analyzer ────────────────────────────────────────────────────

describe('Repository Analyzer', () => {
  const DEMO_APP = path.resolve(__dirname, '../demo-apps/customer-support-app');

  it('produces a complete profile for the demo app', () => {
    const profile = analyzeRepository(DEMO_APP);

    expect(profile.contract_version).toBe('2.0');
    expect(profile.status).toBe('complete');
    expect(profile.repository_name).toBe('customer-support-app');
    expect(profile.language).toMatch(/typescript|javascript/);
    expect(profile.model_references.length).toBeGreaterThan(0);
  });

  it('detects frameworks from package.json', () => {
    const profile = analyzeRepository(DEMO_APP);
    const frameworkNames = profile.detected_frameworks.map(f => f.name);

    // The demo app uses zod but not a specific LLM SDK in package.json
    // It should at least detect something
    expect(profile.detected_frameworks.length).toBeGreaterThan(0);
  });

  it('detects model name references', () => {
    const profile = analyzeRepository(DEMO_APP);
    const modelRefs = profile.model_references.filter(r => r.reference_type === 'model_name_literal');
    expect(modelRefs.length).toBeGreaterThan(0);
  });

  it('detects environment variable dependencies', () => {
    const profile = analyzeRepository(DEMO_APP);
    expect(profile.env_dependencies.length).toBeGreaterThan(0);
  });

  it('returns error profile for non-existent directory', () => {
    const profile = analyzeRepository('/nonexistent/path');
    expect(profile.status).toBe('error');
    expect(profile.unknowns.length).toBeGreaterThan(0);
  });
});

// ─── Failure Diagnostician ──────────────────────────────────────────────────

describe('Failure Diagnostician', () => {
  const sessionId = createSessionId();

  function makeEvalReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
    return {
      contract_version: '2.0',
      eval_run_id: createEvalRunId(),
      session_id: sessionId,
      candidate_id: 'test-candidate',
      timestamp: new Date().toISOString(),
      test_suite_id: 'test',
      total_cases: 15,
      passed_cases: 11,
      case_results: [
        { case_id: 'qa-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: '' },
        { case_id: 'tool-1', category: 'tool', passed: false, latency_ms: 100, estimated_cost: 0.001, failure_reason: 'Tool argument schema validation failed: order_id: Expected number', raw_response_summary: '' },
      ],
      quality: { score: 0.73, threshold: 0.90, passed: false, by_category: {} },
      latency: { p50_ms: 100, p95_ms: 200, p99_ms: 300, threshold_p95_ms: 600, passed: true },
      cost: { estimated_cost_per_1k_req: 0.5, baseline_cost_per_1k_req: 1.85, savings_pct: 73, passed: true },
      regressions: [
        { case_id: 'tool-1', category: 'tool', error: 'Tool argument schema validation failed: order_id: Expected number', severity: 'critical' },
        { case_id: 'tool-2', category: 'tool', error: 'Tool argument schema validation failed: issue_type: invalid enum', severity: 'critical' },
        { case_id: 'tool-3', category: 'tool', error: 'Model failed to emit tool call', severity: 'critical' },
        { case_id: 'tool-4', category: 'tool', error: 'Tool argument schema validation failed: order_id: Expected number', severity: 'critical' },
      ],
      overall: 'FAIL',
      ...overrides,
    };
  }

  it('diagnoses tool calling failures and recommends hybrid routing', () => {
    const report = makeEvalReport();
    const diagnosis = diagnoseFailures({ sessionId, evaluationReport: report });

    expect(diagnosis.primary_failure_category).toBe('tool_calling');
    expect(diagnosis.recommended_strategy).toBe('hybrid_routing');
    expect(diagnosis.confidence).toBeGreaterThan(0.5);
    expect(diagnosis.root_cause_analysis).toContain('schema');
  });

  it('diagnoses latency regression', () => {
    const report = makeEvalReport({
      latency: { p50_ms: 500, p95_ms: 800, p99_ms: 1200, threshold_p95_ms: 600, passed: false },
      regressions: [],
      quality: { score: 1.0, threshold: 0.90, passed: true, by_category: {} },
      overall: 'FAIL',
    });

    const diagnosis = diagnoseFailures({ sessionId, evaluationReport: report });
    expect(diagnosis.primary_failure_category).toBe('latency_regression');
    expect(diagnosis.recommended_strategy).toBe('abort_migration');
  });

  it('produces diagnosis with confidence score', () => {
    const report = makeEvalReport();
    const diagnosis = diagnoseFailures({ sessionId, evaluationReport: report });

    expect(diagnosis.confidence).toBeGreaterThanOrEqual(0);
    expect(diagnosis.confidence).toBeLessThanOrEqual(1);
    expect(diagnosis.diagnosed_at).toBeTruthy();
  });
});

// ─── Migration Planner ──────────────────────────────────────────────────────

describe('Migration Planner', () => {
  it('generates a direct replacement plan for first attempt', () => {
    const sessionId = createSessionId();
    const plan = generateMigrationPlan({
      sessionId,
      profile: {
        contract_version: '2.0',
        status: 'complete',
        repository_path: '/test',
        repository_name: 'test-app',
        language: 'typescript',
        package_manager: 'pnpm',
        detected_frameworks: [{ name: 'openai-sdk', version: '^4.0.0', import_paths: ['openai'] }],
        current_model: 'model-a',
        model_references: [
          {
            file_path: 'src/config.ts',
            line_numbers: [5],
            reference_type: 'model_name_literal',
            code_snippet: `active_model: 'model-a'`,
            confidence: 1.0,
          },
        ],
        tool_schemas: [],
        env_dependencies: ['APP_MODEL'],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      },
      sourceModel: 'model-a',
      targetModel: 'model-b',
    });

    expect(plan.strategy).toBe('direct_replacement');
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.acceptance_criteria.length).toBeGreaterThan(0);
    expect(plan.risk_assessment).toBeDefined();
  });

  it('generates a hybrid routing plan after diagnosis', () => {
    const sessionId = createSessionId();
    const plan = generateMigrationPlan({
      sessionId,
      profile: {
        contract_version: '2.0',
        status: 'complete',
        repository_path: '/test',
        repository_name: 'test-app',
        language: 'typescript',
        package_manager: 'pnpm',
        detected_frameworks: [],
        current_model: 'model-a',
        model_references: [],
        tool_schemas: [],
        env_dependencies: [],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      },
      sourceModel: 'model-a',
      targetModel: 'model-b',
      previousDiagnosis: {
        contract_version: '2.0',
        session_id: sessionId,
        eval_run_id: createEvalRunId(),
        primary_failure_category: 'tool_calling',
        affected_categories: ['tool'],
        root_cause_analysis: 'Tool calling schema failures',
        recommended_strategy: 'hybrid_routing',
        strategy_details: { routing_mode: 'hybrid' },
        confidence: 0.95,
        diagnosed_at: new Date().toISOString(),
      },
    });

    expect(plan.strategy).toBe('hybrid_routing');
    expect(plan.strategy_rationale).toContain('hybrid_routing');
  });
});
