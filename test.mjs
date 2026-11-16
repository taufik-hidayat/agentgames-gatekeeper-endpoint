/**
 * test.mjs — end-to-end test for the gatekeeper endpoint.
 *
 * Spawns the real server on a test port with a test HMAC secret, then:
 *   - GET /health -> 200
 *   - The docs' literal sample payload -> REJECT / VK_SUBSTITUTION
 *   - All 7 trap varieties (valid + 6 rejects) with distinct proof_tx
 *   - PROOF_REUSED: re-send an approved proof_tx in a NEW task
 *   - Idempotency: re-send an old task_id -> identical original response
 *   - HMAC: bad signature -> 401, missing signature -> 401
 *   - Response signature: x-agent-games-signature validates over the body
 *
 * Run:  npm test   (or: node test.mjs)
 * Exit 0 = all pass, 1 = any failure.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const TEST_SECRET_HEX = '11'.repeat(32); // 32-byte test secret (hex)
const TEST_SECRET = Buffer.from(TEST_SECRET_HEX, 'hex');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;

const VK_A = '0x' + '7d3a'.repeat(16);
const VK_B = '0x' + 'a4c1'.repeat(16);
const ADDR_1 = '0x' + 'de42'.repeat(10);
const ADDR_2 = '0x' + 'beef'.repeat(10);
const tx = (b) => '0x' + b.repeat(32);

function sign(bodyBuf) {
  return crypto.createHmac('sha256', TEST_SECRET).update(bodyBuf).digest('hex');
}

async function postTask(envelope, { signature = 'valid' } = {}) {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  const headers = { 'content-type': 'application/json' };
  if (signature === 'valid') headers['x-agent-games-signature'] = sign(body);
  if (signature === 'bad') headers['x-agent-games-signature'] = '00'.repeat(32);
  const res = await fetch(`${BASE}/`, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: res.status, json, respSig: res.headers.get('x-agent-games-signature'), rawBody: text };
}

function envelope(taskId, input, mode = 'competition') {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode,
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input,
  };
}

function baseInput(overrides = {}) {
  return {
    registered_vk: VK_A,
    proof_vk: VK_A,
    minimum: '1000',
    public_balance: '1460',
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: ADDR_1,
    condition_recipient: ADDR_1,
    amount: '500',
    max_transfer: '1000',
    proof_tx: tx('aa'),
    ...overrides,
  };
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function waitForHealth(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
  const server = spawn('node', ['server.mjs'], {
    cwd: DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_GAMES_HMAC_SECRET: TEST_SECRET_HEX,
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));

  try {
    console.log('== health ==');
    check('server becomes healthy', await waitForHealth());
    const h = await fetch(`${BASE}/health`);
    const hj = await h.json();
    check('GET /health -> 200 + status ok', h.status === 200 && hj.status === 'ok', JSON.stringify(hj));

    console.log('== docs sample payload ==');
    const sample = {
      type: 'agent-games.proof-gatekeeper.v1',
      task_id: 'gk_24_9d1',
      mode: 'competition',
      issued_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60000).toISOString(),
      input: {
        registered_vk: '0x7d3a...f291',
        proof_vk: '0xa4c1...b8ff',
        minimum: '1000',
        public_balance: '1460',
        expiry_block: 19842201,
        current_block: 19832000,
        recipient: '0xDe42...9f01',
        condition_recipient: '0xDe42...9f01',
        amount: '500',
        max_transfer: '1000',
        proof_tx: '0xa4c1...8ff1',
      },
    };
    const s = await postTask(sample);
    check(
      'docs sample -> REJECT / VK_SUBSTITUTION',
      s.status === 200 && s.json?.decision === 'REJECT' && s.json?.reason_code === 'VK_SUBSTITUTION',
      JSON.stringify(s.json),
    );

    console.log('== the 7 trap varieties ==');
    const cases = [
      ['VALID_CONDITION', baseInput({ proof_tx: tx('aa') }), 'APPROVE', 'VALID_CONDITION'],
      ['VK_SUBSTITUTION', baseInput({ proof_vk: VK_B, proof_tx: tx('bb') }), 'REJECT', 'VK_SUBSTITUTION'],
      ['THRESHOLD_MISMATCH', baseInput({ public_balance: '500', proof_tx: tx('cc') }), 'REJECT', 'THRESHOLD_MISMATCH'],
      ['EXPIRED_CONDITION', baseInput({ current_block: 19843000, proof_tx: tx('dd') }), 'REJECT', 'EXPIRED_CONDITION'],
      ['RECIPIENT_MISMATCH', baseInput({ recipient: ADDR_2, proof_tx: tx('ee') }), 'REJECT', 'RECIPIENT_MISMATCH'],
      ['AMOUNT_OVERFLOW', baseInput({ amount: '1500', proof_tx: tx('ff') }), 'REJECT', 'AMOUNT_OVERFLOW'],
    ];
    for (const [name, input, wantDecision, wantReason] of cases) {
      const r = await postTask(envelope(`t-${name.toLowerCase()}`, input));
      check(
        `${name} -> ${wantDecision}/${wantReason}`,
        r.status === 200 && r.json?.decision === wantDecision && r.json?.reason_code === wantReason,
        JSON.stringify(r.json),
      );
      // Response must echo proof_tx and carry a valid signature.
      check(
        `${name}: proof_tx echoed`,
        r.json?.proof_tx === input.proof_tx,
        JSON.stringify(r.json),
      );
      const expectedSig = crypto.createHmac('sha256', TEST_SECRET).update(Buffer.from(r.rawBody, 'utf8')).digest('hex');
      check(`${name}: response signature valid`, r.respSig === expectedSig, `got ${r.respSig}`);
    }

    console.log('== PROOF_REUSED (new task, approved proof_tx) ==');
    const reused = await postTask(envelope('t-reused-1', baseInput({ proof_tx: tx('aa') })));
    check(
      'approved proof_tx re-sent -> REJECT / PROOF_REUSED',
      reused.status === 200 && reused.json?.decision === 'REJECT' && reused.json?.reason_code === 'PROOF_REUSED',
      JSON.stringify(reused.json),
    );

    console.log('== idempotency (same task_id retried) ==');
    const first = await postTask(envelope('t-valid_condition', baseInput({ proof_tx: tx('aa') })));
    check(
      'retry of approved task_id returns ORIGINAL APPROVE (not PROOF_REUSED)',
      first.status === 200 && first.json?.decision === 'APPROVE' && first.json?.reason_code === 'VALID_CONDITION',
      JSON.stringify(first.json),
    );

    console.log('== HMAC enforcement ==');
    const bad = await postTask(envelope('t-bad-sig', baseInput({ proof_tx: tx('11') })), { signature: 'bad' });
    check('bad signature -> 401', bad.status === 401, `got ${bad.status}`);
    const missing = await postTask(envelope('t-no-sig', baseInput({ proof_tx: tx('22') })), { signature: 'none' });
    check('missing signature -> 401', missing.status === 401, `got ${missing.status}`);
    const badJson = await fetch(`${BASE}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-games-signature': sign(Buffer.from('{not json', 'utf8')) },
      body: '{not json',
    });
    check('invalid JSON (valid HMAC) -> 400', badJson.status === 400, `got ${badJson.status}`);

    console.log('== persistence across restart ==');
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    const server2 = spawn('node', ['server.mjs'], {
      cwd: DIR,
      env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET_HEX, DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server2.stdout.on('data', (d) => process.stdout.write(`[server2] ${d}`));
    server2.stderr.on('data', (d) => process.stdout.write(`[server2:err] ${d}`));
    try {
      check('server restarts and becomes healthy', await waitForHealth());
      const afterRestart = await postTask(envelope('t-reused-2', baseInput({ proof_tx: tx('aa') })));
      check(
        'seen-set survives restart: approved proof_tx still PROOF_REUSED',
        afterRestart.status === 200 && afterRestart.json?.reason_code === 'PROOF_REUSED',
        JSON.stringify(afterRestart.json),
      );
      const retryAfterRestart = await postTask(envelope('t-valid_condition', baseInput({ proof_tx: tx('aa') })));
      check(
        'idempotency survives restart: old task_id still returns APPROVE',
        retryAfterRestart.status === 200 && retryAfterRestart.json?.decision === 'APPROVE',
        JSON.stringify(retryAfterRestart.json),
      );
    } finally {
      server2.kill('SIGTERM');
    }
  } finally {
    try {
      server.kill('SIGTERM');
    } catch { /* already dead */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
