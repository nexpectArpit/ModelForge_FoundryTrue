/**
 * Sandbox Strict Isolation Integration Test
 *
 * Verifies that during the complete rehearsal lifecycle:
 *   1. Repository is hashed before staging
 *   2. stage_code_migration applies code changes
 *   3. sandbox_run_app starts the application
 *   4. run_deterministic_benchmark evaluates the application
 *   5. Repository is hashed again
 *   6. ZERO source-repository mutation occurs (exact byte-for-byte tree match)
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  handleRehearsalToolCall,
  resetRehearsalState,
  getActiveSandbox,
} from '../mcp-servers/rehearsal-mcp/src/server.js';
import { stopSandboxApp } from '../mcp-servers/rehearsal-mcp/src/sandbox-runner.js';
import crypto from 'node:crypto';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_APP = path.resolve(__dirname, '../demo-apps/customer-support-app');

function computeDirectoryTreeHashes(
  dir: string,
  exclude = new Set(['.git', 'node_modules', '.modelforge-sandboxes', 'dist', 'build', '.DS_Store']),
): Record<string, string> {
  const hashes: Record<string, string> = {};

  function walk(current: string) {
    const entries = readdirSync(current);
    for (const entry of entries) {
      if (exclude.has(entry)) continue;
      const fullPath = path.join(current, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const content = readFileSync(fullPath);
        const rel = path.relative(dir, fullPath);
        hashes[rel] = crypto.createHash('sha256').update(content).digest('hex');
      }
    }
  }

  walk(dir);
  return hashes;
}

function computeCombinedTreeHash(hashes: Record<string, string>): string {
  const sorted = Object.keys(hashes)
    .sort()
    .map(k => `${k}:${hashes[k]}`)
    .join('\n');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

describe('Sandbox Strict Isolation', () => {
  afterEach(() => {
    stopSandboxApp();
    resetRehearsalState();
  });

  it('guarantees zero source-repository mutation during full rehearsal pipeline', async () => {
    // 1. Hash the entire source repository before any staging begins
    const preStageHashes = computeDirectoryTreeHashes(DEMO_APP);
    const preStageCombinedHash = computeCombinedTreeHash(preStageHashes);

    expect(Object.keys(preStageHashes).length).toBeGreaterThan(0);

    // 2. Lifecycle: Inspect & Plan
    await handleRehearsalToolCall('repo_inspect_ai_usage', { repo_path: DEMO_APP });
    await handleRehearsalToolCall('generate_migration_plan', {
      source_model: 'model-a',
      target_model: 'model-b',
    });

    // 3. Stage candidate model in sandbox
    const stagedResult: any = await handleRehearsalToolCall('stage_code_migration', {
      repo_path: DEMO_APP,
      active_model: 'model-b',
    });

    expect(stagedResult.sandbox_path).toBeDefined();
    expect(stagedResult.sandbox_path).not.toBe(DEMO_APP);

    // Verify modifications happened INSIDE the sandbox
    const activeSandbox = getActiveSandbox();
    expect(activeSandbox).toBeDefined();
    const sandboxedConfig = activeSandbox!.readFile('src/config.ts');
    expect(sandboxedConfig).toContain('model-b');

    // 4. Start the application inside the sandbox
    const testPort = 8968;
    const appResult: any = await handleRehearsalToolCall('sandbox_run_app', {
      port: testPort,
    });
    expect(appResult.status).toBe('healthy');
    expect(appResult.sandbox_path).toBe(stagedResult.sandbox_path);

    // 5. Run deterministic evaluation against the sandboxed app
    const evalReport: any = await handleRehearsalToolCall('run_deterministic_benchmark', {
      endpoint_url: `http://127.0.0.1:${testPort}/api/chat`,
      candidate_id: 'isolation-test-candidate',
    });
    expect(evalReport.total_cases).toBeGreaterThan(0);

    // Stop process
    stopSandboxApp();

    // 6. Hash the entire source repository after all operations
    const postEvalHashes = computeDirectoryTreeHashes(DEMO_APP);
    const postEvalCombinedHash = computeCombinedTreeHash(postEvalHashes);

    // 7. Verify byte-for-byte exact equality of every single file
    expect(postEvalCombinedHash).toBe(preStageCombinedHash);
    expect(postEvalHashes).toEqual(preStageHashes);

    // Specifically confirm source src/config.ts still has baseline model-a and was not changed
    const sourceConfig = readFileSync(path.join(DEMO_APP, 'src/config.ts'), 'utf8');
    expect(sourceConfig).toContain("active_model: process.env.APP_MODEL ?? 'model-a'");
    expect(sourceConfig).not.toContain("active_model: process.env.APP_MODEL ?? 'model-b'");
  }, 30000);
});
