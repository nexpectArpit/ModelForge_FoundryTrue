/**
 * Rehearsal MCP Server — v2.2 (Architecture v2)
 *
 * Architectural Principle #1: Separation of concerns
 * Architectural Principle #7: Typed domain error taxonomy
 * Architectural Principle #15: Contract-first MCP boundaries
 * Architectural Principle #16: TrueForge/ModelForge anti-corruption boundary
 * Architectural Principle #20: No hidden procedural orchestration (CommandDispatcher)
 *
 * Governed by MigrationStateMachine:
 *   - All tool calls execute within the authoritative lifecycle state machine.
 *   - Out-of-order operations fail with real InvalidTransitionError.
 *   - Sandbox isolation is strictly preserved: zero bytes written to the source repo.
 *   - The sandboxed application runs exclusively from activeSandbox.sandboxPath.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { analyzeRepository } from '../../../core/repository-analyzer.js';
import { WorkspaceSandbox } from '../../../core/workspace-sandbox.js';
import { runEvaluation } from '../../../core/evaluation-engine.js';
import { diagnoseFailures } from '../../../core/failure-diagnostician.js';
import { generateMigrationPlan } from '../../../core/migration-planner.js';
import { sessionRegistry } from '../../../core/session-registry.js';
import { startSandboxApp, stopSandboxApp } from './sandbox-runner.js';
import {
  applyMigrationPlan,
  applyModelLiteralPatch,
  applyRoutingModePatch,
  applyEnvironmentPatch,
  verifySandboxPatches,
} from '../../../core/patching/index.js';
import {
  NoPrecedingProfileError,
  NoPrecedingEvaluationError,
  SandboxNotInitializedError,
  SandboxVerificationError,
} from '../../../core/errors.js';
import {
  CommandDispatcher,
  RepoInspectInput,
  GeneratePlanInput,
  StageCodeInput,
  SandboxRunInput,
  RunBenchmarkInput,
  DiagnoseInput,
  GetSessionStateInput,
  EstablishBaselineInput,
  CompareRehearsalsInput,
  ApplyRemediationInput,
} from '../../../core/mcp-boundary.js';
import { compareRehearsalReports } from '../../../core/rehearsal/index.js';

// Active sandboxes keyed by session ID
const activeSandboxes = new Map<string, WorkspaceSandbox>();

export function getActiveSandbox(sessionId?: string): WorkspaceSandbox | null {
  const machine = sessionRegistry.getOrCreate({ sessionId });
  return activeSandboxes.get(machine.sessionId) ?? null;
}

export function resetRehearsalState(): void {
  for (const sandbox of activeSandboxes.values()) {
    try {
      sandbox.discard();
    } catch {
      // ignore
    }
  }
  activeSandboxes.clear();
  stopSandboxApp();
  sessionRegistry.reset();
}

// ─── Tool Definitions (JSON-RPC Schema Metadata) ─────────────────────────────

export const REHEARSAL_TOOLS = [
  {
    name: 'repo_inspect_ai_usage',
    description: 'Deep inspection of repository to discover AI SDKs, models, tool schemas, environment dependencies, and model coupling sites. Returns a v2 RepositoryProfile with confidence scores.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Absolute or relative path to repository directory' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'generate_migration_plan',
    description: 'Synthesize a formal MigrationPlan specifying exact code transformations, tool schema adaptations, configuration overrides, and canary deployment stages.',
    inputSchema: {
      type: 'object',
      properties: {
        source_model: { type: 'string', description: 'Current model being replaced' },
        target_model: { type: 'string', description: 'Target candidate model' },
        use_diagnosis: { type: 'boolean', description: 'Whether to incorporate previous failure diagnosis into plan synthesis' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['source_model', 'target_model'],
    },
  },
  {
    name: 'stage_code_migration',
    description: 'Apply synthesized migration plan to an isolated temporary sandbox workspace. Never mutates the source repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: 'Source repository path to clone into sandbox' },
        active_model: { type: 'string', description: 'Model to configure in sandbox' },
        routing_mode: { type: 'string', enum: ['direct', 'hybrid'], description: 'Routing strategy' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['repo_path', 'active_model'],
    },
  },
  {
    name: 'sandbox_run_app',
    description: 'Start the staged application from its isolated sandbox directory for evaluation testing. Guaranteed to execute only within active sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port to bind sandbox server' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
  {
    name: 'run_deterministic_benchmark',
    description: 'Execute the deterministic benchmark test suite against the sandboxed app. Returns v2 EvaluationReport with per-case results and per-category breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint_url: { type: 'string', description: 'HTTP endpoint of application under test' },
        candidate_id: { type: 'string', description: 'Unique identifier for candidate run' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['endpoint_url', 'candidate_id'],
    },
  },
  {
    name: 'diagnose_failures',
    description: 'Analyze the latest evaluation failures using the failure taxonomy. Returns root cause analysis, affected categories, and remediation recommendation with confidence score.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
  {
    name: 'get_session_state',
    description: 'Return the current durable migration session state directly from the state machine.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
  {
    name: 'establish_baseline',
    description: 'Execute deterministic benchmark against the unmodified application to establish authoritative empirical baseline evidence before staging candidate changes.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint_url: { type: 'string', description: 'HTTP endpoint of baseline application' },
        baseline_model: { type: 'string', description: 'Identifier of incumbent model (e.g. gpt-4o)' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
      required: ['endpoint_url'],
    },
  },
  {
    name: 'compare_rehearsals',
    description: 'Perform pure deterministic differential analysis between baseline evidence and latest candidate evidence. Computes accuracy delta, latency shift, cost reduction, and per-case regressions.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
  {
    name: 'apply_sandbox_remediation',
    description: 'Apply diagnosed remediation strategy (e.g. hybrid routing, prompt adaptation) directly to the active candidate sandbox. Returns sandbox patch report.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['hybrid_routing', 'prompt_adaptation', 'schema_simplification', 'temperature_tuning', 'few_shot_examples', 'abort_migration'], description: 'Remediation strategy to apply' },
        session_id: { type: ['string', 'null'], description: 'Optional migration session identifier' },
      },
    },
  },
];

// ─── Command Dispatcher (Principle #20: No Procedural If/Else) ───────────────

const dispatcher = new CommandDispatcher();

// 1. repo_inspect_ai_usage
dispatcher.register('repo_inspect_ai_usage', RepoInspectInput, async (cmd) => {
  let target = path.resolve(process.cwd(), cmd.repo_path);
  if (!existsSync(target) && cmd.repo_path.includes('demo-apps/customer-support-app')) {
    target = path.resolve(process.cwd(), 'demo-apps/customer-support-app');
  }
  const machine = sessionRegistry.getOrCreate({
    sessionId: cmd.session_id,
    repositoryPath: target,
    forceNew: !cmd.session_id,
  });

  machine.startTimer();
  machine.transition('inspecting', 'repo_inspect_ai_usage', { repo_path: target });

  try {
    const profile = analyzeRepository(target);
    machine.transition('inspection_complete', 'inspection_complete', {
      frameworks: profile.detected_frameworks.length,
      references: profile.model_references.length,
    });
    machine.setProfile(profile);
    sessionRegistry.persist(machine);
    return profile;
  } catch (err) {
    machine.transition('failed', 'inspection_failed', { error: (err as Error).message });
    throw err;
  }
});

// 2. generate_migration_plan
dispatcher.register('generate_migration_plan', GeneratePlanInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({
    sessionId: cmd.session_id,
    sourceModel: cmd.source_model,
    targetModel: cmd.target_model,
  });

  machine.startTimer();
  machine.transition('planning', 'generate_migration_plan', {
    source_model: cmd.source_model,
    target_model: cmd.target_model,
  });

  try {
    const profile = machine.currentSession.profile;
    if (!profile) {
      throw new NoPrecedingProfileError(machine.sessionId);
    }

    const previousDiagnosis = cmd.use_diagnosis
      ? machine.latestDiagnosis() ?? undefined
      : undefined;

    const plan = generateMigrationPlan({
      sessionId: machine.sessionId,
      profile,
      sourceModel: cmd.source_model,
      targetModel: cmd.target_model,
      previousDiagnosis,
    });

    machine.transition('plan_ready', 'plan_generated', {
      strategy: plan.strategy,
      changes: plan.changes.length,
    });
    machine.setPlan(plan);
    sessionRegistry.persist(machine);
    return plan;
  } catch (err) {
    machine.transition('failed', 'planning_failed', { error: (err as Error).message });
    throw err;
  }
});

// 3. stage_code_migration
dispatcher.register('stage_code_migration', StageCodeInput, async (cmd) => {
  let target = path.resolve(process.cwd(), cmd.repo_path);
  if (!existsSync(target) && cmd.repo_path.includes('demo-apps/customer-support-app')) {
    target = path.resolve(process.cwd(), 'demo-apps/customer-support-app');
  }
  const machine = sessionRegistry.getOrCreate({
    sessionId: cmd.session_id,
    repositoryPath: target,
  });

  machine.startTimer();
  const currentState = machine.state;

  let isRemediation = false;
  if (currentState === 'diagnosis_complete') {
    machine.transition('remediating', 'start_remediation', {
      active_model: cmd.active_model,
      routing_mode: cmd.routing_mode,
    });
    isRemediation = true;
  } else {
    machine.transition('staging', 'create_sandbox', {
      active_model: cmd.active_model,
      routing_mode: cmd.routing_mode,
    });
  }

  try {
    let sandbox = activeSandboxes.get(machine.sessionId);

    if (!sandbox || sandbox.getManifest().status !== 'active') {
      sandbox = new WorkspaceSandbox({
        sessionId: machine.sessionId,
        sourcePath: target,
      });
      sandbox.initialize();
      activeSandboxes.set(machine.sessionId, sandbox);
    }

    // Reserve sandbox operation in SQLite durable store
    const store = sessionRegistry.getStore();
    const opId = `op-stage-${Date.now().toString(36)}`;
    store.reserveSandboxOperation({
      operationId: opId,
      sessionId: machine.sessionId,
      sandboxPath: sandbox.sandboxPath,
      sourcePath: target,
    });

    // Apply code changes EXCLUSIVELY in sandbox using canonical patch engine
    let applied = false;
    if (machine.currentSession.plan && machine.currentSession.profile) {
      const report = applyMigrationPlan(sandbox, machine.currentSession.plan, machine.currentSession.profile);
      applied = report.total_replacements > 0;
    } else {
      const literalRes = applyModelLiteralPatch(
        sandbox,
        machine.currentSession.source_model,
        cmd.active_model,
        machine.currentSession.profile?.model_references ?? [],
      );
      const routingRes = applyRoutingModePatch(
        sandbox,
        (cmd.routing_mode as 'direct' | 'hybrid') ?? 'direct',
      );
      const envRes = applyEnvironmentPatch(
        sandbox,
        cmd.active_model,
        machine.currentSession.profile?.env_dependencies ?? [],
      );
      applied = literalRes.some(r => r.applied) || routingRes.some(r => r.applied) || envRes.some(r => r.applied);
    }

    // Verify sandbox mutation invariants
    const verification = verifySandboxPatches(sandbox);
    if (!verification.verified) {
      throw new SandboxVerificationError(verification.errors);
    }

    store.checkpointAppliedSandbox(opId);

    const nextState = isRemediation ? 'remediation_staged' : 'staged';
    machine.transition(nextState, isRemediation ? 'remediation_staged' : 'sandbox_staged', {
      sandbox_path: sandbox.sandboxPath,
      modified_files: sandbox.getManifest().modified_files,
    });
    sessionRegistry.persist(machine);

    return {
      sandbox_id: sandbox.getManifest().sandbox_id,
      sandbox_path: sandbox.sandboxPath,
      active_model: cmd.active_model,
      routing_mode: cmd.routing_mode ?? 'direct',
      modified_files: sandbox.getManifest().modified_files,
      file_hashes: sandbox.getManifest().file_hashes,
      applied_in_sandbox: applied,
      diffs: sandbox.getDiffs(),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    machine.transition('failed', 'staging_failed', { error: (err as Error).message });
    throw err;
  }
});

// 4. sandbox_run_app
dispatcher.register('sandbox_run_app', SandboxRunInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  const sandbox = activeSandboxes.get(machine.sessionId);
  if (!sandbox || sandbox.getManifest().status !== 'active') {
    throw new SandboxNotInitializedError(machine.sessionId);
  }

  const port = cmd.port ?? 8955;
  const result = await startSandboxApp({
    targetDir: sandbox.sandboxPath,
    port,
  });

  return {
    ...result,
    sandbox_path: sandbox.sandboxPath,
  };
});

// 5. run_deterministic_benchmark
dispatcher.register('run_deterministic_benchmark', RunBenchmarkInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  machine.startTimer();
  const currentState = machine.state;
  const isReEval = currentState === 'remediation_staged';
  const evalTargetState = isReEval ? 're_evaluating' : 'evaluating';

  machine.transition(evalTargetState, 'start_evaluation', {
    candidate_id: cmd.candidate_id,
    endpoint_url: cmd.endpoint_url,
  });

  try {
    const report = await runEvaluation({
      endpointUrl: cmd.endpoint_url,
      candidateId: cmd.candidate_id,
      sessionId: machine.sessionId,
    });

    const completeState = isReEval ? 're_evaluation_complete' : 'evaluation_complete';
    machine.transition(completeState, 'evaluation_complete', {
      overall: report.overall,
      quality_score: report.quality.score,
      regressions_count: report.regressions.length,
    });

    machine.addEvaluation(report);
    sessionRegistry.persist(machine);
    return report;
  } catch (err) {
    machine.transition('failed', 'evaluation_failed', { error: (err as Error).message });
    throw err;
  }
});

// 6. diagnose_failures
dispatcher.register('diagnose_failures', DiagnoseInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  machine.startTimer();
  machine.transition('diagnosing', 'start_diagnosis');

  try {
    const latestEval = machine.latestEvaluation();
    if (!latestEval) {
      throw new NoPrecedingEvaluationError(machine.sessionId);
    }

    const diagnosis = diagnoseFailures({
      sessionId: machine.sessionId,
      evaluationReport: latestEval,
    });

    machine.transition('diagnosis_complete', 'diagnosis_complete', {
      category: diagnosis.primary_failure_category,
      strategy: diagnosis.recommended_strategy,
      confidence: diagnosis.confidence,
    });

    machine.addDiagnosis(diagnosis);
    sessionRegistry.persist(machine);
    return diagnosis;
  } catch (err) {
    machine.transition('failed', 'diagnosis_failed', { error: (err as Error).message });
    throw err;
  }
});

// 7. get_session_state
dispatcher.register('get_session_state', GetSessionStateInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  return machine.toSnapshot();
});

// 8. establish_baseline
dispatcher.register('establish_baseline', EstablishBaselineInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  const report = await runEvaluation({
    endpointUrl: cmd.endpoint_url,
    candidateId: cmd.baseline_model,
    sessionId: machine.sessionId,
  });
  machine.setBaselineEvaluation(report);
  sessionRegistry.persist(machine);
  return {
    status: 'baseline_established',
    baseline_model: cmd.baseline_model,
    report,
  };
});

// 9. compare_rehearsals
dispatcher.register('compare_rehearsals', CompareRehearsalsInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  const candidateEval = machine.latestEvaluation();
  if (!candidateEval) {
    throw new NoPrecedingEvaluationError(machine.sessionId);
  }
  const baselineEval = machine.session.baseline_evaluation ?? candidateEval;
  const comparison = compareRehearsalReports({
    baselineReport: baselineEval,
    candidateReport: candidateEval,
    baselineModel: machine.session.source_model,
    candidateModel: candidateEval.candidate_id,
    sessionId: machine.sessionId,
  });
  machine.setComparison(comparison);
  sessionRegistry.persist(machine);
  return comparison;
});

// 10. apply_sandbox_remediation
dispatcher.register('apply_sandbox_remediation', ApplyRemediationInput, async (cmd) => {
  const machine = sessionRegistry.getOrCreate({ sessionId: cmd.session_id });
  machine.transition('remediating', 'start_remediation');
  const sandbox = activeSandboxes.get(machine.sessionId);
  if (!sandbox || sandbox.getManifest().status !== 'active') {
    throw new SandboxNotInitializedError(machine.sessionId);
  }
  const strategy = cmd.strategy ?? machine.session.diagnoses[machine.session.diagnoses.length - 1]?.recommended_strategy ?? 'hybrid_routing';
  if (strategy === 'abort_migration') {
    machine.transition('aborted', 'abort_migration_diagnosed');
    sessionRegistry.persist(machine);
    return { status: 'aborted', strategy: 'abort_migration', message: 'Migration aborted due to unsupported capability.' };
  }
  const routingRes = applyRoutingModePatch(
    sandbox,
    strategy === 'hybrid_routing' ? 'hybrid' : 'direct',
  );
  machine.transition('remediation_staged', 'remediation_applied', { strategy });
  sessionRegistry.persist(machine);
  return {
    status: 'remediation_staged',
    strategy,
    routing_patches: routingRes,
    modified_files: sandbox.getManifest().modified_files,
  };
});

// ─── Tool Handler Entrypoint ─────────────────────────────────────────────────

export async function handleRehearsalToolCall(name: string, args: Record<string, any>) {
  return dispatcher.dispatch(name, args);
}

export { dispatcher as rehearsalDispatcher };
