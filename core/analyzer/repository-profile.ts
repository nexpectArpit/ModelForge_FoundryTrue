/**
 * Repository Profile Builder
 *
 * Integrates dependency scanner, source scanner, tool schema extractor,
 * and execution detector into a unified RepositoryProfile with complexity scores.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryProfile, ExecutionDescriptor } from '../types.js';
import { scanDependencies, type DependencyScanResult } from './dependency-scanner.js';
import { scanSourceFiles, type SourceScanResult } from './source-scanner.js';
import { extractToolSchemas } from './tool-schema-extractor.js';
import { detectExecutionTopology } from './execution-detector.js';

export interface ProfileBuildResult {
  profile: RepositoryProfile;
  execution_descriptor: ExecutionDescriptor;
}

export function buildRepositoryProfile(repoPath: string): ProfileBuildResult {
  const targetDir = path.resolve(process.cwd(), repoPath);

  if (!existsSync(targetDir)) {
    const errorProfile: RepositoryProfile = {
      contract_version: '2.0',
      status: 'error',
      repository_path: targetDir,
      repository_name: path.basename(targetDir),
      language: 'unknown',
      package_manager: 'unknown',
      detected_frameworks: [],
      current_model: 'unknown',
      model_references: [],
      tool_schemas: [],
      env_dependencies: [],
      unknowns: [`Directory does not exist: ${targetDir}`],
      inspected_at: new Date().toISOString(),
    };
    return {
      profile: errorProfile,
      execution_descriptor: {
        runtime: 'custom',
        entrypoint: '',
        command: '',
        args: [],
        env: {},
      },
    };
  }

  // 1. Scan dependencies and manifests
  const deps = scanDependencies(targetDir);

  // 2. Scan source code and model references
  const source = scanSourceFiles(targetDir);

  // 3. Extract tool schemas
  const toolSchemas = extractToolSchemas(targetDir);

  // 4. Detect execution topology
  const executionDescriptor = detectExecutionTopology(targetDir);

  // 5. Ensure fallback framework tag
  const frameworks = [...deps.detected_frameworks];
  if (frameworks.length === 0) {
    frameworks.push({
      name: 'custom-http',
      version: null,
      import_paths: [],
    });
  }

  // 6. Compute objective complexity
  const complexity = computeComplexity({
    totalSourceFiles: source.total_source_files,
    totalSourceLines: source.total_source_lines,
    frameworkCount: frameworks.length,
    toolSchemaCount: toolSchemas.length,
    envDepCount: source.env_dependencies.length,
    modelRefCount: source.model_references.length,
    hasToolDefinitions: source.has_tool_definitions,
    hasPromptTemplates: source.has_prompt_templates,
  });

  const profile: RepositoryProfile = {
    contract_version: '2.0',
    status: source.model_references.length > 0 ? 'complete' : 'incomplete',
    repository_path: targetDir,
    repository_name: path.basename(targetDir),
    language: deps.language,
    package_manager: deps.package_manager,
    detected_frameworks: frameworks,
    current_model: source.detected_model,
    model_references: source.model_references,
    tool_schemas: toolSchemas,
    env_dependencies: source.env_dependencies,
    unknowns: source.model_references.length === 0 ? ['No model references found in codebase'] : [],
    inspected_at: new Date().toISOString(),
    complexity,
  };

  return {
    profile,
    execution_descriptor: executionDescriptor,
  };
}

export function computeComplexity(input: {
  totalSourceFiles: number;
  totalSourceLines: number;
  frameworkCount: number;
  toolSchemaCount: number;
  envDepCount: number;
  modelRefCount: number;
  hasToolDefinitions: boolean;
  hasPromptTemplates: boolean;
}): {
  level: 'trivial' | 'standard' | 'complex' | 'advanced';
  score: number;
  factors: Array<{ name: string; weight: number; description: string }>;
} {
  const factors: Array<{ name: string; weight: number; description: string }> = [];
  let score = 0;

  if (input.totalSourceFiles > 50) {
    factors.push({ name: 'large_codebase', weight: 15, description: `${input.totalSourceFiles} source files` });
    score += 15;
  } else if (input.totalSourceFiles > 20) {
    factors.push({ name: 'medium_codebase', weight: 8, description: `${input.totalSourceFiles} source files` });
    score += 8;
  }

  if (input.frameworkCount > 2) {
    factors.push({ name: 'multi_framework', weight: 20, description: `${input.frameworkCount} AI frameworks detected` });
    score += 20;
  } else if (input.frameworkCount > 1) {
    factors.push({ name: 'dual_framework', weight: 10, description: `${input.frameworkCount} AI frameworks detected` });
    score += 10;
  }

  if (input.toolSchemaCount > 5) {
    factors.push({ name: 'heavy_tool_usage', weight: 25, description: `${input.toolSchemaCount} tool schemas defined` });
    score += 25;
  } else if (input.hasToolDefinitions) {
    factors.push({ name: 'tool_calling', weight: 15, description: 'Tool/function definitions present' });
    score += 15;
  }

  if (input.envDepCount > 5) {
    factors.push({ name: 'heavy_env_coupling', weight: 12, description: `${input.envDepCount} environment dependencies` });
    score += 12;
  } else if (input.envDepCount > 2) {
    factors.push({ name: 'env_coupling', weight: 5, description: `${input.envDepCount} environment dependencies` });
    score += 5;
  }

  if (input.modelRefCount > 20) {
    factors.push({ name: 'high_model_coupling', weight: 18, description: `${input.modelRefCount} model references across codebase` });
    score += 18;
  } else if (input.modelRefCount > 5) {
    factors.push({ name: 'moderate_model_coupling', weight: 8, description: `${input.modelRefCount} model references across codebase` });
    score += 8;
  }

  if (input.hasPromptTemplates) {
    factors.push({ name: 'prompt_templates', weight: 10, description: 'Prompt templates detected' });
    score += 10;
  }

  let level: 'trivial' | 'standard' | 'complex' | 'advanced' = 'trivial';
  if (score >= 60) level = 'advanced';
  else if (score >= 35) level = 'complex';
  else if (score >= 15) level = 'standard';

  return { level, score, factors };
}
