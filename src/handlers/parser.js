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
  // BUGFIX: the original chain started with `entry?.text`. When a
  // provider sends text as an object ({ body: "hi" }) that object is
  // truthy, so the chain stopped there and the later `entry?.text?.body`
  // was never reached — the typeof guard below then blanked it to "".
  // MSG91 currently sends a plain string so it worked by luck; any
  // Cloud API-shaped payload silently produced empty text.
  // Unwrapping the object form first makes both shapes work.
  const candidates = [
    typeof entry?.text === 'string' ? entry.text : entry?.text?.body,
    typeof entry?.body === 'string' ? entry.body : entry?.body?.text,
    entry?.message?.text?.body,
    entry?.message?.body,
    entry?.content,
  ];
  const textBody = candidates.find((c) => typeof c === 'string' && c.length > 0) || '';

  return {
    phone,
    type:     'text',
    text:     textBody.trim(),
    buttonId: null,
    listRowId: null,
  };
}

module.exports = { parseInbound };