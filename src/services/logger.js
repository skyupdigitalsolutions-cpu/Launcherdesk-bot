const Conversation = require('../models/Conversation');
const sheetQueue   = require('./sheetQueue');
const { getIO }    = require('../socket');

// ─────────────────────────────────────────────────────────────
//  Conversation Logger
//
//  PERFORMANCE REWRITE
//
//  The previous version awaited, for EVERY message:
//    1. Conversation.save()          MongoDB   ~80ms
//    2. sheets.appendConversation()  Sheets   ~1-3s
//    3. updateLeadActivity()         Sheets   ~1-3s  (a read AND a write)
//    4. Session.findOne()            MongoDB  ~80ms
//    5. session.save()               MongoDB  ~80ms
//
//  ...and logIncoming plus logOutgoing both ran that chain, so a
//  single user message cost ten sequential round trips, four of them
//  to Google Sheets. Measured reply time was 8-9 seconds for work the
//  bot finished in milliseconds.
//
//  Three changes:
//
//  1. NOTHING HERE BLOCKS THE REPLY. The Mongo insert is fired and
//     not awaited by the caller; Sheets rows go to an in-memory queue
//     that flushes in one batched call on a timer.
//
//  2. updateLeadActivity IS GONE from the per-message path. It cost
//     two Sheets calls per message to keep a "last message" column
//     warm — the admin console reads that from MongoDB instantly.
//
//  3. THE SESSION WRITE IS GONE. This was also a correctness bug:
//     the logger loaded its OWN copy of the session and saved it,
//     while the state machine was mutating a different in-memory copy
//     of the same document. Last write won, so conversation counters
//     and occasionally real answers were clobbered. The state machine
//     now owns all session writes.
// ─────────────────────────────────────────────────────────────

function emit(event, payload) {
  try {
    const io = getIO();
    if (io) io.emit(event, payload);
  } catch (err) {
    // A missing or broken socket must never affect message handling.
    console.error(`[Logger] socket emit failed (${event}):`, err.message);
  }
}

// Persist one message. Returns a promise the caller may ignore.
function record(direction, data) {
  const at = new Date();

  // MongoDB is the source of truth, so this is still a real write —
  // but the caller does not wait for it.
  const saved = Conversation.create({
    phone:       data.phone,
    direction,
    message:     data.message,
    messageType: data.messageType,
    state:       data.state,
  }).catch((err) => {
    console.error(`[Logger] Mongo write failed (${direction}):`, err.message);
  });

  // Mirror to the client's spreadsheet, batched and off the hot path.
  sheetQueue.enqueue({
    at,
    phone:       data.phone,
    direction,
    message:     data.message,
    messageType: data.messageType,
    botState:    data.state,
  });

  emit(direction === 'Incoming' ? 'incoming_message' : 'outgoing_message', {
    phone:       data.phone,
    message:     data.message,
    messageType: data.messageType,
    state:       data.state,
    timestamp:   at.toISOString(),
  });

  return saved;
}

async function logIncoming(data) { return record('Incoming', data); }
async function logOutgoing(data) { return record('Outgoing', data); }

module.exports = { logIncoming, logOutgoing };