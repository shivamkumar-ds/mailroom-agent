// Plain JSON-file-backed store. No native compilation required (unlike
// better-sqlite3), so this works on any host's free tier without a
// build-tools headache. Good enough for this assignment's scale
// (64-70 core dossiers + a handful of audit ones per Check).
//
// IMPORTANT for deployment: DATA_DIR must point at a PERSISTENT disk/volume,
// not an ephemeral container filesystem, or your decision cache and
// evaluation/receipt state will be lost on every restart/redeploy - which
// will break replay-safety and re-trigger model calls. On Render's free
// tier there is no persistent disk option, so state will reset whenever
// the instance spins down/restarts. That's fine for local testing and
// initial grader smoke-testing, but for a fully durable submission, use a
// host with a persistent volume (see README).
//
// All writes go through a single in-process queue (writeQueue) so
// concurrent requests never corrupt the file, and every write is an
// atomic rename (write to a tmp file, then rename over the real one).

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_PATH = path.join(DATA_DIR, 'store.json');

function emptyState() {
  return { decisions: {}, evaluations: {}, receipts: {} };
}

function loadState() {
  if (!fs.existsSync(STORE_PATH)) return emptyState();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      decisions: parsed.decisions || {},
      evaluations: parsed.evaluations || {},
      receipts: parsed.receipts || {},
    };
  } catch (err) {
    console.error('Failed to read store.json, starting from empty state:', err.message);
    return emptyState();
  }
}

let state = loadState();

// Serialize writes so concurrent requests can't interleave file writes.
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(() => {
    const tmpPath = STORE_PATH + '.tmp';
    return fs.promises
      .writeFile(tmpPath, JSON.stringify(state), 'utf8')
      .then(() => fs.promises.rename(tmpPath, STORE_PATH));
  });
  return writeQueue;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------- decisions (keyed by content hash) ----------------

function getDecision(contentHash) {
  return state.decisions[contentHash] || null;
}

function putDecision(contentHash, dossierId, callId, proposal) {
  if (state.decisions[contentHash]) return; // first write wins, like INSERT OR IGNORE
  state.decisions[contentHash] = {
    dossierId,
    callId,
    proposal,
    createdAt: nowIso(),
  };
  persist();
}

// ---------------- evaluations ----------------

function getEvaluation(evaluationId) {
  return state.evaluations[evaluationId] || null;
}

function putEvaluation(evaluationId, dossierFingerprint, proposals, receiptKey, status) {
  state.evaluations[evaluationId] = {
    dossierFingerprint,
    proposals,
    receiptKey: receiptKey || null,
    status,
    createdAt: nowIso(),
  };
  persist();
}

// ---------------- receipts ----------------

function getReceipt(receiptId) {
  return state.receipts[receiptId] || null;
}

function putReceipt(receiptId, evaluationId, callId, outcome, effectExecuted) {
  if (state.receipts[receiptId]) return; // first write wins
  state.receipts[receiptId] = {
    evaluationId,
    callId,
    outcome,
    effectExecuted: !!effectExecuted,
    createdAt: nowIso(),
  };
  persist();
}

module.exports = {
  getDecision,
  putDecision,
  getEvaluation,
  putEvaluation,
  getReceipt,
  putReceipt,
};
