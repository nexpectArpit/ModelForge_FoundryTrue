/**
 * MCP Boundary Contracts
 *
 * Architectural Principle #15: Contract-first MCP boundaries
 * Architectural Principle #16: TrueForge/ModelForge anti-corruption boundary
 * Architectural Principle #20: No hidden procedural orchestration
 *
 * Every MCP tool call is validated at the boundary with Zod schemas
 * before entering the domain. The domain never receives raw `args`.
 *
 * The anti-corruption layer translates between:
 *   - MCP protocol (JSON tool arguments) → typed domain commands
 *   - Domain results → MCP protocol responses
 */

import { z } from 'zod';
import { MCPBoundaryError } from './errors.js';

// ─── Validated MCP Input Schemas ─────────────────────────────────────────────

export const RepoInspectInput = z.object({
  repo_path: z.string().min(1, 'repo_path is required'),
  session_id: z.string().optional(),
});

export const GeneratePlanInput = z.object({
  source_model: z.string().min(1, 'source_model is required'),
  target_model: z.string().min(1, 'target_model is required'),
  use_diagnosis: z.boolean().optional().default(false),
  session_id: z.string().optional(),
});

export const StageCodeInput = z.object({
  repo_path: z.string().min(1, 'repo_path is required'),
  active_model: z.string().min(1, 'active_model is required'),
  routing_mode: z.enum(['direct', 'hybrid']).optional().default('direct'),
  session_id: z.string().optional(),
});

export const SandboxRunInput = z.object({
  port: z.number().int().positive().optional().default(8955),
  session_id: z.string().optional(),
});

export const RunBenchmarkInput = z.object({
  endpoint_url: z.string().url('endpoint_url must be a valid URL'),
  candidate_id: z.string().min(1, 'candidate_id is required'),
  session_id: z.string().optional(),
});

export const DiagnoseInput = z.object({
  session_id: z.string().optional(),
});

export const GetSessionStateInput = z.object({
  session_id: z.string().optional(),
});

// ─── Typed Domain Commands ───────────────────────────────────────────────────

export type RepoInspectCommand = z.infer<typeof RepoInspectInput>;
export type GeneratePlanCommand = z.infer<typeof GeneratePlanInput>;
export type StageCodeCommand = z.infer<typeof StageCodeInput>;
export type SandboxRunCommand = z.infer<typeof SandboxRunInput>;
export type RunBenchmarkCommand = z.infer<typeof RunBenchmarkInput>;
export type DiagnoseCommand = z.infer<typeof DiagnoseInput>;
export type GetSessionStateCommand = z.infer<typeof GetSessionStateInput>;

// ─── Input Schemas Registry (Principle #13: Open/closed extensibility) ───────

export const MCP_INPUT_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  repo_inspect_ai_usage: RepoInspectInput,
  generate_migration_plan: GeneratePlanInput,
  stage_code_migration: StageCodeInput,
  sandbox_run_app: SandboxRunInput,
  run_deterministic_benchmark: RunBenchmarkInput,
  diagnose_failures: DiagnoseInput,
  get_session_state: GetSessionStateInput,
};

// ─── Boundary Validation Gate ────────────────────────────────────────────────

/**
 * Validate MCP tool input at the anti-corruption boundary.
 * Fail-closed: if validation fails, no domain operation is attempted.
 *
 * @returns Validated and typed command object
 * @throws MCPBoundaryError on invalid input
 */
export function validateMCPInput<T extends z.ZodType>(
  toolName: string,
  schema: T,
  rawArgs: unknown,
): z.infer<T> {
  const result = schema.safeParse(rawArgs);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new MCPBoundaryError(toolName, errors);
  }
  return result.data;
}

// ─── Command Dispatch Registry (Principle #20) ──────────────────────────────

/**
 * Type-safe command handler signature.
 * Each MCP tool maps to exactly one handler function.
 */
export type CommandHandler<TInput, TOutput> = (input: TInput) => Promise<TOutput>;

/**
 * Command dispatch table entry.
 */
export interface CommandRegistration {
  schema: z.ZodType;
  handler: CommandHandler<unknown, unknown>;
}

/**
 * Command dispatcher — eliminates the procedural if/else chain.
 * Each tool name maps to its schema + handler.
 */
export class CommandDispatcher {
  private commands = new Map<string, CommandRegistration>();

  register<T>(toolName: string, schema: z.ZodType<T>, handler: CommandHandler<T, unknown>): void {
    this.commands.set(toolName, {
      schema,
      handler: handler as CommandHandler<unknown, unknown>,
    });
  }

  async dispatch(toolName: string, rawArgs: unknown): Promise<unknown> {
    const registration = this.commands.get(toolName);
    if (!registration) {
      throw new MCPBoundaryError(toolName, [`Unknown tool: "${toolName}"`]);
    }

    const validated = validateMCPInput(toolName, registration.schema, rawArgs);
    return registration.handler(validated);
  }

  getRegisteredTools(): string[] {
    return [...this.commands.keys()];
  }
}
