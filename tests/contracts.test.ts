/**
 * Agent Contracts v2 Tests
 *
 * Validates the v2 specialist contract schema validation and
 * cross-role correlation logic.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  SPECIALIST_ROLES,
  SPECIALIST_CONTRACTS,
  validateSpecialistReport,
  correlateReports,
} from '../agent/contracts.mjs';

describe('Agent Contracts v2', () => {
  it('has version 2.0', () => {
    expect(CONTRACT_VERSION).toBe('2.0');
  });

  it('defines three specialist roles', () => {
    expect(SPECIALIST_ROLES).toContain('code-inspector');
    expect(SPECIALIST_ROLES).toContain('failure-diagnostician');
    expect(SPECIALIST_ROLES).toContain('migration-planner');
    expect(SPECIALIST_ROLES).toHaveLength(3);
  });

  it('has contract templates for all roles', () => {
    for (const role of SPECIALIST_ROLES) {
      expect((SPECIALIST_CONTRACTS as any)[role]).toBeDefined();
      expect(typeof (SPECIALIST_CONTRACTS as any)[role]).toBe('string');
    }
  });
});

describe('validateSpecialistReport — code-inspector', () => {
  const validReport = {
    contract_version: '2.0',
    role: 'code-inspector',
    status: 'complete',
    repository_name: 'customer-support-app',
    language: 'typescript',
    package_manager: 'pnpm',
    detected_frameworks: [{ name: 'openai-sdk', version: '^4.0.0', import_paths: ['openai'] }],
    current_model: 'model-a',
    model_references: [{
      file_path: 'src/config.ts',
      line_numbers: [5],
      reference_type: 'model_name_literal',
      code_snippet: `active_model: 'model-a'`,
      confidence: 0.95,
    }],
    tool_schemas: [],
    env_dependencies: ['APP_MODEL'],
    unknowns: [],
  };

  it('accepts a valid v2 code-inspector report', () => {
    const result = validateSpecialistReport(validReport, 'code-inspector');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing repository_name', () => {
    const { repository_name, ...incomplete } = validReport;
    const result = validateSpecialistReport(incomplete, 'code-inspector');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('repository_name is required');
  });

  it('rejects invalid confidence in model_references', () => {
    const report = {
      ...validReport,
      model_references: [{
        file_path: 'src/config.ts',
        line_numbers: [5],
        reference_type: 'model_name_literal',
        code_snippet: 'test',
        confidence: 1.5, // Invalid: must be 0-1
      }],
    };
    const result = validateSpecialistReport(report, 'code-inspector');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
  });

  it('rejects complete report with unknowns', () => {
    const report = { ...validReport, unknowns: ['something missing'] };
    const result = validateSpecialistReport(report, 'code-inspector');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('complete report cannot contain unknowns');
  });
});

describe('validateSpecialistReport — failure-diagnostician', () => {
  const validReport = {
    contract_version: '2.0',
    role: 'failure-diagnostician',
    status: 'complete',
    eval_run_id: 'eval-abc123',
    primary_failure_category: 'tool_calling',
    affected_categories: ['tool'],
    root_cause_analysis: 'The candidate model produces invalid parameter schemas for tool calls.',
    recommended_strategy: 'hybrid_routing',
    strategy_details: { routing_mode: 'hybrid', target_for_tools: 'model-a', target_for_bulk: 'model-b' },
    confidence: 0.95,
    unknowns: [],
  };

  it('accepts a valid failure-diagnostician report', () => {
    const result = validateSpecialistReport(validReport, 'failure-diagnostician');
    expect(result.valid).toBe(true);
  });

  it('rejects missing confidence', () => {
    const { confidence, ...incomplete } = validReport;
    const result = validateSpecialistReport(incomplete, 'failure-diagnostician');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
  });
});

describe('validateSpecialistReport — migration-planner', () => {
  const validReport = {
    contract_version: '2.0',
    role: 'migration-planner',
    status: 'complete',
    title: 'Migrate customer-support-app from model-a to model-b',
    strategy: 'direct_replacement',
    strategy_rationale: 'Initial attempt with direct model swap.',
    changes: [{ file_path: 'src/config.ts', description: 'Update model', rationale: 'Swap', risk: 'low' }],
    acceptance_criteria: [{ id: 'quality', description: 'Quality >= 0.90', category: 'quality', threshold: '>= 0.90', required: true }],
    risk_assessment: 'medium',
    unknowns: [],
  };

  it('accepts a valid migration-planner report', () => {
    const result = validateSpecialistReport(validReport, 'migration-planner');
    expect(result.valid).toBe(true);
  });

  it('rejects missing strategy', () => {
    const { strategy, ...incomplete } = validReport;
    const result = validateSpecialistReport(incomplete, 'migration-planner');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('strategy is required');
  });
});

describe('correlateReports', () => {
  it('accepts consistent reports from all specialists', () => {
    const reports = {
      'code-inspector': {
        contract_version: '2.0', role: 'code-inspector', status: 'complete',
        repository_name: 'test-app', language: 'typescript', package_manager: 'pnpm',
        detected_frameworks: [], current_model: 'model-a', model_references: [],
        tool_schemas: [], env_dependencies: [], unknowns: [],
      },
      'failure-diagnostician': {
        contract_version: '2.0', role: 'failure-diagnostician', status: 'complete',
        eval_run_id: 'eval-1', primary_failure_category: 'tool_calling',
        affected_categories: ['tool'], root_cause_analysis: 'Schema failures',
        recommended_strategy: 'hybrid_routing', strategy_details: {},
        confidence: 0.95, unknowns: [],
      },
      'migration-planner': {
        contract_version: '2.0', role: 'migration-planner', status: 'complete',
        title: 'Migrate test-app', strategy: 'hybrid_routing',
        strategy_rationale: 'Based on diagnosis', changes: [],
        acceptance_criteria: [], risk_assessment: 'medium', unknowns: [],
      },
    };

    const result = correlateReports(reports);
    expect(result.ready).toBe(true);
    expect(result.correlations?.strategy).toBe('hybrid_routing');
  });

  it('detects strategy mismatch between diagnostician and planner', () => {
    const reports = {
      'code-inspector': {
        contract_version: '2.0', role: 'code-inspector', status: 'complete',
        repository_name: 'test', language: 'typescript', package_manager: 'npm',
        detected_frameworks: [], current_model: 'x', model_references: [],
        tool_schemas: [], env_dependencies: [], unknowns: [],
      },
      'failure-diagnostician': {
        contract_version: '2.0', role: 'failure-diagnostician', status: 'complete',
        eval_run_id: 'eval-1', primary_failure_category: 'tool_calling',
        affected_categories: ['tool'], root_cause_analysis: 'test',
        recommended_strategy: 'hybrid_routing', strategy_details: {},
        confidence: 0.9, unknowns: [],
      },
      'migration-planner': {
        contract_version: '2.0', role: 'migration-planner', status: 'complete',
        title: 'Migrate', strategy: 'direct_replacement', // Mismatch!
        strategy_rationale: 'test', changes: [], acceptance_criteria: [],
        risk_assessment: 'low', unknowns: [],
      },
    };

    const result = correlateReports(reports);
    expect(result.ready).toBe(false);
    expect(result.errors.some(e => e.includes('does not match'))).toBe(true);
  });
});
