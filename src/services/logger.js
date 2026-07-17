const Conversation = require('../models/Conversation');
const Session = require('../models/Session');
const sheets = require('./sheets');
const { updateLeadActivity } = require('./sheets');
const { getIO } = require('../socket');

// ─────────────────────────────────────────────────────────────
//  Conversation Logger
//  Centralizes logging of every WhatsApp message to MongoDB
//  and Google Sheets, so calling code doesn't repeat itself.
// ─────────────────────────────────────────────────────────────

// Log an incoming WhatsApp message
async function logIncoming(data) {
  try {
    const conversation = new Conversation({
      phone:       data.phone,
      direction:   'Incoming',
      message:     data.message,
      messageType: data.messageType,
      state:       data.state,
    });

    await conversation.save();
    console.log(`[Logger] Incoming message saved to MongoDB — phone: ${data.phone}`);

    try {
      const io = getIO();
      if (io) {
        io.emit('incoming_message', {
          phone:       data.phone,
          message:     data.message,
          messageType: data.messageType,
          state:       data.state,
          timestamp:   new Date().toISOString(),
        });
      }
    } catch (err) {
      // Non-fatal — a missing/broken socket connection must never block logging
      console.error('[Logger] Failed to emit incoming_message event:', err.message);
    }
  } catch (err) {
    // Non-fatal — still try to log to Google Sheets
    console.error('[Logger] Failed to save incoming message to MongoDB:', err.message);
  }

  let sheetsResult = null;
  try {
    sheetsResult = await sheets.appendConversation({
      phone:       data.phone,
      direction:   'Incoming',
      message:     data.message,
      messageType: data.messageType,
      botState:    data.state,
    });
    console.log(`[Logger] Incoming message logged to Google Sheets — phone: ${data.phone}`);
  } catch (err) {
    // Non-fatal — logging should never block the bot flow
    console.error('[Logger] Failed to log incoming message to Google Sheets:', err.message);
  }

  if (sheetsResult) {
    try {
      const updated = await updateLeadActivity(data.phone, {
        lastMessage: data.message,
        status: 'Active',
      });
      if (updated) {
        console.log(`[Logger] Lead activity updated — phone: ${data.phone}`);
      } else {
        console.log(`[Logger] No matching lead found to update — phone: ${data.phone}`);
      }
    } catch (err) {
      // Non-fatal — conversation logging must still succeed
      console.error('[Logger] Failed to update lead activity:', err.message);
    }
  }

  try {
    const session = await Session.findOne({ phone: data.phone });
    if (session) {
      session.conversation.lastIncomingMessage = data.message;
      session.conversation.lastDirection       = 'Incoming';
      session.conversation.unreadCount        += 1;
      session.conversation.totalMessages       += 1;
      session.lastMessageAt = new Date();
      await session.save();
      console.log(`[Logger] Session updated for incoming message — phone: ${data.phone}`);
    }
  } catch (err) {
    // Non-fatal — conversation/Sheets/lead logging must still succeed
    console.error('[Logger] Failed to update session:', err.message);
  }
}

// Log an outgoing WhatsApp message
async function logOutgoing(data) {
  try {
    const conversation = new Conversation({
      phone:       data.phone,
      direction:   'Outgoing',
      message:     data.message,
      messageType: data.messageType,
      state:       data.state,
    });

    await conversation.save();
    console.log(`[Logger] Outgoing message saved to MongoDB — phone: ${data.phone}`);

    try {
      const io = getIO();
      if (io) {
        io.emit('outgoing_message', {
          phone:       data.phone,
          message:     data.message,
          messageType: data.messageType,
          state:       data.state,
          timestamp:   new Date().toISOString(),
        });
      }
    } catch (err) {
      // Non-fatal — a missing/broken socket connection must never block logging
      console.error('[Logger] Failed to emit outgoing_message event:', err.message);
    }
  } catch (err) {
    // Non-fatal — still try to log to Google Sheets
    console.error('[Logger] Failed to save outgoing message to MongoDB:', err.message);
  }

  let sheetsResult = null;
  try {
    sheetsResult = await sheets.appendConversation({
      phone:       data.phone,
      direction:   'Outgoing',
      message:     data.message,
      messageType: data.messageType,
      botState:    data.state,
    });
    console.log(`[Logger] Outgoing message logged to Google Sheets — phone: ${data.phone}`);
  } catch (err) {
    // Non-fatal — logging should never block the bot flow
    console.error('[Logger] Failed to log outgoing message to Google Sheets:', err.message);
  }

  if (sheetsResult) {
    try {
      const updated = await updateLeadActivity(data.phone, {
        lastMessage: data.message,
        status: 'Active',
      });
      if (updated) {
        console.log(`[Logger] Lead activity updated — phone: ${data.phone}`);
      } else {
        console.log(`[Logger] No matching lead found to update — phone: ${data.phone}`);
      }
    } catch (err) {
      // Non-fatal — conversation logging must still succeed
      console.error('[Logger] Failed to update lead activity:', err.message);
    }
  }

  try {
    const session = await Session.findOne({ phone: data.phone });
    if (session) {
      session.conversation.lastOutgoingMessage = data.message;
      session.conversation.lastDirection       = 'Outgoing';
      session.conversation.totalMessages       += 1;
      session.lastMessageAt = new Date();
      await session.save();
      console.log(`[Logger] Session updated for outgoing message — phone: ${data.phone}`);
    }
  } catch (err) {
    // Non-fatal — conversation/Sheets/lead logging must still succeed
    console.error('[Logger] Failed to update session:', err.message);
  }
}

module.exports = {
  logIncoming,
  logOutgoing,
};
