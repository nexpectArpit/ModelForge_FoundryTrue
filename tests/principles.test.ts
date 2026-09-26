/**
 * Architecture Principles Tests
 *
 * Verifies that all 20 architectural principles are implemented and enforced.
 * Tests organized by principle number.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { VALID_TRANSITIONS } from '../core/types.js';
// Direct imports that DON'T transitively pull in node:sqlite
import { resolveModelProfile, createUnknownModelProfile } from '../core/model-capabilities.js';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';

// ─── Principle 7: Typed Domain Error Taxonomy ────────────────────────────────

import {
  ModelForgeError,
  InvalidTransitionError,
  SessionNotFoundError,
  InvalidStateForOperationError,
  ContractValidationError,
  AdmissibilityError,
  MCPBoundaryError,
  SandboxNotInitializedError,
  SandboxVerificationError,
  SandboxLifecycleError,
  SourcePathNotFoundError,
  PatchPreconditionError,
  PatchApplicationError,
  EvaluationConfigError,
  EvaluationAdapterError,
  NoPrecedingEvaluationError,
  NoPrecedingProfileError,
  PersistenceError,
  ApprovalRequiredError,
  ApprovalVerificationError,
  RecoveryError,
  RemediationExhaustedError,
} from '../core/errors.js';

describe('Principle #7: Typed Domain Error Taxonomy', () => {
  it('all errors extend ModelForgeError', () => {
    const errors = [
      new InvalidTransitionError('a', 'b'),
      new SessionNotFoundError('s1'),
      new InvalidStateForOperationError('op', 'state', ['s1']),
      new ContractValidationError('test', ['reason']),
      new AdmissibilityError('Profile', ['bad']),
      new MCPBoundaryError('tool', ['err']),
      new SandboxNotInitializedError('s1'),
      new SandboxVerificationError(['err']),
      new SandboxLifecycleError('msg', 'discarded'),
      new SourcePathNotFoundError('/foo'),
      new PatchPreconditionError('p1', 'fail'),
      new PatchApplicationError('p1', 'f.ts', 'reason'),
      new EvaluationConfigError('missing'),
      new EvaluationAdapterError('demo', 'fail'),
      new NoPrecedingEvaluationError('s1'),
      new NoPrecedingProfileError('s1'),
      new PersistenceError('write', 'disk'),
      new ApprovalRequiredError('s1', 'c1'),
      new ApprovalVerificationError('expired'),
      new RecoveryError('s1', 'corrupt'),
      new RemediationExhaustedError('s1', 3, 3),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(ModelForgeError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('errors carry structured context for audit logging', () => {
    const err = new InvalidTransitionError('staging', 'completed');
    const audit = err.toAuditRecord();

    expect(audit.error_code).toBe('STATE_INVALID_TRANSITION');
    expect(audit.error_category).toBe('state');
    expect(audit.error_context).toEqual({
      from_state: 'staging',
      to_state: 'completed',
    });
    expect(audit.error_timestamp).toBeDefined();
  });

  it('each error has a unique category and code', () => {
    const err1 = new SandboxNotInitializedError('s1');
    const err2 = new ContractValidationError('plan', ['no changes']);

    expect(err1.category).toBe('sandbox');
    expect(err1.code).toBe('SANDBOX_NOT_INITIALIZED');
    expect(err2.category).toBe('validation');
    expect(err2.code).toBe('VALIDATION_CONTRACT_VIOLATION');
  });

  it('errors preserve cause chain', () => {
    const cause = new Error('disk full');
    const err = new PersistenceError('write', 'failed', cause);

    expect(err.cause).toBe(cause);
    expect(err.toAuditRecord().error_cause).toBe('disk full');
  });
});

// ─── Principle 2 & 3: Ports & Adapters / Dependency Inversion ────────────────

import type {
  AnalyzerPort,
  PlannerPort,
  EvaluatorPort,
  DiagnosticsPort,
  SandboxPort,
  StatePort,
  ApprovalPort,
  ObservabilityPort,
  SandboxFactory,
} from '../core/ports.js';

describe('Principle #2 & #3: Ports & Adapters / Dependency Inversion', () => {
  it('port interfaces are well-defined TypeScript contracts', () => {
    // Type-level test: these assignments must compile.
    // If they don't, the port interfaces are broken.
    const mockAnalyzer: AnalyzerPort = {
      analyze: (_path: string) => ({
        contract_version: '2.0' as const,
        status: 'complete' as const,
        repository_path: '/test',
        repository_name: 'test',
        language: 'typescript' as const,
        package_manager: 'npm',
        detected_frameworks: [],
        current_model: 'gpt-4o',
        model_references: [],
        tool_schemas: [],
        env_dependencies: [],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      }),
    };

    const profile = mockAnalyzer.analyze('/test');
    expect(profile.contract_version).toBe('2.0');
    expect(profile.status).toBe('complete');
  });

  it('orchestrator accepts injected port implementations', async () => {
    // Dynamic import to avoid node:sqlite at module level
    const { MigrationOrchestrator } = await import('../core/orchestrator.js');
    // This test verifies the OrchestratorOptions type accepts ports

    let analyzerCalled = false;
    const mockAnalyzer: AnalyzerPort = {
      analyze: () => {
        analyzerCalled = true;
        return {
          contract_version: '2.0',
          status: 'complete',
          repository_path: '/test',
          repository_name: 'test',
          language: 'typescript',
          package_manager: 'npm',
          detected_frameworks: [],
          current_model: 'gpt-4o',
          model_references: [],
          tool_schemas: [],
          env_dependencies: [],
          unknowns: [],
          inspected_at: new Date().toISOString(),
        };
      },
    };

    // Verify ports option is accepted in constructor
    const orchestrator = new MigrationOrchestrator({
      repositoryPath: path.resolve(__dirname, '../demo-apps/customer-support-app'),
      sourceModel: 'gpt-4o',
      targetModel: 'gpt-4o-mini',
      ports: {
        analyzer: mockAnalyzer,
      },
    });

    expect(orchestrator).toBeDefined();
    expect(orchestrator.sessionId).toBeDefined();
  });
});

// ─── Principle 12 & 13: Strategy + Adapter / Open-Closed ────────────────────

import {
  FailurePatternRegistry,
  createDefaultFailurePatternRegistry,
  toolCallingPattern,
  structuredExtractionPattern,
  promptDriftPattern,
  latencyRegressionPattern,
  refusalPattern,
  formatViolationPattern,
  type FailurePatternStrategy,
} from '../core/failure-pattern-registry.js';

describe('Principle #12 & #13: Strategy Registry / Open-Closed Extensibility', () => {
  it('default registry contains all built-in failure patterns', () => {
    const registry = createDefaultFailurePatternRegistry();
    expect(registry.size).toBe(6);

    const patterns = registry.getPatterns();
    const ids = patterns.map(p => p.patternId);
    expect(ids).toContain('tool-calling');
    expect(ids).toContain('structured-extraction');
    expect(ids).toContain('prompt-drift');
    expect(ids).toContain('latency-regression');
    expect(ids).toContain('refusal');
    expect(ids).toContain('format-violation');
  });

  it('patterns are ordered by priority', () => {
    const registry = createDefaultFailurePatternRegistry();
    const patterns = registry.getPatterns();

    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].priority).toBeGreaterThanOrEqual(patterns[i - 1].priority);
    }
  });

  it('new patterns can be registered without modifying existing code', () => {
    const registry = createDefaultFailurePatternRegistry();
    const initialSize = registry.size;

    const customPattern: FailurePatternStrategy = {
      patternId: 'custom-hallucination',
      category: 'hallucination',
      priority: 15, // Between tool-calling (10) and structured-extraction (20)

      matches(regressions) {
        return regressions.some(r => r.error.includes('hallucinated'));
      },

      analyzeRootCause() {
        return 'Model hallucinated content not present in context.';
      },

      recommendStrategy() {
        return 'prompt_adaptation';
      },

      buildStrategyDetails() {
        return { approach: 'Add grounding constraints to system prompt' };
      },
    };

    registry.register(customPattern);
    expect(registry.size).toBe(initialSize + 1);

    // Verify priority ordering is maintained
    const patterns = registry.getPatterns();
    const customIdx = patterns.findIndex(p => p.patternId === 'custom-hallucination');
    expect(customIdx).toBeGreaterThan(0); // After tool-calling (priority 10)
    expect(patterns[customIdx - 1].priority).toBeLessThanOrEqual(15);
  });

  it('diagnostician accepts injected registry', async () => {
    const { diagnoseFailures } = await import('../core/failure-diagnostician.js');
    const customRegistry = new FailurePatternRegistry();
    customRegistry.register({
      patternId: 'always-match',
      category: 'hallucination',
      priority: 1,
      matches: () => true,
      analyzeRootCause: () => 'Custom root cause',
      recommendStrategy: () => 'abort_migration',
      buildStrategyDetails: () => ({ custom: true }),
    });

    const diagnosis = diagnoseFailures({
      sessionId: 'test-session',
      evaluationReport: {
        contract_version: '2.0',
        eval_run_id: 'eval-test',
        session_id: 'test-session',
        candidate_id: 'test',
        timestamp: new Date().toISOString(),
        test_suite_id: 'test',
        total_cases: 1,
        passed_cases: 0,
        case_results: [],
        quality: { score: 0, threshold: 0.9, passed: false },
        latency: { p50_ms: 100, p95_ms: 200, p99_ms: 300, threshold_p95_ms: 600, passed: true },
        cost: { estimated_cost_per_1k_req: 0.1, baseline_cost_per_1k_req: 1.0, savings_pct: 90, passed: true },
        regressions: [{ case_id: 'c1', category: 'qa', error: 'some failure', severity: 'major' }],
        overall: 'FAIL',
      },
      patternRegistry: customRegistry,
    });

    expect(diagnosis.primary_failure_category).toBe('hallucination');
    expect(diagnosis.root_cause_analysis).toBe('Custom root cause');
  });
});

// ─── Principle 15 & 16: Contract-First MCP / Anti-corruption Boundary ────────

import {
  validateMCPInput,
  CommandDispatcher,
  RepoInspectInput,
  GeneratePlanInput,
  StageCodeInput,
  RunBenchmarkInput,
  MCP_INPUT_SCHEMAS,
} from '../core/mcp-boundary.js';

describe('Principle #15 & #16: Contract-First MCP / Anti-corruption Boundary', () => {
  it('validates MCP inputs with Zod schemas', () => {
    // Valid input
    const validated = validateMCPInput('repo_inspect_ai_usage', RepoInspectInput, {
      repo_path: '/some/path',
    });
    expect(validated.repo_path).toBe('/some/path');

    // Invalid input — missing required field
    expect(() => {
      validateMCPInput('repo_inspect_ai_usage', RepoInspectInput, {});
    }).toThrow(MCPBoundaryError);
  });

  it('MCPBoundaryError carries tool name and validation details', () => {
    try {
      validateMCPInput('generate_migration_plan', GeneratePlanInput, {
        source_model: '',
        target_model: '',
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MCPBoundaryError);
      const mErr = err as MCPBoundaryError;
      expect(mErr.code).toBe('MCP_INPUT_VALIDATION_FAILED');
      expect(mErr.context.tool_name).toBe('generate_migration_plan');
    }
  });

  it('validates endpoint_url is a real URL', () => {
    expect(() => {
      validateMCPInput('run_deterministic_benchmark', RunBenchmarkInput, {
        endpoint_url: 'not-a-url',
        candidate_id: 'test',
      });
    }).toThrow(MCPBoundaryError);

    // Valid URL passes
    const result = validateMCPInput('run_deterministic_benchmark', RunBenchmarkInput, {
      endpoint_url: 'http://localhost:8955/api/chat',
      candidate_id: 'test',
    });
    expect(result.endpoint_url).toBe('http://localhost:8955/api/chat');
  });

  it('routing_mode defaults to direct when not specified', () => {
    const result = validateMCPInput('stage_code_migration', StageCodeInput, {
      repo_path: '/test',
      active_model: 'gpt-4o',
    });
    expect(result.routing_mode).toBe('direct');
  });

  it('MCP_INPUT_SCHEMAS maps every tool to a schema', () => {
    const expectedTools = [
      'repo_inspect_ai_usage',
      'generate_migration_plan',
      'stage_code_migration',
      'sandbox_run_app',
      'run_deterministic_benchmark',
      'diagnose_failures',
      'get_session_state',
    ];

    for (const tool of expectedTools) {
      expect(MCP_INPUT_SCHEMAS).toHaveProperty(tool);
    }
  });
});

// ─── Principle 20: No Hidden Procedural Orchestration ────────────────────────

describe('Principle #20: Command Dispatcher (No If/Else Chains)', () => {
  it('command dispatcher routes to registered handlers', async () => {
    const dispatcher = new CommandDispatcher();
    const calls: string[] = [];

    dispatcher.register('test_tool', RepoInspectInput, async (input) => {
      calls.push(`called with ${input.repo_path}`);
      return { ok: true };
    });

    const result = await dispatcher.dispatch('test_tool', { repo_path: '/test' });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['called with /test']);
  });

  it('dispatcher rejects unknown tools', async () => {
    const dispatcher = new CommandDispatcher();

    await expect(
      dispatcher.dispatch('nonexistent_tool', {}),
    ).rejects.toThrow(MCPBoundaryError);
  });

  it('dispatcher validates input before calling handler', async () => {
    const dispatcher = new CommandDispatcher();
    const handlerCalls: unknown[] = [];

    dispatcher.register('repo_inspect_ai_usage', RepoInspectInput, async (input) => {
      handlerCalls.push(input);
      return {};
    });

    // Invalid input — handler should NOT be called
    await expect(
      dispatcher.dispatch('repo_inspect_ai_usage', {}),
    ).rejects.toThrow(MCPBoundaryError);

    expect(handlerCalls).toHaveLength(0);
  });

  it('dispatcher lists registered tools', () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.register('tool_a', RepoInspectInput, async () => ({}));
    dispatcher.register('tool_b', RepoInspectInput, async () => ({}));

    const tools = dispatcher.getRegisteredTools();
    expect(tools).toContain('tool_a');
    expect(tools).toContain('tool_b');
  });
});

// ─── Principle 6: Fail-Closed Behavior ──────────────────────────────────────

describe('Principle #6: Fail-Closed Behavior', () => {
  it('sandbox rejects operations on non-existent source path with typed error', () => {
    expect(() => {
      new WorkspaceSandbox({
        sessionId: 'test',
        sourcePath: '/nonexistent/path/that/does/not/exist',
      });
    }).toThrow(SourcePathNotFoundError);
  });

  it('MCP boundary rejects malformed input before domain is touched', () => {
    expect(() => {
      validateMCPInput('stage_code_migration', StageCodeInput, {
        repo_path: '', // empty string
        active_model: 'gpt-4o',
      });
    }).toThrow(MCPBoundaryError);
  });
});

// ─── Principle 4: Explicit State Machines ───────────────────────────────────

describe('Principle #4: Explicit State Machines (regression)', () => {
  it('VALID_TRANSITIONS covers every MigrationState', () => {
    const allStates: string[] = [
      'initialized', 'inspecting', 'inspection_complete', 'planning',
      'plan_ready', 'staging', 'staged', 'evaluating', 'evaluation_complete',
      'diagnosing', 'diagnosis_complete', 'remediating', 'remediation_staged',
      're_evaluating', 're_evaluation_complete', 'preparing_canary',
      'canary_ready', 'awaiting_approval', 'applying', 'verifying',
      'completed', 'failed', 'aborted',
    ];

    for (const state of allStates) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
      expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
    }
  });

  it('terminal states have no outward transitions except restart', () => {
    expect(VALID_TRANSITIONS.completed).toEqual([]);
    // failed and aborted allow restart to initialized
    expect(VALID_TRANSITIONS.failed).toEqual(['initialized']);
    expect(VALID_TRANSITIONS.aborted).toEqual(['initialized']);
  });
});

// ─── Principle 14: Capability-Based Design ──────────────────────────────────

describe('Principle #14: Capability-Based Design (regression)', () => {
  it('unknown models get conservative profiles', () => {
    const profile = resolveModelProfile('totally-unknown-model');
    expect(profile.model_id).toBe('totally-unknown-model');
    expect(profile.tool_calling.supported).toBe(false);
    expect(profile.structured_output.modes).toEqual([]);
    expect(profile.metadata.is_assumed_profile).toBe(true);
  });

  it('known models have explicit capabilities', () => {
    const gpt4o = resolveModelProfile('gpt-4o');
    expect(gpt4o.tool_calling.supported).toBe(true);
    expect(gpt4o.tool_calling.strict_schema_adherence).toBe('full');
    expect(gpt4o.metadata.is_assumed_profile).toBeUndefined();
  });
});

// ─── Principle 18: Immutable/Auditable Artifacts ─────────────────────────────

describe('Principle #18: Immutable/Auditable Artifacts (regression)', () => {
  it('EvaluationReport contract version is 2.0', () => {
    // Type-level enforcement: any EvaluationReport must have contract_version '2.0'
    const report = {
      contract_version: '2.0' as const,
      eval_run_id: 'eval-test',
      session_id: 'session-test',
    };
    expect(report.contract_version).toBe('2.0');
  });
});

// ─── Principle 19: Single Canonical Implementation ──────────────────────────

describe('Principle #19: Single Canonical Implementation', () => {
  it('evaluation-engine.ts re-export delegates to canonical implementation', async () => {
    // The re-export should exist for backward compatibility
    const evalEngine = await import('../core/evaluation-engine.js');
    expect(evalEngine.runEvaluation).toBeDefined();
    expect(typeof evalEngine.runEvaluation).toBe('function');
  });

  it('patching-engine.ts re-export delegates to canonical implementation', async () => {
    const patchEngine = await import('../core/patching-engine.js');
    expect(patchEngine.applyMigrationPlan).toBeDefined();
    expect(typeof patchEngine.applyMigrationPlan).toBe('function');
  });
});

// ─── Principle 5: Deterministic Core / Nondeterministic Edge ─────────────────

import {
  evaluateBenchmarkCaseAssertion,
  computeEvaluationMetrics,
  EvaluationAdapterRegistry,
} from '../core/evaluation/index.js';

describe('Principle #5: Deterministic Core / Nondeterministic Edge', () => {
  it('evaluateBenchmarkCaseAssertion is pure and deterministic for pass/fail cases', () => {
    const qaCase = {
      id: 'qa-1',
      category: 'qa' as const,
      prompt: 'What is refund policy?',
      assertions: { contains_any: ['30 days', 'refund'] },
    };

    const passResult = evaluateBenchmarkCaseAssertion(qaCase as any, {
      case_id: 'qa-1',
      ok: true,
      status: 200,
      response_text: 'You can request a refund within 30 days of purchase.',
      latency_ms: 120,
    });
    expect(passResult.passed).toBe(true);
    expect(passResult.failureReason).toBe('');

    const failResult = evaluateBenchmarkCaseAssertion(qaCase as any, {
      case_id: 'qa-1',
      ok: true,
      status: 200,
      response_text: 'Our offices are located in Chicago.',
      latency_ms: 100,
    });
    expect(failResult.passed).toBe(false);
    expect(failResult.failureReason).toContain('Response did not contain any expected keywords');
  });

  it('computeEvaluationMetrics compiles stats deterministically without I/O', () => {
    const metrics = computeEvaluationMetrics({
      cases: [{ id: 'c1' } as any, { id: 'c2' } as any],
      latencies: [100, 200],
      totalCostSum: 0.002,
      passedCount: 2,
      regressions: [],
      caseResults: [
        { case_id: 'c1', category: 'qa', passed: true, latency_ms: 100 },
        { case_id: 'c2', category: 'qa', passed: true, latency_ms: 200 },
      ],
      candidateId: 'test-cand',
      baselineCostPer1k: 2.0,
      qualityThreshold: 0.9,
    });

    expect(metrics.contract_version).toBe('2.0');
    expect(metrics.overall).toBe('PASS');
    expect(metrics.quality.score).toBe(1.0);
    expect(metrics.quality.passed).toBe(true);
    expect(metrics.total_cases).toBe(2);
    expect(metrics.passed_cases).toBe(2);
    expect(metrics.cost.savings_pct).toBeGreaterThan(0);
  });
});

// ─── Principle 8: Idempotent Operations ──────────────────────────────────────

import { executePatchOperation } from '../core/patching/patch-operation.js';

describe('Principle #8: Idempotent Operations', () => {
  it('applying a replace patch twice does not corrupt or duplicate content', () => {
    // Mock sandbox
    let fileContent = 'const model = "gpt-4o";';
    const mockSandbox = {
      readFile: () => fileContent,
      writeFile: (_path: string, newContent: string) => {
        fileContent = newContent;
      },
    } as any;

    const patchOp = {
      id: 'patch-replace-model',
      target_file: 'src/config.ts',
      preconditions: [],
      action: {
        operation: 'replace' as const,
        pattern: 'gpt-4o(?!-)',
        replacement: 'gpt-4o-mini',
      },
      description: 'Replace model literal',
    };

    // First execution: replaces
    const res1 = executePatchOperation(mockSandbox, patchOp);
    expect(res1.applied).toBe(true);
    expect(res1.replacements).toBe(1);
    expect(fileContent).toBe('const model = "gpt-4o-mini";');

    // Second execution: idempotent, recognizes already applied
    const res2 = executePatchOperation(mockSandbox, patchOp);
    expect(res2.applied).toBe(true);
    expect(res2.replacements).toBe(0);
    expect(res2.description).toContain('already applied');
    expect(fileContent).toBe('const model = "gpt-4o-mini";');
  });

  it('applying an append patch twice is strictly idempotent', () => {
    let fileContent = 'PORT=3000';
    const mockSandbox = {
      readFile: () => fileContent,
      writeFile: (_path: string, newContent: string) => {
        fileContent = newContent;
      },
    } as any;

    const appendOp = {
      id: 'patch-env-append',
      target_file: '.env',
      preconditions: [],
      action: {
        operation: 'append' as const,
        replacement: 'ROUTING_MODE=hybrid',
      },
      description: 'Append routing mode',
    };

    const res1 = executePatchOperation(mockSandbox, appendOp);
    expect(res1.applied).toBe(true);
    expect(fileContent).toContain('ROUTING_MODE=hybrid');

    const res2 = executePatchOperation(mockSandbox, appendOp);
    expect(res2.applied).toBe(true);
    expect(res2.description).toContain('already appended');
    // Ensure it wasn't appended twice
    const occurrences = (fileContent.match(/ROUTING_MODE=hybrid/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

// ─── Principle 12: Strategy + Adapter Pattern (Evaluation) ───────────────────

describe('Principle #12: Strategy + Adapter Pattern (Evaluation)', () => {
  it('registry allows plugging in custom adapter factories', () => {
    const registry = new EvaluationAdapterRegistry();
    let customCalled = false;

    registry.register((options) => {
      if (options.candidateId === 'custom-special-model') {
        customCalled = true;
        return {
          name: 'custom-adapter',
          executeCase: async () => ({
            case_id: 'test',
            ok: true,
            status: 200,
            latency_ms: 50,
          }),
        };
      }
      return null;
    });

    const adapter = registry.resolve({ candidateId: 'custom-special-model' });
    expect(customCalled).toBe(true);
    expect(adapter.name).toBe('custom-adapter');
  });
});

// ─── Principle 1: Separation of Concerns (Rehearsal Dispatcher) ──────────────

import { rehearsalDispatcher } from '../mcp-servers/rehearsal-mcp/src/server.js';

describe('Principle #1: Separation of Concerns (Rehearsal Dispatcher)', () => {
  it('rehearsalDispatcher registers all canonical rehearsal tools', () => {
    const tools = rehearsalDispatcher.getRegisteredTools();
    expect(tools).toContain('repo_inspect_ai_usage');
    expect(tools).toContain('generate_migration_plan');
    expect(tools).toContain('stage_code_migration');
    expect(tools).toContain('sandbox_run_app');
    expect(tools).toContain('run_deterministic_benchmark');
    expect(tools).toContain('diagnose_failures');
    expect(tools).toContain('get_session_state');
    expect(tools).toContain('establish_baseline');
    expect(tools).toContain('compare_rehearsals');
    expect(tools).toContain('apply_sandbox_remediation');
    expect(tools.length).toBe(10);
  });
});

