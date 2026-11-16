/**
 * core.mjs — shared task-handling logic for the gatekeeper.
 *
 * Used by both the long-running server (server.mjs) and the Vercel
 * serverless entry (api/index.mjs), so the decision path is identical
 * in every deployment.
 *
 * handleTask(headers, rawBody) -> { status, body }
 *   - headers: the request headers object (for x-agent-games-signature)
 *   - rawBody: the raw request body as a Buffer (HMAC is over raw bytes)
 *   - returns a plain object body; the caller serializes it and signs
 *     it with the HMAC secret before sending.
 */
import { decide } from './gatekeeper.mjs';
import { verifySignature } from './hmac.mjs';
import {
  lookupProofOnChain,
  isStrictMode,
  isLookupConfigured,
  LOOKUP_REASON_NOT_ON_CHAIN,
  LOOKUP_REASON_UNVERIFIED,
} from './zkverify.mjs';

const GATEKEEPER_TYPE = 'agent-games.proof-gatekeeper.v1';
const PREFLIGHT_TYPE = 'agent-games.preflight.v1';

export function createCore({ secretBuf, store }) {
  const strictMode = isStrictMode();
  const lookupConfigured = isLookupConfigured();

  function log(obj) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
  }

  async function handleTask(headers, rawBody) {
    const started = Date.now();

    // 1. HMAC verification over the RAW body, before parsing.
    if (secretBuf) {
      const sig = headers['x-agent-games-signature'];
      const check = verifySignature(secretBuf, rawBody, sig);
      if (!check.ok) {
        log({ event: 'task-rejected', reason: check.reason });
        return { status: 401, body: { error: 'invalid signature' } };
      }
    }

    // 2. Parse + validate envelope.
    let env;
    try {
      env = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log({ event: 'task-rejected', reason: 'invalid-json' });
      return { status: 400, body: { error: 'invalid JSON' } };
    }

    // Preflight: the platform's signed reachability probe. It carries no
    // task_id/input, so answer it right after parsing, before the
    // task-envelope validation below.
    if (env && typeof env === 'object' && env.type === PREFLIGHT_TYPE) {
      log({ event: 'preflight-ok' });
      return { status: 200, body: { ok: true, protocolVersion: 'v1' } };
    }

    if (!env || typeof env !== 'object' || typeof env.task_id !== 'string' || !env.task_id) {
      log({ event: 'task-rejected', reason: 'missing-task-id' });
      return { status: 400, body: { error: 'missing task_id' } };
    }
    if (env.type && env.type !== GATEKEEPER_TYPE) {
      // This endpoint serves Proof Gatekeeper only. Steal the VFY /
      // Wildcard use different envelopes and are a follow-up.
      log({ event: 'task-rejected', reason: 'unsupported-type', type: env.type, task_id: env.task_id });
      return { status: 400, body: { error: `unsupported task type: ${env.type}` } };
    }
    if (!env.input || typeof env.input !== 'object') {
      log({ event: 'task-rejected', reason: 'missing-input', task_id: env.task_id });
      return { status: 400, body: { error: 'missing input' } };
    }

    const taskId = env.task_id;
    const mode = env.mode || 'unknown';

    // 3. Idempotency: return the stored response verbatim on retry.
    const stored = store.getResponse(taskId);
    if (stored) {
      log({ event: 'task-duplicate', task_id: taskId, mode, ms: Date.now() - started });
      return { status: 200, body: stored };
    }

    // 4. Optional on-chain lookup (only when configured).
    const proofTx = typeof env.input.proof_tx === 'string' ? env.input.proof_tx : '';
    if (lookupConfigured && proofTx) {
      const lookup = await lookupProofOnChain(proofTx);
      if (lookup.status === 'not_found') {
        const response = { decision: 'REJECT', reason_code: LOOKUP_REASON_NOT_ON_CHAIN, proof_tx: proofTx };
        store.putResponse(taskId, response);
        log({ event: 'task-decided', task_id: taskId, mode, ...response, lookup: lookup.detail, ms: Date.now() - started });
        return { status: 200, body: response };
      }
      if (lookup.status === 'unavailable' && strictMode) {
        const response = { decision: 'REJECT', reason_code: LOOKUP_REASON_UNVERIFIED, proof_tx: proofTx };
        store.putResponse(taskId, response);
        log({ event: 'task-decided', task_id: taskId, mode, ...response, lookup: lookup.detail, ms: Date.now() - started });
        return { status: 200, body: response };
      }
      // 'confirmed' or (unavailable + not strict): proceed to field checks.
    }

    // 5. Decide (all 7 trap checks).
    const response = decide(env.input, store.seenProofs);
    // 6. Persist: record the response; on APPROVE, remember the proof ref.
    if (response.decision === 'APPROVE' && response.proof_tx) {
      store.markProofSeen(response.proof_tx);
    }
    store.putResponse(taskId, response);

    log({ event: 'task-decided', task_id: taskId, mode, ...response, ms: Date.now() - started });
    return { status: 200, body: response };
  }

  function healthPayload() {
    return {
      status: 'ok',
      service: 'agentgames-gatekeeper',
      version: '1.0.0',
      hmac: secretBuf ? 'enforced' : 'disabled-dev-mode',
      store: store.stats(),
      time: new Date().toISOString(),
    };
  }

  return { handleTask, healthPayload, strictMode, lookupConfigured };
}
