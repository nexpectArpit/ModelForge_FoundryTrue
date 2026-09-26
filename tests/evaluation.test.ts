import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { startSandboxApp, stopSandboxApp, stageMigrationDiff } from '../mcp-servers/rehearsal-mcp/src/sandbox-runner.js';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import { createSessionId } from '../core/types.js';
import { runDeterministicEvaluation } from '../evaluation/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');
const PORT = 8999;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/chat`;

describe('Deterministic Evaluation Engine', () => {
  let sandbox: WorkspaceSandbox;
  let testSandboxRoot: string;

  beforeAll(async () => {
    testSandboxRoot = fs.mkdtempSync(path.join(__dirname, '../.test-eval-sandbox-'));
    sandbox = new WorkspaceSandbox({
      sessionId: createSessionId(),
      sourcePath: APP_DIR,
      sandboxRoot: testSandboxRoot,
    });
    sandbox.initialize();
  });

  afterAll(() => {
    stopSandboxApp();
    sandbox.discard();
    if (fs.existsSync(testSandboxRoot)) {
      fs.rmSync(testSandboxRoot, { recursive: true, force: true });
    }
  });

  it('evaluates baseline Model A and achieves 100% PASS', async () => {
    await stageMigrationDiff({ targetDir: sandbox.sandboxPath, activeModel: 'model-a', routingMode: 'direct' });
    await startSandboxApp({ targetDir: sandbox.sandboxPath, port: PORT });
    const result = await runDeterministicEvaluation({
      endpointUrl: ENDPOINT,
      candidateId: 'baseline-model-a',
    });

    expect(result.total_cases).toBe(15);
    expect(result.passed_cases).toBe(15);
    expect(result.quality.score).toBe(1.0);
    expect(result.quality.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
    expect(result.overall).toBe('PASS');
  });

  it('detects tool calling regression in naive Model B and produces FAIL', async () => {
    await stageMigrationDiff({ targetDir: sandbox.sandboxPath, activeModel: 'model-b', routingMode: 'direct' });
    await startSandboxApp({ targetDir: sandbox.sandboxPath, port: PORT });
    const result = await runDeterministicEvaluation({
      endpointUrl: ENDPOINT,
      candidateId: 'candidate-model-b-naive',
    });

    expect(result.total_cases).toBe(15);
    expect(result.passed_cases).toBe(11); // 4 QA + 4 Summarize + 3 Extract = 11 pass, 4 Tool fail
    expect(result.quality.score).toBe(0.73);
    expect(result.quality.passed).toBe(false);
    expect(result.overall).toBe('FAIL');
    expect(result.regressions.length).toBe(4);
    expect(result.regressions[0].category).toBe('tool');
    expect(result.regressions[0].error).toContain('schema validation failed');
  });

  it('evaluates Hybrid Router and achieves 100% PASS with >70% cost savings', async () => {
    await stageMigrationDiff({ targetDir: sandbox.sandboxPath, activeModel: 'model-b', routingMode: 'hybrid' });
    await startSandboxApp({ targetDir: sandbox.sandboxPath, port: PORT });
    const result = await runDeterministicEvaluation({
      endpointUrl: ENDPOINT,
      candidateId: 'candidate-model-b-hybrid',
    });

    expect(result.total_cases).toBe(15);
    expect(result.passed_cases).toBe(15);
    expect(result.quality.score).toBe(1.0);
    expect(result.quality.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
    expect(result.cost.savings_pct).toBeGreaterThan(65);
    expect(result.overall).toBe('PASS');
  });
});
