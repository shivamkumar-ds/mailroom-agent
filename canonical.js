const crypto = require('crypto');

// Deterministic key ordering so the same logical object always hashes
// to the same string, regardless of key insertion order.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const sortedKeys = Object.keys(value).sort();
  const result = {};
  for (const k of sortedKeys) {
    result[k] = canonicalize(value[k]);
  }
  return result;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Fingerprint of ONE dossier's content. Used as the cache key so that
// identical dossiers (same id + same content) across different
// evaluationIds/Checks never trigger a second model call.
//
// ASSUMPTION: a dossier looks like { id: "...", ...contentFields }.
// If the real payload nests content under a different key (e.g.
// dossier.content / dossier.record), adjust the `material` object below.
function contentFingerprint(dossier) {
  const material = {
    id: dossier.id,
    content: dossier.content !== undefined ? dossier.content : dossier,
  };
  return sha256Hex(canonicalStringify(material));
}

// Deterministic callId derived purely from content, so the SAME dossier
// content always yields the SAME callId across different evaluationIds
// and across later Checks (per the "stable dossiers -> stable callId"
// persistence rule in the spec).
function callIdFromFingerprint(fingerprint) {
  return 'call_' + fingerprint.slice(0, 24);
}

module.exports = {
  canonicalize,
  canonicalStringify,
  sha256Hex,
  contentFingerprint,
  callIdFromFingerprint,
};
