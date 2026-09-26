/**
 * Core Patching Module Index
 *
 * Canonical patch engine for ModelForge Architecture v2:
 *   - patch-operation: typed atomic sandbox mutations
 *   - model-literal-patch: model name literal replacements
 *   - environment-patch: .env and config variable updating
 *   - routing-mode-patch: direct vs hybrid routing strategies
 *   - prompt-adaptation-patch: prompt template and system message adaptations
 *   - patch-verifier: sandbox isolation, syntax, and hash verification
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { RepositoryProfile, MigrationPlan } from '../types.js';
import { applyModelLiteralPatch } from './model-literal-patch.js';
import { applyEnvironmentPatch } from './environment-patch.js';
import { applyRoutingModePatch } from './routing-mode-patch.js';
import { applyPromptAdaptationPatch } from './prompt-adaptation-patch.js';
import { verifySandboxPatches, type PatchVerificationResult } from './patch-verifier.js';
import type { PatchExecutionResult } from './patch-operation.js';

export * from './patch-operation.js';
export * from './model-literal-patch.js';
export * from './environment-patch.js';
export * from './routing-mode-patch.js';
export * from './prompt-adaptation-patch.js';
export * from './patch-verifier.js';

export interface PatchReport {
  total_files_patched: number;
  total_replacements: number;
  results: PatchExecutionResult[];
  strategy_applied: string;
  verification: PatchVerificationResult;
}

/**
 * Canonical entrypoint for applying a complete migration plan to a sandbox.
 */
export function applyMigrationPlan(
  sandbox: WorkspaceSandbox,
  plan: MigrationPlan,
  profile: RepositoryProfile,
): PatchReport {
  const results: PatchExecutionResult[] = [];

  // 1. Apply model literal replacements
  const literalResults = applyModelLiteralPatch(
    sandbox,
    plan.source_model,
    plan.target_model,
    profile.model_references,
  );
  results.push(...literalResults);

  // 2. Apply routing mode changes
  if (plan.strategy === 'hybrid_routing') {
    const routingResults = applyRoutingModePatch(sandbox, 'hybrid');
    results.push(...routingResults);
  } else {
    const routingResults = applyRoutingModePatch(sandbox, 'direct');
    results.push(...routingResults);
  }

  // 3. Apply prompt adaptation if requested
  if (plan.strategy === 'prompt_adaptation') {
    const promptResults = applyPromptAdaptationPatch(sandbox, profile.model_references);
    results.push(...promptResults);
  }

  // 4. Apply environment variable patches
  const envResults = applyEnvironmentPatch(sandbox, plan.target_model, profile.env_dependencies);
  results.push(...envResults);

  // 5. Deterministically verify sandbox mutations
  const verification = verifySandboxPatches(sandbox);

  const appliedResults = results.filter(r => r.applied);

  return {
    total_files_patched: new Set(appliedResults.map(r => r.file_path)).size,
    total_replacements: appliedResults.reduce((sum, r) => sum + r.replacements, 0),
    results,
    strategy_applied: plan.strategy,
    verification,
  };
}
