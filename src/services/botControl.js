const Session = require('../models/Session');
const { getIO } = require('../socket');

// Emit a socket event without ever throwing — a missing/broken socket
// connection must never block pause/resume logic.
function emitSafe(event, payload) {
  try {
    const io = getIO();
    if (io) {
      io.emit(event, payload);
    }
  } catch (err) {
    console.error(`[BotControl] Failed to emit ${event} event:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Bot Control Service
//  Pause/resume automated bot replies for a phone number
//  (human takeover). Used by the admin API.
// ─────────────────────────────────────────────────────────────

// Pause the bot for a phone number — hands the conversation to a human agent
async function pauseBot(phone) {
  try {
    const session = await Session.findOne({ phone });
    if (!session) {
      console.error(`[BotControl] pauseBot — no session found for ${phone}`);
      return false;
    }

    session.botPaused = true;
    session.conversation.humanMode = true;
    await session.save();

    console.log(`[BotControl] Bot paused for ${phone}`);
    emitSafe('bot_paused', { phone });
    return true;
  } catch (err) {
    console.error('[BotControl] Failed to pause bot:', err.message);
    return false;
  }
}

// Resume the bot for a phone number — hands the conversation back to automation
async function resumeBot(phone) {
  try {
    const session = await Session.findOne({ phone });
    if (!session) {
      console.error(`[BotControl] resumeBot — no session found for ${phone}`);
      return false;
    }

    session.botPaused = false;
    session.conversation.humanMode = false;
    await session.save();

    console.log(`[BotControl] Bot resumed for ${phone}`);
    emitSafe('bot_resumed', { phone });
    return true;
  } catch (err) {
    console.error('[BotControl] Failed to resume bot:', err.message);
    return false;
  }
}

module.exports = {
  pauseBot,
  resumeBot,
};
