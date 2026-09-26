export class TrueForgeClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8790',
    token,
    timeoutMs = 600_000,
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    return {
      accept: 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async request(method, pathname, { body, expected = [200], query } = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: this.headers(
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new Error(`${method} ${url.pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!expected.includes(response.status)) {
      throw new Error(`${method} ${url.pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  async stream(pathname, body, onEvent, { maxReconnectAttempts = 2 } = {}) {
    let lastSequenceNumber = 0;
    let turnId;
    let terminalSeen = false;
    const deliveredIds = new Set();

    const consume = async (response, operation) => {
      if (!response.ok || response.body === null) {
        throw new Error(`${operation} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
      }

      let buffer = '';
      const decoder = new TextDecoder();

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.id !== undefined) {
            if (deliveredIds.has(parsed.id)) continue;
            deliveredIds.add(parsed.id);
            lastSequenceNumber = Math.max(lastSequenceNumber, Number(parsed.id));
          }
          if (parsed.data.type === 'turn.created') {
            turnId = String(parsed.data.turn_id);
          }
          if (parsed.data.type === 'turn.done') terminalSeen = true;
          await onEvent(parsed.data, parsed.id);
        }
      }
    };

    const initial = await fetch(new URL(pathname, this.baseUrl), {
      method: 'POST',
      headers: this.headers({
        accept: 'text/event-stream',
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await consume(initial, `POST ${pathname}`);
    return lastSequenceNumber;
  }
}

export function parseSseFrame(frame) {
  let id;
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawVal = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal;
    if (field === 'id') id = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  try {
    return { id, data: JSON.parse(text) };
  } catch {
    return null;
  }
}

export async function findAgentByName(client, name) {
  const page = await client.request('GET', '/api/v1/agents');
  const agents = page.data ?? [];
  return agents.find(a => a.name === name);
}
