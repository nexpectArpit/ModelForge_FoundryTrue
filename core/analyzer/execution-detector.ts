/**
 * Execution Detector
 *
 * Discovers how to execute and verify the application under test.
 * Extracts runtime type, entrypoint, run command, default port, and health check
 * parameters into an ExecutionDescriptor.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionDescriptor } from '../types.js';

export function detectExecutionTopology(repoPath: string): ExecutionDescriptor {
  const pkgJsonPath = path.join(repoPath, 'package.json');
  const pyprojectPath = path.join(repoPath, 'pyproject.toml');
  const reqPath = path.join(repoPath, 'requirements.txt');

  let runtime: 'node' | 'python' | 'custom' = 'node';
  let entrypoint = '';
  let command = 'node';
  let args: string[] = [];
  let port = 8955;
  let healthPath = '/health';

  if (existsSync(pkgJsonPath)) {
    runtime = 'node';
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      const scripts = pkg.scripts || {};

      if (scripts.start) {
        command = 'npm';
        args = ['run', 'start'];
      } else if (scripts.dev) {
        command = 'npm';
        args = ['run', 'dev'];
      }

      entrypoint = pkg.main || 'src/index.ts';
    } catch {
      // Fallback
    }
  } else if (existsSync(pyprojectPath) || existsSync(reqPath)) {
    runtime = 'python';
    command = 'python';
    if (existsSync(path.join(repoPath, 'app.py'))) {
      entrypoint = 'app.py';
      args = ['app.py'];
    } else if (existsSync(path.join(repoPath, 'main.py'))) {
      entrypoint = 'main.py';
      args = ['main.py'];
    } else {
      entrypoint = 'main.py';
      args = ['main.py'];
    }
  }

  // Scan common server entry files to detect port and health endpoints
  const candidateEntryFiles = [
    'src/index.ts',
    'src/server.ts',
    'src/app.ts',
    'index.ts',
    'server.ts',
    'app.py',
    'main.py',
  ];

  for (const rel of candidateEntryFiles) {
    const full = path.join(repoPath, rel);
    if (existsSync(full)) {
      if (!entrypoint) entrypoint = rel;
      try {
        const content = readFileSync(full, 'utf8');

        // Port detection: e.g. process.env.PORT || 8955 or .listen(8955)
        const portMatch = content.match(/(?:PORT\s*\|\|\s*|listen\(\s*(?:process\.env\.PORT\s*\|\|\s*)?)(\d{4,5})/);
        if (portMatch) {
          port = Number(portMatch[1]);
        }

        // Health check endpoint detection
        const healthMatch = content.match(/['"](\/(?:health|healthz|api\/health|ping))['"]/i);
        if (healthMatch) {
          healthPath = healthMatch[1];
        }
      } catch {
        // Ignore
      }
      break;
    }
  }

  return {
    runtime,
    entrypoint: entrypoint || 'src/index.ts',
    command,
    args,
    env: {
      PORT: String(port),
      NODE_ENV: 'test',
    },
    cwd: repoPath,
    port,
    health_check: {
      path: healthPath,
      timeout_ms: 10000,
      expected_status: 200,
    },
  };
}
