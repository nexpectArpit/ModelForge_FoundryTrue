/**
 * Core Analyzer Module Index
 *
 * Modular inspection system for ModelForge Architecture v2:
 *   - dependency-scanner: manifests, frameworks, package managers
 *   - source-scanner: model references, client inits, line-exact locations
 *   - tool-schema-extractor: OpenAI & Zod function tools
 *   - execution-detector: entrypoints, ports, health checks
 *   - repository-profile: complete profile builder & complexity scoring
 */

import { buildRepositoryProfile } from './repository-profile.js';
import type { RepositoryProfile } from '../types.js';

export * from './dependency-scanner.js';
export * from './source-scanner.js';
export * from './tool-schema-extractor.js';
export * from './execution-detector.js';
export * from './repository-profile.js';

/**
 * Canonical entrypoint for repository analysis.
 */
export function analyzeRepository(repoPath: string): RepositoryProfile {
  return buildRepositoryProfile(repoPath).profile;
}
