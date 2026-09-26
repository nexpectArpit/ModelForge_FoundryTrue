/**
 * Deterministic Specialist Admissibility Engine
 *
 * Implements Phase A5 of ModelForge Architecture v2 contract philosophy.
 *
 * Rule: Do NOT trust an LLM-generated RepositoryProfile, MigrationPlan, or FailureDiagnosis
 * merely because it parses as JSON.
 *
 * Pipeline:
 *   structured output
 *   → schema validation
 *   → evidence validation
 *   → ground-truth / consistency checks against disk & SQLite
 *   → accepted domain object
 *
 * The LLM proposes conclusions. Deterministic ModelForge code decides whether
 * those conclusions are admissible into the migration state machine.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  RepositoryProfile,
  MigrationPlan,
  FailureDiagnosis,
  SessionId,
  EvaluationReport,
} from './types.js';
import { DurableStateStore } from './durable-state.js';

export interface AdmissibilityResult<T> {
  admissible: boolean;
  accepted: T | null;
  reasons: string[];
}

// ─── Repository Profile Admissibility ───────────────────────────────────────────

export function admitRepositoryProfile(
  profile: RepositoryProfile,
  repoPath: string,
): AdmissibilityResult<RepositoryProfile> {
  const reasons: string[] = [];

  if (!profile || typeof profile !== 'object') {
    return { admissible: false, accepted: null, reasons: ['Profile must be an object'] };
  }

  if (profile.contract_version !== '2.0') {
    reasons.push(`Invalid contract_version: "${profile.contract_version}", expected "2.0"`);
  }

  if (!existsSync(repoPath)) {
    reasons.push(`Repository path does not exist on disk: ${repoPath}`);
    return { admissible: false, accepted: null, reasons };
  }

  // Ground truth check: verify all cited model_references exist on disk
  if (Array.isArray(profile.model_references)) {
    for (const [idx, ref] of profile.model_references.entries()) {
      const fullPath = path.resolve(repoPath, ref.file_path);
      if (!existsSync(fullPath)) {
        reasons.push(
          `Hallucinated model reference [${idx}]: file "${ref.file_path}" does not exist on disk`,
        );
        continue;
      }

      // Verify lines exist in file
      try {
        const content = readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        for (const lineNum of ref.line_numbers) {
          if (lineNum < 1 || lineNum > lines.length) {
            reasons.push(
              `Invalid line number ${lineNum} for file "${ref.file_path}" (file has ${lines.length} lines)`,
            );
          }
        }
      } catch (err) {
        reasons.push(`Could not read referenced file "${ref.file_path}": ${(err as Error).message}`);
      }
    }
  } else {
    reasons.push('model_references must be an array');
  }

  // Ground truth check: verify tool schema source files exist
  if (Array.isArray(profile.tool_schemas)) {
    for (const [idx, tool] of profile.tool_schemas.entries()) {
      if (tool.source_file) {
        const toolFile = path.resolve(repoPath, tool.source_file);
        if (!existsSync(toolFile)) {
          reasons.push(
            `Hallucinated tool schema [${idx}]: source file "${tool.source_file}" does not exist on disk`,
          );
        }
      }
    }
  }

  return {
    admissible: reasons.length === 0,
    accepted: reasons.length === 0 ? profile : null,
    reasons,
  };
}

// ─── Failure Diagnosis Admissibility ───────────────────────────────────────────

export function admitFailureDiagnosis(
  diagnosis: FailureDiagnosis,
  store: DurableStateStore,
): AdmissibilityResult<FailureDiagnosis> {
  const reasons: string[] = [];

  if (!diagnosis || typeof diagnosis !== 'object') {
    return { admissible: false, accepted: null, reasons: ['Diagnosis must be an object'] };
  }

  if (diagnosis.contract_version !== '2.0') {
    reasons.push(`Invalid contract_version: "${diagnosis.contract_version}", expected "2.0"`);
  }

  if (!diagnosis.eval_run_id) {
    reasons.push('Diagnosis missing required eval_run_id');
    return { admissible: false, accepted: null, reasons };
  }

  // Ground truth check: eval_run_id must exist in durable store
  const evalRuns = store.getEvaluationRuns(diagnosis.session_id);
  const matchedRun = evalRuns.find(r => r.eval_run_id === diagnosis.eval_run_id);

  if (!matchedRun) {
    reasons.push(
      `Hallucinated eval_run_id: "${diagnosis.eval_run_id}" not found in durable evaluation records for session "${diagnosis.session_id}"`,
    );
    return { admissible: false, accepted: null, reasons };
  }

  // Ground truth check: evaluation must have actually failed
  if (matchedRun.overall === 'PASS') {
    reasons.push(
      `Invalid diagnosis: evaluation run "${diagnosis.eval_run_id}" had overall verdict PASS; cannot diagnose failure on passing evaluation`,
    );
  }

  return {
    admissible: reasons.length === 0,
    accepted: reasons.length === 0 ? diagnosis : null,
    reasons,
  };
}

// ─── Migration Plan Admissibility ─────────────────────────────────────────────

export function admitMigrationPlan(
  plan: MigrationPlan,
  repoPath: string,
): AdmissibilityResult<MigrationPlan> {
  const reasons: string[] = [];

  if (!plan || typeof plan !== 'object') {
    return { admissible: false, accepted: null, reasons: ['Plan must be an object'] };
  }

  if (plan.contract_version !== '2.0') {
    reasons.push(`Invalid contract_version: "${plan.contract_version}", expected "2.0"`);
  }

  if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
    reasons.push('Plan must propose at least one concrete code change');
  } else {
    // Ground truth check: target files must exist in repository
    for (const [idx, change] of plan.changes.entries()) {
      const targetFile = path.resolve(repoPath, change.file_path);
      if (!existsSync(targetFile)) {
        reasons.push(
          `Planned change [${idx}] targets non-existent file: "${change.file_path}"`,
        );
      }
    }
  }

  if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.length === 0) {
    reasons.push('Plan must declare at least one acceptance criterion');
  }

  return {
    admissible: reasons.length === 0,
    accepted: reasons.length === 0 ? plan : null,
    reasons,
  };
}
