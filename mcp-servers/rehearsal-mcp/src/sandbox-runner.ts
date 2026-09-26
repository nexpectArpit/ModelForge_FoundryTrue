import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  SandboxStartupError,
  SandboxHealthcheckTimeoutError,
  SandboxProcessCrashError,
  UnknownExecutionConfigError,
} from '../../../core/errors.js';

const sessionProcesses = new Map<string, ChildProcess>();
let currentAppPort: number = 8955;

export function getCurrentAppPort(): number {
  return currentAppPort;
}

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

/**
 * Dynamically resolves application startup command based on repository inspection.
 * Never defaults blindly if no configuration exists.
 */
export function resolveStartupCommand(targetDir: string, explicitCommand?: string): { binary: string; args: string[] } {
  if (explicitCommand) {
    const parts = explicitCommand.trim().split(/\s+/);
    return { binary: parts[0], args: parts.slice(1) };
  }

  const packageJsonPath = path.join(targetDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      // Prefer dedicated start script if defined
      if (pkg.scripts?.start) {
        const parts = pkg.scripts.start.trim().split(/\s+/);
        return { binary: parts[0], args: parts.slice(1) };
      }
    } catch {
      // Fall through to entrypoint discovery
    }
  }

  // Check known standard entrypoint files
  if (existsSync(path.join(targetDir, 'src/index.ts'))) {
    return { binary: 'node', args: ['--import', 'tsx', 'src/index.ts'] };
  }
  if (existsSync(path.join(targetDir, 'src/index.js'))) {
    return { binary: 'node', args: ['src/index.js'] };
  }
  if (existsSync(path.join(targetDir, 'index.js'))) {
    return { binary: 'node', args: ['index.js'] };
  }
  if (existsSync(path.join(targetDir, 'main.py'))) {
    return { binary: 'python3', args: ['main.py'] };
  }

  throw new UnknownExecutionConfigError(targetDir, [
    'package.json (scripts.start)',
    'src/index.ts',
    'src/index.js',
    'index.js',
    'main.py',
  ]);
}

/**
 * Filter out sensitive environment variables to prevent sandbox leakages.
 */
function createSanitizedEnv(customEnv: Record<string, string> = {}): Record<string, string> {
  const allowedKeys = new Set([
    'PATH',
    'HOME',
    'USER',
    'TMPDIR',
    'NODE_ENV',
    'PORT',
    'TERM',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TZ',
    'PWD',
  ]);

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedKeys.has(key)) {
      sanitized[key] = value;
    }
  }

  // Explicitly apply caller-provided env without leaking parent process secrets
  return {
    ...sanitized,
    ...customEnv,
  };
}

export async function startSandboxApp({
  sessionId = 'default',
  targetDir,
  port = 8955,
  env = {},
  startCommand,
  healthCheckPath = '/health',
  timeoutMs = 10000,
}: {
  sessionId?: string;
  targetDir: string;
  port?: number;
  env?: Record<string, string>;
  startCommand?: string;
  healthCheckPath?: string;
  timeoutMs?: number;
}): Promise<{ status: string; port: number; pid: number; command: string }> {
  // Stop previously running process for this session if active
  const existingProcess = sessionProcesses.get(sessionId);
  if (existingProcess && !existingProcess.killed) {
    existingProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 200));
    sessionProcesses.delete(sessionId);
  }

  currentAppPort = port;
  const mergedEnv = createSanitizedEnv({
    PORT: String(port),
    ...env,
  });

  const { binary, args } = resolveStartupCommand(targetDir, startCommand);
  const commandStr = `${binary} ${args.join(' ')}`;

  let stderrBuffer = '';
  let earlyExit: { code: number | null; signal: string | null } | null = null;

  const child = spawn(binary, args, {
    cwd: targetDir,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', chunk => {
    stderrBuffer += chunk.toString();
  });

  child.on('exit', (code, signal) => {
    earlyExit = { code, signal };
    sessionProcesses.delete(sessionId);
  });

  sessionProcesses.set(sessionId, child);

  // Poll for health check
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  const healthUrl = `http://127.0.0.1:${port}${healthCheckPath}`;

  while (Date.now() < deadline) {
    const exited: any = earlyExit;
    if (exited !== null) {
      throw new SandboxStartupError(
        `Process exited prematurely during startup with code ${exited.code}`,
        exited.code,
        stderrBuffer.slice(-1000)
      );
    }

    try {
      const res = await fetch(healthUrl);
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
    sessionProcesses.delete(sessionId);
    throw new SandboxHealthcheckTimeoutError(port, timeoutMs, healthUrl);
  }

  return {
    status: 'healthy',
    port,
    pid: child.pid ?? 0,
    command: commandStr,
  };
}

export function stopSandboxApp(sessionId?: string) {
  if (sessionId) {
    const child = sessionProcesses.get(sessionId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    sessionProcesses.delete(sessionId);
  } else {
    for (const [sid, child] of sessionProcesses.entries()) {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    }
    sessionProcesses.clear();
  }
}
