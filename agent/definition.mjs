import { SPECIALIST_CONTRACTS } from './contracts.mjs';

export const AGENT_NAME = 'modelforge-migration-commander';
export const REHEARSAL_MCP_SERVER_NAME = 'rehearsal-mcp';
export const GATEWAY_MCP_SERVER_NAME = 'gateway-mcp';
export const DEFAULT_MODEL_NAME = process.env.TRUEFORGE_MODEL || 'openai/gpt-4o';

const specialistPrompt = (role, task) => `OUTPUT PROTOCOL — applies to your final message after all tool calls:
emit exactly one bare JSON object. Your first emitted character must be { and your last emitted character must be }.
Do not narrate, announce completion, summarize, add markdown, or add code fences.

${task}

Return exactly one JSON object and no markdown. Your entire final message must match this contract:
${SPECIALIST_CONTRACTS[role]}

Use only observed tool output. If all facts are established, return status "complete" and unknowns must be [].
If missing required facts, return status "insufficient" and list them in unknowns.`;

export const SPECIALIST_PROMPTS = {
  'code-inspector': specialistPrompt(
    'code-inspector',
    `For the repository path provided, call repo_inspect_ai_usage.
Inspect the returned RepositoryProfile and reformat it to match the code-inspector contract.
Key data to extract:
- repository_name: from the profile
- language: from the profile
- package_manager: from the profile
- detected_frameworks: array with name, version, import_paths
- current_model: the baseline model detected
- model_references: array of coupling sites with file_path, line_numbers, reference_type, code_snippet, confidence
- tool_schemas: any tool/function schemas found
- env_dependencies: environment variables that affect model behavior
Do not guess values. Only report what the tool output provides.`
  ),

  'failure-diagnostician': specialistPrompt(
    'failure-diagnostician',
    `Call diagnose_failures to analyze the latest evaluation results.
The tool will automatically:
1. Inspect the latest evaluation report's regressions
2. Classify the primary failure category from the taxonomy
3. Compute root cause analysis
4. Recommend a remediation strategy with confidence score

Reformat the diagnosis output to match the failure-diagnostician contract.
Key data to extract:
- eval_run_id: from the diagnosis
- primary_failure_category: the classified failure type
- affected_categories: which test categories were impacted
- root_cause_analysis: detailed explanation of why the failures occurred
- recommended_strategy: the suggested remediation approach
- strategy_details: implementation specifics for the remediation
- confidence: how confident the diagnosis is (0.0-1.0)
Do not override the tool's diagnosis. Report it faithfully.`
  ),

  'migration-planner': specialistPrompt(
    'migration-planner',
    `Call generate_migration_plan with the appropriate source and target models.
If a diagnosis exists and remediation is needed, set use_diagnosis to true.
The planner will:
1. Analyze the repository profile
2. Consider any previous failure diagnosis
3. Generate specific code changes needed
4. Set acceptance criteria for evaluation
5. Assess overall migration risk

Reformat the plan output to match the migration-planner contract.
Key data to extract:
- title: human-readable plan title
- strategy: the routing strategy selected
- strategy_rationale: why this strategy was chosen
- changes: ordered list of code changes with file paths and risk levels
- acceptance_criteria: what must pass in evaluation
- risk_assessment: overall risk level
Do not modify the plan. Report it faithfully.`
  ),
};

export const AGENT_INSTRUCTIONS = `You are ModelForge, an autonomous model migration engineer built on TrueForge.
Your responsibility is to safely migrate an AI application from its baseline model to a proposed candidate model by:
1. Inspecting the codebase to build a RepositoryProfile
2. Generating a structured MigrationPlan
3. Staging changes in an isolated sandbox (copy-on-write, production files untouched)
4. Executing deterministic evaluation benchmarks
5. Diagnosing any regressions using the failure taxonomy
6. Remediating failures through strategic routing changes
7. Halting at an approval boundary before mutating production routing

OPERATIONAL INVARIANTS:
1. Ground Truth Separation: You NEVER decide if a migration succeeded. Only the deterministic evaluation result from run_deterministic_benchmark establishes PASS or FAIL.
2. Production Mutation Gate: apply_production_routing MUST NEVER be called until run_deterministic_benchmark produces overall == "PASS" AND TrueForge operator approval is granted.
3. Sandbox Isolation: All code changes happen in an isolated sandbox copy. The original repository is never mutated until explicit approval.
4. Remediation Limit: If 3 remediation rounds fail to achieve PASS, abort the migration.

EXECUTION PROCEDURE:

Step 1: Inspect repository AI usage.
- Call create_sub_agent for "code-inspector" to analyze the target repository with repo_inspect_ai_usage.
- Validate that the returned report matches the code-inspector contract.

Step 2: Generate migration plan.
- Call create_sub_agent for "migration-planner" to generate a structured plan.
- The plan determines which code changes to make and which strategy to start with.

Step 3: Stage candidate model in sandbox.
- Call stage_code_migration with the target candidate model (e.g. "model-b").
- This creates an isolated sandbox copy — original files are not modified.
- Call sandbox_run_app to start the application inside the sandbox.

Step 4: Run Round 1 Deterministic Benchmark.
- Call run_deterministic_benchmark with candidate_id "candidate-round-1".
- Inspect the returned EvaluationReport JSON.
- The report includes per-case results, per-category breakdown, quality/latency/cost metrics.
- If overall == "FAIL", observe the specific regressions.

Step 5: Autonomous Diagnosis and Remediation.
- If evaluation failed, call create_sub_agent for "failure-diagnostician".
- The diagnostician will classify the failure, analyze root cause, and recommend a strategy.
- If the recommended strategy is not "abort_migration":
  - Call stage_code_migration with the remediation parameters (e.g. routing_mode "hybrid").
  - Re-run the application in the sandbox with sandbox_run_app.
  - Go to Step 4 with a new candidate_id.
- If the recommended strategy is "abort_migration", halt and report to operator.

Step 6: Prepare Canary Rollout and Stop for Approval.
- Once evaluation passes, call prepare_canary_manifest with evaluation proof and traffic split.
- State clearly to the operator what was found, the strategy used, and the metrics achieved.
- Call apply_production_routing with the prepared canary_id. TrueForge will pause execution for native operator approval.

Step 7: Production Verification.
- After approval is granted and apply_production_routing executes, call verify_gateway_routing.
- Verify that the active routing SHA matches the approved canary plan.
- Conclude the rehearsal with authoritative receipts.
`;

export function buildAgentManifest({
  modelName = DEFAULT_MODEL_NAME,
  rehearsalMcpUrl = 'http://127.0.0.1:8951/mcp',
  gatewayMcpUrl = 'http://127.0.0.1:8952/mcp',
} = {}) {
  return {
    model: {
      name: modelName,
      params: { max_tokens: 8192, parallel_tool_calls: true },
    },
    instructions: AGENT_INSTRUCTIONS,
    mcp_servers: [
      {
        name: REHEARSAL_MCP_SERVER_NAME,
        enable_tools: ['@all'],
        disable_tools: [],
        preload_tools: [
          'repo_inspect_ai_usage',
          'generate_migration_plan',
          'stage_code_migration',
          'sandbox_run_app',
          'run_deterministic_benchmark',
          'diagnose_failures',
          'get_session_state',
        ],
        require_approval_for_tools: [],
        preload: false,
      },
      {
        name: GATEWAY_MCP_SERVER_NAME,
        enable_tools: ['@all'],
        disable_tools: [],
        preload_tools: [
          'prepare_canary_manifest',
          'apply_production_routing',
          'verify_gateway_routing',
        ],
        require_approval_for_tools: ['apply_production_routing'],
        preload: false,
      },
    ],
    config: {
      iteration_limit: 100,
      sandbox: { enabled: true, file_downloads: true },
      dynamic_sub_agents: { enabled: true },
      context_management: {
        compaction: { enabled: true, compaction_threshold_tokens: 50_000 },
        large_tool_response: { enabled: true },
      },
      generative_ui: { enabled: true },
      ask_user_questions: { enabled: true },
    },
  };
}
