import readline from 'node:readline';
import { TrueForgeClient, findAgentByName } from '../agent/trueforge-client.mjs';
import { AGENT_NAME } from '../agent/definition.mjs';

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
const token = process.env.TRUEFORGE_TOKEN;
const client = new TrueForgeClient({ baseUrl, token });

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
  console.log(`[session] Connecting to TrueForge Harness at ${baseUrl}...`);
  const agent = await findAgentByName(client, AGENT_NAME);
  if (!agent) {
    console.error(`[session] Agent "${AGENT_NAME}" not found. Run "pnpm modelforge:bootstrap" first.`);
    process.exit(1);
  }

  console.log(`[session] Creating durable session for agent "${AGENT_NAME}"...`);
  const sessionResp = await client.request('POST', '/api/v1/sessions', {
    body: { agent: { name: AGENT_NAME } },
    expected: [200, 201],
  });
  const sessionId = sessionResp.data.id;
  console.log(`[session] Session opened: ${sessionId}`);

  const userPrompt = `Please inspect the application at "demo-apps/customer-support-app", stage candidate model "model-b" into the sandbox, evaluate against the benchmark suite, diagnose any regressions, stage a hybrid routing remediation if needed, re-test, prepare a canary plan, and request human approval to deploy to production.`;

  console.log(`\n[session] Dispatching migration instruction to agent...`);
  console.log(`[session] Streaming SSE turn events from TrueForge:\n`);

  let currentTurnId;
  await client.stream(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    { input: [{ type: 'user.message', content: userPrompt }] },
    async (event, id) => {
      if (event.type === 'turn.created') {
        currentTurnId = event.turn_id;
        console.log(`\x1b[36m[turn.created]\x1b[0m Turn ID: ${event.turn_id}`);
      } else if (event.type === 'thread.created') {
        console.log(`\x1b[35m[subagent.started]\x1b[0m ${event.title ?? 'specialist'}`);
      } else if (event.type === 'thread.done') {
        console.log(`\x1b[35m[subagent.completed]\x1b[0m ${event.title ?? 'specialist'} (${event.state?.status ?? 'done'})`);
      } else if (event.type === 'model.message') {
        if (event.content) console.log(`\x1b[32m[agent]\x1b[0m ${event.content}`);
      } else if (event.type === 'tool.call') {
        console.log(`\x1b[34m[tool.call]\x1b[0m ${event.tool} with args: ${JSON.stringify(event.arguments)}`);
      } else if (event.type === 'tool.response') {
        console.log(`\x1b[34m[tool.response]\x1b[0m ${event.tool} returned output`);
      } else if (event.type === 'tool.approval_required') {
        console.log(`\n\x1b[43m\x1b[30m [TOOL APPROVAL REQUIRED] \x1b[0m`);
        console.log(`Tool: ${event.tool_calls?.[0]?.tool}`);
        console.log(`Arguments: ${JSON.stringify(event.tool_calls?.[0]?.arguments, null, 2)}`);

        const approved = await promptApproval('Do you authorize this production routing change?');
        const pendingCall = event.tool_calls?.[0];
        const canaryId = pendingCall?.arguments?.canary_id;

        // Generate and register cryptographic approval artifact
        try {
          const { issueApprovalArtifact, registerApprovalArtifact } = await import('../core/approval-token.js');
          const { getPreparedCanaryPlan } = await import('../mcp-servers/gateway-mcp/src/canary-manager.js');
          const plan = getPreparedCanaryPlan(canaryId);
          if (plan) {
            const artifact = issueApprovalArtifact({
              sessionId,
              canaryId,
              manifestSha: plan.manifest_sha,
              decision: approved ? 'allow' : 'deny',
              operator: 'trueforge-operator-console',
            });
            registerApprovalArtifact(artifact);
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
                tool_call_id: pendingCall.id,
                approval: { status: approved ? 'allow' : 'deny' },
              },
            ],
          },
          async ev => {
            if (ev.type === 'model.message' && ev.content) {
              console.log(`\x1b[32m[agent post-approval]\x1b[0m ${ev.content}`);
            }
          }
        );
      } else if (event.type === 'turn.done') {
        console.log(`\n\x1b[36m[turn.done]\x1b[0m Status: ${event.state?.status}`);
      }
    }
  );

  console.log(`\n[session] Session execution completed. Persisted audit available in TrueForge.`);
}

runSession().catch(err => {
  console.error('[session] Error running session:', err);
  process.exit(1);
});
