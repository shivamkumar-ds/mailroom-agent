// Simulated side effects. Replace each case body with a real integration
// (helpdesk/CRM API call, mail sender, etc.) once you have real credentials.
// Keep these calls OUTSIDE the LLM step - the model only proposes an
// action; only server.js's commit handler (after receipt verification)
// may call this function, exactly once per approved receipt.
function executeEffect(action, payload, context) {
  switch (action) {
    case 'create_draft':
      return { effect: 'draft_created', queue: payload.queue, draftId: `draft_${context.callId}` };
    case 'update_internal_record':
      return {
        effect: 'record_updated',
        recordId: payload.recordId,
        field: payload.field,
        newValue: payload.newValue,
      };
    case 'send_approved_notice':
      return { effect: 'notice_sent', recipient: payload.recipient, template: payload.template };
    case 'request_confirmation':
      return { effect: 'routed_for_confirmation', queue: payload.queue };
    case 'quarantine_item':
      return { effect: 'quarantined', reason: payload.reason };
    case 'no_action':
      return { effect: 'no_action_taken' };
    default:
      throw new Error(`no effect handler for action ${action}`);
  }
}

module.exports = { executeEffect };
