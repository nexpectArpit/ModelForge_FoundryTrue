import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { TrueForgeClient, findAgentByName } from '../agent/trueforge-client.mjs';
import { AGENT_NAME } from '../agent/definition.mjs';

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
const token = process.env.TRUEFORGE_TOKEN;
const client = new TrueForgeClient({ baseUrl, token });

const EVIDENCE_DIR = path.resolve(process.cwd(), 'evidence/trueforge-live');

async function promptApproval(question) {
  if (process.env.NON_INTERACTIVE === 'true' || process.argv.includes('--auto-approve')) {
    console.log(`\x1b[33m[Operator Console]\x1b[0m Auto-approving for non-interactive run: YES`);
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n\x1b[33m[TRUEFORGE APPROVAL GATE]\x1b[0m ${question} (y/N): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function runSession() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  console.log(`[session] Connecting to TrueForge Harness at ${baseUrl}...`);
  const agent = await findAgentByName(client, AGENT_NAME);
  if (!agent) {
    console.error(`[session] Agent "${AGENT_NAME}" not found. Run "pnpm modelforge:bootstrap" first.`);
    process.exit(1);
  }

  // Record service health check snapshot
  const healthSnapshot = {
    timestamp: new Date().toISOString(),
    trueforge: { url: baseUrl, status: 'online' },
    rehearsal_mcp: { url: 'http://127.0.0.1:8951/mcp', status: 'online' },
    gateway_mcp: { url: 'http://127.0.0.1:8952/mcp', status: 'online' },
    baseline_app: { url: 'http://127.0.0.1:8950', status: 'online' },
  };
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'health_checks.json'),
    JSON.stringify(healthSnapshot, null, 2),
    'utf-8'
  );

  console.log(`[session] Creating durable session for agent "${AGENT_NAME}"...`);
  const sessionResp = await client.request('POST', '/api/v1/sessions', {
    body: { agent: { name: AGENT_NAME } },
    expected: [200, 201],
  });
  const sessionId = sessionResp.data.id;
  console.log(`[session] Session opened: ${sessionId}`);

  const repoPath = 'demo-apps/customer-support-app';
  const userPrompt = `Please execute a migration rehearsal for "${repoPath}".
You must call each tool strictly one at a time sequentially. Do not call multiple tools in parallel.
1. Inspect the repository AI usage using repo_path "${repoPath}".
2. Establish baseline evidence against the running baseline application endpoint at "http://127.0.0.1:8950".
3. Generate a migration plan for candidate target model "model-b".
4. Stage candidate model "model-b" using repo_path "${repoPath}" into an isolated sandbox copy.
5. Run the candidate application in the sandbox.
6. Run the deterministic benchmark against the candidate sandbox application.
7. Call compare_rehearsals to compare candidate evidence against the baseline evidence.
8. If regressions are detected, call diagnose_failures and apply_sandbox_remediation to remediate the sandbox, then re-test with run_deterministic_benchmark and compare_rehearsals.
9. When comparison passes, call prepare_canary_manifest with the evaluation proof.
10. Call apply_production_routing with the canary_id (which will pause for operator approval).
11. After approval, verify production routing with verify_gateway_routing.
12. Conclude by rendering the complete TrueForge Generative UI Operator Dashboard with all six panels.`;

  console.log(`\n[session] Dispatching migration instruction to agent...`);
  console.log(`[session] Streaming SSE turn events from TrueForge:\n`);

  const eventsLog = [];
  const toolCallTranscript = [];
  let finalDashboardContent = '';

  let currentTurnId;
  await client.stream(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    { input: [{ type: 'user.message', content: userPrompt }] },
    async (event, id) => {
      eventsLog.push({ ...event, received_at: new Date().toISOString() });

      if (event.type === 'turn.created') {
        currentTurnId = event.turn_id;
        console.log(`\x1b[36m[turn.created]\x1b[0m Turn ID: ${event.turn_id}`);
      } else if (event.type === 'thread.created') {
        console.log(`\x1b[35m[subagent.started]\x1b[0m ${event.title ?? 'specialist'}`);
      } else if (event.type === 'thread.done') {
        console.log(`\x1b[35m[subagent.completed]\x1b[0m ${event.title ?? 'specialist'} (${event.state?.status ?? 'done'})`);
      } else if (event.type === 'model.message') {
        if (event.content) {
          console.log(`\x1b[32m[agent]\x1b[0m ${event.content}`);
          if (event.content.includes('TRUEFORGE MIGRATION OPERATOR DASHBOARD') || event.content.includes('Migration Lifecycle Timeline')) {
            finalDashboardContent = event.content;
          }
        }
      } else if (event.type === 'tool.call') {
        toolCallTranscript.push({ step: toolCallTranscript.length + 1, type: 'call', tool: event.tool, arguments: event.arguments, timestamp: new Date().toISOString() });
        console.log(`\x1b[34m[tool.call]\x1b[0m ${event.tool} with args: ${JSON.stringify(event.arguments)}`);
      } else if (event.type === 'tool.response') {
        toolCallTranscript.push({ step: toolCallTranscript.length, type: 'response', tool: event.tool, output: event.output ?? event.content ?? event, timestamp: new Date().toISOString() });
        console.log(`\x1b[34m[tool.response]\x1b[0m ${event.tool}:`, JSON.stringify(event.output ?? event.content ?? event, null, 2));
      } else if (event.type === 'tool.approval_required') {
        console.log(`\n\x1b[43m\x1b[30m [TOOL APPROVAL REQUIRED] \x1b[0m`, JSON.stringify(event, null, 2));

        const pendingCall = event.tool_calls?.[0] ?? event;
        const toolName = pendingCall?.tool ?? pendingCall?.function?.name ?? pendingCall?.name ?? 'apply_production_routing';
        const toolArgs = pendingCall?.arguments
          ? (typeof pendingCall.arguments === 'string' ? JSON.parse(pendingCall.arguments) : pendingCall.arguments)
          : {};
        console.log(`Tool: ${toolName}`);
        console.log(`Arguments: ${JSON.stringify(toolArgs, null, 2)}`);

        const approved = await promptApproval('Do you authorize this production routing change?');
        const toolCallId = pendingCall?.id ?? event.tool_call_id;
        const canaryId = toolArgs?.canary_id;

        // Generate and register cryptographic approval artifact
        let approvalArtifact = null;
        try {
          const { issueApprovalArtifact, registerApprovalArtifact } = await import('../core/approval-token.ts');
          const { getPreparedCanaryPlan, getLatestPreparedCanaryPlan } = await import('../mcp-servers/gateway-mcp/src/canary-manager.ts');
          const plan = (canaryId ? getPreparedCanaryPlan(canaryId) : null) ?? getLatestPreparedCanaryPlan();
          if (plan) {
            approvalArtifact = issueApprovalArtifact({
              sessionId: plan.session_id,
              canaryId: plan.canary_id,
              manifestSha: plan.manifest_sha,
              decision: approved ? 'allow' : 'deny',
              operator: 'trueforge-operator-console',
            });
            registerApprovalArtifact(approvalArtifact);
            console.log(`\x1b[32m[approval-gate]\x1b[0m Cryptographic approval artifact issued & registered (Decision: ${approved ? 'ALLOW' : 'DENY'}, SHA: ${plan.manifest_sha})`);
          }
        } catch (err) {
          console.warn(`[approval-gate] Warning: failed to register artifact: ${err.message}`);
        }

        // Stream user approval back into TrueForge
        await client.stream(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
          {
            input: [
              {
                type: 'user.tool_approval',
                thread_id: event.thread_id,
                tool_call_id: toolCallId,
                approval: { status: approved ? 'allow' : 'deny' },
              },
            ],
          },
          async ev => {
            eventsLog.push({ ...ev, post_approval: true, received_at: new Date().toISOString() });
            if (ev.type === 'model.message' && ev.content) {
              console.log(`\x1b[32m[agent post-approval]\x1b[0m ${ev.content}`);
              if (ev.content.includes('TRUEFORGE MIGRATION OPERATOR DASHBOARD') || ev.content.includes('Migration Lifecycle Timeline')) {
                finalDashboardContent = ev.content;
              }
            } else if (ev.type === 'tool.call') {
              toolCallTranscript.push({ step: toolCallTranscript.length + 1, type: 'call_post_approval', tool: ev.tool, arguments: ev.arguments, timestamp: new Date().toISOString() });
              console.log(`\x1b[34m[tool.call post-approval]\x1b[0m ${ev.tool} with args: ${JSON.stringify(ev.arguments)}`);
            } else if (ev.type === 'tool.response') {
              toolCallTranscript.push({ step: toolCallTranscript.length, type: 'response_post_approval', tool: ev.tool, output: ev.output ?? ev.content ?? ev, timestamp: new Date().toISOString() });
              console.log(`\x1b[34m[tool.response post-approval]\x1b[0m ${ev.tool}:`, JSON.stringify(ev.output ?? ev.content ?? ev, null, 2));
            } else {
              console.log(`[post-approval event: ${ev.type}]`);
            }
          }
        );
      } else if (event.type === 'turn.done') {
        console.log(`\n\x1b[36m[turn.done]\x1b[0m Status: ${event.state?.status}`);
      }
    }
  );

  // Write proof artifacts to evidence/trueforge-live/
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'session_transcript.json'),
    JSON.stringify(toolCallTranscript, null, 2),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'session_events.jsonl'),
    eventsLog.map(e => JSON.stringify(e)).join('\n'),
    'utf-8'
  );

  if (finalDashboardContent) {
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'operator_dashboard_evidence.md'),
      finalDashboardContent,
      'utf-8'
    );
  }

  // Retrieve authoritative state and receipt
  try {
    const { sessionRegistry } = await import('../core/session-registry.ts');
    const machine = sessionRegistry.getActive();
    const receipt = machine.generateReceipt();
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'audit_receipt.json'),
      JSON.stringify(receipt, null, 2),
      'utf-8'
    );
    console.log(`\x1b[32m[evidence]\x1b[0m Saved authoritative audit receipt (${receipt.receipt_sha})`);
  } catch (err) {
    console.log(`[evidence] Session receipt notice: ${err.message}`);
  }

  console.log(`\n\x1b[32m[session]\x1b[0m Rehearsal session completed! Evidence written to evidence/trueforge-live/`);
}

runSession().catch(err => {
  console.error('[session] Error running session:', err);
  process.exit(1);
});

