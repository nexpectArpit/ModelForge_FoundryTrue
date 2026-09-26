/**
 * Verifiable Approval Token System
 *
 * Implements an independently verifiable approval artifact for production mutations.
 * Invariant: NO VALID APPROVAL -> NO PRODUCTION MUTATION.
 *
 * Tokens are cryptographically bound to:
 *   - The specific migration session_id
 *   - The prepared canary_id
 *   - The proposed manifest_sha (content of the routing change)
 *   - The operator decision ('allow' | 'deny')
 *   - An issuance timestamp and expiration window
 */

import crypto from 'node:crypto';
import type { SessionId } from './types.js';

const DEFAULT_SECRET = process.env.MODELFORGE_APPROVAL_SECRET ?? 'modelforge-internal-gate-secret-key-32b';

export interface ApprovalPayload {
  version: '1.0';
  session_id: SessionId;
  canary_id: string;
  manifest_sha: string;
  decision: 'allow' | 'deny';
  operator: string;
  issued_at: string;
  expires_at: string;
}

export interface ApprovalArtifact {
  payload: ApprovalPayload;
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  artifact?: ApprovalArtifact;
}

/**
 * Generate a signed approval artifact for an operator sign-off.
 */
export function issueApprovalArtifact(opts: {
  sessionId: SessionId;
  canaryId: string;
  manifestSha: string;
  decision: 'allow' | 'deny';
  operator?: string;
  ttlSeconds?: number;
  secret?: string;
}): ApprovalArtifact {
  const issuedAt = new Date();
  const ttlMs = (opts.ttlSeconds ?? 300) * 1000; // 5 min default TTL
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);

  const payload: ApprovalPayload = {
    version: '1.0',
    session_id: opts.sessionId,
    canary_id: opts.canaryId,
    manifest_sha: opts.manifestSha,
    decision: opts.decision,
    operator: opts.operator ?? 'operator-console',
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const secret = opts.secret ?? DEFAULT_SECRET;
  const canonical = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');

  return { payload, signature };
}

/**
 * Independently verify an approval artifact before allowing production mutation.
 */
export function verifyApprovalArtifact(
  artifact: unknown,
  expected: {
    sessionId: SessionId | string;
    canaryId: string;
    manifestSha: string;
  },
  secret: string = DEFAULT_SECRET,
): VerificationResult {
  if (!artifact || typeof artifact !== 'object') {
    return { valid: false, reason: 'Missing or malformed approval artifact' };
  }

  const { payload, signature } = artifact as ApprovalArtifact;
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string') {
    return { valid: false, reason: 'Invalid approval artifact structure: missing payload or signature' };
  }

  // 1. Verify cryptographic signature
  const canonical = JSON.stringify(payload);
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSig, 'utf8'))) {
    return { valid: false, reason: 'Cryptographic signature mismatch: artifact was forged or tampered' };
  }

  // 2. Verify explicit allowance decision
  if (payload.decision !== 'allow') {
    return { valid: false, reason: `Approval decision was '${payload.decision}', not 'allow'` };
  }

  // 3. Verify session ID match
  if (payload.session_id !== expected.sessionId) {
    return {
      valid: false,
      reason: `Session ID mismatch: artifact is for '${payload.session_id}', expected '${expected.sessionId}'`,
    };
  }

  // 4. Verify canary ID match
  if (payload.canary_id !== expected.canaryId) {
    return {
      valid: false,
      reason: `Canary ID mismatch: artifact is for '${payload.canary_id}', expected '${expected.canaryId}'`,
    };
  }

  // 5. Verify manifest SHA match
  if (payload.manifest_sha !== expected.manifestSha) {
    return {
      valid: false,
      reason: `Manifest SHA mismatch: artifact approved '${payload.manifest_sha}', but live plan is '${expected.manifestSha}'`,
    };
  }

  // 6. Verify expiration
  const now = Date.now();
  const expTime = Date.parse(payload.expires_at);
  if (Number.isNaN(expTime) || now > expTime) {
    return { valid: false, reason: 'Approval artifact has expired' };
  }

  return { valid: true, artifact: { payload, signature } };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const APPROVALS_DIR = path.resolve(process.cwd(), '.modelforge-approvals');

export function registerApprovalArtifact(artifact: ApprovalArtifact): void {
  try {
    mkdirSync(APPROVALS_DIR, { recursive: true });
    const filePath = path.join(APPROVALS_DIR, `${artifact.payload.canary_id}.json`);
    writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  } catch {
    // Best-effort disk persistence
  }
}

export function getRegisteredApprovalArtifact(canaryId: string): ApprovalArtifact | null {
  try {
    const filePath = path.join(APPROVALS_DIR, `${canaryId}.json`);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    }
  } catch {
    // Ignore read errors
  }
  return null;
}
