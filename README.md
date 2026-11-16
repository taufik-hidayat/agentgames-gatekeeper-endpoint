# Agent Games — Proof Gatekeeper endpoint

Public HTTPS agent endpoint for the **Agent Games** tournament (zkVerify),
serving the **Proof Gatekeeper** track. One endpoint, one decision loop:
verify the signed task, check all 7 trap varieties, return a signed
decision — well inside the 60-second deadline.

**Status: code complete and fully tested (29/29 tests pass). NOT YET
DEPLOYED to a public URL — see [Deployment](#deployment) for the blocker
and the two paths to get it live.**

## How it works

```
Platform --POST signed task-->  this endpoint
                                  1. Verify x-agent-games-signature (HMAC-SHA256
                                     over the RAW body, secret from env)
                                  2. Parse + validate the envelope
                                  3. Idempotency: task_id already answered?
                                     -> return the stored response verbatim
                                  4. Optional on-chain lookup (only if
                                     ZKVERIFY_LOOKUP_URL is set)
                                  5. Decide: all 7 trap checks (gatekeeper.mjs)
                                  6. APPROVE -> remember proof_tx in the
                                     durable seen-set (data/state.json)
                                  7. Sign the response (same HMAC secret) and
                                     return {decision, reason_code, proof_tx}
```

### The 7 checks (in order)

| Check | Condition | Result |
|---|---|---|
| `PROOF_REUSED` | `proof_tx` was already APPROVED by this agent | REJECT |
| `VK_SUBSTITUTION` | `proof_vk != registered_vk` (case-insensitive) | REJECT |
| `EXPIRED_CONDITION` | `current_block > expiry_block` | REJECT |
| `RECIPIENT_MISMATCH` | `recipient != condition_recipient` | REJECT |
| `AMOUNT_OVERFLOW` | `amount > max_transfer` (BigInt compare) | REJECT |
| `THRESHOLD_MISMATCH` | `public_balance < minimum` (BigInt compare) | REJECT |
| `VALID_CONDITION` | all of the above pass | APPROVE |

Amounts arrive as decimal strings and are compared with `BigInt`
(no float precision loss). Hex values (VKs, addresses) are compared
case-insensitively.

### Scoring impact

Correct decision: **+12**. Incorrect APPROVE: **−6**. Incorrect REJECT:
**−3**. Timeout: **−2**. A correct decision without a valid Groth16
proof costs an extra **−2** and earns no reliability bonus (+0–5).
See [Missing pieces](#missing-pieces).

## Files

| File | Purpose |
|---|---|
| `server.mjs` | Long-running HTTP server (the production entry point) |
| `core.mjs` | Task-handling logic shared by server + Vercel entry |
| `gatekeeper.mjs` | Decision engine (pure functions, all 7 checks) |
| `hmac.mjs` | HMAC-SHA256 sign/verify (raw body, timing-safe compare) |
| `store.mjs` | Durable seen-set + idempotency store (`data/state.json`) |
| `zkverify.mjs` | Best-effort on-chain lookup hook (see below) |
| `api/index.mjs` | Vercel serverless entry (same logic via `core.mjs`) |
| `test.mjs` | End-to-end test suite (29 checks) |
| `vercel.json` | Vercel function config (30s max duration) |
| `start.sh` | Convenience starter (loads `.env` if present) |

Zero npm dependencies — pure Node.js stdlib (`node:http`, `node:crypto`).
Node >= 18 (tested on Node v24.22.1).

## Run locally

```bash
cd ~/workspace/agentgames/endpoint
cp .env.example .env        # then fill in AGENT_GAMES_HMAC_SECRET
./start.sh                  # or: node server.mjs
# GET  http://localhost:3000/health
# POST http://localhost:3000/   (task endpoint; also /task, /webhook, /agent)
```

Without a secret the server runs in **dev mode**: HMAC verification is
disabled and a loud warning is logged. Never run dev mode in production.

## The HMAC secret

The 32-byte secret is issued **once** when you register the agent on the
Agent Games dashboard (Agent settings → HMAC secret / Rotate Secret).
It is **not** in this repo and **never** will be.

```bash
# .env (never commit this file)
AGENT_GAMES_HMAC_SECRET=<paste the 32-byte secret here>
```

Accepted formats: 64 hex chars (most likely), 44-char base64, or a raw
string. The server accepts the platform's signature header as bare hex,
`sha256=<hex>`, or base64. Responses are signed with the same secret
(`x-agent-games-signature: <hex>` over the raw response body).

**Rotate:** get a new secret from the dashboard, update the env var on
the host, restart. The old secret stops working immediately.

## Deployment

**Current state: NOT deployed.** No public URL exists yet.

What was tried from this VM (15 Nov 2026):

- **Cloudflare quick tunnel (`cloudflared tunnel --url`)** — BLOCKED.
  The VM's egress proxy returns 403 "Your request was blocked" for
  `api.trycloudflare.com`, so no tunnel can be created.
- **Vercel** — the `vercel` tool here is the official Vercel MCP server
  and reports `not_connected`. It needs the user to authorize once:
  **https://agent.meta.ai/connectors/connect/vercel**
  After that, deployment is `vercel deploy` from this directory (the
  `api/index.mjs` entry is ready). This is the recommended path:
  Vercel serverless does not sleep, and cold starts (~1–3s) are well
  inside the 60s deadline.
- **Render / Railway / Fly.io** — no accounts or CLIs on this VM.
  Render free tier works from a GitHub repo, but free web services
  sleep after 15 min of inactivity (the rules page warns this costs
  tasks). Mitigation: a cron pinging the endpoint every 10 min keeps
  it warm.
- **GitHub CLI (`gh`)** — installed but not logged in, so the code
  cannot be pushed to github.com/taufik-hidayat from here yet.

### Deploy to Vercel (recommended, once connected)

```bash
cd ~/workspace/agentgames/endpoint
# 1. User authorizes Vercel once at the connect URL above.
# 2. Then, from this directory:
vercel deploy --prod
# 3. Set the env var in the Vercel dashboard (or CLI):
#    AGENT_GAMES_HMAC_SECRET=<secret from the Agent Games dashboard>
# 4. Note the public URL, e.g. https://agentgames-gatekeeper.vercel.app
```

**Vercel caveat — seen-set durability:** Vercel serverless functions
have an ephemeral filesystem, so `data/state.json` does not persist
across cold starts; the store falls back to in-memory (warm instances
retain it, which covers the 8 tasks of a round that arrive minutes
apart). For a fully durable seen-set on Vercel, attach Vercel KV /
Upstash Redis and swap the `Store` for a KV-backed one (the interface
is small: `hasSeenProof` / `markProofSeen` / `getResponse` /
`putResponse` / `stats`). On a long-running host (Render/Fly/Railway)
the file store is durable as-is.

### Deploy to Render (alternative)

1. Push this directory to a GitHub repo (e.g.
   `github.com/taufik-hidayat/agentgames-gatekeeper`).
2. In Render: New → Web Service → connect the repo → Build command:
   *(none — zero dependencies)* → Start command: `node server.mjs` →
   set `AGENT_GAMES_HMAC_SECRET` in Environment.
3. Keep it warm: a cron job `curl`ing the `/health` URL every 10 min
   (free tier sleeps after 15 min idle).

## Health check

```
GET <public-url>/health   -> 200 {"status":"ok","service":"agentgames-gatekeeper",...}
GET <public-url>/         -> 200 (same payload; the root also answers GET)
```

The platform health-checks the registered endpoint URL. Register the
**root URL** (e.g. `https://agentgames-gatekeeper.vercel.app`) — GET
on `/` returns 200, and POST on `/` accepts tasks.

## Register the endpoint on the Agent Games dashboard

(The user does this — the endpoint is registered to their account.)

1. Deploy the endpoint (above) and confirm `GET <url>/health` returns 200.
2. In the Agent Games dashboard, go to **Agent settings / Register agent**.
3. Paste the public endpoint URL (root URL, no path, no port, `https://`).
4. The platform generates the **32-byte HMAC secret — shown exactly once**.
   Copy it immediately and set it as `AGENT_GAMES_HMAC_SECRET` on the
   host, then restart/redeploy the endpoint.
5. Run the platform's **health check** (it must pass) and complete the
   **signed preflight + at least one practice task** before the next
   scored round.
6. Enter **Proof Gatekeeper** (and later Wildcard / Steal the VFY with
   the same endpoint URL — the endpoint already accepts the gatekeeper
   envelope; Steal the VFY needs its own handler, see below).

## Testing

```bash
npm test        # 29 checks, exit 0 = all pass
```

Covered: `GET /health`; the docs' literal sample payload
(`REJECT / VK_SUBSTITUTION`); all 7 trap varieties with full-length
hashes; `PROOF_REUSED` on a re-sent approved `proof_tx`; idempotency
(same `task_id` retried returns the original APPROVE, not
`PROOF_REUSED`); HMAC enforcement (bad/missing signature → 401);
invalid JSON → 400; response-signature validity; and **persistence
across restart** (seen-set + idempotency survive a server restart).
Decisions take 0–1 ms locally.

## On-chain proof confirmation — design decision (read this)

The build checklist asks for a zkVerifyJS/Kurier call to confirm the
proof is on-chain and its VK matches. Verified 15 Nov 2026 from this VM:

- **Kurier** (`https://api.kurier.xyz`) requires a mainnet API key, and
  its `job-status` endpoint takes a **Kurier jobId** — it cannot look up
  an arbitrary `proof_tx` from a task envelope.
- **zkVerifyJS** requires a seed phrase + a tVFY-funded account.
- The public **Subscan** explorer for zkVerify
  (`https://zkverify.subscan.io`) does not expose its API endpoints
  (every `/api/scan/*` call returns 307 → /404 from this VM).
- **No credential-free public endpoint exists** to confirm an arbitrary
  `proof_tx` on zkVerify mainnet.

Therefore the primary trust anchor is the **task envelope itself**: the
platform HMAC-signs every task, and it only generates a task for a proof
it has already verified on-chain. All 7 trap varieties are detectable
from the envelope fields — the trap encyclopedia states: *"The test is
whether your agent checks every field."* (Note: an on-chain existence
check could not catch `VK_SUBSTITUTION`, `PROOF_REUSED`, or any other
trap anyway — those proofs *are* on-chain and valid; only the field
checks catch them.)

`zkverify.mjs` is a hardening hook for when a lookup becomes available:
set `ZKVERIFY_LOOKUP_URL` to an endpoint that answers
`{"found": true/false}` for a `proof_tx` (use `{tx}` as a placeholder).
A definitive "not found" → REJECT. With `ZKVERIFY_STRICT=true`, a
lookup timeout/unavailable also fails closed (REJECT). **Without a
lookup URL, strict mode refuses to start** — failing closed on a lookup
that can never succeed would reject every valid condition (~50% of
tasks, −3 each) and is strictly worse than trusting the platform's own
signed envelope. If a Kurier API key or an indexer URL is obtained
later, set the env vars and restart — no code change needed.

## Missing pieces (follow-ups, in priority order)

1. **Groth16 proof generation (reliability bonus +0–5, avoids −2/task).**
   A correct decision without a valid proof scores +10 instead of +12.
   Circuit artifacts exist (`/api/circuit-info`: gatekeeper
   `vkHash 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`,
   `gatekeeper.wasm` + `gatekeeper_final.zkey` at
   `agentgames.zkverify.io/circuits/`). **Blocked on information, not
   effort:** the circuit's input signals (private/public) are not
   documented on the pages — the proof cannot be generated without the
   circuit source or an input spec. Needs the circuit's input format
   (or the starter prompt/code from the build page) before implementing
   with `snarkjs`.
2. **Durable seen-set on serverless** (Vercel KV) — see Deployment.
3. **Steal the VFY handler** — different envelope (`matchId`, `turn`,
   game state) and response (`action` + policy proof). The endpoint
   currently returns 400 for non-gatekeeper task types. Needs the
   Steal the VFY envelope spec + the `vfy-policy` circuit
   (`vkHash 0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`).
4. **Kurier API key** (optional hardening) — request a mainnet key at
   `https://api.kurier.xyz/docs` for the lookup hook above.
5. **Uptime watch** — the rules publish uptime history; a missed task
   is forfeited. Once deployed, add a cron that GETs `/health` every
   5–10 min and alerts if it is not 200.

## Round schedule (2026)

Rounds run daily 13–21 Nov, 4:00 PM–2:00 AM IST (17:30–03:30 WIB),
8 tasks per agent per round. Round 03 is 15 Nov; rounds 04–08 are
16–20 Nov. Event registration + submission window opened 16 Nov.
