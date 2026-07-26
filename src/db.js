const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// IMPORTANT for deployment: this must point at a PERSISTENT volume/disk,
// not an ephemeral container filesystem, or your decision cache and
// evaluation/receipt state will be lost on every restart/redeploy -
// which will break replay-safety and re-trigger model calls.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'mailroom.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS decisions (
  content_hash TEXT PRIMARY KEY,
  dossier_id   TEXT NOT NULL,
  call_id      TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id       TEXT PRIMARY KEY,
  dossier_fingerprint TEXT NOT NULL,
  proposals_json      TEXT NOT NULL,
  receipt_key         TEXT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id      TEXT PRIMARY KEY,
  evaluation_id   TEXT NOT NULL,
  call_id         TEXT NOT NULL,
  outcome_json    TEXT NOT NULL,
  effect_executed INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
`);

module.exports = db;
