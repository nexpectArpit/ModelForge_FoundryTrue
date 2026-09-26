/**
 * Failure Diagnostician
 *
 * Analyzes evaluation failures to determine root cause and recommend
 * remediation strategies. Unlike the current hardcoded diagnosis in
 * run-full-demo.mjs (which always outputs the same text), this module:
 *
 *   1. Inspects actual evaluation results to classify failure patterns
 *   2. Uses a taxonomy of known failure modes (tool calling, extraction, etc.)
 *   3. Computes confidence scores based on evidence strength
 *   4. Recommends concrete remediation strategies
 */

import type {
  EvaluationReport,
  FailureDiagnosis,
  FailureCategory,
  RemediationStrategy,
  SessionId,
  EvalRunId,
  MigrationSession,
} from './types.js';

import {
  createDefaultFailurePatternRegistry,
  type FailurePatternRegistry,
  type DiagnosisContext,
} from './failure-pattern-registry.js';

// ─── Failure Pattern Recognizers ─────────────────────────────────────────────

interface FailurePattern {
  category: FailureCategory;
  /** Test to check if this pattern matches the regressions */
  matches(regressions: EvaluationReport['regressions'], report: EvaluationReport): boolean;
  /** Generate root cause analysis text */
  analyzeRootCause(regressions: EvaluationReport['regressions'], report: EvaluationReport, context: DiagnosisContext): string;
  /** Which remediation strategy to recommend */
  recommendStrategy(regressions: EvaluationReport['regressions'], report: EvaluationReport): RemediationStrategy;
  /** Build strategy detail object */
  buildStrategyDetails(regressions: EvaluationReport['regressions'], report: EvaluationReport, context: DiagnosisContext): Record<string, unknown>;
}

/** Context passed to failure patterns for data-driven details */
interface DiagnosisContext {
  sourceModel: string;
  targetModel: string;
}

const FAILURE_PATTERNS: FailurePattern[] = [
  // ── Tool Calling Failures ──
  {
    category: 'tool_calling',
    matches(regressions) {
      return regressions.some(r =>
        r.category === 'tool' && (
          r.error.includes('schema validation') ||
          r.error.includes('failed to emit tool call') ||
          r.error.includes('Expected tool') ||
          r.error.includes('argument value mismatch') ||
          r.error.includes('argument')
        )
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
          `This indicates the candidate model has weaker function-calling adherence.`
        );
      }
      if (argMismatches.length > 0 && schemaFailures.length === 0) {
        parts.push(
          `${argMismatches.length} tool call(s) produced incorrect argument values. ` +
          `The candidate model generates semantically different parameter values ` +
          `(e.g., string identifiers instead of numeric IDs).`
        );
      }
      if (missingCalls.length > 0) {
        parts.push(
          `${missingCalls.length} prompt(s) failed to trigger tool invocation entirely.`
        );
      }

      // Check non-tool categories
      const nonToolResults = report.case_results?.filter(r => r.category !== 'tool') ?? [];
      const nonToolPassed = nonToolResults.filter(r => r.passed).length;
      if (nonToolResults.length > 0 && nonToolPassed === nonToolResults.length) {
        parts.push(
          `Non-tool categories (QA, Summarize, Extract) show 100% pass rate — ` +
          `the candidate model's text generation capabilities are intact.`
        );
      }

      return parts.join(' ');
    },
    recommendStrategy(_regressions, report) {
      // If non-tool tasks pass perfectly, hybrid routing is the optimal strategy
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
  },

  // ── Structured Extraction Failures ──
  {
    category: 'structured_extraction',
    matches(regressions) {
      return regressions.some(r =>
        r.category === 'extract' && r.error.includes('Extraction mismatch')
      );
    },
    analyzeRootCause(regressions, _report, _context) {
      const extractFailures = regressions.filter(r => r.category === 'extract');
      return (
        `${extractFailures.length} structured extraction(s) returned incorrect field values. ` +
        `The candidate model is not reliably producing the expected JSON structure.`
      );
    },
    recommendStrategy() {
      return 'prompt_adaptation';
    },
    buildStrategyDetails(_regressions: any, _report: any, _context: DiagnosisContext) {
      return {
        approach: 'Add explicit JSON schema instructions to the system prompt',
        add_few_shot_examples: true,
      };
    },
  },

  // ── Prompt Drift (QA/Summarization Failures) ──
  {
    category: 'prompt_drift',
    matches(regressions) {
      return regressions.some(r =>
        (r.category === 'qa' || r.category === 'summarize') &&
        (r.error.includes('did not contain') || r.error.includes('missing mandatory'))
      );
    },
    analyzeRootCause(regressions, _report, _context) {
      const driftFailures = regressions.filter(r =>
        r.category === 'qa' || r.category === 'summarize'
      );
      return (
        `${driftFailures.length} text-generation responses deviated from expected content patterns. ` +
        `The candidate model interprets prompts differently, producing outputs that miss required keywords or entities.`
      );
    },
    recommendStrategy() {
      return 'prompt_adaptation';
    },
    buildStrategyDetails(_regressions, _report, _context) {
      return {
        approach: 'Modify system prompts to be more explicit for the candidate model',
        add_output_constraints: true,
      };
    },
  },

  // ── Latency Regression ──
  {
    category: 'latency_regression',
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
    buildStrategyDetails(_regressions, report, _context) {
      return {
        reason: 'Latency regression cannot be remediated at the application level',
        observed_p95_ms: report.latency.p95_ms,
        threshold_p95_ms: report.latency.threshold_p95_ms,
      };
    },
  },

  // ── Refusal Pattern ──
  {
    category: 'refusal',
    matches(regressions) {
      return regressions.some(r =>
        r.error.toLowerCase().includes('refuse') ||
        r.error.toLowerCase().includes('cannot') ||
        r.error.toLowerCase().includes('i\'m sorry') ||
        r.error.toLowerCase().includes('unable to')
      );
    },
    analyzeRootCause(regressions, _report, context) {
      const refusals = regressions.filter(r =>
        r.error.toLowerCase().includes('refuse') ||
        r.error.toLowerCase().includes('cannot') ||
        r.error.toLowerCase().includes('i\'m sorry') ||
        r.error.toLowerCase().includes('unable to')
      );
      return (
        `${refusals.length} request(s) were refused by the candidate model "${context.targetModel}". ` +
        `The model's safety filters or content policy may be more restrictive than "${context.sourceModel}".`
      );
    },
    recommendStrategy() {
      return 'prompt_adaptation';
    },
    buildStrategyDetails(_regressions, _report, _context) {
      return {
        approach: 'Modify system prompts to avoid triggering safety filters',
        adjust_content_framing: true,
      };
    },
  },

  // ── Format Violation ──
  {
    category: 'format_violation',
    matches(regressions) {
      return regressions.some(r =>
        r.error.toLowerCase().includes('format') ||
        r.error.toLowerCase().includes('json') ||
        r.error.toLowerCase().includes('parse') ||
        r.error.toLowerCase().includes('syntax')
      );
    },
    analyzeRootCause(regressions, _report, context) {
      const formatFailures = regressions.filter(r =>
        r.error.toLowerCase().includes('format') ||
        r.error.toLowerCase().includes('json') ||
        r.error.toLowerCase().includes('parse')
      );
      return (
        `${formatFailures.length} response(s) from "${context.targetModel}" violated the expected output format. ` +
        `The model may not support the required structured output mode.`
      );
    },
    recommendStrategy() {
      return 'prompt_adaptation';
    },
    buildStrategyDetails(_regressions, _report, _context) {
      return {
        approach: 'Add explicit format instructions and few-shot examples to prompts',
        enforce_json_mode: true,
      };
    },
  },
];

// ─── Diagnostician ───────────────────────────────────────────────────────────

export interface DiagnosisInput {
  sessionId: SessionId;
  evaluationReport: EvaluationReport;
  /** Source model name for data-driven context (optional for backward compat) */
  sourceModel?: string;
  /** Target model name for data-driven context (optional for backward compat) */
  targetModel?: string;
  /** Optional custom failure pattern registry (Principle #12: Strategy pattern) */
  patternRegistry?: FailurePatternRegistry;
}

/**
 * Analyze an evaluation report and produce a diagnosis.
 *
 * The diagnostician tries each known failure pattern in order.
 * The first pattern that matches becomes the primary diagnosis.
 * If no pattern matches but the evaluation failed, a generic diagnosis is returned.
 */
export function diagnoseFailures(input: DiagnosisInput): FailureDiagnosis {
  const { sessionId, evaluationReport, sourceModel, targetModel, patternRegistry } = input;
  const regressions = evaluationReport.regressions;

  // Use injected registry or default (Principle #12: Strategy + adapter)
  const registry = patternRegistry ?? createDefaultFailurePatternRegistry();

  // Build context for data-driven strategy details
  const context: DiagnosisContext = {
    sourceModel: sourceModel ?? 'baseline',
    targetModel: targetModel ?? 'candidate',
  };

  // Try each failure pattern from registry (Principle #13: Open/closed)
  const matchedPattern = registry.findMatch(regressions, evaluationReport);
  if (matchedPattern) {
      const affectedCategories = [
        ...new Set(
          regressions
            .filter(r => {
              if (matchedPattern.category === 'tool_calling') return r.category === 'tool';
              if (matchedPattern.category === 'structured_extraction') return r.category === 'extract';
              if (matchedPattern.category === 'prompt_drift') return r.category === 'qa' || r.category === 'summarize';
              if (matchedPattern.category === 'latency_regression') return true;
              if (matchedPattern.category === 'refusal') return true;
              if (matchedPattern.category === 'format_violation') return true;
              return false;
            })
            .map(r => r.category)
        ),
      ];

      return {
        contract_version: '2.0',
        session_id: sessionId,
        eval_run_id: evaluationReport.eval_run_id,
        primary_failure_category: matchedPattern.category,
        affected_categories: affectedCategories,
        root_cause_analysis: matchedPattern.analyzeRootCause(regressions, evaluationReport, context),
        recommended_strategy: matchedPattern.recommendStrategy(regressions, evaluationReport),
        strategy_details: matchedPattern.buildStrategyDetails(regressions, evaluationReport, context),
        confidence: computeConfidence(regressions, evaluationReport, matchedPattern.category),
        diagnosed_at: new Date().toISOString(),
      };
    }

  // Generic fallback — evaluation failed but no recognized pattern
  return {
    contract_version: '2.0',
    session_id: sessionId,
    eval_run_id: evaluationReport.eval_run_id,
    primary_failure_category: 'hallucination',
    affected_categories: [...new Set(regressions.map(r => r.category))],
    root_cause_analysis:
      `${regressions.length} regression(s) detected across categories: ` +
      `${[...new Set(regressions.map(r => r.category))].join(', ')}. ` +
      `No specific failure pattern was identified.`,
    recommended_strategy: 'abort_migration',
    strategy_details: {
      reason: 'No recognized remediation pattern — manual investigation required',
      regression_count: regressions.length,
    },
    confidence: 0.3,
    diagnosed_at: new Date().toISOString(),
  };
}

// ─── Confidence Computation ──────────────────────────────────────────────────

function computeConfidence(
  regressions: EvaluationReport['regressions'],
  report: EvaluationReport,
  category: FailureCategory,
): number {
  // More regressions in the same category = higher confidence
  let relevantRegressions: number;
  let totalCasesInCategory: number;

  switch (category) {
    case 'tool_calling':
      relevantRegressions = regressions.filter(r => r.category === 'tool').length;
      totalCasesInCategory = report.case_results?.filter(r => r.category === 'tool').length ?? 0;
      break;
    case 'structured_extraction':
      relevantRegressions = regressions.filter(r => r.category === 'extract').length;
      totalCasesInCategory = report.case_results?.filter(r => r.category === 'extract').length ?? 0;
      break;
    case 'latency_regression':
      return report.latency.passed ? 0.3 : 0.95;
    default:
      relevantRegressions = regressions.length;
      totalCasesInCategory = report.total_cases;
  }

  if (totalCasesInCategory === 0) return 0.5;

  // If ALL cases in the category failed, very high confidence
  const failureRate = relevantRegressions / totalCasesInCategory;
  if (failureRate >= 1.0) return 0.98;
  if (failureRate >= 0.75) return 0.90;
  if (failureRate >= 0.5) return 0.75;
  return 0.60;
}
