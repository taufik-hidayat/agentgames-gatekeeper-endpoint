/**
 * gatekeeper.mjs — Proof Gatekeeper decision engine.
 *
 * Pure functions over the task envelope. No I/O, no network — so the
 * decision is deterministic and fast (well inside the 60s deadline).
 *
 * Task envelope (from https://agentgames.zkverify.io/events/proof-gatekeeper):
 *   {
 *     "type": "agent-games.proof-gatekeeper.v1",
 *     "task_id": "gk_24_9d1",
 *     "mode": "competition" | "practice",
 *     "issued_at": "...", "deadline_at": "...",
 *     "input": {
 *       "registered_vk": "0x...", "proof_vk": "0x...",
 *       "minimum": "1000", "public_balance": "1460",
 *       "expiry_block": 19842201, "current_block": 19832000,
 *       "recipient": "0x...", "condition_recipient": "0x...",
 *       "amount": "500", "max_transfer": "1000",
 *       "proof_tx": "0x..."
 *     }
 *   }
 *
 * Response: { "decision": "APPROVE"|"REJECT", "reason_code": "<trap>", "proof_tx": "0x..." }
 *
 * The 7 trap varieties (each task carries at most one trap; ~50% are valid):
 *   VALID_CONDITION    -> APPROVE  (proof on-chain, VK matches, balance >=
 *                                    minimum, proof ref never seen before)
 *   VK_SUBSTITUTION    -> REJECT   (proof_vk != registered_vk)
 *   THRESHOLD_MISMATCH -> REJECT   (public_balance < minimum)
 *   PROOF_REUSED       -> REJECT   (proof_tx already accepted before)
 *   EXPIRED_CONDITION  -> REJECT   (current_block > expiry_block)
 *   RECIPIENT_MISMATCH -> REJECT   (recipient != condition_recipient)
 *   AMOUNT_OVERFLOW    -> REJECT   (amount > max_transfer)
 *
 * Check order: PROOF_REUSED first (a property of the proof reference
 * itself), then VK, expiry, recipient, amount, threshold. Since each
 * task carries a single trap, order only matters for hypothetical
 * multi-trap tasks; the order above rejects on the most fundamental
 * violation first.
 *
 * Amounts are compared with BigInt (they arrive as decimal strings and
 * may exceed Number.MAX_SAFE_INTEGER). Block heights are plain numbers.
 * Hex values (VKs, addresses) are compared case-insensitively.
 */

export const REASON = {
  VALID: 'VALID_CONDITION',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  PROOF_REUSED: 'PROOF_REUSED',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  // Defensive fallbacks (not platform trap names; used only when the
  // envelope itself is missing the field a check needs).
  INVALID_TASK: 'INVALID_TASK',
};

function normHex(v) {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/^0x/, '');
}

function normAddr(v) {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase();
}

/** Parse a decimal-string / number amount into BigInt; null if unparsable. */
function toBigInt(v) {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  } catch {
    return null;
  }
}

function toBlockNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Decide a task. `input` is the envelope's `input` object, `seenProofs`
 * is a Set-like with .has(proofTx) of previously APPROVED proof refs.
 * Returns { decision, reason_code, proof_tx }.
 */
export function decide(input, seenProofs) {
  const proofTx = typeof input?.proof_tx === 'string' ? input.proof_tx : '';

  const reject = (reason) => ({ decision: 'REJECT', reason_code: reason, proof_tx: proofTx });

  if (!input || typeof input !== 'object') return reject(REASON.INVALID_TASK);
  if (!proofTx) return reject(REASON.INVALID_TASK);

  // 1. PROOF_REUSED — this proof reference was already accepted before.
  if (seenProofs && typeof seenProofs.has === 'function' && seenProofs.has(proofTx)) {
    return reject(REASON.PROOF_REUSED);
  }

  // 2. VK_SUBSTITUTION — the proof's VK must match the registered condition VK.
  // Missing either VK means the proof cannot be tied to the condition: fail closed.
  const registeredVk = normHex(input.registered_vk);
  const proofVk = normHex(input.proof_vk);
  if (!registeredVk || !proofVk || registeredVk !== proofVk) {
    return reject(REASON.VK_SUBSTITUTION);
  }

  // 3. EXPIRED_CONDITION — the payment window must still be open.
  // Missing block heights means expiry cannot be confirmed: fail closed.
  const expiry = toBlockNumber(input.expiry_block);
  const current = toBlockNumber(input.current_block);
  if (expiry === null || current === null || current > expiry) {
    return reject(REASON.EXPIRED_CONDITION);
  }

  // 4. RECIPIENT_MISMATCH — the payment must go to the condition's recipient.
  const recipient = normAddr(input.recipient);
  const conditionRecipient = normAddr(input.condition_recipient);
  if (!recipient || !conditionRecipient || recipient !== conditionRecipient) {
    return reject(REASON.RECIPIENT_MISMATCH);
  }

  // 5. AMOUNT_OVERFLOW — the payment must not exceed the single-transfer cap.
  const amount = toBigInt(input.amount);
  const maxTransfer = toBigInt(input.max_transfer);
  if (amount === null || maxTransfer === null || amount > maxTransfer) {
    return reject(REASON.AMOUNT_OVERFLOW);
  }

  // 6. THRESHOLD_MISMATCH — the disclosed public balance must meet the minimum.
  const balance = toBigInt(input.public_balance);
  const minimum = toBigInt(input.minimum);
  if (balance === null || minimum === null || balance < minimum) {
    return reject(REASON.THRESHOLD_MISMATCH);
  }

  // 7. All checks pass: valid condition.
  return { decision: 'APPROVE', reason_code: REASON.VALID, proof_tx: proofTx };
}
