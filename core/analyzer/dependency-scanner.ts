/**
 * Dependency Scanner
 *
 * Scans repository manifests (package.json, pnpm-lock.yaml, requirements.txt, pyproject.toml)
 * to detect primary language, package manager, and installed AI SDK frameworks with
 * explicit semver versions and import paths.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DetectedFramework } from '../types.js';

export interface DependencyScanResult {
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  package_manager: string;
  detected_frameworks: DetectedFramework[];
}

export interface FrameworkPattern {
  name: string;
  source_patterns: RegExp[];
  package_names: string[];
  python_packages: string[];
}

export const FRAMEWORK_PATTERNS: FrameworkPattern[] = [
  {
    name: 'openai-sdk',
    source_patterns: [
      /from\s+['"]openai['"]/i,
      /require\(['"]openai['"]\)/i,
      /import.*from\s+['"]openai['"]/i,
      /new\s+OpenAI\s*\(/i,
    ],
    package_names: ['openai'],
    python_packages: ['openai'],
  },
  {
    name: 'groq-sdk',
    source_patterns: [
      /from\s+['"]groq['"]/i,
      /require\(['"]groq-sdk['"]\)/i,
      /import.*from\s+['"]groq-sdk['"]/i,
      /new\s+Groq\s*\(/i,
    ],
    package_names: ['groq-sdk', 'groq'],
    python_packages: ['groq'],
  },
  {
    name: 'ai-sdk',
    source_patterns: [
      /from\s+['"]@ai-sdk/i,
      /import.*from\s+['"]ai['"]/i,
      /from\s+['"]ai['"]/i,
    ],
    package_names: ['ai', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google'],
    python_packages: [],
  },
  {
    name: 'langchain',
    source_patterns: [
      /from\s+['"]langchain/i,
      /from\s+['"]@langchain/i,
      /import.*langchain/i,
      /from\s+langchain/i,
    ],
    package_names: ['langchain', '@langchain/core', '@langchain/openai'],
    python_packages: ['langchain', 'langchain-core', 'langchain-openai'],
  },
  {
    name: 'anthropic-sdk',
    source_patterns: [
      /from\s+['"]@anthropic-ai\/sdk['"]/i,
      /require\(['"]@anthropic-ai\/sdk['"]\)/i,
      /new\s+Anthropic\s*\(/i,
    ],
    package_names: ['@anthropic-ai/sdk'],
    python_packages: ['anthropic'],
  },
  {
    name: 'llamaindex',
    source_patterns: [
      /from\s+['"]llamaindex['"]/i,
      /import.*llamaindex/i,
    ],
    package_names: ['llamaindex'],
    python_packages: ['llama-index', 'llama_index'],
  },
];

/**
 * Scan manifests in repoPath to extract dependencies, language, and package manager.
 */
export function scanDependencies(repoPath: string): DependencyScanResult {
  const frameworks = new Map<string, DetectedFramework>();
  let language: 'typescript' | 'javascript' | 'python' | 'unknown' = 'unknown';
  let packageManager = 'unknown';

  const pkgJsonPath = path.join(repoPath, 'package.json');
  const pnpmLockPath = path.join(repoPath, 'pnpm-lock.yaml');
  const yarnLockPath = path.join(repoPath, 'yarn.lock');
  const pkgLockPath = path.join(repoPath, 'package-lock.json');
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');

  const requirementsTxtPath = path.join(repoPath, 'requirements.txt');
  const pyprojectPath = path.join(repoPath, 'pyproject.toml');

  if (existsSync(pkgJsonPath)) {
    language = existsSync(tsconfigPath) ? 'typescript' : 'javascript';

    if (existsSync(pnpmLockPath)) packageManager = 'pnpm';
    else if (existsSync(yarnLockPath)) packageManager = 'yarn';
    else if (existsSync(pkgLockPath)) packageManager = 'npm';
    else packageManager = 'npm';

    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const allDeps: Record<string, string> = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      // Check if typescript is in devDependencies
      if (allDeps['typescript'] && language !== 'typescript') {
        language = 'typescript';
      }

      for (const fp of FRAMEWORK_PATTERNS) {
        for (const pkgName of fp.package_names) {
          const version = allDeps[pkgName];
          if (version) {
            const existing = frameworks.get(fp.name);
            if (existing) {
              if (!existing.version) existing.version = version;
              if (!existing.import_paths.includes(pkgName)) {
                existing.import_paths.push(pkgName);
              }
            } else {
              frameworks.set(fp.name, {
                name: fp.name,
                version,
                import_paths: [pkgName],
              });
            }
          }
        }
      }
    } catch {
      // Malformed package.json
    }
  } else if (existsSync(requirementsTxtPath) || existsSync(pyprojectPath)) {
    language = 'python';
    packageManager = existsSync(pyprojectPath) ? 'poetry' : 'pip';

    if (existsSync(requirementsTxtPath)) {
      parsePythonRequirements(requirementsTxtPath, frameworks);
    }
    if (existsSync(pyprojectPath)) {
      parsePyproject(pyprojectPath, frameworks);
    }
  }

  return {
    language,
    package_manager: packageManager,
    detected_frameworks: Array.from(frameworks.values()),
  };
}

function parsePythonRequirements(reqPath: string, frameworks: Map<string, DetectedFramework>): void {
  try {
    const content = readFileSync(reqPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([a-zA-Z0-9_\-]+)(?:([><=!~]+)(.+))?$/);
      if (!match) continue;

      const [, pkgName, , version] = match;

      for (const fp of FRAMEWORK_PATTERNS) {
        if (fp.python_packages.includes(pkgName.toLowerCase())) {
          frameworks.set(fp.name, {
            name: fp.name,
            version: version?.trim() ?? null,
            import_paths: [pkgName],
          });
        }
      }
    }
  } catch {
    // Ignore read errors
  }
}

function parsePyproject(pyprojectPath: string, frameworks: Map<string, DetectedFramework>): void {
  try {
    const content = readFileSync(pyprojectPath, 'utf8');
    for (const fp of FRAMEWORK_PATTERNS) {
      for (const pyPkg of fp.python_packages) {
        const regex = new RegExp(`^${pyPkg}\\s*=\\s*["']([^"']+)["']`, 'm');
        const match = content.match(regex);
        if (match) {
          frameworks.set(fp.name, {
            name: fp.name,
            version: match[1],
            import_paths: [pyPkg],
          });
        }
      }
    }
  } catch {
    // Ignore
  }
}
