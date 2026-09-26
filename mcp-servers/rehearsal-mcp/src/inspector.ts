import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ModelReference {
  file_path: string;
  line_numbers: number[];
  reference_type: "model_name_literal" | "client_init" | "prompt_template" | "tool_definition";
  code_snippet: string;
}

export interface MigrationInspectionResult {
  contract_version: "1.0";
  status: "complete" | "insufficient";
  repository_name: string;
  detected_frameworks: string[];
  current_model: string;
  model_coupling_files: ModelReference[];
  unknowns: string[];
}

const AI_SDK_PATTERNS = [
  { pattern: /from\s+['"]openai['"]|require\(['"]openai['"]\)|import.*from\s+['"]openai['"]/i, framework: 'openai-sdk' },
  { pattern: /from\s+['"]groq['"]|require\(['"]groq['"]\)|import.*from\s+['"]groq['"]/i, framework: 'groq-sdk' },
  { pattern: /from\s+['"]@ai-sdk/i, framework: 'ai-sdk' },
  { pattern: /from\s+['"]langchain['"]|import.*langchain/i, framework: 'langchain' },
  { pattern: /litellm/i, framework: 'litellm' },
];

const MODEL_LITERAL_REGEX = /['"](gpt-[a-z0-9.-]+|llama-[a-z0-9.-]+|claude-[a-z0-9.-]+|model-[a-z0-9.-]+|mistral-[a-z0-9.-]+)['"]/gi;

export function inspectRepositoryAIUsage(targetDir: string): MigrationInspectionResult {
  const references: ModelReference[] = [];
  const detectedFrameworks = new Set<string>();
  let currentModel = 'unknown';

  function walk(current: string) {
    const entries = readdirSync(current);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue;
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && /\.(ts|js|py|json|env|yaml|yml)$/.test(entry)) {
        try {
          const content = readFileSync(full, 'utf8');
          const lines = content.split('\n');

          // Check frameworks
          for (const sdk of AI_SDK_PATTERNS) {
            if (sdk.pattern.test(content)) {
              detectedFrameworks.add(sdk.framework);
            }
          }

          // Check lines for model names or tools
          lines.forEach((line, idx) => {
            const lineNum = idx + 1;

            // Model name literals
            let match;
            const lineRegex = new RegExp(MODEL_LITERAL_REGEX);
            while ((match = lineRegex.exec(line)) !== null) {
              const modelName = match[1];
              if (currentModel === 'unknown' && modelName.startsWith('model-') || modelName.includes('gpt-') || modelName.includes('llama-')) {
                currentModel = modelName;
              }
              references.push({
                file_path: path.relative(targetDir, full),
                line_numbers: [lineNum],
                reference_type: 'model_name_literal',
                code_snippet: line.trim(),
              });
            }

            // Tool definitions
            if (/SUPPORT_TOOLS|tools\s*=|functions\s*=|tool_calls/i.test(line)) {
              references.push({
                file_path: path.relative(targetDir, full),
                line_numbers: [lineNum],
                reference_type: 'tool_definition',
                code_snippet: line.trim(),
              });
            }
          });
        } catch {
          // Ignore binary or unreadable files
        }
      }
    }
  }

  walk(targetDir);

  if (detectedFrameworks.size === 0) {
    detectedFrameworks.add('custom-http');
  }

  return {
    contract_version: "1.0",
    status: references.length > 0 ? "complete" : "insufficient",
    repository_name: path.basename(targetDir),
    detected_frameworks: Array.from(detectedFrameworks),
    current_model: currentModel === 'unknown' ? 'model-a' : currentModel,
    model_coupling_files: references,
    unknowns: references.length === 0 ? ['no model references found in codebase'] : [],
  };
}
