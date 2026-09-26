/**
 * Source Scanner
 *
 * Scans repository source files to discover model references, client instantiations,
 * prompt templates, config settings, and environment variable dependencies.
 * Produces structured ModelReference records with exact 1-indexed line numbers
 * and confidence scores.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ModelReference, ReferenceType } from '../types.js';

export interface SourceScanResult {
  model_references: ModelReference[];
  env_dependencies: string[];
  total_source_files: number;
  total_source_lines: number;
  detected_model: string;
  has_tool_definitions: boolean;
  has_prompt_templates: boolean;
}

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', '.mypy_cache', '.pytest_cache', 'coverage',
  '.modelforge', '.modelforge-sandboxes', '.modelforge-sessions',
]);

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
]);

export const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.env', '.toml',
]);

export const MODEL_PATTERNS: Array<{ regex: RegExp; weight: number }> = [
  // Generic known model families
  { regex: /['"](gpt-4o(?:-mini)?|gpt-4-turbo|gpt-4|gpt-3\.5-turbo)['"]/i, weight: 0.95 },
  { regex: /['"](claude-3-(?:5-sonnet|opus|sonnet|haiku)(?:-\d{8})?)['"]/i, weight: 0.95 },
  // Architecture/testing model identifiers
  { regex: /['"](model-[ab])['"]/i, weight: 0.90 },

  // Generic key-value configurations: model: "..." or model_name: "..."
  { regex: /(?:model|model_name|modelId|model_id)\s*:\s*['"]([a-zA-Z0-9_\-\.\/]+)['"]/i, weight: 0.85 },
  { regex: /(?:model|model_name)\s*=\s*['"]([a-zA-Z0-9_\-\.\/]+)['"]/i, weight: 0.85 },
];

/**
 * Scan all source and config files in repoPath.
 */
export function scanSourceFiles(repoPath: string): SourceScanResult {
  const references: ModelReference[] = [];
  const envDeps = new Set<string>();

  let totalFiles = 0;
  let totalLines = 0;
  let detectedModel = 'unknown';
  let hasToolDefs = false;
  let hasPromptTemplates = false;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = path.extname(entry);
      if (!SOURCE_EXTENSIONS.has(ext) && !CONFIG_EXTENSIONS.has(ext)) continue;

      try {
        const content = readFileSync(fullPath, 'utf8');
        const relPath = path.relative(repoPath, fullPath);
        const lines = content.split('\n');

        if (SOURCE_EXTENSIONS.has(ext)) {
          totalFiles += 1;
          totalLines += lines.length;
        }

        // Check for tool definitions or prompt templates markers
        if (/tools\s*:\s*\[|functions\s*:\s*\[|z\.object\(/i.test(content)) {
          hasToolDefs = true;
        }
        if (/SystemMessage|HumanMessage|ChatPromptTemplate|prompt\s*:\s*['"`]/i.test(content)) {
          hasPromptTemplates = true;
        }

        // Scan lines
        lines.forEach((line, idx) => {
          const lineNum = idx + 1;

          // Model patterns
          for (const mp of MODEL_PATTERNS) {
            const flags = mp.regex.flags.includes('g') ? mp.regex.flags : mp.regex.flags + 'g';
            const lineRegex = new RegExp(mp.regex.source, flags);
            let match: RegExpExecArray | null;
            while ((match = lineRegex.exec(line)) !== null) {
              const modelName = match[1] ?? match[0].replace(/['"]/g, '');

              if (detectedModel === 'unknown' && modelName !== 'model-a' && modelName !== 'model-b') {
                detectedModel = modelName;
              }

              references.push({
                file_path: relPath,
                line_numbers: [lineNum],
                reference_type: classifyReference(line, modelName),
                code_snippet: line.trim(),
                confidence: computeConfidence(line, modelName),
              });
            }
          }

          // Client instantiations
          const clientMatch = line.match(/(?:new\s+(?:OpenAI|Groq|Anthropic)|(?:openai|groq|anthropic)\.(?:chat|completions))/i);
          if (clientMatch) {
            references.push({
              file_path: relPath,
              line_numbers: [lineNum],
              reference_type: 'client_init',
              code_snippet: line.trim(),
              confidence: 0.90,
            });
          }

          // Environment variable references in source
          const envMatches = line.matchAll(/process\.env\.([A-Z0-9_]+)|os\.(?:environ\[['"]([A-Z0-9_]+)['"]\]|getenv\(['"]([A-Z0-9_]+)['"]\))/g);
          for (const em of envMatches) {
            const varName = em[1] ?? em[2] ?? em[3];
            if (varName && /MODEL|API_KEY|ENDPOINT|BASE_URL|ROUTING/i.test(varName)) {
              envDeps.add(varName);
              references.push({
                file_path: relPath,
                line_numbers: [lineNum],
                reference_type: 'env_variable',
                code_snippet: line.trim(),
                confidence: 0.85,
              });
            }
          }
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(repoPath);

  // Scan standalone .env files
  const envFiles = ['.env', '.env.example', '.env.local', '.env.development'];
  for (const envFile of envFiles) {
    const fullEnvPath = path.join(repoPath, envFile);
    if (existsSync(fullEnvPath)) {
      try {
        const content = readFileSync(fullEnvPath, 'utf8');
        content.split('\n').forEach((line, idx) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (/MODEL|API_KEY|ENDPOINT|BASE_URL|ROUTING/i.test(key)) {
              envDeps.add(key);
              references.push({
                file_path: envFile,
                line_numbers: [idx + 1],
                reference_type: 'env_variable',
                code_snippet: `${key}=${value.slice(0, 30)}`,
                confidence: 0.90,
              });
            }
          }
        });
      } catch {
        // Ignore
      }
    }
  }

  // Fallback for model-a if detectedModel is still unknown
  if (detectedModel === 'unknown') {
    const modelARef = references.find(r => r.code_snippet.includes("'model-a'") || r.code_snippet.includes('"model-a"'));
    if (modelARef) {
      detectedModel = 'model-a';
    }
  }

  const deduped = deduplicateReferences(references);

  return {
    model_references: deduped,
    env_dependencies: Array.from(envDeps),
    total_source_files: totalFiles,
    total_source_lines: totalLines,
    detected_model: detectedModel,
    has_tool_definitions: hasToolDefs,
    has_prompt_templates: hasPromptTemplates,
  };
}

export function classifyReference(line: string, modelName: string): ReferenceType {
  const lower = line.toLowerCase();
  if (lower.includes('process.env') || lower.includes('os.environ') || lower.includes('getenv')) {
    return 'env_variable';
  }
  if (lower.includes('config') || lower.includes('active_model') || lower.includes('settings')) {
    return 'config_file';
  }
  if (lower.includes('system') || lower.includes('prompt') || lower.includes('template')) {
    return 'prompt_template';
  }
  if (lower.includes('import ') || lower.includes('require(')) {
    return 'import_statement';
  }
  if (lower.includes('tool') || lower.includes('function') || lower.includes('schema')) {
    return 'tool_definition';
  }
  if (lower.includes('new ') || lower.includes('client') || lower.includes('openai(') || lower.includes('groq(')) {
    return 'client_init';
  }
  return 'model_name_literal';
}

export function computeConfidence(line: string, modelName: string): number {
  let score = 0.70;
  if (/['"`][a-zA-Z0-9_\-\.]+['"`]/.test(line)) score += 0.15;
  if (/model|active_model|model_name/i.test(line)) score += 0.10;
  return Math.min(1.0, score);
}

export function deduplicateReferences(refs: ModelReference[]): ModelReference[] {
  const seen = new Set<string>();
  const deduped: ModelReference[] = [];

  for (const ref of refs) {
    const key = `${ref.file_path}:${ref.line_numbers.join(',')}:${ref.reference_type}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ref);
    }
  }

  return deduped;
}
