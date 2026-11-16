/**
 * zkverify.mjs — best-effort on-chain proof confirmation.
 *
 * What the platform's build checklist asks for: "Call zkVerifyJS to
 * confirm the proof is on-chain and its VK matches the registered
 * condition VK."
 *
 * Reality check (verified 15 Nov 2026 from this VM):
 *   - Kurier REST API (https://api.kurier.xyz) requires a mainnet API
 *     key, and its job-status endpoint takes a Kurier jobId — it cannot
 *     look up an arbitrary proof_tx from a task envelope.
 *   - zkVerifyJS requires a seed phrase and a tVFY-funded account
 *     (for submission); read-only chain queries need an indexer.
 *   - The public Subscan explorer for zkVerify
 *     (https://zkverify.subscan.io) does NOT expose its API endpoints
 *     (every /api/scan/* call returns 307 -> /404 from this VM).
 *   - No credential-free public endpoint exists to confirm an arbitrary
 *     proof_tx on zkVerify mainnet.
 *
 * So the primary trust anchor is the task envelope itself: the platform
 * HMAC-signs every task, and it only generates a task for a proof it has
 * already verified on-chain. All 7 trap varieties are detectable from
 * the envelope fields (the trap encyclopedia says: "The test is whether
 * your agent checks every field"). The on-chain lookup below is a
 * hardening hook for when a lookup endpoint becomes available.
 *
 * Configuration:
 *   ZKVERIFY_LOOKUP_URL   Optional. A URL template containing {tx}, or a
 *                         base URL to which the proof_tx is appended.
 *                         The endpoint must answer JSON: {"found": true}
 *                         (or {"exists": true} / a non-null "data") for a
 *                         confirmed proof, {"found": false} / HTTP 404
 *                         for a missing one.
 *   ZKVERIFY_LOOKUP_TIMEOUT_MS  Timeout per lookup (default 4000).
 *   ZKVERIFY_STRICT       "true" => if the lookup is unavailable or
 *                         times out, FAIL CLOSED (reject). Default false:
 *                         fall back to the signed-envelope field checks.
 *                         Strict mode is only meaningful once a lookup
 *                         URL is configured; with no lookup configured
 *                         and strict=true the endpoint would reject
 *                         every task, so the server refuses to start in
 *                         that combination (see server.mjs).
 */
export const LOOKUP_REASON_NOT_ON_CHAIN = 'PROOF_NOT_ON_CHAIN';
export const LOOKUP_REASON_UNVERIFIED = 'PROOF_UNVERIFIED';

const timeoutMs = Number(process.env.ZKVERIFY_LOOKUP_TIMEOUT_MS || 4000);

function buildUrl(template, proofTx) {
  if (template.includes('{tx}')) return template.replaceAll('{tx}', encodeURIComponent(proofTx));
  const sep = template.endsWith('/') ? '' : '/';
  return `${template}${sep}${encodeURIComponent(proofTx)}`;
}

/**
 * Attempt to confirm proofTx on-chain.
 * Returns { status: 'confirmed' | 'not_found' | 'unavailable', detail }.
 * Never throws; never takes longer than the configured timeout.
 */
export async function lookupProofOnChain(proofTx) {
  const template = (process.env.ZKVERIFY_LOOKUP_URL || '').trim();
  if (!template) {
    return { status: 'unavailable', detail: 'lookup-not-configured' };
  }
  const url = buildUrl(template, proofTx);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 404) return { status: 'not_found', detail: `HTTP 404 from ${url}` };
    if (!res.ok) return { status: 'unavailable', detail: `HTTP ${res.status} from lookup` };
    let body = null;
    try {
      body = await res.json();
    } catch {
      return { status: 'unavailable', detail: 'lookup returned non-JSON' };
    }
    if (body && (body.found === true || body.exists === true)) {
      return { status: 'confirmed', detail: 'lookup found the proof' };
    }
    if (body && (body.found === false || body.exists === false)) {
      return { status: 'not_found', detail: 'lookup says proof not found' };
    }
    if (body && body.data !== undefined && body.data !== null) {
      return { status: 'confirmed', detail: 'lookup returned data for the proof' };
    }
    return { status: 'unavailable', detail: 'lookup response ambiguous' };
  } catch (err) {
    const detail = err?.name === 'AbortError' ? `lookup timed out after ${timeoutMs}ms` : `lookup error: ${err?.message || err}`;
    return { status: 'unavailable', detail };
  } finally {
    clearTimeout(timer);
  }
}

export function isStrictMode() {
  return (process.env.ZKVERIFY_STRICT || '').trim().toLowerCase() === 'true';
}

export function isLookupConfigured() {
  return Boolean((process.env.ZKVERIFY_LOOKUP_URL || '').trim());
}
