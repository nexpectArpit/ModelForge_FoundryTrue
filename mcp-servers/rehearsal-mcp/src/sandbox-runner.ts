import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let activeAppProcess: ChildProcess | null = null;
let currentAppPort: number = 8955;

export async function stageMigrationDiff({
  targetDir,
  targetFile,
  activeModel,
  routingMode,
}: {
  targetDir: string;
  targetFile?: string;
  activeModel: string;
  routingMode?: 'direct' | 'hybrid';
}) {
  const file = path.resolve(targetDir, targetFile ?? 'src/config.ts');
  const original = readFileSync(file, 'utf8');

  let updated = original.replace(
    /active_model:\s*process\.env\.APP_MODEL\s*\?\?\s*['"][^'"]+['"]/g,
    `active_model: process.env.APP_MODEL ?? '${activeModel}'`
  );

  if (routingMode) {
    updated = updated.replace(
      /routing_mode:\s*\(process\.env\.APP_ROUTING_MODE\s*as\s*[^)]+\)\s*\?\?\s*['"][^'"]+['"]/g,
      `routing_mode: (process.env.APP_ROUTING_MODE as 'direct' | 'hybrid') ?? '${routingMode}'`
    );
  }

  writeFileSync(file, updated, 'utf8');
  return {
    staged_file: path.relative(targetDir, file),
    active_model: activeModel,
    routing_mode: routingMode ?? 'direct',
    timestamp: new Date().toISOString(),
  };
}

export async function startSandboxApp({
  targetDir,
  port = 8955,
  env = {},
}: {
  targetDir: string;
  port?: number;
  env?: Record<string, string>;
}): Promise<{ status: string; port: number; pid: number }> {
  // Stop any previously running process
  if (activeAppProcess && !activeAppProcess.killed) {
    activeAppProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 200));
  }

  currentAppPort = port;
  const mergedEnv = {
    ...process.env,
    PORT: String(port),
    ...env,
  };

  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: targetDir,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeAppProcess = child;

  // Poll for health check
  const deadline = Date.now() + 10000;
  let healthy = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`Sandbox app on port ${port} failed health check within 10 seconds`);
  }

  return {
    status: 'healthy',
    port,
    pid: child.pid ?? 0,
  };
}

export function stopSandboxApp() {
  if (activeAppProcess && !activeAppProcess.killed) {
    activeAppProcess.kill('SIGTERM');
    activeAppProcess = null;
  }
}
