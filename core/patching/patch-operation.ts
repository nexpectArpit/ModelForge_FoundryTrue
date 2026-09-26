/**
 * Concrete Patch Operation Engine
 *
 * Implements deterministic executable mutations against a WorkspaceSandbox copy.
 * Evaluates preconditions before applying changes and emits structured execution results.
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { PatchOperation, PatchPrecondition } from '../types.js';

export interface PatchExecutionResult {
  patch_id: string;
  file_path: string;
  applied: boolean;
  description: string;
  replacements: number;
  error?: string;
}

export interface PreconditionCheckResult {
  passed: boolean;
  failures: string[];
}

/**
 * Check preconditions before applying a patch operation.
 */
export function checkPreconditions(
  sandbox: WorkspaceSandbox,
  preconditions: PatchPrecondition[],
): PreconditionCheckResult {
  const failures: string[] = [];

  for (const pre of preconditions) {
    if (pre.type === 'file_exists') {
      try {
        sandbox.readFile(pre.target);
      } catch {
        failures.push(`Precondition failed: file "${pre.target}" does not exist in sandbox`);
      }
    } else if (pre.type === 'content_matches') {
      try {
        const content = sandbox.readFile(pre.target);
        if (pre.expected && !content.includes(pre.expected)) {
          failures.push(`Precondition failed: content in "${pre.target}" does not match expected pattern`);
        }
      } catch {
        failures.push(`Precondition failed: could not read "${pre.target}" to check content`);
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Execute an individual typed patch operation within the sandbox.
 */
export function executePatchOperation(
  sandbox: WorkspaceSandbox,
  op: PatchOperation,
): PatchExecutionResult {
  // 1. Verify preconditions
  const preCheck = checkPreconditions(sandbox, op.preconditions);
  if (!preCheck.passed) {
    return {
      patch_id: op.id,
      file_path: op.target_file,
      applied: false,
      description: op.description,
      replacements: 0,
      error: preCheck.failures.join('; '),
    };
  }

  try {
    let content: string;
    try {
      content = sandbox.readFile(op.target_file);
    } catch {
      // If file doesn't exist and operation is insert/append, create it
      if (op.action.operation === 'insert' || op.action.operation === 'append') {
        content = '';
      } else {
        throw new Error(`Target file "${op.target_file}" does not exist in sandbox`);
      }
    }

    let modified = content;
    let replacements = 0;

    switch (op.action.operation) {
      case 'replace': {
        const pattern = op.action.pattern;
        const replacement = op.action.replacement ?? '';
        if (!pattern) throw new Error('Replace operation missing pattern');

        // Regex or literal replacement
        const regex = new RegExp(pattern, 'g');
        const matches = content.match(regex);
        replacements = matches ? matches.length : 0;

        if (replacements > 0) {
          modified = content.replace(regex, replacement);
          if (content === modified) {
            return {
              patch_id: op.id,
              file_path: op.target_file,
              applied: true,
              description: `${op.description} (already applied)`,
              replacements: 0,
            };
          }
        } else if (content.includes(replacement)) {
          // Idempotent: already applied
          return {
            patch_id: op.id,
            file_path: op.target_file,
            applied: true,
            description: `${op.description} (already applied)`,
            replacements: 0,
          };
        } else {
          return {
            patch_id: op.id,
            file_path: op.target_file,
            applied: false,
            description: `${op.description} (pattern not found)`,
            replacements: 0,
          };
        }
        break;
      }

      case 'append': {
        const toAppend = op.action.replacement ?? (op.action.value as string) ?? '';
        if (content.includes(toAppend.trim())) {
          return {
            patch_id: op.id,
            file_path: op.target_file,
            applied: true,
            description: `${op.description} (already appended)`,
            replacements: 0,
          };
        }
        modified = content ? `${content.trimEnd()}\n${toAppend}\n` : `${toAppend}\n`;
        replacements = 1;
        break;
      }

      case 'insert': {
        const toInsert = op.action.replacement ?? '';
        modified = `${toInsert}\n${content}`;
        replacements = 1;
        break;
      }

      case 'delete': {
        const pattern = op.action.pattern;
        if (!pattern) throw new Error('Delete operation missing pattern');
        const regex = new RegExp(pattern, 'g');
        const matches = content.match(regex);
        replacements = matches ? matches.length : 0;
        modified = content.replace(regex, '');
        break;
      }

      default:
        throw new Error(`Unsupported patch operation: ${op.action.operation}`);
    }

    if (replacements > 0 && content !== modified) {
      sandbox.writeFile(op.target_file, modified);
    }

    return {
      patch_id: op.id,
      file_path: op.target_file,
      applied: true,
      description: op.description,
      replacements,
    };
  } catch (err) {
    return {
      patch_id: op.id,
      file_path: op.target_file,
      applied: false,
      description: op.description,
      replacements: 0,
      error: (err as Error).message,
    };
  }
}
