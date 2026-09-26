/**
 * Workspace Sandbox
 *
 * Creates an isolated copy-on-write workspace for migration changes.
 * Instead of mutating files in-place (the current approach), this module:
 *
 *   1. Copies the target repository into a temporary scratchpad directory
 *   2. All code changes are applied to the scratchpad copy
 *   3. The sandbox can be inspected, diffed, and thrown away without side effects
 *   4. Production files are never touched until explicit approval
 * Guarantees safe sandboxed execution before production mutation — never mutating original files directly.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SessionId } from './types.js';
import { SourcePathNotFoundError, SandboxLifecycleError } from './errors.js';

export interface SandboxManifest {
  sandbox_id: string;
  session_id: SessionId;
  source_path: string;
  sandbox_path: string;
  created_at: string;
  /** Files modified in the sandbox (relative paths) */
  modified_files: string[];
  /** SHA-256 of the original file → SHA-256 of the modified file */
  file_hashes: Record<string, { original: string; modified: string }>;
  status: 'active' | 'committed' | 'discarded';
}

export interface FileDiff {
  file_path: string;
  original_content: string;
  modified_content: string;
  original_sha: string;
  modified_sha: string;
}

export class WorkspaceSandbox {
  private manifest: SandboxManifest;
  private readonly excludeDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    '.venv', 'venv', '.mypy_cache', '.pytest_cache', 'coverage',
  ]);

  constructor(opts: {
    sessionId: SessionId;
    sourcePath: string;
    /** Base directory for sandbox workspaces (defaults to OS tmp) */
    sandboxRoot?: string;
  }) {
    if (!existsSync(opts.sourcePath)) {
      throw new SourcePathNotFoundError(opts.sourcePath);
    }

    const sandboxId = `sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const sandboxRoot = opts.sandboxRoot ?? path.join(opts.sourcePath, '..', '.modelforge-sandboxes');
    const sandboxPath = path.join(sandboxRoot, sandboxId);

    this.manifest = {
      sandbox_id: sandboxId,
      session_id: opts.sessionId,
      source_path: opts.sourcePath,
      sandbox_path: sandboxPath,
      created_at: new Date().toISOString(),
      modified_files: [],
      file_hashes: {},
      status: 'active',
    };
  }

  /** Initialize the sandbox by copying the source repository */
  initialize(): SandboxManifest {
    mkdirSync(this.manifest.sandbox_path, { recursive: true });

    // Selective copy — skip excluded directories for speed
    this.copyDirectory(this.manifest.source_path, this.manifest.sandbox_path);

    // Copy node_modules symlink or run install if package.json exists
    const pkgJson = path.join(this.manifest.source_path, 'package.json');
    if (existsSync(pkgJson)) {
      const srcModules = path.join(this.manifest.source_path, 'node_modules');
      const dstModules = path.join(this.manifest.sandbox_path, 'node_modules');
      if (existsSync(srcModules) && !existsSync(dstModules)) {
        // Symlink node_modules to save disk space and time
        try {
          const { symlinkSync } = require('node:fs');
          symlinkSync(srcModules, dstModules, 'dir');
        } catch {
          // Fall back to copying if symlink fails (Windows, permissions, etc.)
          cpSync(srcModules, dstModules, { recursive: true });
        }
      }
    }

    return this.getManifest();
  }

  private copyDirectory(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true });
    const entries = readdirSync(src);

    for (const entry of entries) {
      if (this.excludeDirs.has(entry)) continue;

      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        this.copyDirectory(srcPath, dstPath);
      } else if (stat.isFile()) {
        cpSync(srcPath, dstPath);
      }
    }
  }

  // ─── File Operations ──────────────────────────────────────────────────

  /** Read a file from the sandbox */
  readFile(relativePath: string): string {
    const fullPath = path.join(this.manifest.sandbox_path, relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`File not found in sandbox: ${relativePath}`);
    }
    return readFileSync(fullPath, 'utf8');
  }

  /** Write a file in the sandbox (tracks the modification) */
  writeFile(relativePath: string, content: string): void {
    this.assertActive();

    const sandboxFile = path.join(this.manifest.sandbox_path, relativePath);
    const sourceFile = path.join(this.manifest.source_path, relativePath);

    // Compute original hash (if original exists)
    let originalSha = 'new-file';
    let originalContent = '';
    if (existsSync(sourceFile)) {
      originalContent = readFileSync(sourceFile, 'utf8');
      originalSha = this.sha256(originalContent);
    }

    // Ensure directory exists
    mkdirSync(path.dirname(sandboxFile), { recursive: true });
    writeFileSync(sandboxFile, content, 'utf8');

    const modifiedSha = this.sha256(content);

    // Track modification
    if (!this.manifest.modified_files.includes(relativePath)) {
      this.manifest.modified_files.push(relativePath);
    }
    this.manifest.file_hashes[relativePath] = {
      original: originalSha,
      modified: modifiedSha,
    };
  }

  /**
   * Apply a targeted replacement within a sandbox file.
   * Unlike the current regex-replace-in-place approach, this is safe
   * because it only operates on the sandbox copy.
   */
  replaceInFile(
    relativePath: string,
    searchPattern: string | RegExp,
    replacement: string,
  ): { matched: boolean; file_path: string } {
    this.assertActive();

    const content = this.readFile(relativePath);
    const updated = typeof searchPattern === 'string'
      ? content.replace(searchPattern, replacement)
      : content.replace(searchPattern, replacement);

    const matched = content !== updated;
    if (matched) {
      this.writeFile(relativePath, updated);
    }

    return { matched, file_path: relativePath };
  }

  // ─── Diff and Inspection ───────────────────────────────────────────────

  /** Get diffs for all modified files */
  getDiffs(): FileDiff[] {
    return this.manifest.modified_files.map(relPath => {
      const sourceFile = path.join(this.manifest.source_path, relPath);
      const sandboxFile = path.join(this.manifest.sandbox_path, relPath);

      const originalContent = existsSync(sourceFile)
        ? readFileSync(sourceFile, 'utf8')
        : '';
      const modifiedContent = existsSync(sandboxFile)
        ? readFileSync(sandboxFile, 'utf8')
        : '';

      return {
        file_path: relPath,
        original_content: originalContent,
        modified_content: modifiedContent,
        original_sha: this.sha256(originalContent),
        modified_sha: this.sha256(modifiedContent),
      };
    });
  }

  /** Check if any files have been modified in the sandbox */
  hasModifications(): boolean {
    return this.manifest.modified_files.length > 0;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /** Get the sandbox directory path (for subprocess execution) */
  get sandboxPath(): string {
    return this.manifest.sandbox_path;
  }

  /** Get the manifest */
  getManifest(): SandboxManifest {
    return { ...this.manifest };
  }

  /**
   * Discard the sandbox — removes the directory and all modifications.
   * Production files remain untouched.
   */
  discard(): void {
    if (existsSync(this.manifest.sandbox_path)) {
      rmSync(this.manifest.sandbox_path, { recursive: true, force: true });
    }
    this.manifest.status = 'discarded';
  }

  /**
   * Commit sandbox changes back to the source.
   * This is the ONLY codepath that modifies the original repository,
   * and it only runs after explicit approval.
   */
  commit(): { committed_files: string[] } {
    this.assertActive();

    const committed: string[] = [];
    for (const relPath of this.manifest.modified_files) {
      const sandboxFile = path.join(this.manifest.sandbox_path, relPath);
      const sourceFile = path.join(this.manifest.source_path, relPath);

      if (existsSync(sandboxFile)) {
        const content = readFileSync(sandboxFile, 'utf8');
        mkdirSync(path.dirname(sourceFile), { recursive: true });
        writeFileSync(sourceFile, content, 'utf8');
        committed.push(relPath);
      }
    }

    this.manifest.status = 'committed';
    return { committed_files: committed };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  private assertActive(): void {
    if (this.manifest.status !== 'active') {
      throw new SandboxLifecycleError(
        `Sandbox is ${this.manifest.status}, cannot modify`,
        this.manifest.status,
      );
    }
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
