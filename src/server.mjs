import http from 'node:http';
import { ScoreStore } from './store.mjs';

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function difficulty(value) {
  if (value !== 'easy' && value !== 'normal') throw new RequestError(400, 'difficulty must be easy or normal');
  return value;
}

function defeated(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new RequestError(400, 'defeated must be an integer from 0 to 100');
  return value;
}

async function readScore(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Content-Type must be application/json');
  }
  const chunks = [];
  let length = 0;
  if (Number(request.headers['content-length']) > 4096) { request.resume(); throw new RequestError(413, 'Request is too large'); }
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) { request.resume(); throw new RequestError(413, 'Request is too large'); }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Expected a score object');
  if (typeof body.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.runId)) {
    throw new RequestError(400, 'runId must be a UUID v4');
  }
  if (typeof body.name !== 'string') throw new RequestError(400, 'name is required');
  const name = body.name.normalize('NFKC').trim();
  if (!name || [...name].length > 12 || /\p{C}/u.test(name)) {
    throw new RequestError(400, 'name must contain 1 to 12 printable characters');
  }
  if (body.serverId != null && typeof body.serverId !== 'string') throw new RequestError(400, 'serverId must be a string');
  return { runId: body.runId.toLowerCase(), name, difficulty: difficulty(body.difficulty), defeated: defeated(body.defeated), serverId: body.serverId };
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

export function createScoreServer({ databasePath = ':memory:' } = {}) {
  const store = new ScoreStore(databasePath);
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response).catch(error => {
      if (!(error instanceof RequestError)) console.error('Score request failed:', error);
      if (!response.headersSent && !response.destroyed) {
        send(response, error.status ?? 500, { code: 'REQUEST_FAILED', error: error.status ? error.message : 'Score server failed' });
      }
    });
  });
  server.on('close', () => store.close());
  Object.defineProperty(server, 'scoreServerId', { value: store.serverId });
  function send(response, status, body) { json(response, status, { ...body, serverId: store.serverId }); }
  function wrongServer(response) { send(response, 409, { code: 'SERVER_CHANGED', error: 'The score belongs to another score database.' }); }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const expectedServer = request.headers['x-kosen-score-server'];
    if (expectedServer && expectedServer !== store.serverId) { request.resume(); return wrongServer(response); }
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
    if (request.method === 'GET' && ['/api/scores', '/api/scores/qualification'].includes(url.pathname)) {
      const mode = difficulty(url.searchParams.get('difficulty'));
      const entries = store.leaderboard(mode);
      if (url.pathname === '/api/scores') return send(response, 200, { difficulty: mode, entries });
      const raw = url.searchParams.get('defeated');
      if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) throw new RequestError(400, 'defeated must be an integer from 0 to 100');
      return send(response, 200, { difficulty: mode, entries, ...store.qualification(mode, defeated(Number(raw))) });
    }
    if (request.method === 'POST' && url.pathname === '/api/scores') {
      const score = await readScore(request);
      if (score.serverId && score.serverId !== store.serverId) return wrongServer(response);
      const { status, ...result } = store.register(score);
      return send(response, status, result);
    }
    send(response, 404, { code: 'NOT_FOUND', error: 'Not found' });
  }
  return server;
}
