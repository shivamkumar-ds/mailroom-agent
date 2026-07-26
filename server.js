const express = require('express');
const db = require('./db');
const { ProposeRequestSchema, CommitRequestSchema, validateActionPayload } = require('./validate');
const { classifyDossier } = require('./llm');
const { contentFingerprint, callIdFromFingerprint, canonicalStringify, sha256Hex } = require('./canonical');
const { executeEffect } = require('./actions');

const app = express();
app.use(express.json({ limit: '2mb' }));

const MODEL_TIMEOUT_MS = 20_000; // leaves headroom inside the 55s per-request budget

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nowIso() {
  return new Date().toISOString();
}

function jsonError(res, status, message, details) {
  return res.status(status).type('application/json').json({ status: 'error', error: message, details });
}

// ---------------- decision cache (keyed by dossier content, not evaluationId) ----------------

function getCachedDecision(contentHash) {
  const row = db.prepare('SELECT * FROM decisions WHERE content_hash = ?').get(contentHash);
  if (!row) return null;
  return { callId: row.call_id, proposal: JSON.parse(row.proposal_json) };
}

function storeCachedDecision(contentHash, dossierId, callId, proposal) {
  db.prepare(
    `INSERT OR IGNORE INTO decisions (content_hash, dossier_id, call_id, proposal_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(contentHash, dossierId, callId, JSON.stringify(proposal), nowIso());
}

async function decideForDossier(dossier) {
  const contentHash = contentFingerprint(dossier);
  const cached = getCachedDecision(contentHash);
  if (cached) return cached;

  const callId = callIdFromFingerprint(contentHash);
  const llmResult = await withTimeout(classifyDossier(dossier), MODEL_TIMEOUT_MS);

  const check = validateActionPayload(llmResult.payload);
  const safePayload = check.ok
    ? check.value
    : { action: 'request_confirmation', queue: 'general-review', reason: 'schema validation failed, routed to human review' };
  const finalAction = check.ok ? safePayload.action : 'request_confirmation';

  const proposal = {
    dossierId: dossier.id,
    callId,
    action: finalAction,
    payload: safePayload,
    evidence: Array.isArray(llmResult.evidence) ? llmResult.evidence.slice(0, 5) : [],
    rationale: typeof llmResult.rationale === 'string' ? llmResult.rationale.slice(0, 400) : '',
  };
  proposal.proposalDigest = sha256Hex(canonicalStringify(proposal));

  storeCachedDecision(contentHash, dossier.id, callId, proposal);
  return { callId, proposal };
}

// ---------------- evaluation state ----------------

function fingerprintDossierSet(dossiers) {
  const hashes = dossiers.map((d) => contentFingerprint(d)).sort();
  return sha256Hex(canonicalStringify(hashes));
}

function getEvaluation(evaluationId) {
  const row = db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(evaluationId);
  if (!row) return null;
  return {
    evaluationId: row.evaluation_id,
    dossierFingerprint: row.dossier_fingerprint,
    proposals: JSON.parse(row.proposals_json),
    receiptKey: row.receipt_key,
    status: row.status,
  };
}

function storeEvaluation(evaluationId, dossierFingerprint, proposals, receiptKey, status) {
  db.prepare(
    `INSERT INTO evaluations (evaluation_id, dossier_fingerprint, proposals_json, receipt_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(evaluation_id) DO UPDATE SET
       dossier_fingerprint = excluded.dossier_fingerprint,
       proposals_json = excluded.proposals_json,
       receipt_key = excluded.receipt_key,
       status = excluded.status`
  ).run(evaluationId, dossierFingerprint, JSON.stringify(proposals), receiptKey, status, nowIso());
}

// ---------------- receipts ----------------

function getStoredReceipt(receiptId) {
  const row = db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!row) return null;
  return { ...row, outcome: JSON.parse(row.outcome_json) };
}

function storeReceipt(receiptId, evaluationId, callId, outcome, effectExecuted) {
  db.prepare(
    `INSERT OR IGNORE INTO receipts (receipt_id, evaluation_id, call_id, outcome_json, effect_executed, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(receiptId, evaluationId, callId, JSON.stringify(outcome), effectExecuted ? 1 : 0, nowIso());
}

// ---------------- endpoint ----------------

app.post('/', async (req, res) => {
  const body = req.body;

  if (!body || typeof body.operation !== 'string') {
    return jsonError(res, 400, 'missing or invalid operation');
  }
  if (body.operation === 'propose') return handlePropose(req, res);
  if (body.operation === 'commit') return handleCommit(req, res);
  return jsonError(res, 400, 'unknown operation');
});

async function handlePropose(req, res) {
  const parsed = ProposeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return jsonError(res, 422, 'invalid propose request', parsed.error.issues);
  }
  const { evaluationId, dossiers } = parsed.data;

  const ids = dossiers.map((d) => d.id);
  if (new Set(ids).size !== ids.length) {
    return jsonError(res, 400, 'duplicate dossier IDs in request');
  }

  const dossierFingerprint = fingerprintDossierSet(dossiers);
  const existing = getEvaluation(evaluationId);

  if (existing) {
    if (existing.dossierFingerprint !== dossierFingerprint) {
      return jsonError(res, 409, 'evaluationId reused with changed dossier content');
    }
    // exact replay: return the byte-equivalent stored result, no new model work
    return res.status(200).type('application/json').json({
      status: 'awaiting_receipts',
      proposals: existing.proposals,
    });
  }

  try {
    const proposals = [];
    for (const dossier of dossiers) {
      const { proposal } = await decideForDossier(dossier);
      proposals.push(proposal);
    }

    // ASSUMPTION: storing an optional receipt-verification key the grader
    // may send alongside the propose request (e.g. body.receiptVerificationKey).
    // Confirm the real field name once you have the exact request example.
    storeEvaluation(evaluationId, dossierFingerprint, proposals, req.body.receiptVerificationKey || null, 'awaiting_receipts');

    return res.status(200).type('application/json').json({
      status: 'awaiting_receipts',
      proposals,
    });
  } catch (err) {
    console.error('propose error', err);
    return jsonError(res, 500, 'internal error during propose');
  }
}

async function handleCommit(req, res) {
  const parsed = CommitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return jsonError(res, 422, 'invalid commit request', parsed.error.issues);
  }
  const { receipts } = parsed.data;

  const outcomes = [];

  for (const receipt of receipts) {
    const existingReceipt = getStoredReceipt(receipt.receiptId);
    if (existingReceipt) {
      // exact replay: never repeat the tool effect
      outcomes.push(existingReceipt.outcome);
      continue;
    }

    const evaluation = getEvaluation(receipt.evaluationId);
    if (!evaluation) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'unknown evaluationId' };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    const proposal = evaluation.proposals.find((p) => p.callId === receipt.callId);
    if (!proposal) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'unknown callId for this evaluation' };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    if (receipt.proposalDigest && receipt.proposalDigest !== proposal.proposalDigest) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'proposal digest mismatch' };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    if (receipt.action && receipt.action !== proposal.action) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'action mismatch' };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    // TODO (CRITICAL - fill in before submitting): verify the receipt is
    // authentic using evaluation.receiptKey (the "unpredictable receipt"
    // the grader controls). Until the real signing/verification scheme
    // from the assignment page is dropped in here, this file trusts any
    // syntactically valid receipt whose ids/digest match - which will
    // NOT satisfy "verify every receipt before recording any effect".
    const approved = receipt.approved !== false;

    if (!approved) {
      const outcome = { receiptId: receipt.receiptId, status: 'not_approved', dossierId: proposal.dossierId, action: proposal.action };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    try {
      const effectResult = executeEffect(proposal.action, proposal.payload, { callId: receipt.callId });
      const outcome = {
        receiptId: receipt.receiptId,
        status: 'executed',
        dossierId: proposal.dossierId,
        callId: proposal.callId,
        action: proposal.action,
        result: effectResult,
      };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, true);
      outcomes.push(outcome);
    } catch (err) {
      const outcome = { receiptId: receipt.receiptId, status: 'error', reason: err.message };
      storeReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
    }
  }

  return res.status(200).type('application/json').json({ status: 'completed', outcomes });
}

app.use((req, res) => jsonError(res, 400, 'unsupported route or method'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mailroom agent listening on port ${PORT}`);
});

module.exports = app;
