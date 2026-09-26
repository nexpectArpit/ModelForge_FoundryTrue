import http from 'node:http';
import { REHEARSAL_TOOLS, handleRehearsalToolCall } from './server.js';

const PORT = Number(process.env.PORT ?? 8951);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', server: 'rehearsal-mcp', port: PORT }));
    return;
  }

  // Standard MCP JSON-RPC / REST Endpoint
  if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');

        // Handle JSON-RPC method dispatch
        if (payload.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'rehearsal-mcp', version: '1.0.0' },
            },
          }));
          return;
        }

        if (payload.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: { tools: REHEARSAL_TOOLS },
          }));
          return;
        }

        if (payload.method === 'tools/call') {
          const { name, arguments: toolArgs } = payload.params ?? {};
          const result = await handleRehearsalToolCall(name, toolArgs ?? {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
              structuredContent: result,
            },
          }));
          return;
        }

        // Direct tool invocation fallback (for easy script access)
        if (payload.tool) {
          const result = await handleRehearsalToolCall(payload.tool, payload.arguments ?? {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unsupported method: ${payload.method}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[rehearsal-mcp] Listening on http://127.0.0.1:${PORT}/mcp`);
});
