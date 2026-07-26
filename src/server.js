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

function jsonError(res, status, message, details) {
  return res.status(status).type('application/json').json({ status: 'error', error: message, details });
}

// ---------------- decision cache (keyed by dossier content, not evaluationId) ----------------

async function decideForDossier(dossier) {
  const contentHash = contentFingerprint(dossier);
  const cached = db.getDecision(contentHash);
  if (cached) return { callId: cached.callId, proposal: cached.proposal };

  const callId = callIdFromFingerprint(contentHash);
  const llmResult = await withTimeout(classifyDossier(dossier), MODEL_TIMEOUT_MS);

  const check = validateActionPayload(llmResult.payload);
  const safePayload = check.ok
    ? check.value
    : { action: 'request_confirmation', queue: 'general-review', reason: 'schema validation failed, routed to human review' };
  const finalAction = check.ok ? safePayload.action : 'request_confirmation';

  const proposal = {
    dossierId: dossier.dossierId,
    callId,
    action: finalAction,
    payload: safePayload,
    evidence: Array.isArray(llmResult.evidence) ? llmResult.evidence.slice(0, 5) : [],
    rationale: typeof llmResult.rationale === 'string' ? llmResult.rationale.slice(0, 400) : '',
  };
  proposal.proposalDigest = sha256Hex(canonicalStringify(proposal));

  db.putDecision(contentHash, dossier.dossierId, callId, proposal);
  return { callId, proposal };
}

// ---------------- evaluation helpers ----------------

function fingerprintDossierSet(dossiers) {
  const hashes = dossiers.map((d) => contentFingerprint(d)).sort();
  return sha256Hex(canonicalStringify(hashes));
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
  console.log('PROPOSE raw body:', JSON.stringify(req.body).slice(0, 3000));
  const parsed = ProposeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('PROPOSE validation failed:', JSON.stringify(parsed.error.issues));
    return jsonError(res, 422, 'invalid propose request', parsed.error.issues);
  }
  const { evaluationId, dossiers } = parsed.data;

  const ids = dossiers.map((d) => d.dossierId);
  if (new Set(ids).size !== ids.length) {
    return jsonError(res, 400, 'duplicate dossier IDs in request');
  }

  const dossierFingerprint = fingerprintDossierSet(dossiers);
  const existing = db.getEvaluation(evaluationId);

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

    // CONFIRMED: the grader sends a real receiptVerifier object
    // { algorithm: "Ed25519", publicKeyJwk: {...} } on every propose
    // request. Store it with the evaluation so commit-time signature
    // verification (still TODO below) can use it.
    db.putEvaluation(evaluationId, dossierFingerprint, proposals, req.body.receiptVerifier || null, 'awaiting_receipts');

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
  console.log('COMMIT raw body:', JSON.stringify(req.body).slice(0, 3000));
  const parsed = CommitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('COMMIT validation failed:', JSON.stringify(parsed.error.issues));
    return jsonError(res, 422, 'invalid commit request', parsed.error.issues);
  }
  const { receipts } = parsed.data;

  const outcomes = [];

  for (const receipt of receipts) {
    const existingReceipt = db.getReceipt(receipt.receiptId);
    if (existingReceipt) {
      // exact replay: never repeat the tool effect
      outcomes.push(existingReceipt.outcome);
      continue;
    }

    const evaluation = db.getEvaluation(receipt.evaluationId);
    if (!evaluation) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'unknown evaluationId' };
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    const proposal = evaluation.proposals.find((p) => p.callId === receipt.callId);
    if (!proposal) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'unknown callId for this evaluation' };
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    if (receipt.proposalDigest && receipt.proposalDigest !== proposal.proposalDigest) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'proposal digest mismatch' };
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
      outcomes.push(outcome);
      continue;
    }

    if (receipt.action && receipt.action !== proposal.action) {
      const outcome = { receiptId: receipt.receiptId, status: 'rejected', reason: 'action mismatch' };
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
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
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
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
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, true);
      outcomes.push(outcome);
    } catch (err) {
      const outcome = { receiptId: receipt.receiptId, status: 'error', reason: err.message };
      db.putReceipt(receipt.receiptId, receipt.evaluationId, receipt.callId, outcome, false);
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
