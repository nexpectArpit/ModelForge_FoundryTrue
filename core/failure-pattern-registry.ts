/**
 * Failure Pattern Registry
 *
 * Architectural Principle #12: Strategy + adapter patterns
 * Architectural Principle #13: Open/closed extensibility
 *
 * The failure diagnostician no longer holds a hardcoded array of patterns.
 * Patterns are registered at system initialization and can be extended
 * without modifying the diagnostician core.
 *
 * Each pattern is a strategy implementing the FailurePatternStrategy interface.
 */

import type {
  EvaluationReport,
  FailureCategory,
  RemediationStrategy,
} from './types.js';

// ─── Strategy Interface ──────────────────────────────────────────────────────

export interface DiagnosisContext {
  sourceModel: string;
  targetModel: string;
}

export interface FailurePatternStrategy {
  /** Unique identifier for this pattern */
  readonly patternId: string;
  /** Which failure category this pattern diagnoses */
  readonly category: FailureCategory;
  /** Priority for ordering (lower = checked first) */
  readonly priority: number;

  /** Test if this pattern matches the given regression data */
  matches(
    regressions: EvaluationReport['regressions'],
    report: EvaluationReport,
  ): boolean;

  /** Generate root cause analysis text */
  analyzeRootCause(
    regressions: EvaluationReport['regressions'],
    report: EvaluationReport,
    context: DiagnosisContext,
  ): string;

  /** Recommend a remediation strategy */
  recommendStrategy(
    regressions: EvaluationReport['regressions'],
    report: EvaluationReport,
  ): RemediationStrategy;

  /** Build strategy details for the diagnosis report */
  buildStrategyDetails(
    regressions: EvaluationReport['regressions'],
    report: EvaluationReport,
    context: DiagnosisContext,
  ): Record<string, unknown>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Open/closed registry for failure patterns.
 * New patterns can be added without modifying existing code.
 */
export class FailurePatternRegistry {
  private patterns: FailurePatternStrategy[] = [];

  /** Register a new failure pattern strategy */
  register(pattern: FailurePatternStrategy): void {
    this.patterns.push(pattern);
    // Maintain priority ordering
    this.patterns.sort((a, b) => a.priority - b.priority);
  }

  /** Register multiple patterns at once */
  registerAll(patterns: FailurePatternStrategy[]): void {
    for (const p of patterns) {
      this.register(p);
    }
  }

  /** Get all registered patterns in priority order */
  getPatterns(): readonly FailurePatternStrategy[] {
    return this.patterns;
  }

  /** Find the first matching pattern for given regressions */
  findMatch(
    regressions: EvaluationReport['regressions'],
    report: EvaluationReport,
  ): FailurePatternStrategy | null {
    for (const pattern of this.patterns) {
      if (pattern.matches(regressions, report)) {
        return pattern;
      }
    }
    return null;
  }

  /** Get registered pattern count */
  get size(): number {
    return this.patterns.length;
  }
}

// ─── Built-in Patterns ───────────────────────────────────────────────────────

export const toolCallingPattern: FailurePatternStrategy = {
  patternId: 'tool-calling',
  category: 'tool_calling',
  priority: 10,

  matches(regressions) {
    return regressions.some(r =>
      r.category === 'tool' && (
        r.error.includes('schema validation') ||
        r.error.includes('failed to emit tool call') ||
        r.error.includes('Expected tool') ||
        r.error.includes('argument value mismatch') ||
        r.error.includes('argument')
      ),
    );
  },

  analyzeRootCause(regressions, report, context) {
    const toolRegressions = regressions.filter(r => r.category === 'tool');
    const schemaFailures = toolRegressions.filter(r => r.error.includes('schema validation'));
    const argMismatches = toolRegressions.filter(r => r.error.includes('argument'));
    const missingCalls = toolRegressions.filter(r => r.error.includes('failed to emit'));

    const parts: string[] = [];
    if (schemaFailures.length > 0) {
      parts.push(
        `${schemaFailures.length} tool call(s) produced invalid parameter schemas. ` +
        `Common issues: string values where integers expected, invalid enum values. ` +
        `This indicates the candidate model has weaker function-calling adherence.`,
      );
    }
    if (argMismatches.length > 0 && schemaFailures.length === 0) {
      parts.push(
        `${argMismatches.length} tool call(s) produced incorrect argument values. ` +
        `The candidate model generates semantically different parameter values ` +
        `(e.g., string identifiers instead of numeric IDs).`,
      );
    }
    if (missingCalls.length > 0) {
      parts.push(`${missingCalls.length} prompt(s) failed to trigger tool invocation entirely.`);
    }

    const nonToolResults = report.case_results?.filter(r => r.category !== 'tool') ?? [];
    const nonToolPassed = nonToolResults.filter(r => r.passed).length;
    if (nonToolResults.length > 0 && nonToolPassed === nonToolResults.length) {
      parts.push(
        `Non-tool categories (QA, Summarize, Extract) show 100% pass rate — ` +
        `the candidate model's text generation capabilities are intact.`,
      );
    }

    return parts.join(' ');
  },

  recommendStrategy(_regressions, report) {
    const nonToolResults = report.case_results?.filter(r => r.category !== 'tool') ?? [];
    const nonToolPassed = nonToolResults.filter(r => r.passed).length;
    if (nonToolResults.length > 0 && nonToolPassed === nonToolResults.length) {
      return 'hybrid_routing';
    }
    return 'abort_migration';
  },

  buildStrategyDetails(_regressions, _report, context) {
    return {
      routing_mode: 'hybrid',
      target_for_tools: context.sourceModel,
      target_for_bulk: context.targetModel,
      rationale:
        `Route tool-calling tasks to the reliable baseline model ("${context.sourceModel}"), ` +
        `route high-volume QA/summarization/extraction to the cost-efficient candidate ("${context.targetModel}").`,
    };
  },
};

export const structuredExtractionPattern: FailurePatternStrategy = {
  patternId: 'structured-extraction',
  category: 'structured_extraction',
  priority: 20,

  matches(regressions) {
    return regressions.some(r =>
      r.category === 'extract' && r.error.includes('Extraction mismatch'),
    );
  },

  analyzeRootCause(regressions) {
    const extractFailures = regressions.filter(r => r.category === 'extract');
    return (
      `${extractFailures.length} structured extraction(s) returned incorrect field values. ` +
      `The candidate model is not reliably producing the expected JSON structure.`
    );
  },

  recommendStrategy() {
    return 'prompt_adaptation';
  },

  buildStrategyDetails() {
    return {
      approach: 'Add explicit JSON schema instructions to the system prompt',
      add_few_shot_examples: true,
    };
  },
};

export const promptDriftPattern: FailurePatternStrategy = {
  patternId: 'prompt-drift',
  category: 'prompt_drift',
  priority: 30,

  matches(regressions) {
    return regressions.some(r =>
      (r.category === 'qa' || r.category === 'summarize') &&
      (r.error.includes('did not contain') || r.error.includes('missing mandatory')),
    );
  },

  analyzeRootCause(regressions) {
    const driftFailures = regressions.filter(r =>
      r.category === 'qa' || r.category === 'summarize',
    );
    return (
      `${driftFailures.length} text-generation responses deviated from expected content patterns. ` +
      `The candidate model interprets prompts differently, producing outputs that miss required keywords or entities.`
    );
  },

  recommendStrategy() {
    return 'prompt_adaptation';
  },

  buildStrategyDetails() {
    return {
      approach: 'Modify system prompts to be more explicit for the candidate model',
      add_output_constraints: true,
    };
  },
};

export const latencyRegressionPattern: FailurePatternStrategy = {
  patternId: 'latency-regression',
  category: 'latency_regression',
  priority: 40,

  matches(_regressions, report) {
    return !report.latency.passed;
  },

  analyzeRootCause(_regressions, report, context) {
    return (
      `Latency p95 is ${report.latency.p95_ms}ms, exceeding the threshold of ` +
      `${report.latency.threshold_p95_ms}ms. The candidate model "${context.targetModel}" or its provider ` +
      `is significantly slower than the baseline "${context.sourceModel}".`
    );
  },

  recommendStrategy() {
    return 'abort_migration';
  },

  buildStrategyDetails(_regressions, report) {
    return {
      reason: 'Latency regression cannot be remediated at the application level',
      observed_p95_ms: report.latency.p95_ms,
      threshold_p95_ms: report.latency.threshold_p95_ms,
    };
  },
};

export const refusalPattern: FailurePatternStrategy = {
  patternId: 'refusal',
  category: 'refusal',
  priority: 50,

  matches(regressions) {
    return regressions.some(r =>
      r.error.toLowerCase().includes('refuse') ||
      r.error.toLowerCase().includes('cannot') ||
      r.error.toLowerCase().includes('i\'m sorry') ||
      r.error.toLowerCase().includes('unable to'),
    );
  },

  analyzeRootCause(regressions, _report, context) {
    const refusals = regressions.filter(r =>
      r.error.toLowerCase().includes('refuse') ||
      r.error.toLowerCase().includes('cannot') ||
      r.error.toLowerCase().includes('i\'m sorry') ||
      r.error.toLowerCase().includes('unable to'),
    );
    return (
      `${refusals.length} request(s) were refused by the candidate model "${context.targetModel}". ` +
      `The model's safety filters or content policy may be more restrictive than "${context.sourceModel}".`
    );
  },

  recommendStrategy() {
    return 'prompt_adaptation';
  },

  buildStrategyDetails() {
    return {
      approach: 'Modify system prompts to avoid triggering safety filters',
      adjust_content_framing: true,
    };
  },
};

export const formatViolationPattern: FailurePatternStrategy = {
  patternId: 'format-violation',
  category: 'format_violation',
  priority: 60,

  matches(regressions) {
    return regressions.some(r =>
      r.error.toLowerCase().includes('format') ||
      r.error.toLowerCase().includes('json') ||
      r.error.toLowerCase().includes('parse') ||
      r.error.toLowerCase().includes('syntax'),
    );
  },

  analyzeRootCause(regressions, _report, context) {
    const formatFailures = regressions.filter(r =>
      r.error.toLowerCase().includes('format') ||
      r.error.toLowerCase().includes('json') ||
      r.error.toLowerCase().includes('parse'),
    );
    return (
      `${formatFailures.length} response(s) from "${context.targetModel}" violated the expected output format. ` +
      `The model may not support the required structured output mode.`
    );
  },

  recommendStrategy() {
    return 'prompt_adaptation';
  },

  buildStrategyDetails() {
    return {
      approach: 'Add explicit format instructions and few-shot examples to prompts',
      enforce_json_mode: true,
    };
  },
};

// ─── Default Registry ────────────────────────────────────────────────────────

/**
 * Create a registry pre-populated with all built-in failure patterns.
 */
export function createDefaultFailurePatternRegistry(): FailurePatternRegistry {
  const registry = new FailurePatternRegistry();
  registry.registerAll([
    toolCallingPattern,
    structuredExtractionPattern,
    promptDriftPattern,
    latencyRegressionPattern,
    refusalPattern,
    formatViolationPattern,
  ]);
  return registry;
}
