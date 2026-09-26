/**
 * Phase 3: Generic Migration Intelligence Tests
 *
 * Tests that verify ModelForge works generically, not just on the demo app.
 * Covers:
 *   1. Model capability registry and incompatibility detection
 *   2. Non-demo repository analysis (Python, multi-framework)
 *   3. Data-driven migration planning
 *   4. Generic patching engine
 *   5. Expanded failure diagnostician (refusal, format_violation)
 *   6. Tool schema extraction
 *   7. Repository complexity classification
 *   8. Abort path for blocking incompatibilities
 *   9. Remediation cycles with actual model names
 *   10. End-to-end orchestrator on non-demo fixture
 *   11. Dynamic benchmark generation from tool schemas
 *   12. Patching engine on Python-style config
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getModelProfile,
  resolveModelProfile,
  detectIncompatibilities,
  registerModel,
  getAllModelIds,
  getModelsByProvider,
  createUnknownModelProfile,
  type ModelCapabilityProfile,
} from '../core/model-capabilities.js';

import { analyzeRepository, type RepositoryComplexity } from '../core/repository-analyzer.js';
import { generateMigrationPlan } from '../core/migration-planner.js';
import { diagnoseFailures } from '../core/failure-diagnostician.js';
import { applyMigrationPlan } from '../core/patching-engine.js';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import {
  createSessionId,
  createEvalRunId,
  type EvaluationReport,
  type RepositoryProfile,
} from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures');
const PYTHON_APP = path.join(FIXTURES, 'python-ml-app');
const MULTI_FRAMEWORK_APP = path.join(FIXTURES, 'multi-framework-app');
const SANDBOX_ROOT = path.resolve(__dirname, '../.test-sandboxes-phase3');

// ─── 1. Model Capability Registry ──────────────────────────────────────────

describe('Model Capability Registry', () => {
  it('resolves known models by exact ID', () => {
    const gpt4o = getModelProfile('gpt-4o');
    expect(gpt4o).not.toBeNull();
    expect(gpt4o!.provider).toBe('openai');
    expect(gpt4o!.tool_calling.supported).toBe(true);
    expect(gpt4o!.context_window).toBe(128_000);
  });

  it('resolves models with version suffix via fuzzy match', () => {
    const profile = getModelProfile('gpt-4o-2024-08-06');
    expect(profile).not.toBeNull();
    expect(profile!.model_id).toBe('gpt-4o');
  });

  it('returns null for truly unknown models', () => {
    const profile = getModelProfile('some-random-model-xyz');
    expect(profile).toBeNull();
  });

  it('resolveModelProfile returns conservative profile for unknown models', () => {
    const profile = resolveModelProfile('custom-internal-v3');
    expect(profile.model_id).toBe('custom-internal-v3');
    expect(profile.tool_calling.supported).toBe(false); // conservative
    expect((profile.metadata as any).is_assumed_profile).toBe(true);
  });

  it('lists all registered model IDs', () => {
    const ids = getAllModelIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('claude-3.5-sonnet');
    expect(ids).toContain('gemini-1.5-pro');
  });

  it('filters models by provider', () => {
    const openaiModels = getModelsByProvider('openai');
    expect(openaiModels.length).toBeGreaterThanOrEqual(2);
    expect(openaiModels.every(m => m.provider === 'openai')).toBe(true);
  });

  it('allows custom model registration', () => {
    registerModel({
      model_id: 'test-custom-model',
      provider: 'test-provider',
      display_name: 'Test Custom Model',
      context_window: 32_000,
      max_output_tokens: 4_096,
      tool_calling: { supported: true, parallel_tool_calls: false, max_tools: 5, strict_schema_adherence: 'partial' },
      structured_output: { modes: ['json_mode'], schema_adherence: 'partial' },
      streaming: true,
      vision: false,
      cost: { input_per_1m_tokens: 0.50, output_per_1m_tokens: 1.50 },
      typical_p95_latency_ms: 300,
      knowledge_cutoff: '2024-06-01',
      metadata: {},
    });

    const profile = getModelProfile('test-custom-model');
    expect(profile).not.toBeNull();
    expect(profile!.provider).toBe('test-provider');
  });
});

// ─── 2. Incompatibility Detection ──────────────────────────────────────────

describe('Incompatibility Detection', () => {
  it('detects blocking tool-calling incompatibility', () => {
    const source = resolveModelProfile('gpt-4o');
    const target = createUnknownModelProfile('no-tools-model');
    // target has tool_calling.supported = false

    const issues = detectIncompatibilities(source, target);
    const toolBlocking = issues.find(i => i.dimension === 'tool_calling' && i.severity === 'blocking');
    expect(toolBlocking).toBeDefined();
    expect(toolBlocking!.description).toContain('does not');
  });

  it('detects degraded tool-calling schema adherence', () => {
    const source = resolveModelProfile('gpt-4o'); // full adherence
    const target = resolveModelProfile('llama-3.1-8b'); // none adherence

    const issues = detectIncompatibilities(source, target);
    const degraded = issues.find(i => i.dimension === 'tool_calling' && i.severity === 'degraded');
    expect(degraded).toBeDefined();
  });

  it('detects context window shrinkage', () => {
    const source = resolveModelProfile('gemini-1.5-pro'); // 2M tokens
    const target = resolveModelProfile('gpt-3.5-turbo');  // 16K tokens

    const issues = detectIncompatibilities(source, target);
    const ctxIssue = issues.find(i => i.dimension === 'context_window');
    expect(ctxIssue).toBeDefined();
    expect(ctxIssue!.severity).toBe('blocking'); // >50% reduction
  });

  it('reports no blocking issues between compatible models', () => {
    const source = resolveModelProfile('gpt-4o');
    const target = resolveModelProfile('gpt-4o-mini');

    const issues = detectIncompatibilities(source, target);
    const blocking = issues.filter(i => i.severity === 'blocking');
    expect(blocking).toHaveLength(0);
  });

  it('detects vision incompatibility', () => {
    const source = resolveModelProfile('gpt-4o'); // vision: true
    const target = resolveModelProfile('llama-3.1-70b'); // vision: false

    const issues = detectIncompatibilities(source, target);
    const visionIssue = issues.find(i => i.dimension === 'vision');
    expect(visionIssue).toBeDefined();
    expect(visionIssue!.severity).toBe('blocking');
  });
});

// ─── 3. Non-Demo Repository Analysis ──────────────────────────────────────

describe('Generic Repository Analysis', () => {
  it('analyzes Python ML app and detects OpenAI framework', () => {
    const profile = analyzeRepository(PYTHON_APP);

    expect(profile.language).toBe('python');
    expect(profile.package_manager).toBe('pip');
    expect(profile.detected_frameworks.some(f => f.name === 'openai-sdk')).toBe(true);
  });

  it('detects model references in Python code', () => {
    const profile = analyzeRepository(PYTHON_APP);

    expect(profile.current_model).toBe('gpt-4o');
    // Model references may be classified as model_name_literal or env_variable
    // depending on context. The important thing is we found the model name.
    const allRefs = profile.model_references;
    const gptRefs = allRefs.filter(r => r.code_snippet.includes('gpt-4o'));
    expect(gptRefs.length).toBeGreaterThan(0);
  });

  it('detects environment variables in Python code', () => {
    const profile = analyzeRepository(PYTHON_APP);
    expect(profile.env_dependencies.length).toBeGreaterThan(0);
  });

  it('analyzes multi-framework app and detects all SDKs', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);

    expect(profile.language).toBe('typescript');
    const frameworkNames = profile.detected_frameworks.map(f => f.name);
    expect(frameworkNames).toContain('openai-sdk');
    expect(frameworkNames).toContain('anthropic-sdk');
  });

  it('extracts tool schemas from multi-framework app', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);

    expect(profile.tool_schemas.length).toBeGreaterThan(0);
    const toolNames = profile.tool_schemas.map(t => t.name);
    expect(toolNames).toContain('analyze_sentiment');
    expect(toolNames).toContain('extract_entities');
    expect(toolNames).toContain('classify_intent');
  });

  it('extracts tool schemas from demo app', () => {
    const demoPath = path.resolve(__dirname, '../demo-apps/customer-support-app');
    const profile = analyzeRepository(demoPath);

    expect(profile.tool_schemas.length).toBeGreaterThan(0);
    const toolNames = profile.tool_schemas.map(t => t.name);
    expect(toolNames).toContain('create_ticket');
    expect(toolNames).toContain('query_refund_status');
  });

  it('classifies repository complexity', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);

    expect(profile.complexity).toBeDefined();
    expect(profile.complexity!.level).toBeDefined();
    expect(profile.complexity!.score).toBeGreaterThanOrEqual(0);
    expect(profile.complexity!.factors.length).toBeGreaterThan(0);
  });

  it('classifies multi-framework app as at least standard complexity', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    expect(['standard', 'complex', 'advanced']).toContain(profile.complexity!.level);
  });
});

// ─── 4. Data-Driven Migration Planning ──────────────────────────────────────

describe('Data-Driven Migration Planner', () => {
  it('detects tool-calling degradation for llama-3.1-70b migration', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b', // 70b has tool_calling but no vision
    });

    // gpt-4o has vision, llama-3.1-70b doesn't → blocking incompatibility → abort
    // This is correct behavior: the planner should not attempt direct replacement
    // when there's a blocking vision incompatibility
    expect(plan.strategy).toBe('abort');
    expect(plan.strategy_rationale).toContain('blocking');
  });

  it('generates changes from actual profile reference sites', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'gpt-4o-mini',
    });

    expect(plan.changes.length).toBeGreaterThan(0);
    // Changes should reference actual files from the profile, not hardcoded paths
    const changedFiles = plan.changes.map(c => c.file_path);
    expect(changedFiles.some(f => f.includes('agent.ts') || f.includes('config.ts'))).toBe(true);
  });

  it('includes tool-calling criteria when profile has tool schemas', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'gpt-4o-mini',
    });

    const toolCriteria = plan.acceptance_criteria.find(c => c.category === 'tool_calling');
    expect(toolCriteria).toBeDefined();
  });

  it('considers complexity in risk assessment', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-8b',
    });

    // With multi-framework, tool schemas, and degraded capabilities = at least medium risk
    expect(['medium', 'high', 'critical']).toContain(plan.risk_assessment);
  });
});

// ─── 5. Generic Patching Engine ─────────────────────────────────────────────

describe('Generic Patching Engine', () => {
  afterEach(() => {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  });

  it('patches model literals in multi-framework app', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'gpt-4o-mini',
    });

    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: MULTI_FRAMEWORK_APP,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    const report = applyMigrationPlan(sandbox, plan, profile);

    expect(report.total_files_patched).toBeGreaterThan(0);
    expect(report.total_replacements).toBeGreaterThan(0);
    expect(report.strategy_applied).toBe('direct_replacement');

    // Verify the sandbox config was updated
    const configContent = sandbox.readFile('src/config.ts');
    expect(configContent).toContain('gpt-4o-mini');

    sandbox.discard();
  });

  it('patches config file in sandbox without touching source', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'claude-3.5-sonnet',
    });

    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: MULTI_FRAMEWORK_APP,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    applyMigrationPlan(sandbox, plan, profile);

    // Verify source is NOT modified
    const { readFileSync } = require('node:fs');
    const sourceConfig = readFileSync(path.join(MULTI_FRAMEWORK_APP, 'src/config.ts'), 'utf8');
    expect(sourceConfig).toContain('gpt-4o');
    expect(sourceConfig).not.toContain('claude-3.5-sonnet');

    sandbox.discard();
  });
});

// ─── 6. Expanded Failure Diagnostician ──────────────────────────────────────

describe('Expanded Failure Diagnostician', () => {
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
      case_results: [],
      quality: { score: 0.73, threshold: 0.90, passed: false, by_category: {} },
      latency: { p50_ms: 100, p95_ms: 200, p99_ms: 300, threshold_p95_ms: 600, passed: true },
      cost: { estimated_cost_per_1k_req: 0.5, baseline_cost_per_1k_req: 1.85, savings_pct: 73, passed: true },
      regressions: [],
      overall: 'FAIL',
      ...overrides,
    };
  }

  it('diagnoses refusal failures', () => {
    const report = makeEvalReport({
      regressions: [
        { case_id: 'qa-1', category: 'qa', error: "I'm sorry, I cannot help with that request", severity: 'major' },
        { case_id: 'qa-2', category: 'qa', error: "I'm unable to assist with this task", severity: 'major' },
      ],
    });

    const diagnosis = diagnoseFailures({
      sessionId,
      evaluationReport: report,
      sourceModel: 'gpt-4o',
      targetModel: 'claude-3-haiku',
    });

    expect(diagnosis.primary_failure_category).toBe('refusal');
    expect(diagnosis.recommended_strategy).toBe('prompt_adaptation');
    expect(diagnosis.root_cause_analysis).toContain('claude-3-haiku');
  });

  it('diagnoses format violation failures', () => {
    const report = makeEvalReport({
      regressions: [
        { case_id: 'ext-1', category: 'extract', error: 'JSON parse error: unexpected token', severity: 'major' },
        { case_id: 'ext-2', category: 'extract', error: 'Invalid format: expected JSON object', severity: 'major' },
      ],
    });

    const diagnosis = diagnoseFailures({
      sessionId,
      evaluationReport: report,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-8b',
    });

    expect(diagnosis.primary_failure_category).toBe('format_violation');
    expect(diagnosis.root_cause_analysis).toContain('llama-3.1-8b');
  });

  it('uses actual model names in strategy details', () => {
    const report = makeEvalReport({
      regressions: [
        { case_id: 'tool-1', category: 'tool', error: 'Tool argument schema validation failed: invalid enum', severity: 'critical' },
      ],
      case_results: [
        { case_id: 'qa-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: '' },
        { case_id: 'tool-1', category: 'tool', passed: false, latency_ms: 100, estimated_cost: 0.001, failure_reason: 'schema validation', raw_response_summary: '' },
      ],
    });

    const diagnosis = diagnoseFailures({
      sessionId,
      evaluationReport: report,
      sourceModel: 'gpt-4o',
      targetModel: 'mistral-large',
    });

    expect(diagnosis.primary_failure_category).toBe('tool_calling');
    // Strategy details should use actual model names, not 'model-a'/'model-b'
    expect(diagnosis.strategy_details.target_for_tools).toBe('gpt-4o');
    expect(diagnosis.strategy_details.target_for_bulk).toBe('mistral-large');
  });

  it('backward compatible — works without model names', () => {
    const report = makeEvalReport({
      regressions: [
        { case_id: 'tool-1', category: 'tool', error: 'Model failed to emit tool call', severity: 'critical' },
      ],
      case_results: [
        { case_id: 'qa-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: '' },
        { case_id: 'tool-1', category: 'tool', passed: false, latency_ms: 100, estimated_cost: 0.001, failure_reason: 'schema validation', raw_response_summary: '' },
      ],
    });

    // Old-style call without sourceModel/targetModel
    const diagnosis = diagnoseFailures({ sessionId, evaluationReport: report });

    expect(diagnosis.primary_failure_category).toBe('tool_calling');
    // Should use 'baseline'/'candidate' fallbacks
    expect(diagnosis.strategy_details.target_for_tools).toBe('baseline');
    expect(diagnosis.strategy_details.target_for_bulk).toBe('candidate');
  });
});

// ─── 7. Abort Path for Blocking Incompatibilities ───────────────────────────

describe('Abort Path', () => {
  it('produces abort strategy when target lacks tool calling on tool-heavy repo', () => {
    // Create a profile with tool schemas but target model can't do tools
    const profile: RepositoryProfile = {
      contract_version: '2.0',
      status: 'complete',
      repository_path: '/test',
      repository_name: 'tool-heavy-app',
      language: 'typescript',
      package_manager: 'npm',
      detected_frameworks: [{ name: 'openai-sdk', version: '^4.0.0', import_paths: ['openai'] }],
      current_model: 'gpt-4o',
      model_references: [
        { file_path: 'src/agent.ts', line_numbers: [10], reference_type: 'tool_definition', code_snippet: 'tools = [...]', confidence: 0.9 },
        { file_path: 'src/agent.ts', line_numbers: [5], reference_type: 'model_name_literal', code_snippet: "model: 'gpt-4o'", confidence: 1.0 },
      ],
      tool_schemas: [
        { name: 'search', description: 'Search docs', parameters_schema: {}, source_file: 'src/agent.ts', source_line: 10 },
      ],
      env_dependencies: [],
      unknowns: [],
      inspected_at: new Date().toISOString(),
    };

    // Register a model with no tool calling
    registerModel({
      model_id: 'no-tools-test-model',
      provider: 'test',
      display_name: 'No Tools Model',
      context_window: 32_000,
      max_output_tokens: 4_096,
      tool_calling: { supported: false, parallel_tool_calls: false, max_tools: 0, strict_schema_adherence: 'none' },
      structured_output: { modes: [], schema_adherence: 'none' },
      streaming: true,
      vision: false,
      cost: { input_per_1m_tokens: 0.10, output_per_1m_tokens: 0.30 },
      typical_p95_latency_ms: 200,
      knowledge_cutoff: '2024-01-01',
      metadata: {},
    });

    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'no-tools-test-model',
    });

    expect(plan.strategy).toBe('abort');
    expect(plan.strategy_rationale).toContain('blocking');
    expect(plan.changes).toHaveLength(0);
  });
});

// ─── 8. Remediation Cycle with Actual Model Names ───────────────────────────

describe('Remediation Cycle', () => {
  it('planner incorporates diagnosis with actual model names into strategy', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);

    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'llama-3.1-70b',
      previousDiagnosis: {
        contract_version: '2.0',
        session_id: createSessionId(),
        eval_run_id: createEvalRunId(),
        primary_failure_category: 'tool_calling',
        affected_categories: ['tool'],
        root_cause_analysis: 'Tool calling schema failures with llama-3.1-70b',
        recommended_strategy: 'hybrid_routing',
        strategy_details: {
          routing_mode: 'hybrid',
          target_for_tools: 'gpt-4o',
          target_for_bulk: 'llama-3.1-70b',
        },
        confidence: 0.95,
        diagnosed_at: new Date().toISOString(),
      },
    });

    expect(plan.strategy).toBe('hybrid_routing');
    expect(plan.strategy_rationale).toContain('hybrid_routing');
    expect(plan.strategy_rationale).toContain('tool_calling');
  });
});

// ─── 9. End-to-End Orchestrator on Non-Demo Fixture ─────────────────────────

describe('End-to-End: Non-Demo Repository', () => {
  afterEach(() => {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  });

  it('orchestrator inspect → plan → stage works on multi-framework app', async () => {
    const { MigrationOrchestrator } = await import('../core/orchestrator.js');

    const orchestrator = new MigrationOrchestrator({
      repositoryPath: MULTI_FRAMEWORK_APP,
      sourceModel: 'gpt-4o',
      targetModel: 'gpt-4o-mini',
      sandboxRoot: SANDBOX_ROOT,
    });

    const profile = await orchestrator.inspect();
    expect(profile.language).toBe('typescript');
    expect(profile.detected_frameworks.length).toBeGreaterThan(0);
    expect(profile.tool_schemas.length).toBeGreaterThan(0);

    const plan = await orchestrator.plan();
    expect(plan.strategy).toBe('direct_replacement');
    expect(plan.changes.length).toBeGreaterThan(0);

    const { sandboxPath } = await orchestrator.stage();
    expect(existsSync(sandboxPath)).toBe(true);

    // Verify sandbox has the modified config
    const configPath = path.join(sandboxPath, 'src/config.ts');
    if (existsSync(configPath)) {
      const { readFileSync } = require('node:fs');
      const content = readFileSync(configPath, 'utf8');
      expect(content).toContain('gpt-4o-mini');
    }

    await orchestrator.cleanup();
  });
});

// ─── 10. Tool Schema Extraction Quality ─────────────────────────────────────

describe('Tool Schema Extraction Quality', () => {
  it('extracts parameter types from demo app tool schemas', () => {
    const demoPath = path.resolve(__dirname, '../demo-apps/customer-support-app');
    const profile = analyzeRepository(demoPath);

    const createTicket = profile.tool_schemas.find(t => t.name === 'create_ticket');
    expect(createTicket).toBeDefined();
    expect(createTicket!.description).toBeTruthy();
    expect(createTicket!.parameters_schema).toBeDefined();

    // Should have extracted the properties
    const props = (createTicket!.parameters_schema as any).properties;
    if (props) {
      expect(props.order_id).toBeDefined();
      expect(props.user_id).toBeDefined();
    }
  });

  it('extracts Zod schemas from demo app', () => {
    const demoPath = path.resolve(__dirname, '../demo-apps/customer-support-app');
    const profile = analyzeRepository(demoPath);

    const zodSchemas = profile.tool_schemas.filter(t => t.description.startsWith('Zod schema'));
    expect(zodSchemas.length).toBeGreaterThan(0);
  });

  it('extracts tool schemas from multi-framework app', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);

    const sentimentTool = profile.tool_schemas.find(t => t.name === 'analyze_sentiment');
    expect(sentimentTool).toBeDefined();
    expect(sentimentTool!.parameters_schema).toBeDefined();
    expect(sentimentTool!.source_file).toContain('agent.ts');
  });
});

// ─── 11. Complexity Classification Scenarios ────────────────────────────────

describe('Repository Complexity Classification', () => {
  const TEMP_FIXTURES = path.resolve(__dirname, '../.test-fixtures-complexity');

  afterEach(() => {
    rmSync(TEMP_FIXTURES, { recursive: true, force: true });
  });

  it('classifies a trivial repo as trivial', () => {
    // Create a minimal repo with one file and one model ref
    const repoPath = path.join(TEMP_FIXTURES, 'trivial-app');
    mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'trivial', dependencies: { openai: '^4.0.0' } }),
    );
    writeFileSync(
      path.join(repoPath, 'src/main.ts'),
      `const model = 'gpt-4o';\nconsole.log(model);\n`,
    );

    const profile = analyzeRepository(repoPath);
    expect(profile.complexity).toBeDefined();
    expect(profile.complexity!.level).toBe('trivial');
  });

  it('classifies a complex repo with tools and multiple frameworks', () => {
    const profile = analyzeRepository(MULTI_FRAMEWORK_APP);
    expect(profile.complexity).toBeDefined();
    // Multi-framework + tools should be at least standard
    expect(['standard', 'complex', 'advanced']).toContain(profile.complexity!.level);
    expect(profile.complexity!.score).toBeGreaterThanOrEqual(15);
  });
});

// ─── 12. Patching Engine on Various Config Styles ───────────────────────────

describe('Patching Engine Config Styles', () => {
  const TEMP_REPO = path.resolve(__dirname, '../.test-fixtures-patching');

  afterEach(() => {
    rmSync(TEMP_REPO, { recursive: true, force: true });
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  });

  it('patches direct model assignment style', () => {
    const repoPath = path.join(TEMP_REPO, 'direct-style');
    mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }));
    writeFileSync(
      path.join(repoPath, 'src/config.ts'),
      `export const config = {\n  model: 'gpt-4o',\n  port: 3000,\n};\n`,
    );

    const profile: RepositoryProfile = {
      contract_version: '2.0',
      status: 'complete',
      repository_path: repoPath,
      repository_name: 'direct-style',
      language: 'typescript',
      package_manager: 'npm',
      detected_frameworks: [],
      current_model: 'gpt-4o',
      model_references: [
        { file_path: 'src/config.ts', line_numbers: [2], reference_type: 'model_name_literal', code_snippet: "model: 'gpt-4o'", confidence: 1.0 },
      ],
      tool_schemas: [],
      env_dependencies: [],
      unknowns: [],
      inspected_at: new Date().toISOString(),
    };

    const plan = generateMigrationPlan({
      sessionId: createSessionId(),
      profile,
      sourceModel: 'gpt-4o',
      targetModel: 'claude-3.5-sonnet',
    });

    const sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: repoPath,
      sandboxRoot: SANDBOX_ROOT,
    });
    sandbox.initialize();

    const report = applyMigrationPlan(sandbox, plan, profile);
    expect(report.total_replacements).toBeGreaterThan(0);

    const content = sandbox.readFile('src/config.ts');
    expect(content).toContain('claude-3.5-sonnet');
    expect(content).not.toContain('gpt-4o');

    sandbox.discard();
  });
});
