import { describe, it, expect } from 'vitest';
import { compareRehearsalReports } from '../core/rehearsal/comparison.js';
import { type EvaluationReport, createEvalRunId, createSessionId } from '../core/types.js';

function createMockReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    contract_version: '2.0',
    eval_run_id: createEvalRunId(),
    session_id: createSessionId(),
    candidate_id: 'test-candidate',
    timestamp: new Date().toISOString(),
    test_suite_id: 'test-suite-v1',
    total_cases: 4,
    passed_cases: 4,
    case_results: [
      { case_id: 'case-qa-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
      { case_id: 'case-sum-1', category: 'summarize', passed: true, latency_ms: 120, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
      { case_id: 'case-ext-1', category: 'extract', passed: true, latency_ms: 90, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
      { case_id: 'case-tool-1', category: 'tool', passed: true, latency_ms: 150, estimated_cost: 0.002, failure_reason: null, raw_response_summary: 'ok' },
    ],
    quality: {
      score: 1.0,
      threshold: 0.9,
      passed: true,
      by_category: {
        qa: { passed: 1, total: 1, score: 1.0 },
        summarize: { passed: 1, total: 1, score: 1.0 },
        extract: { passed: 1, total: 1, score: 1.0 },
        tool: { passed: 1, total: 1, score: 1.0 },
      },
    },
    latency: { p50_ms: 105, p95_ms: 145, p99_ms: 150, threshold_p95_ms: 500, passed: true },
    cost: { estimated_cost_per_1k_req: 1.85, baseline_cost_per_1k_req: 1.85, savings_pct: 0, passed: true },
    regressions: [],
    overall: 'PASS',
    ...overrides,
  };
}

describe('Rehearsal Comparison Engine', () => {
  it('identifies parity with zero regressions as PASS and ready_for_approval', () => {
    const baseline = createMockReport({ candidate_id: 'baseline-model-a' });
    const candidate = createMockReport({
      candidate_id: 'candidate-model-b',
      latency: { p50_ms: 50, p95_ms: 70, p99_ms: 80, threshold_p95_ms: 500, passed: true },
      cost: { estimated_cost_per_1k_req: 0.15, baseline_cost_per_1k_req: 1.85, savings_pct: 92, passed: true },
    });

    const matrix = compareRehearsalReports({
      baselineReport: baseline,
      candidateReport: candidate,
      baselineModel: 'model-a',
      candidateModel: 'model-b',
    });

    expect(matrix.verdict).toBe('PASS');
    expect(matrix.recommendation).toBe('ready_for_approval');
    expect(matrix.regressions_count).toBe(0);
    expect(matrix.total_cases).toBe(4);
    expect(matrix.accuracy_delta).toBe(0);
    expect(matrix.latency_p95_shift_ms).toBe(-75);
    expect(matrix.cost_savings_pct).toBe(92);
    expect(matrix.case_comparisons.every(c => c.status === 'maintained_pass')).toBe(true);
    expect(matrix.summary).toContain('Ready for approval');
  });

  it('detects tool calling regression as FAIL and recommends needs_remediation', () => {
    const baseline = createMockReport({ candidate_id: 'model-a' });
    const candidate = createMockReport({
      candidate_id: 'model-b',
      passed_cases: 3,
      overall: 'FAIL',
      quality: {
        score: 0.75,
        threshold: 0.9,
        passed: false,
        by_category: {
          qa: { passed: 1, total: 1, score: 1.0 },
          summarize: { passed: 1, total: 1, score: 1.0 },
          extract: { passed: 1, total: 1, score: 1.0 },
          tool: { passed: 0, total: 1, score: 0.0 },
        },
      },
      case_results: [
        { case_id: 'case-qa-1', category: 'qa', passed: true, latency_ms: 40, estimated_cost: 0.0001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-sum-1', category: 'summarize', passed: true, latency_ms: 45, estimated_cost: 0.0001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-ext-1', category: 'extract', passed: true, latency_ms: 35, estimated_cost: 0.0001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-tool-1', category: 'tool', passed: false, latency_ms: 60, estimated_cost: 0.0002, failure_reason: 'Schema validation failed: order_id is string', raw_response_summary: 'err' },
      ],
      regressions: [{ case_id: 'case-tool-1', category: 'tool', error: 'Schema validation failed', severity: 'critical' }],
      cost: { estimated_cost_per_1k_req: 0.15, baseline_cost_per_1k_req: 1.85, savings_pct: 92, passed: true },
    });

    const matrix = compareRehearsalReports({
      baselineReport: baseline,
      candidateReport: candidate,
      baselineModel: 'model-a',
      candidateModel: 'model-b',
    });

    expect(matrix.verdict).toBe('FAIL');
    expect(matrix.recommendation).toBe('needs_remediation');
    expect(matrix.regressions_count).toBe(1);
    expect(matrix.accuracy_delta).toBe(-0.25);
    const toolCase = matrix.case_comparisons.find(c => c.case_id === 'case-tool-1');
    expect(toolCase?.status).toBe('regression');
    expect(toolCase?.failure_reason).toContain('order_id is string');
    expect(matrix.summary).toContain('1 regression(s) vs baseline');
    expect(matrix.summary).toContain('tool');
  });

  it('detects improvements when candidate passes a case failed by baseline', () => {
    const baseline = createMockReport({
      candidate_id: 'model-a',
      passed_cases: 3,
      case_results: [
        { case_id: 'case-qa-1', category: 'qa', passed: true, latency_ms: 100, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-sum-1', category: 'summarize', passed: false, latency_ms: 120, estimated_cost: 0.001, failure_reason: 'timeout', raw_response_summary: 'err' },
        { case_id: 'case-ext-1', category: 'extract', passed: true, latency_ms: 90, estimated_cost: 0.001, failure_reason: null, raw_response_summary: 'ok' },
        { case_id: 'case-tool-1', category: 'tool', passed: true, latency_ms: 150, estimated_cost: 0.002, failure_reason: null, raw_response_summary: 'ok' },
      ],
      quality: { score: 0.75, threshold: 0.9, passed: false, by_category: {} },
    });
    const candidate = createMockReport({ candidate_id: 'model-b', passed_cases: 4, overall: 'PASS' });

    const matrix = compareRehearsalReports({
      baselineReport: baseline,
      candidateReport: candidate,
      baselineModel: 'model-a',
      candidateModel: 'model-b',
    });

    expect(matrix.verdict).toBe('PASS');
    expect(matrix.improvements_count).toBe(1);
    expect(matrix.regressions_count).toBe(0);
    const sumCase = matrix.case_comparisons.find(c => c.case_id === 'case-sum-1');
    expect(sumCase?.status).toBe('improvement');
  });
});
