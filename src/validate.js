const { z } = require('zod');

// CONFIRMED from the grader's actual propose payload: a dossier's stable
// identifier field is `dossierId`, not `id`. Other fields (partition,
// receivedAt, mailbox, objective, sources[]) vary by case, so we keep
// passthrough() and don't hard-require them.
const DossierSchema = z
  .object({
    dossierId: z.string().min(1),
  })
  .passthrough();

// CONFIRMED envelope fields from the real grader payload:
// { profile, operation, evaluationId, receiptVerifier, corpus, allowedActions, dossiers }
const ProposeRequestSchema = z
  .object({
    operation: z.literal('propose'),
    evaluationId: z.string().min(1),
    dossiers: z.array(DossierSchema).min(1),
  })
  .passthrough();

// ASSUMPTION: the exact receipt shape from the grader is not in the
// excerpt you pasted. This accepts evaluationId + callId + receiptId
// plus whatever else the grader sends (passthrough), so extra/renamed
// fields won't fail validation - but you MUST confirm field names
// against the real "Exact commit request" example and adjust the
// lookups in server.js to match (search for "ASSUMPTION" there too).
const ReceiptSchema = z
  .object({
    evaluationId: z.string().min(1),
    callId: z.string().min(1),
    receiptId: z.string().min(1),
  })
  .passthrough();

const CommitRequestSchema = z.object({
  operation: z.literal('commit'),
  receipts: z.array(ReceiptSchema).min(1),
});

const ALLOWED_ACTIONS = [
  'create_draft',
  'update_internal_record',
  'send_approved_notice',
  'request_confirmation',
  'quarantine_item',
  'no_action',
];

const ActionPayloadSchemas = {
  create_draft: z
    .object({
      action: z.literal('create_draft'),
      queue: z.string().min(1),
      recipient: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
    })
    .passthrough(),
  update_internal_record: z
    .object({
      action: z.literal('update_internal_record'),
      recordId: z.string().min(1),
      field: z.string().min(1),
      newValue: z.union([z.string(), z.number(), z.boolean()]),
    })
    .passthrough(),
  send_approved_notice: z
    .object({
      action: z.literal('send_approved_notice'),
      recipient: z.string().min(1),
      template: z.string().min(1),
      approvalRef: z.string().min(1),
    })
    .passthrough(),
  request_confirmation: z
    .object({
      action: z.literal('request_confirmation'),
      queue: z.string().min(1),
      reason: z.string().min(1),
    })
    .passthrough(),
  quarantine_item: z
    .object({
      action: z.literal('quarantine_item'),
      reason: z.string().min(1),
    })
    .passthrough(),
  no_action: z
    .object({
      action: z.literal('no_action'),
      reason: z.string().optional(),
    })
    .passthrough(),
};

function validateActionPayload(payload) {
  if (!payload || typeof payload.action !== 'string' || !ALLOWED_ACTIONS.includes(payload.action)) {
    return { ok: false, error: 'unknown or missing action' };
  }
  const schema = ActionPayloadSchemas[payload.action];
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, value: result.data };
}

module.exports = {
  ProposeRequestSchema,
  CommitRequestSchema,
  ALLOWED_ACTIONS,
  validateActionPayload,
};
