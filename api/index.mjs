/**
 * api/index.mjs — Vercel serverless entry for the gatekeeper.
 *
 * Reuses the exact same task logic as the long-running server (core.mjs).
 * Deploy with `vercel deploy` (or `vercel --prod`) from the endpoint dir
 * after connecting the Vercel account; set AGENT_GAMES_HMAC_SECRET in the
 * Vercel project environment variables (never commit it).
 *
 * NOTE on the seen-set: Vercel serverless functions have an ephemeral
 * filesystem, so the file-backed Store falls back to in-memory state
 * (warm instances retain it; cold starts forget it). For a durable
 * seen-set on Vercel, attach Vercel KV / Upstash Redis and swap the
 * Store for a KV-backed one — the Store interface is small
 * (hasSeenProof / markProofSeen / getResponse / putResponse / stats).
 */
import { parseSecret, signResponse } from '../hmac.mjs';
import { Store } from '../store.mjs';
import { createCore } from '../core.mjs';

const secretBuf = parseSecret(process.env.AGENT_GAMES_HMAC_SECRET);
const store = new Store(process.env.DATA_DIR || '/tmp/agentgames-data');
const core = createCore({ secretBuf, store });

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const sendJson = (status, obj, sign = true) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    if (sign && secretBuf) res.setHeader('x-agent-games-signature', signResponse(secretBuf, body));
    res.setHeader('content-type', 'application/json');
    res.status(status).end(body);
  };

  try {
    if (req.method === 'GET') {
      return sendJson(200, core.healthPayload());
    }
    if (req.method === 'POST') {
      const raw = await readRawBody(req);
      const { status, body } = await core.handleTask(req.headers, raw);
      return sendJson(status, body, status === 200);
    }
    return sendJson(404, { error: 'not found' }, false);
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'server-error', error: err?.message || err }));
    return sendJson(500, { error: 'internal error' }, false);
  }
}
