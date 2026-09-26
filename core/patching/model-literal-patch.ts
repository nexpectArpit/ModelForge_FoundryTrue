/**
 * Model Literal Patch
 *
 * Replaces AI model name literals across codebase source files and configuration
 * files based on detected ModelReference locations.
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { ModelReference, PatchOperation } from '../types.js';
import { executePatchOperation, type PatchExecutionResult } from './patch-operation.js';

export function applyModelLiteralPatch(
  sandbox: WorkspaceSandbox,
  sourceModel: string,
  targetModel: string,
  references: ModelReference[] = [],
): PatchExecutionResult[] {
  const results: PatchExecutionResult[] = [];

  // Group references by file
  const fileGroups = new Map<string, ModelReference[]>();
  for (const ref of references) {
    if (ref.reference_type === 'model_name_literal' || ref.reference_type === 'config_file') {
      const list = fileGroups.get(ref.file_path) || [];
      list.push(ref);
      fileGroups.set(ref.file_path, list);
    }
  }

  // 1. Patch files cited in profile references
  for (const [filePath, fileRefs] of fileGroups.entries()) {
    try {
      const content = sandbox.readFile(filePath);

      // Strategy A: Direct model string replacement in quoted contexts
      const quotedSourceRegex = new RegExp(`(['"\`])${escapeRegex(sourceModel)}\\1`);
      if (quotedSourceRegex.test(content)) {
        const op: PatchOperation = {
          id: `patch-model-literal-${filePath.replace(/[\/\.]/g, '-')}` as any,
          type: 'model_literal',
          target_file: filePath,
          preconditions: [{ type: 'file_exists', target: filePath }],
          action: {
            operation: 'replace',
            pattern: `(['"\`])${escapeRegex(sourceModel)}\\1`,
            replacement: `$1${targetModel}$1`,
          },
          description: `Replace model literal "${sourceModel}" with "${targetModel}" in ${filePath}`,
          risk: 'low',
        };

        const res = executePatchOperation(sandbox, op);
        results.push(res);
      }
    } catch {
      // Skip if file doesn't exist
    }
  }

  // 2. Scan standard configuration files for fallback / generic patterns
  const candidateConfigFiles = [
    'src/config.ts',
    'src/config.js',
    'config.ts',
    'config.js',
    'src/settings.py',
    'settings.py',
    'src/config.json',
  ];

  for (const configFile of candidateConfigFiles) {
    try {
      const content = sandbox.readFile(configFile);

      // Pattern: active_model: process.env.APP_MODEL ?? 'model-a'
      const activeModelPattern = /(active_model\s*:\s*process\.env\.[A-Z0-9_]+\s*\?\?\s*['"])([^'"]+)(['"])/g;
      if (activeModelPattern.test(content)) {
        const op: PatchOperation = {
          id: `patch-active-model-${configFile.replace(/[\/\.]/g, '-')}` as any,
          type: 'model_literal',
          target_file: configFile,
          preconditions: [{ type: 'file_exists', target: configFile }],
          action: {
            operation: 'replace',
            pattern: `(active_model\\s*:\\s*process\\.env\\.[A-Z0-9_]+\\s*\\?\\?\\s*['"])([^'"]+)(['"])`,
            replacement: `$1${targetModel}$3`,
          },
          description: `Update active_model fallback to "${targetModel}" in ${configFile}`,
          risk: 'low',
        };

        const res = executePatchOperation(sandbox, op);
        results.push(res);
      } else if (content.includes(`'${sourceModel}'`) || content.includes(`"${sourceModel}"`)) {
        const op: PatchOperation = {
          id: `patch-config-model-${configFile.replace(/[\/\.]/g, '-')}` as any,
          type: 'model_literal',
          target_file: configFile,
          preconditions: [{ type: 'file_exists', target: configFile }],
          action: {
            operation: 'replace',
            pattern: `(['"])${escapeRegex(sourceModel)}\\1`,
            replacement: `$1${targetModel}$1`,
          },
          description: `Update model reference to "${targetModel}" in ${configFile}`,
          risk: 'low',
        };
        const res = executePatchOperation(sandbox, op);
        results.push(res);
      }
    } catch {
      // Ignore
    }
  }

  return results;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
