# Safe AI Mailroom Agent — starter implementation

This is a working scaffold for the assignment: an Express service exposing one
POST endpoint that handles `propose` and `commit`, with:

- canonical JSON hashing (stable across key order)
- a decision cache keyed by **dossier content**, not evaluationId or dossier id
  alone — so identical dossiers never trigger a second model call, even across
  new evaluationIds or a later Check
- deterministic `callId`s derived from content hash (stable across evaluations)
- SQLite-backed persistence for decisions, evaluations, and receipts (durable
  across restarts — not in-process memory)
- exact-replay handling for both `propose` and `commit`
- HTTP 409 when an `evaluationId` is reused with changed dossier content
- HTTP 400/422 for malformed/duplicate input, before any model or tool call
- an LLM classification step with a prompt-injection-aware system prompt, and
  a dependency-free heuristic fallback so the service runs even with no API key
- schema validation of the model's proposed action/payload before it's ever
  trusted or persisted

It was tested locally end-to-end (propose → replay → conflict → new-eval cache
hit → commit → commit-replay → unknown-evaluation commit) and all paths behave
as expected — see the smoke test output.

## ⚠️ What you MUST fix before submitting

The prompt you gave me had two headers — **"Exact propose request and
response"** and **"Exact commit request and terminal response"** — but the
actual JSON examples under them didn't come through in the text (likely
images or a collapsed block). I built this against the *transcript* and
*prose rules* in the spec, but I had to **guess exact field names** in a few
places. Go back to the assignment page/PDF, get the literal JSON, and fix:

1. **Dossier shape** (`src/canonical.js`, `contentFingerprint`) — I assumed
   `{ id, ...fields }` or `{ id, content: {...} }`. If dossiers nest content
   under a different key, or IDs live somewhere else, fix the `material`
   object there.

2. **Receipt shape** (`src/validate.js` `ReceiptSchema`, and the lookups in
   `src/server.js` `handleCommit`) — I assumed each receipt has
   `evaluationId`, `callId`, `receiptId`, and optionally `proposalDigest` /
   `action` / `approved`. Confirm the real field names.

3. **Receipt verification (the big one)** — the spec says the grader "sends
   an unpredictable receipt" and you must "verify every receipt before
   recording any effect." Right now `handleCommit` in `src/server.js` has a
   `TODO (CRITICAL)` comment where it currently just checks that IDs/digest
   line up — it does **not** cryptographically verify the receipt is
   authentic. You need to find out (from the assignment) whether receipts
   are signed (HMAC/JWT/etc.) and whether a verification key is handed to
   you in the `propose` response's request, or per evaluation, and implement
   that check there. Until you do, this fails "Failure to reject an invalid
   receipt caps the score at 2/4."

4. **The `send_approved_notice` "explicit trusted approval"** — confirm what
   the trusted-approval field actually looks like in a real dossier so the
   model (and your schema in `src/validate.js`) can check it's scoped to the
   exact recipient/template/facts, per the spec's wording.

Search each file for the word `ASSUMPTION` or `TODO` to find every spot that
needs your attention.

## Project layout

```
mailroom-agent/
  src/
    server.js      # the HTTP endpoint: propose + commit handlers
    db.js          # SQLite persistence (decisions, evaluations, receipts)
    canonical.js    # canonical JSON + hashing + deterministic callId
    validate.js     # zod request/action schemas
    llm.js          # model call + prompt + heuristic fallback
    actions.js      # simulated tool-effect execution per action
  test/
    smoke-test.js  # local end-to-end test (no grader needed)
  .env.example
  package.json
```

## Run it locally

```bash
cd mailroom-agent
npm install
cp .env.example .env
# optionally set ANTHROPIC_API_KEY in .env — without it, the heuristic
# fallback classifier runs instead (useful for free testing)
npm start
```

In another terminal:

```bash
node test/smoke-test.js
```

You should see: a 400 on malformed input, matching replayed propose
responses, a 409 on changed content with the same evaluationId, stable
callIds across two different evaluationIds for identical dossiers, executed
commit outcomes, and identical replayed commit outcomes.

## Deploying to get a public HTTPS URL

Any host that gives you (a) a public HTTPS URL and (b) a **persistent disk**
works — persistence matters because your decision cache and receipt log must
survive restarts (replay-safety and "don't repeat a tool effect" both depend
on this). Two easy free/cheap options:

### Option A — Railway (simplest)
1. Push this folder to a GitHub repo.
2. On railway.app, "New Project" → "Deploy from GitHub repo".
3. Add a **Volume**, mount it at e.g. `/data`, and set env var
   `DATA_DIR=/data`.
4. Set `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL` if you want) in the
   Railway environment variables.
5. Railway auto-detects `npm start` and gives you a `*.up.railway.app` HTTPS
   URL — that's your submission URL (root path `/`, no query/fragment).

### Option B — Fly.io
1. `fly launch` in this folder (accept the Node detection).
2. `fly volumes create data --size 1` then mount it at `/data` in
   `fly.toml`, and set `DATA_DIR=/data`.
3. `fly secrets set ANTHROPIC_API_KEY=...`
4. `fly deploy` — you get `https://<app>.fly.dev`.

### Option C — Render
Render's free web services work but their free-tier disks are ephemeral
across deploys/restarts — fine for a first smoke test against the grader,
but for real grading get a paid persistent disk add-on or use Option A/B.

Whatever you pick: **the submitted URL must be the bare HTTPS root** (no
query string, no fragment, no embedded credentials) — e.g.
`https://your-app.up.railway.app/`.

## Notes on cost / model choice

The heuristic fallback in `llm.js` means the service runs (and can be
smoke-tested) for free with zero API calls. When you do set
`ANTHROPIC_API_KEY`, it defaults to a small/cheap model
(`claude-haiku-4-5-20251001`) — swap `ANTHROPIC_MODEL` for whatever the
cheapest capable model is by the time you submit. Caching by content hash
(not evaluationId) means the 64 core dossiers are classified once, ever —
later Checks and Save reuse the same cache entries and make no new model
calls, exactly as the spec asks.

## Security posture already built in

- The LLM is only ever asked to *classify*; it never calls tools directly.
  Only `handleCommit`, after receipt checks pass, calls `executeEffect`.
- The dossier is passed to the model labeled explicitly as untrusted DATA,
  with an instruction not to obey text inside it (see `SYSTEM_PROMPT` in
  `llm.js`) — this is the "external content is data, not instructions"
  requirement from the spec.
- The model's output is schema-validated (`validate.js`) before it's ever
  persisted or acted on; anything that doesn't match a known action schema
  is downgraded to `request_confirmation` rather than trusted blindly.
- Raw dossier text is never echoed into `payload` fields — only whatever
  short evidence/rationale the model chooses to return, capped in length.
