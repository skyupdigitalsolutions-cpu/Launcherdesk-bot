// ─────────────────────────────────────────────────────────────
//  MSG91 Inbound Payload Parser
//
//  MSG91 sends different payload shapes for:
//   - Plain text messages
//   - Quick reply button clicks
//   - Interactive list selections
//   - Template button clicks ("Explore Services")
//
//  This normalises all of them into one consistent object:
//  { phone, type, text, buttonId, listRowId }
// ─────────────────────────────────────────────────────────────

function parseInbound(body) {
  // MSG91 wraps everything under 'data' or 'entry' depending on version
  // Try both shapes
  const entry = body?.data || body;

  // Phone number — always present as wa_id or mobile
 const phone =
  entry?.customerNumber ||   // MSG91
  entry?.wa_id ||
  entry?.mobile ||
  entry?.from ||
  entry?.sender ||
  entry?.phone ||
  null;

  if (!phone) {
    console.warn('[Parser] Could not extract phone from payload:', JSON.stringify(body).slice(0, 200));
    return null;
  }

  const msgType =
  entry?.contentType ||
  entry?.type ||
  entry?.message_type ||
  "text";

  // ── Template button click (e.g. "Explore Services") ──────
  if (msgType === 'button' || entry?.button) {
    const btnPayload = entry?.button || entry?.interactive?.button_reply;
    return {
      phone,
      type:     'button',
      text:     btnPayload?.text || btnPayload?.title || '',
      buttonId: btnPayload?.payload || btnPayload?.id || '',
      listRowId: null,
    };
  }

  // ── Interactive reply button click ────────────────────────
  if (msgType === 'interactive') {
    const interactive = entry?.interactive || entry?.message?.interactive;

    if (interactive?.type === 'button_reply') {
      return {
        phone,
        type:     'button_reply',
        text:     interactive.button_reply?.title || '',
        buttonId: interactive.button_reply?.id    || '',
        listRowId: null,
      };
    }

    if (interactive?.type === 'list_reply') {
      return {
        phone,
        type:     'list_reply',
        text:     interactive.list_reply?.title || '',
        buttonId: null,
        listRowId: interactive.list_reply?.id   || '',
      };
    }
  }

  // ── Plain text message ────────────────────────────────────
 const textBody =
  entry?.text ||
  entry?.body ||
  entry?.message?.body ||
  entry?.text?.body ||
  "";
  

  return {
    phone,
    type:     'text',
    text:     (typeof textBody === 'string' ? textBody : '').trim(),
    buttonId: null,
    listRowId: null,
  };
}

module.exports = { parseInbound };
