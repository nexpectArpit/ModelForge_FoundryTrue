/**
 * Prompt Adaptation Patch
 *
 * Adapts prompt templates or system instructions in the sandbox when migrating
 * to models with prompt drift or stricter formatting requirements.
 */

import type { WorkspaceSandbox } from '../workspace-sandbox.js';
import type { ModelReference, PatchOperation } from '../types.js';
import { executePatchOperation, type PatchExecutionResult } from './patch-operation.js';

export interface PromptAdaptationOptions {
  adaptationType: 'json_schema_enforcement' | 'system_instruction_clarification' | 'few_shot_injection';
  instructionText?: string;
}

export function applyPromptAdaptationPatch(
  sandbox: WorkspaceSandbox,
  references: ModelReference[] = [],
  options: PromptAdaptationOptions = { adaptationType: 'json_schema_enforcement' },
): PatchExecutionResult[] {
  const results: PatchExecutionResult[] = [];
  const promptRefs = references.filter(r => r.reference_type === 'prompt_template');

  const defaultInstruction = options.instructionText ??
    ' IMPORTANT: You must output strictly valid JSON matching the requested schema. Do not include markdown codeblocks or preamble.';

  for (const ref of promptRefs) {
    try {
      const content = sandbox.readFile(ref.file_path);

      // Strategy: find system message or prompt strings and append instructions
      const systemPromptRegex = /(system(?:_message|_prompt)?\s*:\s*['"`])([^'"`]+)(['"`])/i;
      if (systemPromptRegex.test(content)) {
        const op: PatchOperation = {
          id: `patch-prompt-${ref.file_path.replace(/[\/\.]/g, '-')}` as any,
          type: 'prompt_adaptation',
          target_file: ref.file_path,
          preconditions: [{ type: 'file_exists', target: ref.file_path }],
          action: {
            operation: 'replace',
            pattern: `(system(?:_message|_prompt)?\\s*:\\s*['"\`])([^'"\`]+)(['"\`])`,
            replacement: `$1$2${defaultInstruction}$3`,
          },
          description: `Adapt system prompt with formatting enforcement in ${ref.file_path}`,
          risk: 'medium',
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
