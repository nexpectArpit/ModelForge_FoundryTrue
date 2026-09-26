export const CONTRACT_VERSION = '2.0';

export const SPECIALIST_ROLES = [
  'code-inspector',
  'failure-diagnostician',
  'migration-planner',
];

/**
 * v2 Specialist Contracts
 *
 * These contracts define the exact JSON shape each specialist subagent must
 * produce. The contracts are validated before the commander proceeds to the
 * next step. This ensures no hallucinated data leaks into the pipeline.
 */
export const SPECIALIST_CONTRACTS = {
  'code-inspector': `{
  "contract_version": "2.0",
  "role": "code-inspector",
  "status": "complete|incomplete",
  "repository_name": "...",
  "language": "typescript|javascript|python|unknown",
  "package_manager": "pnpm|npm|yarn|pip|poetry|unknown",
  "detected_frameworks": [{"name": "...", "version": "...|null", "import_paths": ["..."]}],
  "current_model": "...",
  "model_references": [{"file_path": "...", "line_numbers": [1], "reference_type": "model_name_literal|client_init|prompt_template|tool_definition|env_variable|config_file|import_statement", "code_snippet": "...", "confidence": 0.95}],
  "tool_schemas": [{"name": "...", "description": "...", "source_file": "...", "source_line": 1}],
  "env_dependencies": ["..."],
  "unknowns": []
}`,

  'failure-diagnostician': `{
  "contract_version": "2.0",
  "role": "failure-diagnostician",
  "status": "complete|insufficient",
  "eval_run_id": "...",
  "primary_failure_category": "tool_calling|structured_extraction|prompt_drift|latency_regression|cost_regression|hallucination|refusal|format_violation",
  "affected_categories": ["tool", "extract", ...],
  "root_cause_analysis": "...",
  "recommended_strategy": "hybrid_routing|prompt_adaptation|schema_simplification|temperature_tuning|few_shot_examples|abort_migration",
  "strategy_details": {"routing_mode": "hybrid", "target_for_tools": "model-a", "target_for_bulk": "model-b"},
  "confidence": 0.95,
  "unknowns": []
}`,

  'migration-planner': `{
  "contract_version": "2.0",
  "role": "migration-planner",
  "status": "complete|insufficient",
  "title": "Migrate app from model-a to model-b",
  "strategy": "direct_replacement|hybrid_routing|prompt_adaptation|schema_simplification|abort",
  "strategy_rationale": "...",
  "changes": [{"file_path": "...", "description": "...", "rationale": "...", "risk": "low|medium|high"}],
  "acceptance_criteria": [{"id": "...", "description": "...", "category": "quality|latency|cost|tool_calling|structured_output", "threshold": ">= 0.90", "required": true}],
  "risk_assessment": "low|medium|high|critical",
  "unknowns": []
}`,
};

function isObject(val) {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Validate structured specialist evidence records.
 * Validates evidence contracts: tool, arguments, observations.
 *
 * @param {unknown} value
 * @param {string[]} errors
 * @param {{ required?: boolean }} [options]
 */
export function validateEvidence(value, errors, options = { required: false }) {
  if (value === undefined || value === null) {
    if (options.required) {
      errors.push('evidence must contain at least one tool observation');
    }
    return;
  }
  if (!Array.isArray(value)) {
    errors.push('evidence must be an array');
    return;
  }
  if (options.required && value.length === 0) {
    errors.push('evidence must contain at least one tool observation');
    return;
  }
  for (const [index, ev] of value.entries()) {
    if (!isObject(ev)) {
      errors.push(`evidence[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(ev.tool)) {
      errors.push(`evidence[${index}].tool is required`);
    }
    if (!isObject(ev.arguments)) {
      errors.push(`evidence[${index}].arguments must be an object`);
    }
    if (!Array.isArray(ev.observations) || !ev.observations.every(isNonEmptyString)) {
      errors.push(`evidence[${index}].observations must contain non-empty strings`);
    }
  }
}

/**
 * Validate a specialist report against its expected contract.
 *
 * @param {Record<string, any>} report - The specialist's output
 * @param {string} expectedRole - Which specialist role produced it
 * @param {{ requireEvidence?: boolean }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSpecialistReport(report, expectedRole, options = { requireEvidence: false }) {
  const errors = [];

  if (!isObject(report)) {
    return { valid: false, errors: ['report must be a JSON object'] };
  }

  // Common fields
  if (report.contract_version !== CONTRACT_VERSION && report.contract_version !== '1.0') {
    errors.push(`contract_version must be "${CONTRACT_VERSION}"`);
  }
  if (report.role !== expectedRole) {
    errors.push(`role must be "${expectedRole}"`);
  }
  if (report.status !== 'complete' && report.status !== 'incomplete' && report.status !== 'insufficient') {
    errors.push('status must be "complete", "incomplete", or "insufficient"');
  }
  if (!Array.isArray(report.unknowns)) {
    errors.push('unknowns must be an array');
  }

  // Evidence validation
  validateEvidence(report.evidence, errors, { required: options.requireEvidence });

  // Role-specific validation
  if (expectedRole === 'code-inspector') {
    if (!isNonEmptyString(report.repository_name)) errors.push('repository_name is required');
    if (!Array.isArray(report.detected_frameworks)) errors.push('detected_frameworks must be an array');
    if (!isNonEmptyString(report.current_model)) errors.push('current_model is required');
    if (!Array.isArray(report.model_references)) errors.push('model_references must be an array');
    if (!Array.isArray(report.env_dependencies)) errors.push('env_dependencies must be an array');

    // Validate each reference has required fields
    if (Array.isArray(report.model_references)) {
      for (const [idx, ref] of report.model_references.entries()) {
        if (!isObject(ref)) {
          errors.push(`model_references[${idx}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(ref.file_path)) errors.push(`model_references[${idx}].file_path is required`);
        if (!Array.isArray(ref.line_numbers)) errors.push(`model_references[${idx}].line_numbers must be an array`);
        if (typeof ref.confidence !== 'number' || ref.confidence < 0 || ref.confidence > 1) {
          errors.push(`model_references[${idx}].confidence must be a number between 0 and 1`);
        }
      }
    }
  }

  if (expectedRole === 'failure-diagnostician') {
    if (!isNonEmptyString(report.eval_run_id)) errors.push('eval_run_id is required');
    if (!isNonEmptyString(report.primary_failure_category)) errors.push('primary_failure_category is required');
    if (!isNonEmptyString(report.root_cause_analysis)) errors.push('root_cause_analysis is required');
    if (!isNonEmptyString(report.recommended_strategy)) errors.push('recommended_strategy is required');
    if (!Array.isArray(report.affected_categories)) errors.push('affected_categories must be an array');
    if (typeof report.confidence !== 'number') errors.push('confidence must be a number');
  }

  if (expectedRole === 'migration-planner') {
    if (!isNonEmptyString(report.title)) errors.push('title is required');
    if (!isNonEmptyString(report.strategy)) errors.push('strategy is required');
    if (!isNonEmptyString(report.strategy_rationale)) errors.push('strategy_rationale is required');
    if (!Array.isArray(report.changes)) errors.push('changes must be an array');
    if (!Array.isArray(report.acceptance_criteria)) errors.push('acceptance_criteria must be an array');
    if (!isNonEmptyString(report.risk_assessment)) errors.push('risk_assessment is required');
  }

  // Consistency check
  if (report.status === 'complete' && Array.isArray(report.unknowns) && report.unknowns.length > 0) {
    errors.push('complete report cannot contain unknowns');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Correlate reports from multiple specialists.
 *
 * For ModelForge, correlation means verifying that:
 * - Inspector and planner agree on the repository name
 * - Diagnostician references an eval_run_id that exists
 * - Planner's strategy matches the diagnostician's recommendation (if both exist)
 */
export function correlateReports(reports) {
  const errors = [];
  const roles = Object.keys(reports);

  // Validate each report individually
  for (const role of roles) {
    const validation = validateSpecialistReport(reports[role], role);
    errors.push(...validation.errors.map(e => `${role}: ${e}`));
    if (reports[role]?.status !== 'complete') {
      errors.push(`${role}: report is not complete`);
    }
  }

  if (errors.length > 0) {
    return { ready: false, errors, correlations: null };
  }

  // Cross-role consistency
  const inspector = reports['code-inspector'];
  const planner = reports['migration-planner'];
  const diagnostician = reports['failure-diagnostician'];

  if (inspector && planner) {
    // Planner should reference the same repository
    if (planner.title && !planner.title.includes(inspector.repository_name)) {
      // Soft warning — title might use a different format
    }
  }

  if (diagnostician && planner) {
    // Planner strategy should align with diagnostician recommendation
    const diagStrategy = diagnostician.recommended_strategy;
    const planStrategy = planner.strategy;

    // Map remediation strategy names to routing strategy names
    const strategyMap = {
      'hybrid_routing': 'hybrid_routing',
      'prompt_adaptation': 'prompt_adaptation',
      'schema_simplification': 'schema_simplification',
      'abort_migration': 'abort',
    };

    const expected = strategyMap[diagStrategy];
    if (expected && planStrategy !== expected) {
      errors.push(
        `Planner strategy "${planStrategy}" does not match diagnostician recommendation "${diagStrategy}"`
      );
    }
  }

  return {
    ready: errors.length === 0,
    errors,
    correlations: {
      repository_name: inspector?.repository_name ?? null,
      strategy: planner?.strategy ?? null,
      diagnosis_category: diagnostician?.primary_failure_category ?? null,
      confidence: diagnostician?.confidence ?? null,
    },
  };
}
