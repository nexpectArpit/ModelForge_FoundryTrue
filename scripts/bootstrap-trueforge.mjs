import { TrueForgeClient, findAgentByName } from '../agent/trueforge-client.mjs';
import {
  AGENT_NAME,
  DEFAULT_MODEL_NAME,
  REHEARSAL_MCP_SERVER_NAME,
  GATEWAY_MCP_SERVER_NAME,
  buildAgentManifest,
} from '../agent/definition.mjs';

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
const token = process.env.TRUEFORGE_TOKEN;
const client = new TrueForgeClient({ baseUrl, token, timeoutMs: 30000 });

async function upsertMcpConnector(name, url, description) {
  console.log(`[bootstrap] Registering MCP connector: ${name} -> ${url}`);
  return client.request(
    'PUT',
    '/api/v1/settings/mcp-servers',
    {
      body: {
        manifest: {
          type: 'remote',
          name,
          url,
          description,
        },
      },
      expected: [200, 201],
    }
  );
}

async function upsertAgent() {
  console.log(`[bootstrap] Registering agent: ${AGENT_NAME}`);
  const existing = await findAgentByName(client, AGENT_NAME);
  const manifest = buildAgentManifest();

  const description =
    'Autonomous AI model migration rehearsal agent with empirical differential verification and human approval gate.';

  if (!existing) {
    return client.request('POST', '/api/v1/agents', {
      body: { name: AGENT_NAME, description, manifest },
      expected: [200, 201],
    });
  }

  return client.request('PUT', `/api/v1/agents/${encodeURIComponent(existing.id)}`, {
    body: { description, manifest },
    expected: [200],
  });
}

async function main() {
  console.log(`[bootstrap] Connecting to TrueForge at ${baseUrl}...`);
  try {
    const health = await client.request('GET', '/api/v1/openapi.json', { expected: [200] });
    console.log(`[bootstrap] TrueForge is running! API Version: ${health.info?.version ?? '0.2.1'}`);
  } catch (err) {
    console.error(`[bootstrap] Could not connect to TrueForge at ${baseUrl}. Ensure "npx @truefoundry/trueforge" is running.`);
    process.exit(1);
  }

  // Register MCP Servers
  await upsertMcpConnector(
    REHEARSAL_MCP_SERVER_NAME,
    process.env.REHEARSAL_MCP_URL ?? 'http://127.0.0.1:8951/mcp',
    'Repository inspection, sandbox app execution, and deterministic benchmark evaluation.'
  );

  await upsertMcpConnector(
    GATEWAY_MCP_SERVER_NAME,
    process.env.GATEWAY_MCP_URL ?? 'http://127.0.0.1:8952/mcp',
    'Privileged production gateway canary preparation, approval-gated rollout, and routing verification.'
  );

  // Register Agent
  const agent = await upsertAgent();
  console.log(`[bootstrap] Agent registered successfully! ID: ${agent.data?.id ?? 'active'}`);
  console.log(`[bootstrap] ModelForge is fully bootstrapped and ready.`);
}

main().catch(err => {
  console.error('[bootstrap] Fatal error:', err);
  process.exit(1);
});
