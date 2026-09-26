import http from 'node:http';
import { config, getConfig } from './config.js';
import { processChat } from './agent.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Health check endpoint
  if (req.method === 'GET' && url.pathname === '/health') {
    const current = getConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      app: 'customer-support-app',
      active_model: current.active_model,
      routing_mode: current.routing_mode,
      uptime_seconds: process.uptime(),
    }));
    return;
  }

  // Chat completion endpoint (supports /, /chat, /api/chat)
  if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname === '/' || url.pathname === '/chat')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const message = payload.message ?? payload.prompt ?? payload.input ?? '';
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message or prompt field is required' }));
          return;
        }

        const task = payload.task ?? payload.category;
        const result = await processChat({ ...payload, message, task });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const port = config.port;
server.listen(port, '127.0.0.1', () => {
  console.log(`[customer-support-app] Running on http://127.0.0.1:${port} (Model: ${config.active_model}, Mode: ${config.routing_mode})`);
});

// Graceful termination
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
