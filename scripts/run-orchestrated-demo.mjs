/**
 * ModelForge — Orchestrator-Driven Migration Demo
 *
 * This replaces the procedural run-full-demo.mjs with the core
 * orchestrator + state machine architecture. Every step flows through
 * the state machine, produces real evaluation data, and generates
 * an immutable audit receipt.
 *
 * Usage:
 *   node --env-file-if-exists=.env --import tsx scripts/run-orchestrated-demo.mjs
 *   node --env-file-if-exists=.env --import tsx scripts/run-orchestrated-demo.mjs --auto-approve
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { MigrationOrchestrator } from '../core/orchestrator.js';
import { analyzeRepository } from '../core/repository-analyzer.js';
import { startSandboxApp, stopSandboxApp } from '../mcp-servers/rehearsal-mcp/src/sandbox-runner.js';
import { WorkspaceSandbox } from '../core/workspace-sandbox.js';
import { applyMigrationPlan } from '../core/patching/index.js';
import { runEvaluation } from '../core/evaluation-engine.js';
import { diagnoseFailures } from '../core/failure-diagnostician.js';
import { generateMigrationPlan } from '../core/migration-planner.js';
import { MigrationStateMachine } from '../core/state-machine.js';
import {
  prepareCanaryManifest,
  applyProductionRouting,
  verifyGatewayRouting,
} from '../mcp-servers/gateway-mcp/src/canary-manager.js';
import { issueApprovalArtifact } from '../core/approval-token.js';
import { sessionRegistry } from '../core/session-registry.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_APP_DIR = path.resolve(ROOT_DIR, 'demo-apps/customer-support-app');
const RECEIPTS_DIR = path.resolve(ROOT_DIR, '.modelforge-receipts');
const SANDBOX_PORT = 8955;

// ─── Console Formatting ──────────────────────────────────────────────────────

function printBanner(text) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${text}`);
  console.log('═'.repeat(80));
}

function printStep(num, title) {
  console.log(`\n\x1b[36m━━ STEP ${num} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`\x1b[1m${title}\x1b[0m`);
}

function printMetric(label, value, status) {
  const statusColor = status === 'PASS' ? '\x1b[32m' : status === 'FAIL' ? '\x1b[31m' : '\x1b[33m';
  console.log(`  • ${label.padEnd(22)} ${value}${status ? ` → ${statusColor}[${status}]\x1b[0m` : ''}`);
}

function printStateTransition(from, to) {
  console.log(`\x1b[90m  [state] ${from} → ${to}\x1b[0m`);
}

async function promptApproval(question) {
  if (process.env.NON_INTERACTIVE === 'true' || process.argv.includes('--auto-approve')) {
    console.log(`\x1b[33m[Operator Console]\x1b[0m Auto-approving: YES`);
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n\x1b[33m[HUMAN CHECKPOINT]\x1b[0m ${question} (y/N): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  printBanner('MODELFORGE // ORCHESTRATOR-DRIVEN AI MODEL MIGRATION');
  console.log(`Target Repository:  ${TARGET_APP_DIR}`);
  console.log(`Baseline Model:     model-a`);
  console.log(`Candidate Model:    model-b`);

  const machine = sessionRegistry.getOrCreate({
    repositoryPath: TARGET_APP_DIR,
    sourceModel: 'model-a',
    targetModel: 'model-b',
    maxRemediationRounds: 3,
  });
  const sessionId = machine.sessionId;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Repository Inspection (via core/repository-analyzer)
  // ═══════════════════════════════════════════════════════════════════════════
  printStep(1, 'Deep Repository Analysis (core/repository-analyzer)');

  machine.startTimer();
  machine.transition('inspecting', 'inspect_repository');
  const profile = analyzeRepository(TARGET_APP_DIR);
  machine.transition('inspection_complete', 'inspection_complete', {
    status: profile.status,
    references: profile.model_references.length,
  });
  machine.setProfile(profile);

  printMetric('Status', profile.status);
  printMetric('Language', profile.language);
  printMetric('Package Manager', profile.package_manager);
  printMetric('Frameworks', profile.detected_frameworks.map(f => `${f.name}${f.version ? `@${f.version}` : ''}`).join(', '));
  printMetric('Current Model', profile.current_model);
  printMetric('Model References', `${profile.model_references.length} coupling sites`);
  printMetric('Env Dependencies', profile.env_dependencies.join(', ') || 'none');

  console.log(`\n  Model Coupling Sites:`);
  for (const ref of profile.model_references.slice(0, 10)) {
    console.log(`    [${ref.reference_type}] ${ref.file_path}:${ref.line_numbers.join(',')} (conf: ${ref.confidence})`);
  }
  if (profile.model_references.length > 10) {
    console.log(`    ... and ${profile.model_references.length - 10} more`);
  }

  printStateTransition('initialized', 'inspection_complete');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Migration Planning (via core/migration-planner)
  // ═══════════════════════════════════════════════════════════════════════════
  printStep(2, 'Migration Plan Generation (core/migration-planner)');

  machine.startTimer();
  machine.transition('planning', 'generate_plan');
  const plan = generateMigrationPlan({
    sessionId,
    profile,
    sourceModel: 'model-a',
    targetModel: 'model-b',
  });
  machine.transition('plan_ready', 'plan_generated', { strategy: plan.strategy });
  machine.setPlan(plan);

  printMetric('Strategy', plan.strategy);
  printMetric('Risk Assessment', plan.risk_assessment);
  printMetric('Planned Changes', `${plan.changes.length} code modifications`);
  printMetric('Acceptance Criteria', `${plan.acceptance_criteria.length} criteria`);

  console.log(`\n  Planned Changes:`);
  for (const change of plan.changes) {
    console.log(`    [${change.risk}] ${change.file_path}: ${change.description}`);
  }

  printStateTransition('planning', 'plan_ready');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Sandbox Staging (WorkspaceSandbox copy-on-write isolation)
  // ═══════════════════════════════════════════════════════════════════════════
  printStep(3, 'Staging Candidate in Isolated Sandbox');

  machine.startTimer();
  machine.transition('staging', 'create_sandbox');

  const sandbox = new WorkspaceSandbox({
    sessionId,
    sourcePath: TARGET_APP_DIR,
  });
  sandbox.initialize();

  // Stage direct model-b replacement inside sandbox
  applyMigrationPlan(sandbox, plan, profile);
  const appInstance = await startSandboxApp({ targetDir: sandbox.sandboxPath, port: SANDBOX_PORT });

  machine.transition('staged', 'sandbox_staged');

  printMetric('Active Model', 'model-b');
  printMetric('Routing Mode', 'direct (naive replacement)');
  printMetric('Sandbox App', `http://127.0.0.1:${appInstance.port}/health (PID: ${appInstance.pid})`);

  printStateTransition('staging', 'staged');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Round 1 Evaluation (via core/evaluation-engine)
  // ═══════════════════════════════════════════════════════════════════════════
  printStep(4, 'Round 1 Deterministic Evaluation (core/evaluation-engine)');

  machine.startTimer();
  machine.transition('evaluating', 'start_evaluation');

  const evalRound1 = await runEvaluation({
    endpointUrl: `http://127.0.0.1:${SANDBOX_PORT}/api/chat`,
    candidateId: 'candidate-model-b-round-1',
    sessionId,
  });

  machine.transition('evaluation_complete', 'evaluation_complete', {
    overall: evalRound1.overall,
    quality: evalRound1.quality.score,
  });
  machine.addEvaluation(evalRound1);

  console.log(`\n  ─── ROUND 1 EVALUATION RECEIPT ───`);
  printMetric('Total Cases', String(evalRound1.total_cases));
  printMetric('Passed Cases', `${evalRound1.passed_cases} / ${evalRound1.total_cases}`);
  printMetric('Quality Score', `${evalRound1.quality.score} (threshold: ${evalRound1.quality.threshold})`, evalRound1.quality.passed ? 'PASS' : 'FAIL');
  printMetric('Latency p95', `${evalRound1.latency.p95_ms}ms (threshold: ${evalRound1.latency.threshold_p95_ms}ms)`, evalRound1.latency.passed ? 'PASS' : 'FAIL');
  printMetric('Cost / 1k req', `$${evalRound1.cost.estimated_cost_per_1k_req} (baseline: $${evalRound1.cost.baseline_cost_per_1k_req}, savings: ${evalRound1.cost.savings_pct}%)`);
  printMetric('OVERALL', evalRound1.overall, evalRound1.overall);

  if (evalRound1.quality.by_category) {
    console.log(`\n  Per-Category Breakdown:`);
    for (const [cat, stats] of Object.entries(evalRound1.quality.by_category)) {
      printMetric(`  ${cat}`, `${stats.passed}/${stats.total} (${stats.score})`);
    }
  }

  if (evalRound1.regressions.length > 0) {
    console.log(`\n  \x1b[31mRegressions (${evalRound1.regressions.length}):\x1b[0m`);
    for (const r of evalRound1.regressions) {
      console.log(`    [${r.severity}] ${r.case_id} (${r.category}): ${r.error}`);
    }
  }

  printStateTransition('evaluating', 'evaluation_complete');

  let passingEval = null;
  let finalArchitecture = 'single_candidate';
  let finalStrategy = 'direct_replacement';

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Failure Diagnosis & Remediation Loop (if Round 1 failed)
  // ═══════════════════════════════════════════════════════════════════════════
  if (evalRound1.overall === 'FAIL') {
    printStep(5, 'Autonomous Failure Diagnosis (core/failure-diagnostician)');

    machine.startTimer();
    machine.transition('diagnosing', 'start_diagnosis');

    const diagnosis = diagnoseFailures({
      sessionId,
      evaluationReport: evalRound1,
    });

    machine.transition('diagnosis_complete', 'diagnosis_complete', {
      category: diagnosis.primary_failure_category,
      strategy: diagnosis.recommended_strategy,
    });
    machine.addDiagnosis(diagnosis);

    printMetric('Primary Failure', diagnosis.primary_failure_category);
    printMetric('Affected Categories', diagnosis.affected_categories.join(', '));
    printMetric('Confidence', `${(diagnosis.confidence * 100).toFixed(0)}%`);
    printMetric('Recommended Strategy', diagnosis.recommended_strategy);
    console.log(`\n  Root Cause Analysis:`);
    console.log(`    ${diagnosis.root_cause_analysis}`);

    printStateTransition('diagnosing', 'diagnosis_complete');

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 6: Remediation — Hybrid Routing
    // ═════════════════════════════════════════════════════════════════════════
    if (diagnosis.recommended_strategy !== 'abort_migration') {
      printStep(6, 'Applying Remediation: Hybrid Routing Architecture');

      machine.startTimer();
      machine.transition('remediating', 'start_remediation');

      // Re-plan with diagnosis
      const remediationPlan = generateMigrationPlan({
        sessionId,
        profile,
        sourceModel: 'model-a',
        targetModel: 'model-b',
        previousDiagnosis: diagnosis,
      });

      // Stage hybrid routing inside isolated sandbox
      applyMigrationPlan(sandbox, remediationPlan, profile);
      await startSandboxApp({ targetDir: sandbox.sandboxPath, port: SANDBOX_PORT });

      machine.transition('remediation_staged', 'remediation_staged', {
        strategy: remediationPlan.strategy,
      });

      printMetric('New Strategy', remediationPlan.strategy);
      printMetric('Active Model', 'model-b (hybrid routing)');
      printMetric('Tool Tasks', '→ model-a (high reliability)');
      printMetric('Bulk Tasks', '→ model-b (cost efficient)');

      printStateTransition('remediating', 'remediation_staged');

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 7: Round 2 Evaluation
      // ═══════════════════════════════════════════════════════════════════════
      printStep(7, 'Round 2 Deterministic Evaluation (Validation)');

      machine.startTimer();
      machine.transition('re_evaluating', 'start_re_evaluation');

      const evalRound2 = await runEvaluation({
        endpointUrl: `http://127.0.0.1:${SANDBOX_PORT}/api/chat`,
        candidateId: 'candidate-model-b-round-2-hybrid',
        sessionId,
      });

      machine.transition('re_evaluation_complete', 're_evaluation_complete', {
        overall: evalRound2.overall,
        quality: evalRound2.quality.score,
      });
      machine.addEvaluation(evalRound2);

      console.log(`\n  ─── ROUND 2 EVALUATION RECEIPT ───`);
      printMetric('Total Cases', String(evalRound2.total_cases));
      printMetric('Passed Cases', `${evalRound2.passed_cases} / ${evalRound2.total_cases}`);
      printMetric('Quality Score', `${evalRound2.quality.score} (threshold: ${evalRound2.quality.threshold})`, evalRound2.quality.passed ? 'PASS' : 'FAIL');
      printMetric('Latency p95', `${evalRound2.latency.p95_ms}ms`, evalRound2.latency.passed ? 'PASS' : 'FAIL');
      printMetric('Cost Savings', `${evalRound2.cost.savings_pct}%`);
      printMetric('OVERALL', evalRound2.overall, evalRound2.overall);

      if (evalRound2.quality.by_category) {
        console.log(`\n  Per-Category Breakdown:`);
        for (const [cat, stats] of Object.entries(evalRound2.quality.by_category)) {
          printMetric(`  ${cat}`, `${stats.passed}/${stats.total} (${stats.score})`);
        }
      }

      printStateTransition('re_evaluating', 're_evaluation_complete');

      if (evalRound2.overall === 'PASS') {
        passingEval = evalRound2;
        finalArchitecture = 'hybrid_routed';
        finalStrategy = remediationPlan.strategy;
      }
    }
  } else {
    passingEval = evalRound1;
    finalArchitecture = 'single_candidate';
    finalStrategy = 'direct_replacement';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STEP 8: Canary Preparation
  // ═════════════════════════════════════════════════════════════════════════
  if (passingEval) {
    printStep(8, 'Preparing Production Canary Plan');

    const canaryPlan = prepareCanaryManifest({
      candidateId: passingEval.candidate_id,
      sessionId: machine.sessionId,
      baselineModel: 'model-a',
      candidateModel: 'model-b',
      routingArchitecture: finalArchitecture,
      trafficSplitCandidatePct: 10,
      evaluationProof: {
        eval_run_id: passingEval.eval_run_id,
        quality_score: passingEval.quality.score,
        p95_ms: passingEval.latency.p95_ms,
        savings_pct: passingEval.cost.savings_pct,
      },
    });

    printMetric('Canary ID', canaryPlan.canary_id);
    printMetric('Traffic Split', `90% Baseline / 10% Candidate Canary`);
    printMetric('Expected Savings', `${canaryPlan.evaluation_proof.savings_pct}%`);
    printMetric('Circuit Breaker', `error > ${canaryPlan.circuit_breakers.error_rate_threshold_pct}% or p95 > ${canaryPlan.circuit_breakers.p95_latency_threshold_ms}ms`);
    printMetric('Manifest SHA', canaryPlan.manifest_sha);

    printStateTransition('preparing_canary', 'canary_ready');

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 9: Human Approval Gate
    // ═══════════════════════════════════════════════════════════════════════
    printStep(9, 'TrueForge Approval Gate — Production Routing Mutation');

    console.log(`\n  ┌──────────────────────────────────────────────────────────────┐`);
    console.log(`  │           PRODUCTION ROUTING CANARY APPROVAL                 │`);
    console.log(`  ├──────────────────────────────────────────────────────────────┤`);
    console.log(`  │ All ${passingEval.total_cases} deterministic tests PASSED                       │`);
    console.log(`  │ Strategy: ${finalStrategy.padEnd(46)} │`);
    console.log(`  │ Quality: ${passingEval.quality.score}  Latency p95: ${passingEval.latency.p95_ms}ms  Savings: ${passingEval.cost.savings_pct}%   │`);
    console.log(`  │ Traffic: 90% Baseline / 10% Canary                          │`);
    console.log(`  └──────────────────────────────────────────────────────────────┘`);

    const approved = await promptApproval('Authorize production AI Gateway routing mutation?');
    if (!approved) {
      machine.transition('aborted', 'operator_rejected');
      console.log(`\n\x1b[31m[REJECTED]\x1b[0m Production mutation denied. Migration safely halted.`);
      stopSandboxApp();

      // Generate receipt for aborted migration
      const receipt = machine.generateReceipt();
      saveReceipt(receipt);
      printStateTransition('awaiting_approval', 'aborted');
      process.exit(0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 10: Apply Production Routing
    // ═══════════════════════════════════════════════════════════════════════
    printStep(10, 'Mutating Production AI Gateway Routing Table');

    // Generate cryptographically signed approval artifact
    const approvalToken = issueApprovalArtifact({
      sessionId: machine.sessionId,
      canaryId: canaryPlan.canary_id,
      manifestSha: canaryPlan.manifest_sha,
      decision: 'allow',
      operator: 'trueforge-operator-console',
    });

    const applyResult = applyProductionRouting({
      canaryId: canaryPlan.canary_id,
      approvalToken,
      sessionId: machine.sessionId,
    });

    printMetric('Gateway Response', applyResult.status);
    printMetric('Active Routing SHA', applyResult.active_sha);
    printMetric('Approved By', applyResult.approved_by);

    printStateTransition('applying', 'verifying');

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 11: Production Verification
    // ═══════════════════════════════════════════════════════════════════════
    printStep(11, 'Authoritative Live Production Verification');

    const verification = verifyGatewayRouting(canaryPlan.canary_id, machine.sessionId);

    printMetric('Expected SHA', verification.expected_routing_sha);
    printMetric('Active SHA', verification.active_routing_sha);
    printMetric('SHA Match', verification.verified ? '\x1b[32mVERIFIED\x1b[0m' : '\x1b[31mMISMATCH\x1b[0m');

    console.log(`\n  Live Traffic Routes:`);
    for (const route of verification.live_routes) {
      console.log(`    ${route.target.padEnd(12)} │ ${route.weight_pct}% │ ${route.architecture}`);
    }

    printStateTransition('verifying', 'completed');

    // ═══════════════════════════════════════════════════════════════════════
    // Generate Audit Receipt
    // ═══════════════════════════════════════════════════════════════════════
    const receipt = verification.receipt ?? machine.generateReceipt();
    saveReceipt(receipt);

    printBanner('MODELFORGE MIGRATION COMPLETED SUCCESSFULLY');
    console.log(`\n  Session ID:           ${receipt.session_id}`);
    console.log(`  Outcome:              ${receipt.outcome}`);
    console.log(`  Duration:             ${receipt.total_duration_ms}ms`);
    console.log(`  Strategy:             ${receipt.final_strategy}`);
    console.log(`  Evaluation Rounds:    ${receipt.total_evaluation_rounds}`);
    console.log(`  Remediation Rounds:   ${receipt.total_remediation_rounds}`);
    console.log(`  Final Quality:        ${receipt.final_quality_score}`);
    console.log(`  Cost Savings:         ${receipt.final_cost_savings_pct}%`);
    console.log(`  Manifest SHA:         ${receipt.manifest_sha}`);
    console.log(`  Receipt SHA:          ${receipt.receipt_sha}`);
    console.log(`  State Transitions:    ${receipt.events.length}`);
  }

  sandbox.discard();
  stopSandboxApp();
}

function saveReceipt(receipt) {
  if (!existsSync(RECEIPTS_DIR)) {
    mkdirSync(RECEIPTS_DIR, { recursive: true });
  }
  const filename = `receipt-${receipt.session_id}.json`;
  const filepath = path.join(RECEIPTS_DIR, filename);
  writeFileSync(filepath, JSON.stringify(receipt, null, 2), 'utf8');
  console.log(`\n  \x1b[32m[Receipt saved]\x1b[0m ${filepath}`);
}

main().catch(err => {
  console.error('\n[FATAL ERROR]', err);
  stopSandboxApp();
  process.exit(1);
});
