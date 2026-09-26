/**
 * Environment Patch
 *
 * Patches environment configuration files (.env, .env.example, etc.)
 * to point model environment variables to the candidate model.
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { PatchOperation } from '../types.js';
import { executePatchOperation, type PatchExecutionResult } from './patch-operation.js';

export function applyEnvironmentPatch(
  sandbox: WorkspaceSandbox,
  targetModel: string,
  envKeys: string[] = ['APP_MODEL', 'OPENAI_MODEL', 'MODEL_NAME'],
): PatchExecutionResult[] {
  const results: PatchExecutionResult[] = [];
  const candidateEnvFiles = ['.env', '.env.example', '.env.local', '.env.development'];

  for (const envFile of candidateEnvFiles) {
    let content: string;
    try {
      content = sandbox.readFile(envFile);
    } catch {
      continue;
    }

    for (const key of envKeys) {
      const keyPattern = new RegExp(`^${key}=.*$`, 'm');
      if (keyPattern.test(content)) {
        const op: PatchOperation = {
          id: `patch-env-${envFile.replace(/[\/\.]/g, '-')}-${key}` as any,
          type: 'config_setting',
          target_file: envFile,
          preconditions: [{ type: 'file_exists', target: envFile }],
          action: {
            operation: 'replace',
            pattern: `^${key}=.*$`,
            replacement: `${key}=${targetModel}`,
          },
          description: `Update ${key} to "${targetModel}" in ${envFile}`,
          risk: 'low',
        };

        const res = executePatchOperation(sandbox, op);
        results.push(res);
      }
    }
  }

  return results;
}
