/**
 * hmac.mjs — HMAC-SHA256 signing / verification for Agent Games.
 *
 * The platform sends every task with an `x-agent-games-signature` header:
 * an HMAC over the RAW request body, keyed with the 32-byte secret issued
 * at agent registration. Responses must be signed the same way.
 *
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
 *   - base64 of the raw HMAC bytes
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
  const h = headerValue.trim();
  const candidates = [];
  // Strip a "sha256=" prefix if present.
  const bare = h.replace(/^sha256=/i, '');
  // Hex candidate (the computed digest).
  candidates.push(hmacHex(secretBuf, rawBodyBuf));
  // Base64 candidate.
  candidates.push(hmacBase64(secretBuf, rawBodyBuf));

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
  return { ok: false, reason: 'signature-mismatch' };
}

/** Sign a raw response body. Returns the bare hex digest. */
export function signResponse(secretBuf, rawBodyBuf) {
  return hmacHex(secretBuf, rawBodyBuf);
}
