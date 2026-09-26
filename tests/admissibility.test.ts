/**
 * Admissibility & Evidence Contract Tests
 *
 * Verifies Phase A5 requirements:
 *   1. Specialist evidence contracts ({ tool, arguments, observations })
 *   2. Deterministic admissibility verification:
 *      - Rejects hallucinated file paths in repository profile
 *      - Rejects hallucinated eval_run_ids in failure diagnosis
 *      - Rejects diagnosis targeting passing evaluations
 *      - Rejects plans targeting non-existent files
 */

import { describe, expect, it, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvidence, validateSpecialistReport } from '../agent/contracts.mjs';
import {
  admitRepositoryProfile,
  admitFailureDiagnosis,
  admitMigrationPlan,
} from '../core/admissibility-engine.js';
import { DurableStateStore } from '../core/durable-state.js';
import {
  createSessionId,
  createEvalRunId,
  type RepositoryProfile,
  type FailureDiagnosis,
  type MigrationPlan,
  type EvaluationReport,
} from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../demo-apps/customer-support-app');

describe('Specialist Evidence Contracts', () => {
  it('validates structured specialist tool evidence', () => {
    const errors: string[] = [];
    const validEvidence = [
      {
        tool: 'repo_inspect_ai_usage',
        arguments: { repo_path: 'demo-apps/customer-support-app' },
        observations: ['found model-a in src/config.ts:5'],
      },
    ];

    validateEvidence(validEvidence, errors, { required: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects evidence missing required tool name', () => {
    const errors: string[] = [];
    const invalidEvidence = [
      {
        arguments: {},
        observations: ['observation without tool'],
      },
    ];

    validateEvidence(invalidEvidence, errors, { required: true });
    expect(errors.some(e => e.includes('tool is required'))).toBe(true);
  });

  it('rejects empty evidence when evidence is required', () => {
    const errors: string[] = [];
    validateEvidence([], errors, { required: true });
    expect(errors).toContain('evidence must contain at least one tool observation');
  });

  it('enforces evidence requirement in validateSpecialistReport when flag set', () => {
    const report = {
      contract_version: '2.0',
      role: 'code-inspector',
      status: 'complete',
      repository_name: 'test-app',
      language: 'typescript',
      package_manager: 'pnpm',
      detected_frameworks: [],
      current_model: 'model-a',
      model_references: [],
      tool_schemas: [],
      env_dependencies: [],
      unknowns: [],
    };

    const res = validateSpecialistReport(report, 'code-inspector', { requireEvidence: true });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('evidence must contain at least one tool observation');
  });
});

describe('Deterministic Admissibility Engine', () => {
  let store: DurableStateStore;
  let sessionId: string;

  beforeEach(() => {
    store = new DurableStateStore({ inMemory: true });
    sessionId = createSessionId();
    store.createOrGetSession({
      sessionId,
      repositoryPath: APP_DIR,
      sourceModel: 'model-a',
      targetModel: 'model-b',
    });
  });

  describe('Repository Profile Admissibility', () => {
    it('admits a valid profile with real files on disk', () => {
      const validProfile: RepositoryProfile = {
        contract_version: '2.0',
        status: 'complete',
        repository_path: APP_DIR,
        repository_name: 'customer-support-app',
        language: 'typescript',
        package_manager: 'npm',
        detected_frameworks: [{ name: 'openai', version: null, import_paths: ['openai'] }],
        current_model: 'model-a',
        model_references: [
          {
            file_path: 'src/config.ts',
            line_numbers: [1],
            reference_type: 'model_name_literal',
            code_snippet: 'active_model',
            confidence: 0.95,
          },
        ],
        tool_schemas: [],
        env_dependencies: ['APP_MODEL'],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      };

      const result = admitRepositoryProfile(validProfile, APP_DIR);
      expect(result.admissible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('rejects a profile citing non-existent files (hallucination defense)', () => {
      const hallucinatedProfile: RepositoryProfile = {
        contract_version: '2.0',
        status: 'complete',
        repository_path: APP_DIR,
        repository_name: 'customer-support-app',
        language: 'typescript',
        package_manager: 'npm',
        detected_frameworks: [],
        current_model: 'model-a',
        model_references: [
          {
            file_path: 'src/non_existent_file.ts',
            line_numbers: [10],
            reference_type: 'model_name_literal',
            code_snippet: 'fake',
            confidence: 0.99,
          },
        ],
        tool_schemas: [],
        env_dependencies: [],
        unknowns: [],
        inspected_at: new Date().toISOString(),
      };

      const result = admitRepositoryProfile(hallucinatedProfile, APP_DIR);
      expect(result.admissible).toBe(false);
      expect(result.reasons.some(r => r.includes('Hallucinated model reference'))).toBe(true);
    });
  });

  describe('Failure Diagnosis Admissibility', () => {
    it('admits a diagnosis citing a real failed evaluation in SQLite', () => {
      const evalRunId = createEvalRunId();
      const report: EvaluationReport = {
        contract_version: '2.0',
        eval_run_id: evalRunId,
        session_id: sessionId as any,
        candidate_id: 'model-b',
        test_suite_id: 'standard-suite',
        overall: 'FAIL',
        quality: { score: 0.65, threshold: 0.90, passed: false, by_category: { tool_calling: 0.2 } },
        latency: { p50_ms: 100, p95_ms: 250, p99_ms: 300, threshold_p95_ms: 600, passed: true },
        cost: { estimated_cost_per_1k_req: 0.4, baseline_cost_per_1k_req: 1.8, savings_pct: 77.0, passed: true },
        passed_cases: 6,
        total_cases: 10,
        regressions: ['tool_calling'],
        case_results: [],
        timestamp: new Date().toISOString(),
      };

      store.recordEvaluation(sessionId, report);

      const diagnosis: FailureDiagnosis = {
        contract_version: '2.0',
        session_id: sessionId as any,
        eval_run_id: evalRunId,
        primary_failure_category: 'tool_calling',
        affected_categories: ['tool_calling'],
        root_cause_analysis: 'Candidate model failed parameter generation',
        recommended_strategy: 'hybrid_routing',
        strategy_details: { routing_mode: 'hybrid' },
        confidence: 0.95,
        diagnosed_at: new Date().toISOString(),
      };

      const result = admitFailureDiagnosis(diagnosis, store);
      expect(result.admissible).toBe(true);
      expect(result.accepted).toEqual(diagnosis);
    });

    it('rejects a diagnosis citing a non-existent eval_run_id', () => {
      const diagnosis: FailureDiagnosis = {
        contract_version: '2.0',
        session_id: sessionId as any,
        eval_run_id: 'eval-hallucinated-999' as any,
        primary_failure_category: 'tool_calling',
        affected_categories: ['tool_calling'],
        root_cause_analysis: 'Hallucinated run',
        recommended_strategy: 'hybrid_routing',
        strategy_details: {},
        confidence: 0.95,
        diagnosed_at: new Date().toISOString(),
      };

      const result = admitFailureDiagnosis(diagnosis, store);
      expect(result.admissible).toBe(false);
      expect(result.reasons.some(r => r.includes('Hallucinated eval_run_id'))).toBe(true);
    });

    it('rejects a failure diagnosis for an evaluation that PASSED', () => {
      const evalRunId = createEvalRunId();
      const passingReport: EvaluationReport = {
        contract_version: '2.0',
        eval_run_id: evalRunId,
        session_id: sessionId as any,
        candidate_id: 'model-b',
        test_suite_id: 'standard-suite',
        overall: 'PASS',
        quality: { score: 0.98, threshold: 0.90, passed: true, by_category: {} },
        latency: { p50_ms: 100, p95_ms: 250, p99_ms: 300, threshold_p95_ms: 600, passed: true },
        cost: { estimated_cost_per_1k_req: 0.4, baseline_cost_per_1k_req: 1.8, savings_pct: 77.0, passed: true },
        passed_cases: 10,
        total_cases: 10,
        regressions: [],
        case_results: [],
        timestamp: new Date().toISOString(),
      };

      store.recordEvaluation(sessionId, passingReport);

      const diagnosis: FailureDiagnosis = {
        contract_version: '2.0',
        session_id: sessionId as any,
        eval_run_id: evalRunId,
        primary_failure_category: 'latency_regression',
        affected_categories: [],
        root_cause_analysis: 'Fake latency issue on a passing benchmark',
        recommended_strategy: 'abort_migration',
        strategy_details: {},
        confidence: 0.95,
        diagnosed_at: new Date().toISOString(),
      };

      const result = admitFailureDiagnosis(diagnosis, store);
      expect(result.admissible).toBe(false);
      expect(result.reasons.some(r => r.includes('overall verdict PASS'))).toBe(true);
    });
  });

  describe('Migration Plan Admissibility', () => {
    it('admits a plan targeting existing repository files', () => {
      const plan: MigrationPlan = {
        contract_version: '2.0',
        plan_id: 'plan-001' as any,
        session_id: sessionId as any,
        created_at: new Date().toISOString(),
        source_model: 'model-a',
        target_model: 'model-b',
        strategy: 'direct_replacement',
        strategy_rationale: 'Valid direct swap',
        changes: [
          {
            file_path: 'src/config.ts',
            description: 'Change active model',
            rationale: 'Switch to candidate',
            line_range: { start: 1, end: 10 },
            risk: 'low',
          },
        ],
        acceptance_criteria: [
          { id: 'quality', description: 'Score >= 0.9', category: 'quality', threshold: '>= 0.9', required: true },
        ],
        risk_assessment: 'low',
        estimated_cost_savings_pct: 70,
      };

      const result = admitMigrationPlan(plan, APP_DIR);
      expect(result.admissible).toBe(true);
    });

    it('rejects a plan targeting non-existent files', () => {
      const plan: MigrationPlan = {
        contract_version: '2.0',
        plan_id: 'plan-002' as any,
        session_id: sessionId as any,
        created_at: new Date().toISOString(),
        source_model: 'model-a',
        target_model: 'model-b',
        strategy: 'direct_replacement',
        strategy_rationale: 'Hallucinated changes',
        changes: [
          {
            file_path: 'src/missing_service.py',
            description: 'Change model in non-existent file',
            rationale: 'Hallucinated',
            line_range: null,
            risk: 'high',
          },
        ],
        acceptance_criteria: [
          { id: 'quality', description: 'Score >= 0.9', category: 'quality', threshold: '>= 0.9', required: true },
        ],
        risk_assessment: 'high',
        estimated_cost_savings_pct: 50,
      };

      const result = admitMigrationPlan(plan, APP_DIR);
      expect(result.admissible).toBe(false);
      expect(result.reasons.some(r => r.includes('targets non-existent file'))).toBe(true);
    });
  });
});
