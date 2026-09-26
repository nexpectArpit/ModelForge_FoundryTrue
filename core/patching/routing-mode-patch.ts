/**
 * Routing Mode Patch
 *
 * Configures the application routing strategy mode ('direct' vs 'hybrid')
 * in application configuration and environment files.
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { PatchOperation } from '../types.js';
import { executePatchOperation, type PatchExecutionResult } from './patch-operation.js';

export function applyRoutingModePatch(
  sandbox: WorkspaceSandbox,
  routingMode: 'direct' | 'hybrid',
): PatchExecutionResult[] {
  const results: PatchExecutionResult[] = [];
  const candidateConfigFiles = ['src/config.ts', 'src/config.js', 'config.ts', 'config.js'];

  for (const configFile of candidateConfigFiles) {
    try {
      const content = sandbox.readFile(configFile);

      // Pattern: routing_mode: (process.env.APP_ROUTING_MODE as ...) ?? 'direct'
      const routingPattern = /(routing_mode\s*:\s*\(process\.env\.[A-Z0-9_]+\s*as\s*[^)]+\)\s*\?\?\s*['"])([^'"]+)(['"])/g;
      if (routingPattern.test(content)) {
        const op: PatchOperation = {
          id: `patch-routing-mode-${configFile.replace(/[\/\.]/g, '-')}` as any,
          type: 'routing_mode',
          target_file: configFile,
          preconditions: [{ type: 'file_exists', target: configFile }],
          action: {
            operation: 'replace',
            pattern: `(routing_mode\\s*:\\s*\\(process\\.env\\.[A-Z0-9_]+\\s*as\\s*[^)]+\\)\\s*\\?\\?\\s*['"])([^'"]+)(['"])`,
            replacement: `$1${routingMode}$3`,
          },
          description: `Set routing_mode to "${routingMode}" in ${configFile}`,
          risk: 'medium',
        };

        const res = executePatchOperation(sandbox, op);
        results.push(res);
      }
    } catch {
      // Ignore
    }
  }

  // Also update .env if APP_ROUTING_MODE exists
  const candidateEnvFiles = ['.env', '.env.example', '.env.local'];
  for (const envFile of candidateEnvFiles) {
    try {
      const content = sandbox.readFile(envFile);
      if (/APP_ROUTING_MODE=/m.test(content)) {
        const op: PatchOperation = {
          id: `patch-env-routing-${envFile.replace(/[\/\.]/g, '-')}` as any,
          type: 'routing_mode',
          target_file: envFile,
          preconditions: [{ type: 'file_exists', target: envFile }],
          action: {
            operation: 'replace',
            pattern: `^APP_ROUTING_MODE=.*$`,
            replacement: `APP_ROUTING_MODE=${routingMode}`,
          },
          description: `Set APP_ROUTING_MODE=${routingMode} in ${envFile}`,
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
