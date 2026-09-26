/**
 * Rehearsal Comparison Engine
 *
 * Architectural Principle #5: Deterministic core / nondeterministic edge
 * Architectural Principle #6: Fail-closed behavior
 * Architectural Principle #18: Immutable/auditable artifacts
 *
 * Pure deterministic differential analysis comparing Baseline evidence against
 * Candidate execution evidence across accuracy, per-case regressions, latency shift,
 * and cost savings.
 */

import {
  type EvaluationReport,
  type RehearsalComparisonMatrix,
  type CaseComparison,
  type CaseComparisonStatus,
  type SessionId,
  createComparisonId,
} from '../types.js';

export interface CompareRehearsalsOptions {
  baselineReport: EvaluationReport;
  candidateReport: EvaluationReport;
  baselineModel?: string;
  candidateModel?: string;
  sessionId?: SessionId;
}

/**
 * Pure function to deterministically compare a baseline evaluation against a candidate evaluation.
 * Performs zero network I/O, zero state mutation.
 */
export function compareRehearsalReports(options: CompareRehearsalsOptions): RehearsalComparisonMatrix {
  const {
    baselineReport,
    candidateReport,
    baselineModel = 'baseline-model',
    candidateModel = candidateReport.candidate_id || 'candidate-model',
    sessionId = candidateReport.session_id,
  } = options;

  const baselineMap = new Map(baselineReport.case_results.map(c => [c.case_id, c]));
  const candidateMap = new Map(candidateReport.case_results.map(c => [c.case_id, c]));

  // Collect all unique case IDs preserving baseline order first
  const allCaseIds = new Set<string>([
    ...baselineReport.case_results.map(c => c.case_id),
    ...candidateReport.case_results.map(c => c.case_id),
  ]);

  const caseComparisons: CaseComparison[] = [];
  let regressionsCount = 0;
  let improvementsCount = 0;

  for (const caseId of allCaseIds) {
    const baseCase = baselineMap.get(caseId);
    const candCase = candidateMap.get(caseId);

    const baselinePassed = Boolean(baseCase?.passed);
    const candidatePassed = Boolean(candCase?.passed);

    let status: CaseComparisonStatus;
    if (baselinePassed && candidatePassed) {
      status = 'maintained_pass';
    } else if (baselinePassed && !candidatePassed) {
      status = 'regression';
      regressionsCount++;
    } else if (!baselinePassed && candidatePassed) {
      status = 'improvement';
      improvementsCount++;
    } else {
      status = 'maintained_fail';
    }

    const baselineLatency = baseCase?.latency_ms ?? 0;
    const candidateLatency = candCase?.latency_ms ?? 0;
    const latencyDelta = candidateLatency - baselineLatency;

    caseComparisons.push({
      case_id: caseId,
      category: (candCase?.category || baseCase?.category || 'qa') as 'qa' | 'summarize' | 'extract' | 'tool',
      baseline_passed: baselinePassed,
      candidate_passed: candidatePassed,
      status,
      baseline_latency_ms: baselineLatency,
      candidate_latency_ms: candidateLatency,
      latency_delta_ms: latencyDelta,
      failure_reason: candCase?.failure_reason ?? (!candidatePassed ? 'Case failed validation' : null),
    });
  }

  const baselineScore = baselineReport.quality?.score ?? 0;
  const candidateScore = candidateReport.quality?.score ?? 0;
  const accuracyDelta = Number((candidateScore - baselineScore).toFixed(2));

  const baselineP50 = baselineReport.latency?.p50_ms ?? 0;
  const candidateP50 = candidateReport.latency?.p50_ms ?? 0;
  const latencyP50Shift = candidateP50 - baselineP50;

  const baselineP95 = baselineReport.latency?.p95_ms ?? 0;
  const candidateP95 = candidateReport.latency?.p95_ms ?? 0;
  const latencyP95Shift = candidateP95 - baselineP95;

  const costSavingsPct = candidateReport.cost?.savings_pct ?? 0;

  // Fail-closed verdict determination:
  // If there are ANY regressions or candidate failed overall, verdict is FAIL.
  let verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  let recommendation: 'ready_for_approval' | 'needs_remediation' | 'abort_migration';

  if (allCaseIds.size === 0) {
    verdict = 'INCONCLUSIVE';
    recommendation = 'needs_remediation';
  } else if (regressionsCount === 0 && candidateReport.overall === 'PASS') {
    verdict = 'PASS';
    recommendation = 'ready_for_approval';
  } else {
    verdict = 'FAIL';
    recommendation = 'needs_remediation';
  }

  // Generate objective, empirical summary
  let summary: string;
  if (verdict === 'PASS') {
    summary = `Candidate ${candidateModel} achieved parity with baseline ${baselineModel}: ${candidateReport.passed_cases}/${allCaseIds.size} passed (quality score ${candidateScore}, accuracy delta ${accuracyDelta >= 0 ? '+' : ''}${accuracyDelta}). Zero regressions detected with ${costSavingsPct}% cost reduction. Ready for approval.`;
  } else {
    const regressedCategories = [...new Set(caseComparisons.filter(c => c.status === 'regression').map(c => c.category))];
    summary = `Candidate ${candidateModel} exhibited ${regressionsCount} regression(s) vs baseline ${baselineModel} (${candidateReport.passed_cases}/${allCaseIds.size} passed, quality score ${candidateScore}, accuracy delta ${accuracyDelta >= 0 ? '+' : ''}${accuracyDelta}). Affected categories: ${regressedCategories.join(', ') || 'general'}. Recommendation: apply remediation.`;
  }

  return {
    contract_version: '2.0',
    comparison_id: createComparisonId(),
    session_id: sessionId,
    baseline_eval_id: baselineReport.eval_run_id,
    candidate_eval_id: candidateReport.eval_run_id,
    baseline_model: baselineModel,
    candidate_model: candidateModel,
    timestamp: new Date().toISOString(),
    total_cases: allCaseIds.size,
    baseline_passed: baselineReport.passed_cases,
    candidate_passed: candidateReport.passed_cases,
    accuracy_delta: accuracyDelta,
    latency_p50_shift_ms: latencyP50Shift,
    latency_p95_shift_ms: latencyP95Shift,
    cost_savings_pct: costSavingsPct,
    regressions_count: regressionsCount,
    improvements_count: improvementsCount,
    case_comparisons: caseComparisons,
    verdict,
    recommendation,
    summary,
  };
}
