/**
 * Patching Engine & Concrete Operations Tests
 *
 * Verifies Phase B requirements:
 *   - Typed patch operations with preconditions
 *   - Model literal patching
 *   - Environment variable patching
 *   - Routing mode configuration
 *   - Post-patch verification and sandbox isolation
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import {
  executePatchOperation,
  applyModelLiteralPatch,
  applyEnvironmentPatch,
  applyRoutingModePatch,
  verifySandboxPatches,
  applyMigrationPlan,
} from '../core/patching/index.js';
import { createSessionId, type MigrationPlan, type RepositoryProfile } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('Canonical Patch Engine (Phase B)', () => {
  let sandbox: WorkspaceSandbox;
  let testSandboxRoot: string;

  beforeEach(() => {
    testSandboxRoot = fs.mkdtempSync(path.join(__dirname, '../.test-patch-'));
    sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: APP_DIR,
      sandboxRoot: testSandboxRoot,
    });
    sandbox.initialize();
  });

  afterEach(() => {
    sandbox.discard();
    if (fs.existsSync(testSandboxRoot)) {
      fs.rmSync(testSandboxRoot, { recursive: true, force: true });
    }
  });

  it('executes a typed patch operation with preconditions', () => {
    const op = {
      id: 'test-patch-1' as any,
      type: 'model_literal' as const,
      target_file: 'src/config.ts',
      preconditions: [
        { type: 'file_exists' as const, target: 'src/config.ts' },
        { type: 'content_matches' as const, target: 'src/config.ts', expected: 'active_model' },
      ],
      action: {
        operation: 'replace' as const,
        pattern: "model-a",
        replacement: "candidate-x",
      },
      description: 'Replace model-a with candidate-x in config',
      risk: 'low' as const,
    };

    const res = executePatchOperation(sandbox, op);
    expect(res.applied).toBe(true);
    expect(res.replacements).toBeGreaterThan(0);

    const updated = sandbox.readFile('src/config.ts');
    expect(updated).toContain('candidate-x');
    expect(updated).not.toContain("'model-a'");
  });

  it('fails safely when preconditions are violated', () => {
    const op = {
      id: 'test-patch-failing' as any,
      type: 'model_literal' as const,
      target_file: 'src/non_existent.ts',
      preconditions: [
        { type: 'file_exists' as const, target: 'src/non_existent.ts' },
      ],
      action: {
        operation: 'replace' as const,
        pattern: "foo",
        replacement: "bar",
      },
      description: 'Should fail precondition',
      risk: 'low' as const,
    };

    const res = executePatchOperation(sandbox, op);
    expect(res.applied).toBe(false);
    expect(res.error).toContain('Precondition failed');
  });

  it('handles idempotency gracefully without error', () => {
    const op = {
      id: 'test-patch-idempotent' as any,
      type: 'model_literal' as const,
      target_file: 'src/config.ts',
      preconditions: [{ type: 'file_exists' as const, target: 'src/config.ts' }],
      action: {
        operation: 'replace' as const,
        pattern: "model-a",
        replacement: "candidate-y",
      },
      description: 'Replace model-a with candidate-y',
      risk: 'low' as const,
    };

    const first = executePatchOperation(sandbox, op);
    expect(first.applied).toBe(true);

    // Apply exact same operation again
    const second = executePatchOperation(sandbox, op);
    expect(second.applied).toBe(true);
    expect(second.description).toContain('already applied');
  });

  it('applies model literal and routing mode patches cleanly', () => {
    const literalResults = applyModelLiteralPatch(
      sandbox,
      'model-a',
      'llama-3.1-70b',
      [{ file_path: 'src/config.ts', line_numbers: [5], reference_type: 'config_file', code_snippet: '', confidence: 0.9 }],
    );

    expect(literalResults.some(r => r.applied)).toBe(true);

    const routingResults = applyRoutingModePatch(sandbox, 'hybrid');
    expect(routingResults.some(r => r.applied)).toBe(true);

    const configContent = sandbox.readFile('src/config.ts');
    expect(configContent).toContain('llama-3.1-70b');
    expect(configContent).toContain("'hybrid'");

    // Verify sandbox patches
    const verification = verifySandboxPatches(sandbox);
    expect(verification.verified).toBe(true);
    expect(verification.errors).toHaveLength(0);
    expect(verification.modified_files).toContain('src/config.ts');
  });

  it('applies complete migration plan end-to-end via canonical entrypoint', () => {
    const plan: MigrationPlan = {
      contract_version: '2.0',
      session_id: 'session-e2e' as any,
      created_at: new Date().toISOString(),
      source_model: 'model-a',
      target_model: 'candidate-z',
      strategy: 'hybrid_routing',
      strategy_rationale: 'Hybrid routing for tool compliance',
      changes: [
        { file_path: 'src/config.ts', description: 'Update model and routing', rationale: '', line_range: null, risk: 'low' },
      ],
      acceptance_criteria: [
        { id: 'crit-1', description: 'PASS quality', category: 'quality', threshold: '>= 0.9', required: true },
      ],
      risk_assessment: 'low',
      estimated_cost_savings_pct: 70,
    };

    const profile: RepositoryProfile = {
      contract_version: '2.0',
      status: 'complete',
      repository_path: APP_DIR,
      repository_name: 'customer-support-app',
      language: 'typescript',
      package_manager: 'npm',
      detected_frameworks: [],
      current_model: 'model-a',
      model_references: [
        { file_path: 'src/config.ts', line_numbers: [5], reference_type: 'config_file', code_snippet: '', confidence: 0.9 },
      ],
      tool_schemas: [],
      env_dependencies: ['APP_MODEL', 'APP_ROUTING_MODE'],
      unknowns: [],
      inspected_at: new Date().toISOString(),
    };

    const report = applyMigrationPlan(sandbox, plan, profile);
    expect(report.total_files_patched).toBeGreaterThan(0);
    expect(report.total_replacements).toBeGreaterThan(0);
    expect(report.verification.verified).toBe(true);
    expect(report.verification.errors).toHaveLength(0);

    const patchedContent = sandbox.readFile('src/config.ts');
    expect(patchedContent).toContain('candidate-z');
    expect(patchedContent).toContain("'hybrid'");
  });
});
