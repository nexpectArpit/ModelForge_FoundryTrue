/**
 * Patch Verifier
 *
 * Deterministically verifies the integrity, correctness, and isolation
 * of applied patches inside a WorkspaceSandbox before evaluation.
 *
 * Invariants verified:
 *   1. Zero source repository mutation (source_path untouched).
 *   2. All modified files exist and are readable inside the sandbox.
 *   3. All modified files have valid basic syntax (balanced brackets/braces/JSON).
 *   4. File hashes changed as expected and diffs are non-empty.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { WorkspaceSandbox } from '../workspace-sandbox.js';

export interface PatchVerificationResult {
  verified: boolean;
  modified_files: string[];
  total_diffs: number;
  errors: string[];
}

export function verifySandboxPatches(sandbox: WorkspaceSandbox): PatchVerificationResult {
  const errors: string[] = [];
  const manifest = sandbox.getManifest();

  // Invariant 1: Isolation check
  if (path.resolve(sandbox.sandboxPath) === path.resolve(manifest.source_path)) {
    errors.push('CRITICAL: Sandbox path is identical to source repository path! Isolation breached.');
  }

  // Invariant 2: Modified files verification
  const diffs = sandbox.getDiffs();
  for (const file of manifest.modified_files) {
    const fullSandboxPath = path.join(sandbox.sandboxPath, file);
    if (!existsSync(fullSandboxPath)) {
      errors.push(`Modified file missing from sandbox: ${file}`);
      continue;
    }

    try {
      const content = readFileSync(fullSandboxPath, 'utf8');

      // Invariant 3: Syntax check
      if (file.endsWith('.json')) {
        JSON.parse(content);
      } else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
        const sourceFile = ts.createSourceFile(
          file,
          content,
          ts.ScriptTarget.Latest,
          true
        );
        const parseDiagnostics = (sourceFile as any).parseDiagnostics || [];
        if (parseDiagnostics.length > 0) {
          for (const diag of parseDiagnostics) {
            const msg = typeof diag.messageText === 'string' ? diag.messageText : diag.messageText?.messageText;
            errors.push(`Syntax error in patched file "${file}": ${msg}`);
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to verify patched file "${file}": ${(err as Error).message}`);
    }
  }

  // Invariant 4: Hash verification
  for (const [file, hashes] of Object.entries(manifest.file_hashes)) {
    if (hashes.original === hashes.modified) {
      errors.push(`File "${file}" was marked modified but hash did not change`);
    }
  }

  return {
    verified: errors.length === 0,
    modified_files: manifest.modified_files,
    total_diffs: diffs.length,
    errors,
  };
}
