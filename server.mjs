/**
 * server.mjs — Agent Games Proof Gatekeeper endpoint (long-running server).
 *
 * Zero-dependency Node.js HTTP server. All task logic lives in core.mjs
 * (shared with the Vercel serverless entry in api/index.mjs).
 *
 * Routes:
 *   GET  /  /health  -> 200 {"status":"ok", ...}  (platform health check)
 *   POST /  /task  /webhook  /agent  /api/task  -> signed task decision
 *
 * Env:
 *   PORT                      default 3000
 *   AGENT_GAMES_HMAC_SECRET   32-byte secret from agent registration
 *                             (hex 64 chars, base64, or raw string).
 *                             If unset, HMAC verification is SKIPPED and
 *                             a loud warning is logged (dev/test mode).
 *   DATA_DIR                  where state.json lives (default ./data)
 *   ZKVERIFY_LOOKUP_URL       optional on-chain lookup endpoint (see zkverify.mjs)
 *   ZKVERIFY_STRICT           "true" => fail closed on lookup failure
 *   BODY_LIMIT_BYTES          default 1048576 (1 MB)
 */
import http from 'node:http';
import { parseSecret, signResponse } from './hmac.mjs';
import { Store } from './store.mjs';
import { createCore } from './core.mjs';
import { isLookupConfigured, isStrictMode } from './zkverify.mjs';

const PORT = Number(process.env.PORT || 3000);
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES || 1048576);

const secretBuf = parseSecret(process.env.AGENT_GAMES_HMAC_SECRET);

if (!secretBuf) {
  console.warn(
    '[security] WARNING: AGENT_GAMES_HMAC_SECRET is not set. ' +
      'HMAC verification is DISABLED (dev/test mode). ' +
      'Set the secret from agent registration before going live — ' +
      'anyone could otherwise forge tasks.',
  );
}
if (isStrictMode() && !isLookupConfigured()) {
  console.error(
    '[config] FATAL: ZKVERIFY_STRICT=true but ZKVERIFY_LOOKUP_URL is not set. ' +
      'Strict mode with no lookup would reject EVERY task. ' +
      'Either set ZKVERIFY_LOOKUP_URL or unset ZKVERIFY_STRICT.',
  );
  process.exit(1);
}

const store = new Store();
const core = createCore({ secretBuf, store });
console.log(
  `[boot] gatekeeper up. hmac=${secretBuf ? 'enforced' : 'DISABLED (dev)'} ` +
    `lookup=${core.lookupConfigured ? 'configured' : 'not-configured'} strict=${core.strictMode} ` +
    `store=${JSON.stringify(store.stats())}`,
);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, sign = true) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = { 'content-type': 'application/json' };
  if (sign && secretBuf) {
    headers['x-agent-games-signature'] = signResponse(secretBuf, body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

const TASK_PATHS = new Set(['/', '/task', '/webhook', '/agent', '/api/task']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return sendJson(res, 200, core.healthPayload());
    }
    if (req.method === 'POST' && TASK_PATHS.has(url.pathname)) {
      let raw;
      try {
        raw = await readRawBody(req);
      } catch {
        return sendJson(res, 413, { error: 'body too large or unreadable' }, false);
      }
      const { status, body } = await core.handleTask(req.headers, raw);
      // Sign every task response (200s); error responses (401/400) are
      // not signed, matching the platform's expectation that only real
      // decisions carry the agent signature.
      return sendJson(res, status, body, status === 200);
    }
    return sendJson(res, 404, { error: 'not found' }, false);
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'server-error', error: err?.message || err }));
    if (!res.headersSent) return sendJson(res, 500, { error: 'internal error' }, false);
    return res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] listening on 0.0.0.0:${PORT} — GET /health, POST / (task)`);
});
