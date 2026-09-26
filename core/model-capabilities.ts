/**
 * Model Capability Registry
 *
 * A typed, extensible registry of provider and model capabilities.
 * This drives all data-driven decisions in the migration pipeline:
 *
 *   - The planner uses it to detect incompatibilities before staging code
 *   - The diagnostician uses it to classify failure root causes
 *   - The evaluator uses it to set appropriate thresholds
 *
 * Design decisions:
 *   - Capabilities are declared per-model, not per-provider, because
 *     different model tiers within the same provider have different features
 *   - Unknown models get a conservative "baseline" capability set
 *   - The registry is append-only; downstream code never mutates it
 */

// ─── Capability Types ────────────────────────────────────────────────────────

/** Granular feature support levels */
export type SupportLevel = 'full' | 'partial' | 'none';

/** Structured output modes a model can produce */
export type StructuredOutputMode = 'json_mode' | 'json_schema' | 'none';

/** Tool/function calling capability descriptor */
export interface ToolCallingCapability {
  /** Whether the model supports tool/function calling at all */
  supported: boolean;
  /** Whether the model can call multiple tools in a single turn */
  parallel_tool_calls: boolean;
  /** Maximum number of tool definitions the model can accept (0 = unlimited) */
  max_tools: number;
  /** Whether the model reliably follows strict JSON Schema for tool args */
  strict_schema_adherence: SupportLevel;
}

/** Structured output capability descriptor */
export interface StructuredOutputCapability {
  /** Which structured output modes are supported */
  modes: StructuredOutputMode[];
  /** Whether the model can reliably produce valid JSON matching a schema */
  schema_adherence: SupportLevel;
}

/** Cost descriptor (per 1M tokens) */
export interface CostProfile {
  /** Cost per 1M input tokens in USD */
  input_per_1m_tokens: number;
  /** Cost per 1M output tokens in USD */
  output_per_1m_tokens: number;
}

/** Complete capability profile for a single model */
export interface ModelCapabilityProfile {
  /** Canonical model identifier (e.g., 'gpt-4o', 'claude-3.5-sonnet') */
  model_id: string;
  /** Provider identifier (e.g., 'openai', 'anthropic', 'google') */
  provider: string;
  /** Human-readable display name */
  display_name: string;
  /** Maximum context window in tokens */
  context_window: number;
  /** Maximum output tokens per completion */
  max_output_tokens: number;
  /** Tool/function calling capabilities */
  tool_calling: ToolCallingCapability;
  /** Structured output capabilities */
  structured_output: StructuredOutputCapability;
  /** Streaming support */
  streaming: boolean;
  /** Vision/image input support */
  vision: boolean;
  /** Cost profile */
  cost: CostProfile;
  /** Typical P95 latency in ms for a ~500 token completion */
  typical_p95_latency_ms: number;
  /** Model knowledge cutoff date (ISO 8601) */
  knowledge_cutoff: string;
  /** Additional provider-specific metadata */
  metadata: Record<string, unknown>;
}

// ─── Incompatibility Detection ───────────────────────────────────────────────

/** A specific incompatibility between source and target models */
export interface ModelIncompatibility {
  /** Which capability dimension is incompatible */
  dimension: 'tool_calling' | 'structured_output' | 'context_window' | 'vision' | 'streaming' | 'parallel_tools' | 'cost';
  /** Severity of the incompatibility */
  severity: 'blocking' | 'degraded' | 'informational';
  /** Human-readable description */
  description: string;
  /** Suggested mitigation strategy */
  mitigation: string | null;
}

/**
 * Compare two model profiles and return all detected incompatibilities.
 * This is the core analysis function the migration planner uses.
 */
export function detectIncompatibilities(
  source: ModelCapabilityProfile,
  target: ModelCapabilityProfile,
): ModelIncompatibility[] {
  const issues: ModelIncompatibility[] = [];

  // ── Tool Calling ──
  if (source.tool_calling.supported && !target.tool_calling.supported) {
    issues.push({
      dimension: 'tool_calling',
      severity: 'blocking',
      description: `Source model "${source.model_id}" supports tool calling, but target "${target.model_id}" does not.`,
      mitigation: 'Use hybrid routing: route tool-calling tasks to the source model.',
    });
  } else if (source.tool_calling.supported && target.tool_calling.supported) {
    // Check strict schema adherence degradation
    if (
      source.tool_calling.strict_schema_adherence === 'full' &&
      target.tool_calling.strict_schema_adherence !== 'full'
    ) {
      issues.push({
        dimension: 'tool_calling',
        severity: 'degraded',
        description:
          `Target model "${target.model_id}" has ${target.tool_calling.strict_schema_adherence} ` +
          `schema adherence (source has full). Tool argument validation failures are likely.`,
        mitigation: 'Simplify tool schemas or use hybrid routing for tool-calling tasks.',
      });
    }

    // Check parallel tool calls
    if (source.tool_calling.parallel_tool_calls && !target.tool_calling.parallel_tool_calls) {
      issues.push({
        dimension: 'parallel_tools',
        severity: 'degraded',
        description:
          `Source model supports parallel tool calls, but target "${target.model_id}" does not. ` +
          `Multi-tool workflows may require sequential invocations.`,
        mitigation: 'Ensure application handles single-tool-per-turn responses.',
      });
    }

    // Check max tools limit
    if (
      target.tool_calling.max_tools > 0 &&
      source.tool_calling.max_tools !== target.tool_calling.max_tools
    ) {
      if (source.tool_calling.max_tools === 0 || source.tool_calling.max_tools > target.tool_calling.max_tools) {
        issues.push({
          dimension: 'tool_calling',
          severity: 'informational',
          description:
            `Target model "${target.model_id}" supports max ${target.tool_calling.max_tools} tools ` +
            `(source: ${source.tool_calling.max_tools === 0 ? 'unlimited' : source.tool_calling.max_tools}).`,
          mitigation: 'Verify the application defines fewer tools than the target limit.',
        });
      }
    }
  }

  // ── Structured Output ──
  if (source.structured_output.modes.length > 0) {
    const sourceModes = new Set(source.structured_output.modes);
    const targetModes = new Set(target.structured_output.modes);
    const missingModes = [...sourceModes].filter(m => m !== 'none' && !targetModes.has(m));

    if (missingModes.length > 0) {
      issues.push({
        dimension: 'structured_output',
        severity: 'degraded',
        description:
          `Target model "${target.model_id}" does not support structured output modes: ` +
          `${missingModes.join(', ')} (used by source).`,
        mitigation: 'Use prompt adaptation to enforce JSON output format.',
      });
    }

    if (
      source.structured_output.schema_adherence === 'full' &&
      target.structured_output.schema_adherence !== 'full'
    ) {
      issues.push({
        dimension: 'structured_output',
        severity: 'degraded',
        description:
          `Target model has ${target.structured_output.schema_adherence} schema adherence ` +
          `for structured output (source has full).`,
        mitigation: 'Add explicit JSON schema instructions to prompts.',
      });
    }
  }

  // ── Context Window ──
  if (target.context_window < source.context_window) {
    const ratio = target.context_window / source.context_window;
    issues.push({
      dimension: 'context_window',
      severity: ratio < 0.5 ? 'blocking' : 'informational',
      description:
        `Target model context window (${target.context_window} tokens) is ` +
        `${((1 - ratio) * 100).toFixed(0)}% smaller than source (${source.context_window} tokens).`,
      mitigation: ratio < 0.5
        ? 'Application may need chunking or context management changes.'
        : null,
    });
  }

  // ── Vision ──
  if (source.vision && !target.vision) {
    issues.push({
      dimension: 'vision',
      severity: 'blocking',
      description: `Source model supports vision input, but target "${target.model_id}" does not.`,
      mitigation: null,
    });
  }

  // ── Streaming ──
  if (source.streaming && !target.streaming) {
    issues.push({
      dimension: 'streaming',
      severity: 'degraded',
      description: `Target model "${target.model_id}" does not support streaming responses.`,
      mitigation: 'Application must handle non-streaming responses gracefully.',
    });
  }

  // ── Cost ──
  const sourceCost = source.cost.input_per_1m_tokens + source.cost.output_per_1m_tokens;
  const targetCost = target.cost.input_per_1m_tokens + target.cost.output_per_1m_tokens;
  if (targetCost > sourceCost * 1.5) {
    issues.push({
      dimension: 'cost',
      severity: 'informational',
      description:
        `Target model is ${((targetCost / sourceCost - 1) * 100).toFixed(0)}% more expensive ` +
        `than source per combined token cost.`,
      mitigation: 'Consider cost implications at scale.',
    });
  }

  return issues;
}

// ─── Built-in Model Registry ─────────────────────────────────────────────────

/**
 * Built-in registry of well-known models.
 *
 * This is intentionally a flat map keyed by model ID, not a database.
 * It's designed to be consulted at planning time, not at runtime.
 */
const REGISTRY = new Map<string, ModelCapabilityProfile>();

function register(profile: ModelCapabilityProfile): void {
  REGISTRY.set(profile.model_id, profile);
}

// ── OpenAI Models ──

register({
  model_id: 'gpt-4o',
  provider: 'openai',
  display_name: 'GPT-4o',
  context_window: 128_000,
  max_output_tokens: 16_384,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0, // unlimited
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode', 'json_schema'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 2.50, output_per_1m_tokens: 10.00 },
  typical_p95_latency_ms: 400,
  knowledge_cutoff: '2024-10-01',
  metadata: {},
});

register({
  model_id: 'gpt-4o-mini',
  provider: 'openai',
  display_name: 'GPT-4o Mini',
  context_window: 128_000,
  max_output_tokens: 16_384,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0,
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode', 'json_schema'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 0.15, output_per_1m_tokens: 0.60 },
  typical_p95_latency_ms: 250,
  knowledge_cutoff: '2024-10-01',
  metadata: {},
});

register({
  model_id: 'gpt-3.5-turbo',
  provider: 'openai',
  display_name: 'GPT-3.5 Turbo',
  context_window: 16_385,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0,
    strict_schema_adherence: 'partial',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'partial',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 0.50, output_per_1m_tokens: 1.50 },
  typical_p95_latency_ms: 300,
  knowledge_cutoff: '2021-09-01',
  metadata: {},
});

// ── Anthropic Models ──

register({
  model_id: 'claude-3.5-sonnet',
  provider: 'anthropic',
  display_name: 'Claude 3.5 Sonnet',
  context_window: 200_000,
  max_output_tokens: 8_192,
  tool_calling: {
    supported: true,
    parallel_tool_calls: false,
    max_tools: 0,
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 3.00, output_per_1m_tokens: 15.00 },
  typical_p95_latency_ms: 500,
  knowledge_cutoff: '2025-04-01',
  metadata: {},
});

register({
  model_id: 'claude-3-haiku',
  provider: 'anthropic',
  display_name: 'Claude 3 Haiku',
  context_window: 200_000,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: false,
    max_tools: 0,
    strict_schema_adherence: 'partial',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'partial',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 0.25, output_per_1m_tokens: 1.25 },
  typical_p95_latency_ms: 250,
  knowledge_cutoff: '2024-08-01',
  metadata: {},
});

// ── Google Models ──

register({
  model_id: 'gemini-1.5-pro',
  provider: 'google',
  display_name: 'Gemini 1.5 Pro',
  context_window: 2_000_000,
  max_output_tokens: 8_192,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0,
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode', 'json_schema'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 1.25, output_per_1m_tokens: 5.00 },
  typical_p95_latency_ms: 600,
  knowledge_cutoff: '2024-11-01',
  metadata: {},
});

register({
  model_id: 'gemini-1.5-flash',
  provider: 'google',
  display_name: 'Gemini 1.5 Flash',
  context_window: 1_000_000,
  max_output_tokens: 8_192,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0,
    strict_schema_adherence: 'partial',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'partial',
  },
  streaming: true,
  vision: true,
  cost: { input_per_1m_tokens: 0.075, output_per_1m_tokens: 0.30 },
  typical_p95_latency_ms: 200,
  knowledge_cutoff: '2024-11-01',
  metadata: {},
});

// ── Meta / Groq Models ──

register({
  model_id: 'llama-3.1-70b',
  provider: 'meta',
  display_name: 'Llama 3.1 70B',
  context_window: 128_000,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: false,
    max_tools: 8,
    strict_schema_adherence: 'partial',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'partial',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 0.59, output_per_1m_tokens: 0.79 },
  typical_p95_latency_ms: 350,
  knowledge_cutoff: '2024-12-01',
  metadata: { hosted_on: ['groq', 'together', 'fireworks'] },
});

register({
  model_id: 'llama-3.1-8b',
  provider: 'meta',
  display_name: 'Llama 3.1 8B',
  context_window: 128_000,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: false,
    max_tools: 4,
    strict_schema_adherence: 'none',
  },
  structured_output: {
    modes: [],
    schema_adherence: 'none',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 0.05, output_per_1m_tokens: 0.08 },
  typical_p95_latency_ms: 150,
  knowledge_cutoff: '2024-12-01',
  metadata: { hosted_on: ['groq', 'together', 'fireworks'] },
});

register({
  model_id: 'mistral-large',
  provider: 'mistral',
  display_name: 'Mistral Large',
  context_window: 128_000,
  max_output_tokens: 8_192,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 0,
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 2.00, output_per_1m_tokens: 6.00 },
  typical_p95_latency_ms: 400,
  knowledge_cutoff: '2024-11-01',
  metadata: {},
});

// ── ModelForge Demo Models ──

register({
  model_id: 'model-a',
  provider: 'incumbent',
  display_name: 'Model A (Baseline Frontier)',
  context_window: 128_000,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: true,
    max_tools: 16,
    strict_schema_adherence: 'full',
  },
  structured_output: {
    modes: ['json_mode', 'json_schema'],
    schema_adherence: 'full',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 3.00, output_per_1m_tokens: 15.00 },
  typical_p95_latency_ms: 780,
  knowledge_cutoff: '2024-10-01',
  metadata: { tier: 'frontier' },
});

register({
  model_id: 'model-b',
  provider: 'candidate',
  display_name: 'Model B (Cost-Efficient Candidate)',
  context_window: 128_000,
  max_output_tokens: 4_096,
  tool_calling: {
    supported: true,
    parallel_tool_calls: false,
    max_tools: 8,
    strict_schema_adherence: 'partial',
  },
  structured_output: {
    modes: ['json_mode'],
    schema_adherence: 'partial',
  },
  streaming: true,
  vision: false,
  cost: { input_per_1m_tokens: 0.15, output_per_1m_tokens: 0.60 },
  typical_p95_latency_ms: 290,
  knowledge_cutoff: '2024-10-01',
  metadata: { tier: 'lightweight' },
});

// ─── Registry API ────────────────────────────────────────────────────────────

/**
 * Look up a model's capability profile by model ID.
 * Returns null if the model is not in the registry.
 */
export function getModelProfile(modelId: string): ModelCapabilityProfile | null {
  // Exact match first
  if (REGISTRY.has(modelId)) {
    return REGISTRY.get(modelId)!;
  }

  // Fuzzy match: strip version suffixes (e.g. 'gpt-4o-2024-08-06' → 'gpt-4o')
  for (const [key, profile] of REGISTRY) {
    if (modelId.startsWith(key)) {
      return profile;
    }
  }

  return null;
}

/**
 * Get all registered models for a specific provider.
 */
export function getModelsByProvider(provider: string): ModelCapabilityProfile[] {
  return [...REGISTRY.values()].filter(p => p.provider === provider);
}

/**
 * Get all registered model IDs.
 */
export function getAllModelIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Register a custom model profile (for user-defined or private models).
 */
export function registerModel(profile: ModelCapabilityProfile): void {
  register(profile);
}

/**
 * Create a conservative baseline profile for unknown models.
 * Used when the model is not in the registry — assumes limited capabilities
 * to avoid false-positive "compatible" results.
 */
export function createUnknownModelProfile(modelId: string, provider: string = 'unknown'): ModelCapabilityProfile {
  return {
    model_id: modelId,
    provider,
    display_name: `Unknown (${modelId})`,
    context_window: 8_192,
    max_output_tokens: 2_048,
    tool_calling: {
      supported: false,
      parallel_tool_calls: false,
      max_tools: 0,
      strict_schema_adherence: 'none',
    },
    structured_output: {
      modes: [],
      schema_adherence: 'none',
    },
    streaming: true,
    vision: false,
    cost: { input_per_1m_tokens: 1.00, output_per_1m_tokens: 3.00 },
    typical_p95_latency_ms: 500,
    knowledge_cutoff: '2024-01-01',
    metadata: { is_assumed_profile: true },
  };
}

/**
 * Resolve a model profile — returns the registered profile if known,
 * or a conservative unknown profile if not.
 */
export function resolveModelProfile(modelId: string): ModelCapabilityProfile {
  return getModelProfile(modelId) ?? createUnknownModelProfile(modelId);
}
