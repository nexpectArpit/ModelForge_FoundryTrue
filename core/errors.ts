/**
 * ModelForge Domain Error Taxonomy
 *
 * Architectural Principle #7: Typed domain error taxonomy
 * Architectural Principle #6: Fail-closed behavior
 *
 * Every error that can occur in the ModelForge domain is a subclass of
 * ModelForgeError. No more bare `throw new Error(string)`.
 *
 * Categories:
 *   - StateError: invalid state machine transitions
 *   - ValidationError: data contracts violated
 *   - SandboxError: sandbox isolation violations
 *   - PatchError: code mutation failures
 *   - EvaluationError: evaluation pipeline failures
 *   - PersistenceError: durable state store failures
 *   - ApprovalError: production gating violations
 *   - RecoveryError: restart reconciliation failures
 *
 * Design: Each error carries a `code` (machine-readable),
 * `category` (for routing/observability), and optional `context`
 * (structured metadata for audit logging).
 */

// ─── Error Categories ────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'state'
  | 'validation'
  | 'sandbox'
  | 'patching'
  | 'evaluation'
  | 'persistence'
  | 'approval'
  | 'recovery'
  | 'mcp_boundary'
  | 'unknown';

// ─── Base Error ──────────────────────────────────────────────────────────────

export class ModelForgeError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly timestamp: string;

  constructor(
    message: string,
    opts: {
      category: ErrorCategory;
      code: string;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ModelForgeError';
    this.category = opts.category;
    this.code = opts.code;
    this.context = opts.context ?? {};
    this.timestamp = new Date().toISOString();
  }

  /** Structured representation for audit logging */
  toAuditRecord(): Record<string, unknown> {
    return {
      error_name: this.name,
      error_code: this.code,
      error_category: this.category,
      error_message: this.message,
      error_context: this.context,
      error_timestamp: this.timestamp,
      error_cause: this.cause instanceof Error ? this.cause.message : undefined,
    };
  }
}

// ─── State Errors ────────────────────────────────────────────────────────────

export class InvalidTransitionError extends ModelForgeError {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid state transition: ${from} → ${to}`, {
      category: 'state',
      code: 'STATE_INVALID_TRANSITION',
      context: { from_state: from, to_state: to },
    });
    this.name = 'InvalidTransitionError';
  }
}

export class SessionNotFoundError extends ModelForgeError {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`, {
      category: 'state',
      code: 'STATE_SESSION_NOT_FOUND',
      context: { session_id: sessionId },
    });
    this.name = 'SessionNotFoundError';
  }
}

export class InvalidStateForOperationError extends ModelForgeError {
  constructor(operation: string, currentState: string, requiredStates: string[]) {
    super(
      `Cannot perform "${operation}" in state "${currentState}". Required: [${requiredStates.join(', ')}]`,
      {
        category: 'state',
        code: 'STATE_INVALID_FOR_OPERATION',
        context: { operation, current_state: currentState, required_states: requiredStates },
      },
    );
    this.name = 'InvalidStateForOperationError';
  }
}

// ─── Validation Errors ───────────────────────────────────────────────────────

export class ContractValidationError extends ModelForgeError {
  constructor(contractName: string, violations: string[]) {
    super(
      `Contract "${contractName}" validation failed: ${violations.join('; ')}`,
      {
        category: 'validation',
        code: 'VALIDATION_CONTRACT_VIOLATION',
        context: { contract: contractName, violations },
      },
    );
    this.name = 'ContractValidationError';
  }
}

export class AdmissibilityError extends ModelForgeError {
  constructor(artifactType: string, reasons: string[]) {
    super(
      `${artifactType} inadmissible: ${reasons.join('; ')}`,
      {
        category: 'validation',
        code: 'VALIDATION_INADMISSIBLE',
        context: { artifact_type: artifactType, reasons },
      },
    );
    this.name = 'AdmissibilityError';
  }
}

export class MCPBoundaryError extends ModelForgeError {
  constructor(toolName: string, validationErrors: string[]) {
    super(
      `MCP tool "${toolName}" input validation failed: ${validationErrors.join('; ')}`,
      {
        category: 'mcp_boundary',
        code: 'MCP_INPUT_VALIDATION_FAILED',
        context: { tool_name: toolName, validation_errors: validationErrors },
      },
    );
    this.name = 'MCPBoundaryError';
  }
}

// ─── Sandbox Errors ──────────────────────────────────────────────────────────

export class SandboxNotInitializedError extends ModelForgeError {
  constructor(sessionId: string) {
    super(
      `No active sandbox for session "${sessionId}". Call stage_code_migration first.`,
      {
        category: 'sandbox',
        code: 'SANDBOX_NOT_INITIALIZED',
        context: { session_id: sessionId },
      },
    );
    this.name = 'SandboxNotInitializedError';
  }
}

export class SandboxVerificationError extends ModelForgeError {
  constructor(errors: string[]) {
    super(
      `Sandbox patch verification failed: ${errors.join('; ')}`,
      {
        category: 'sandbox',
        code: 'SANDBOX_VERIFICATION_FAILED',
        context: { verification_errors: errors },
      },
    );
    this.name = 'SandboxVerificationError';
  }
}

export class SandboxLifecycleError extends ModelForgeError {
  constructor(message: string, status: string) {
    super(message, {
      category: 'sandbox',
      code: 'SANDBOX_LIFECYCLE_ERROR',
      context: { sandbox_status: status },
    });
    this.name = 'SandboxLifecycleError';
  }
}

export class SourcePathNotFoundError extends ModelForgeError {
  constructor(sourcePath: string) {
    super(`Source path does not exist: ${sourcePath}`, {
      category: 'sandbox',
      code: 'SANDBOX_SOURCE_NOT_FOUND',
      context: { source_path: sourcePath },
    });
    this.name = 'SourcePathNotFoundError';
  }
}

// ─── Patching Errors ─────────────────────────────────────────────────────────

export class PatchPreconditionError extends ModelForgeError {
  constructor(patchId: string, precondition: string) {
    super(
      `Patch "${patchId}" precondition failed: ${precondition}`,
      {
        category: 'patching',
        code: 'PATCH_PRECONDITION_FAILED',
        context: { patch_id: patchId, precondition },
      },
    );
    this.name = 'PatchPreconditionError';
  }
}

export class PatchApplicationError extends ModelForgeError {
  constructor(patchId: string, filePath: string, reason: string) {
    super(
      `Failed to apply patch "${patchId}" to "${filePath}": ${reason}`,
      {
        category: 'patching',
        code: 'PATCH_APPLICATION_FAILED',
        context: { patch_id: patchId, file_path: filePath, reason },
      },
    );
    this.name = 'PatchApplicationError';
  }
}

// ─── Evaluation Errors ───────────────────────────────────────────────────────

export class EvaluationConfigError extends ModelForgeError {
  constructor(message: string) {
    super(message, {
      category: 'evaluation',
      code: 'EVALUATION_CONFIG_ERROR',
    });
    this.name = 'EvaluationConfigError';
  }
}

export class EvaluationAdapterError extends ModelForgeError {
  constructor(adapterType: string, reason: string, cause?: Error) {
    super(
      `Evaluation adapter "${adapterType}" failed: ${reason}`,
      {
        category: 'evaluation',
        code: 'EVALUATION_ADAPTER_FAILED',
        context: { adapter_type: adapterType, reason },
        cause,
      },
    );
    this.name = 'EvaluationAdapterError';
  }
}

export class NoPrecedingEvaluationError extends ModelForgeError {
  constructor(sessionId: string) {
    super(
      `No evaluation report available in session "${sessionId}" to diagnose`,
      {
        category: 'evaluation',
        code: 'EVALUATION_NO_PRECEDING_REPORT',
        context: { session_id: sessionId },
      },
    );
    this.name = 'NoPrecedingEvaluationError';
  }
}

export class NoPrecedingProfileError extends ModelForgeError {
  constructor(sessionId: string) {
    super(
      `No repository profile available in session "${sessionId}". Inspect first.`,
      {
        category: 'evaluation',
        code: 'NO_PRECEDING_PROFILE',
        context: { session_id: sessionId },
      },
    );
    this.name = 'NoPrecedingProfileError';
  }
}

// ─── Persistence Errors ──────────────────────────────────────────────────────

export class PersistenceError extends ModelForgeError {
  constructor(operation: string, reason: string, cause?: Error) {
    super(
      `Persistence operation "${operation}" failed: ${reason}`,
      {
        category: 'persistence',
        code: 'PERSISTENCE_FAILED',
        context: { operation, reason },
        cause,
      },
    );
    this.name = 'PersistenceError';
  }
}

// ─── Approval Errors ─────────────────────────────────────────────────────────

export class ApprovalRequiredError extends ModelForgeError {
  constructor(sessionId: string, canaryId: string) {
    super(
      `Production mutation blocked: no valid approval artifact for session "${sessionId}", canary "${canaryId}"`,
      {
        category: 'approval',
        code: 'APPROVAL_REQUIRED',
        context: { session_id: sessionId, canary_id: canaryId },
      },
    );
    this.name = 'ApprovalRequiredError';
  }
}

export class ApprovalVerificationError extends ModelForgeError {
  constructor(reason: string) {
    super(
      `Approval verification failed: ${reason}`,
      {
        category: 'approval',
        code: 'APPROVAL_VERIFICATION_FAILED',
        context: { reason },
      },
    );
    this.name = 'ApprovalVerificationError';
  }
}

// ─── Recovery Errors ─────────────────────────────────────────────────────────

export class RecoveryError extends ModelForgeError {
  constructor(sessionId: string, reason: string) {
    super(
      `Recovery failed for session "${sessionId}": ${reason}`,
      {
        category: 'recovery',
        code: 'RECOVERY_FAILED',
        context: { session_id: sessionId, reason },
      },
    );
    this.name = 'RecoveryError';
  }
}

export class RemediationExhaustedError extends ModelForgeError {
  constructor(sessionId: string, rounds: number, maxRounds: number) {
    super(
      `Maximum remediation rounds exhausted (${rounds}/${maxRounds}) for session "${sessionId}"`,
      {
        category: 'recovery',
        code: 'REMEDIATION_EXHAUSTED',
        context: { session_id: sessionId, rounds, max_rounds: maxRounds },
      },
    );
    this.name = 'RemediationExhaustedError';
  }
}
