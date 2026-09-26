/**
 * Migration Planner
 *
 * Takes a RepositoryProfile and produces a MigrationPlan. The planner:
 *
 *   1. Consults the model capability registry to detect incompatibilities
 *   2. Determines the routing strategy based on profile data + capabilities
 *   3. Generates specific code changes from actual ModelReference sites
 *   4. Sets acceptance criteria informed by model capabilities
 *
 * The planner is data-driven: it never hardcodes file paths or model names.
 */

import type {
  RepositoryProfile,
  MigrationPlan,
  PlannedChange,
  AcceptanceCriterion,
  RoutingStrategy,
  SessionId,
  FailureDiagnosis,
} from './types.js';

import {
  resolveModelProfile,
  detectIncompatibilities,
  type ModelIncompatibility,
} from './model-capabilities.js';

// ─── Planner Interface ───────────────────────────────────────────────────────

export interface PlannerInput {
  sessionId: SessionId;
  profile: RepositoryProfile;
  sourceModel: string;
  targetModel: string;
  /** Optional previous diagnosis to incorporate into the plan */
  previousDiagnosis?: FailureDiagnosis;
}

/**
 * Generate a migration plan based on repository analysis.
 *
 * If a previous diagnosis is provided (remediation round), the planner
 * incorporates the recommended strategy from the diagnostician.
 *
 * The planner now checks the model capability registry for known
 * incompatibilities to make a data-driven strategy recommendation.
 */
export function generateMigrationPlan(input: PlannerInput): MigrationPlan {
  const { sessionId, profile, sourceModel, targetModel, previousDiagnosis } = input;

  // Resolve model capabilities
  const sourceProfile = resolveModelProfile(sourceModel);
  const targetProfile = resolveModelProfile(targetModel);
  const incompatibilities = detectIncompatibilities(sourceProfile, targetProfile);

  // Determine strategy
  let strategy: RoutingStrategy;
  let strategyRationale: string;

  if (previousDiagnosis) {
    // Remediation round — use the diagnostician's recommended strategy
    strategy = mapRemediationToRouting(previousDiagnosis.recommended_strategy);
    strategyRationale = buildRemediationRationale(previousDiagnosis);
  } else {
    // First round — data-driven strategy selection
    const selected = selectInitialStrategy(profile, incompatibilities, sourceModel, targetModel);
    strategy = selected.strategy;
    strategyRationale = selected.rationale;
  }

  // Generate planned changes from profile data
  const changes = generateChanges(profile, sourceModel, targetModel, strategy);

  // Set acceptance criteria informed by capabilities
  const criteria = generateAcceptanceCriteria(strategy, profile, incompatibilities);

  // Assess risk
  const risk = assessRisk(profile, strategy, incompatibilities);

  return {
    contract_version: '2.0',
    session_id: sessionId,
    title: `Migrate ${profile.repository_name} from ${sourceModel} to ${targetModel}`,
    source_model: sourceModel,
    target_model: targetModel,
    strategy,
    strategy_rationale: strategyRationale,
    changes,
    acceptance_criteria: criteria,
    risk_assessment: risk,
    planned_at: new Date().toISOString(),
  };
}

// ─── Strategy Selection ──────────────────────────────────────────────────────

interface StrategySelection {
  strategy: RoutingStrategy;
  rationale: string;
}

/**
 * Select the initial migration strategy based on:
 *   1. Known model incompatibilities from the capability registry
 *   2. Repository complexity signals (tool definitions, prompt templates)
 *   3. If no incompatibilities detected → direct replacement
 */
function selectInitialStrategy(
  profile: RepositoryProfile,
  incompatibilities: ModelIncompatibility[],
  sourceModel: string,
  targetModel: string,
): StrategySelection {
  // Check for blocking incompatibilities
  const blocking = incompatibilities.filter(i => i.severity === 'blocking');
  if (blocking.length > 0) {
    const blockingDimensions = blocking.map(i => i.dimension).join(', ');
    return {
      strategy: 'abort',
      rationale:
        `Migration from "${sourceModel}" to "${targetModel}" has blocking incompatibilities: ` +
        `${blockingDimensions}. ${blocking.map(i => i.description).join(' ')}`,
    };
  }

  // Check for degraded tool-calling — suggest hybrid routing
  const toolDegraded = incompatibilities.filter(
    i => i.dimension === 'tool_calling' && i.severity === 'degraded',
  );
  const hasToolSchemas = profile.tool_schemas.length > 0;
  const hasToolRefs = profile.model_references.some(r => r.reference_type === 'tool_definition');

  if (toolDegraded.length > 0 && (hasToolSchemas || hasToolRefs)) {
    return {
      strategy: 'direct_replacement',
      rationale:
        `Initial migration attempt using direct model replacement. ` +
        `Note: the capability registry indicates degraded tool-calling adherence ` +
        `for "${targetModel}" (${toolDegraded.map(i => i.description).join(' ')}). ` +
        `If tool-calling regressions are detected in evaluation, the system will ` +
        `recommend hybrid routing to route tool tasks to "${sourceModel}".`,
    };
  }

  // Check for structured output degradation
  const structuredDegraded = incompatibilities.filter(
    i => i.dimension === 'structured_output' && i.severity === 'degraded',
  );
  const hasExtractRefs = profile.model_references.some(
    r => r.code_snippet.toLowerCase().includes('structured') ||
         r.code_snippet.toLowerCase().includes('extract') ||
         r.code_snippet.toLowerCase().includes('json'),
  );

  if (structuredDegraded.length > 0 && hasExtractRefs) {
    return {
      strategy: 'direct_replacement',
      rationale:
        `Initial migration attempt using direct replacement. ` +
        `Capability registry warns of degraded structured output for "${targetModel}". ` +
        `If structured extraction regressions are detected, prompt adaptation will be recommended.`,
    };
  }

  // No known incompatibilities — direct replacement as initial hypothesis
  const infoIssues = incompatibilities.filter(i => i.severity === 'informational');
  const infoNote = infoIssues.length > 0
    ? ` Informational notes: ${infoIssues.map(i => i.description).join('; ')}.`
    : '';

  return {
    strategy: 'direct_replacement',
    rationale:
      `Initial migration attempt using direct model replacement. ` +
      `Source model "${sourceModel}" will be replaced with "${targetModel}" across all references. ` +
      `If tool-calling or structured output regressions are detected, the system will ` +
      `autonomously diagnose and suggest a remediation strategy (e.g., hybrid routing).` +
      infoNote,
  };
}

// ─── Change Generation ───────────────────────────────────────────────────────

function generateChanges(
  profile: RepositoryProfile,
  sourceModel: string,
  targetModel: string,
  strategy: RoutingStrategy,
): PlannedChange[] {
  const changes: PlannedChange[] = [];

  if (strategy === 'abort') return changes;

  // Group references by file
  const fileRefs = new Map<string, typeof profile.model_references>();
  for (const ref of profile.model_references) {
    const existing = fileRefs.get(ref.file_path) ?? [];
    existing.push(ref);
    fileRefs.set(ref.file_path, existing);
  }

  for (const [filePath, refs] of fileRefs) {
    // Model name literal changes
    const modelLiterals = refs.filter(r => r.reference_type === 'model_name_literal');
    if (modelLiterals.length > 0) {
      changes.push({
        file_path: filePath,
        description: `Replace model identifier "${sourceModel}" with "${targetModel}" in ${modelLiterals.length} location(s)`,
        rationale: strategy === 'direct_replacement'
          ? 'Direct model swap — all model references updated'
          : 'Active model updated for non-tool-calling paths',
        line_range: modelLiterals.length > 0
          ? { start: Math.min(...modelLiterals.flatMap(r => r.line_numbers)), end: Math.max(...modelLiterals.flatMap(r => r.line_numbers)) }
          : null,
        risk: 'low',
      });
    }

    // Config file changes
    const configRefs = refs.filter(r => r.reference_type === 'config_file' || r.reference_type === 'env_variable');
    if (configRefs.length > 0) {
      changes.push({
        file_path: filePath,
        description: `Update configuration: active_model → "${targetModel}"`,
        rationale: 'Configuration change to point to the candidate model',
        line_range: configRefs.length > 0
          ? { start: Math.min(...configRefs.flatMap(r => r.line_numbers)), end: Math.max(...configRefs.flatMap(r => r.line_numbers)) }
          : null,
        risk: 'low',
      });
    }
  }

  // Strategy-specific changes
  if (strategy === 'hybrid_routing') {
    const configFile = inferConfigFile(profile);
    changes.push({
      file_path: configFile,
      description: 'Enable hybrid routing mode in application configuration',
      rationale:
        `Hybrid routing splits traffic: tool-calling tasks use the reliable baseline model ("${sourceModel}"), ` +
        `while bulk QA/summarization/extraction use the cost-efficient candidate model ("${targetModel}").`,
      line_range: null,
      risk: 'medium',
    });
  }

  if (strategy === 'prompt_adaptation') {
    // Find prompt template files
    const promptFiles = profile.model_references
      .filter(r => r.reference_type === 'prompt_template')
      .map(r => r.file_path);
    const uniquePromptFiles = [...new Set(promptFiles)];

    for (const filePath of uniquePromptFiles) {
      changes.push({
        file_path: filePath,
        description: 'Adapt system prompts for candidate model compatibility',
        rationale: `The candidate model "${targetModel}" may interpret prompts differently — adding explicit constraints`,
        line_range: null,
        risk: 'medium',
      });
    }
  }

  if (strategy === 'schema_simplification' && profile.tool_schemas.length > 0) {
    const toolFiles = [...new Set(profile.tool_schemas.map(s => s.source_file))];
    for (const filePath of toolFiles) {
      changes.push({
        file_path: filePath,
        description: 'Simplify tool schemas for target model compatibility',
        rationale: `The target model "${targetModel}" has limited schema adherence — simplifying tool parameter definitions`,
        line_range: null,
        risk: 'high',
      });
    }
  }

  return changes;
}

// ─── Acceptance Criteria ─────────────────────────────────────────────────────

function generateAcceptanceCriteria(
  strategy: RoutingStrategy,
  profile: RepositoryProfile,
  incompatibilities: ModelIncompatibility[],
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [
    {
      id: 'quality-overall',
      description: 'Overall quality score must meet threshold',
      category: 'quality',
      threshold: '>= 0.90',
      required: true,
    },
    {
      id: 'latency-p95',
      description: 'P95 latency must be within threshold',
      category: 'latency',
      threshold: '< 600ms',
      required: true,
    },
    {
      id: 'cost-savings',
      description: 'Cost savings should be positive',
      category: 'cost',
      threshold: '> 0%',
      required: false,
    },
  ];

  if (strategy === 'hybrid_routing') {
    criteria.push({
      id: 'tool-calling-100',
      description: 'Tool calling must achieve 100% pass rate under hybrid routing',
      category: 'tool_calling',
      threshold: '= 1.00',
      required: true,
    });
  }

  if (strategy === 'direct_replacement') {
    // If the profile has tool schemas, add tool-calling criteria
    const hasTools = profile.tool_schemas.length > 0 ||
      profile.model_references.some(r => r.reference_type === 'tool_definition');

    if (hasTools) {
      criteria.push({
        id: 'tool-calling-baseline',
        description: 'Tool calling pass rate must match baseline',
        category: 'tool_calling',
        threshold: '>= 0.90',
        required: true,
      });
    }

    criteria.push({
      id: 'structured-output',
      description: 'Structured extraction must match baseline accuracy',
      category: 'structured_output',
      threshold: '>= 0.90',
      required: true,
    });
  }

  return criteria;
}

// ─── Risk Assessment ─────────────────────────────────────────────────────────

function assessRisk(
  profile: RepositoryProfile,
  strategy: RoutingStrategy,
  incompatibilities: ModelIncompatibility[],
): 'low' | 'medium' | 'high' | 'critical' {
  let riskScore = 0;

  // More model references = higher coupling = higher risk
  if (profile.model_references.length > 20) riskScore += 2;
  else if (profile.model_references.length > 10) riskScore += 1;

  // Tool definitions increase risk (tool-calling is fragile across models)
  const toolRefs = profile.model_references.filter(r => r.reference_type === 'tool_definition');
  if (toolRefs.length > 0) riskScore += 2;

  // Multiple frameworks = complex migration
  if (profile.detected_frameworks.length > 1) riskScore += 1;

  // Direct replacement with tool schemas = high risk
  if (strategy === 'direct_replacement' && toolRefs.length > 0) riskScore += 1;

  // Hybrid routing is generally safer
  if (strategy === 'hybrid_routing') riskScore -= 1;

  // Known incompatibilities increase risk
  const degradedCount = incompatibilities.filter(i => i.severity === 'degraded').length;
  riskScore += degradedCount;

  // Repository complexity
  if (profile.complexity) {
    if (profile.complexity.level === 'advanced') riskScore += 2;
    else if (profile.complexity.level === 'complex') riskScore += 1;
  }

  if (riskScore >= 5) return 'critical';
  if (riskScore >= 3) return 'high';
  if (riskScore >= 1) return 'medium';
  return 'low';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapRemediationToRouting(strategy: string): RoutingStrategy {
  switch (strategy) {
    case 'hybrid_routing': return 'hybrid_routing';
    case 'prompt_adaptation': return 'prompt_adaptation';
    case 'schema_simplification': return 'schema_simplification';
    case 'abort_migration': return 'abort';
    default: return 'direct_replacement';
  }
}

function buildRemediationRationale(diagnosis: FailureDiagnosis): string {
  return (
    `Remediation based on diagnosis of ${diagnosis.primary_failure_category} failures. ` +
    `Root cause: ${diagnosis.root_cause_analysis} ` +
    `Recommended strategy: ${diagnosis.recommended_strategy} ` +
    `(confidence: ${(diagnosis.confidence * 100).toFixed(0)}%).`
  );
}

function inferConfigFile(profile: RepositoryProfile): string {
  // Look for config files in model references
  const configRef = profile.model_references.find(
    r => r.file_path.includes('config') && r.reference_type !== 'import_statement'
  );
  if (configRef) return configRef.file_path;

  // Default paths by language
  if (profile.language === 'typescript' || profile.language === 'javascript') {
    return 'src/config.ts';
  }
  return 'config.py';
}
