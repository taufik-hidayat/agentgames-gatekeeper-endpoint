/**
 * hmac.mjs — HMAC-SHA256 signing / verification for Agent Games.
 *
 * The platform sends every task with an `x-agent-games-signature` header:
 * an HMAC over the RAW request body, keyed with the 32-byte secret issued
 * at agent registration. Responses must be signed the same way.
 * The secret is read from AGENT_GAMES_HMAC_SECRET (never hardcoded).
 * Accepted secret formats:
 *   - 64 hex chars  -> 32 raw bytes (most likely platform format)
 *   - 44-char base64 (with trailing =) -> 32 raw bytes
 *   - anything else -> UTF-8 bytes of the string as given
 *
 * Accepted signature header formats (the platform does not document the
 * exact wire format, so we accept the common ones):
 *   - bare lowercase/uppercase hex
 *   - "sha256=<hex>"
 *   - "v1=<hex>" (including Stripe-style "t=<ts>,v1=<hex>")
 *   - base64 of the raw HMAC bytes
 *
 * Key encodings: the platform displays the secret as a 64-char hex string.
 * It may key the HMAC with the decoded 32 raw bytes OR with the UTF-8
 * bytes of the hex string itself, so verification tries both.
 */

import crypto from 'node:crypto';

/** Parse the secret env value into a Buffer of key bytes. Returns null if unset/empty. */
export function parseSecret(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(v)) return Buffer.from(v, 'base64');
  return Buffer.from(v, 'utf8');
}

/** HMAC-SHA256 of a raw Buffer, returned as lowercase hex. */
export function hmacHex(secretBuf, rawBodyBuf) {
  return crypto.createHmac('sha256', secretBuf).update(rawBodyBuf).digest('hex');
}

/** HMAC-SHA256 of a raw Buffer, returned as base64. */
export function hmacBase64(secretBuf, rawBodyBuf) {
  return crypto.createHmac('sha256', secretBuf).update(rawBodyBuf).digest('base64');
}

/**
 * Verify an incoming signature header against the raw body.
 * Returns { ok: true } or { ok: false, reason }.
 * Uses timingSafeEqual so the comparison does not leak timing info.
 */
export function verifySignature(secretBuf, rawBodyBuf, headerValue) {
  if (!secretBuf) return { ok: false, reason: 'no-secret-configured' };
  if (!headerValue || typeof headerValue !== 'string') {
    return { ok: false, reason: 'missing-signature-header' };
  }
  let h = headerValue.trim();
  // Stripe-style combined header "t=<ts>,v1=<hex>" — extract the v1 value.
  const v1Match = h.match(/(?:^|,)v1=([0-9a-fA-F]{64})(?:,|$)/);
  if (v1Match) h = v1Match[1];
  // Strip a "sha256=" or "v1=" prefix if present.
  const bare = h.replace(/^(?:sha256|v1)=/i, '');

  // Try both key encodings: the decoded 32 raw bytes, and the UTF-8 bytes
  // of the hex string itself (the platform may key with either).
  const keyBuffers = [secretBuf];
  const hexAsUtf8 = Buffer.from(secretBuf.toString('hex'), 'utf8');
  if (!hexAsUtf8.equals(secretBuf)) keyBuffers.push(hexAsUtf8);

  for (const key of keyBuffers) {
    const candidates = [];
    // Hex candidate (the computed digest).
    candidates.push(hmacHex(key, rawBodyBuf));
    // Base64 candidate.
    candidates.push(hmacBase64(key, rawBodyBuf));

    for (const cand of candidates) {
      // Compare case-insensitively for hex.
      if (bare.length === cand.length) {
        const a = Buffer.from(bare.toLowerCase(), 'utf8');
        const b = Buffer.from(cand.toLowerCase(), 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          return { ok: true };
        }
      }
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

/**
 * Sign a raw response body. Returns the bare hex digest.
 * The platform keys its HMAC with the secret as displayed (the 64-char
 * hex string, UTF-8 bytes), so responses are signed with that same key —
 * the UTF-8 bytes of the hex string — not the decoded raw bytes.
 */
export function signResponse(secretBuf, rawBodyBuf) {
  const key = Buffer.from(secretBuf.toString('hex'), 'utf8');
  return hmacHex(key, rawBodyBuf);
}
