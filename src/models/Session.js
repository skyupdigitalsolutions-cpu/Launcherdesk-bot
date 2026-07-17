const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Session Schema
//  One document per WhatsApp number.
//  Tracks exactly where in the conversation flow each user is.
// ─────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema(
  {
    // WhatsApp number (wa_id from MSG91 webhook) — primary key
    phone: { type: String, required: true, unique: true, index: true },

    // Current state in the conversation state machine
    // States: NEW | MENU | CATEGORY | ASK_NAME | ASK_EMAIL |
    //         ASK_BUSINESS | ASK_CITY | CONFIRM | DONE | HUMAN
    state: { type: String, default: 'NEW' },

    // Accumulated lead data during capture flow
    data: {
      name:         { type: String, default: '' },
      email:        { type: String, default: '' },
      businessName: { type: String, default: '' },
      city:         { type: String, default: '' },
      category:     { type: String, default: '' },   // category key e.g. 'biz_reg'
      categoryLabel:{ type: String, default: '' },   // human-readable label
    },

    // Pause bot for human takeover (set when user picks 'Talk to Expert')
    botPaused: { type: Boolean, default: false },

    // Opt-out (STOP received)
    optedOut: { type: Boolean, default: false },

    // Track last message time (for 24h window awareness)
    lastMessageAt: { type: Date, default: Date.now },

    // Conversation-level metadata (message history summary)
    conversation: {
      firstMessageAt: { type: Date, default: Date.now },

      lastIncomingMessage: { type: String, default: '' },
      lastOutgoingMessage: { type: String, default: '' },

      unreadCount:   { type: Number, default: 0 },
      totalMessages: { type: Number, default: 0 },

      lastDirection: {
        type: String,
        enum: ['Incoming', 'Outgoing'],
        default: 'Incoming',
      },

      humanMode: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

// Update lastMessageAt on every save
sessionSchema.pre('save', function (next) {
  this.lastMessageAt = new Date();
  next();
});

module.exports = mongoose.model('Session', sessionSchema);
