/**
 * store.mjs — durable state for the gatekeeper.
 *
 * Two pieces of state must survive restarts:
 *   1. seenProofs: proof_tx values this agent has APPROVED (accepted).
 *      A later task re-using one of these is the PROOF_REUSED trap.
 *      Only APPROVED proofs go in here — a rejected proof was never
 *      accepted, so re-sending it is not "reuse" by the platform's
 *      definition ("already accepted in a previous task").
 *   2. responses: task_id -> the exact response object already returned.
 *      The platform may retry a delivery after a network failure, so a
 *      task_id is an idempotency key: a retry must get the SAME response
 *      verbatim, NOT a fresh evaluation (which would wrongly say
 *      PROOF_REUSED, because the first evaluation already approved it).
 *
 * Persistence: a single JSON file, written atomically (temp file + rename).
 * If the data directory is not writable (e.g. Vercel serverless), the
 * store falls back to in-memory only and logs a clear warning — in that
 * deployment the seen-set survives only while the instance is warm.
 * For a durable seen-set on serverless, plug in Vercel KV / Upstash.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

export class Store {
  constructor(dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.durable = false;
    this.seenProofs = new Set();
    this.responses = new Map();
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw.seenProofs)) this.seenProofs = new Set(raw.seenProofs);
        if (raw.responses && typeof raw.responses === 'object') {
          this.responses = new Map(Object.entries(raw.responses));
        }
      }
      // Prove writability with a probe write.
      this._persist();
      this.durable = true;
    } catch (err) {
      console.warn(
        `[store] WARNING: state is NOT durable (${err.message}). ` +
          'Seen-set and idempotency live in memory only. ' +
          'Set DATA_DIR to a writable path, or use a KV store on serverless.',
      );
      this.durable = false;
    }
  }

  _persist() {
    const payload = JSON.stringify({
      seenProofs: [...this.seenProofs],
      responses: Object.fromEntries(this.responses),
    });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  save() {
    if (!this.durable) return;
    try {
      this._persist();
    } catch (err) {
      console.warn(`[store] WARNING: persist failed (${err.message}); state now memory-only.`);
      this.durable = false;
    }
  }

  hasSeenProof(proofTx) {
    return typeof proofTx === 'string' && proofTx.length > 0 && this.seenProofs.has(proofTx);
  }

  markProofSeen(proofTx) {
    if (typeof proofTx === 'string' && proofTx.length > 0) {
      this.seenProofs.add(proofTx);
      this.save();
    }
  }

  getResponse(taskId) {
    return this.responses.get(taskId);
  }

  putResponse(taskId, response) {
    this.responses.set(taskId, response);
    this.save();
  }

  stats() {
    return { seenProofs: this.seenProofs.size, responses: this.responses.size, durable: this.durable };
  }
}
