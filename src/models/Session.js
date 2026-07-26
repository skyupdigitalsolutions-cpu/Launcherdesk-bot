const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Session Schema
//  One document per WhatsApp number. Tracks exactly where in the
//  conversation each user is.
//
//  IMPORTANT CHANGE FROM STAGE 1
//  `answers` is Schema.Types.Mixed, not a fixed sub-schema.
//
//  In stage 1, `data` declared six named fields. Mongoose silently
//  discards any key not in the schema on save, so the moment the
//  flows started collecting entity_type, budget, office_size and
//  the rest, those answers would have vanished on write with no
//  error thrown — the hardest class of bug to trace.
//  Mixed accepts arbitrary keys. The cost is that Mongoose can't
//  auto-detect nested mutation, so every write MUST be followed by
//  markModified('answers'). Use setAnswer() rather than assigning
//  directly and that is handled for you.
// ─────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },

    // MENU | FLOW | SUMMARY | DONE | HUMAN
    state: { type: String, default: 'MENU', index: true },

    // Active flow id from config/flows.js (e.g. 'biz_reg', 'mp_buyer')
    flowId: { type: String, default: null },

    // Index into FLOWS[flowId].steps
    stepIndex: { type: Number, default: 0 },

    // All collected answers, keyed by step.key. Arbitrary shape.
    answers: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    // Per-step retry counter. Doc §10: re-prompt once on invalid
    // entry, then offer "Talk to an Expert" as a fallback.
    invalidAttempts: { type: Number, default: 0 },

    // Set while waiting for a typed mobile after "Use another"
    awaitingTypedMobile: { type: Boolean, default: false },

    // True between sending the flow intro and the user tapping
    // "Let's Start". Firing the intro and question 1 together made
    // the button meaningless and pushed the intro off screen before
    // it could be read.
    awaitingIntroAck: { type: Boolean, default: false },

    // ── Human takeover / opt-out ────────────────────────────
    botPaused: { type: Boolean, default: false },
    optedOut:  { type: Boolean, default: false },

    // ── Inactivity handling (Doc §10) ───────────────────────
    lastMessageAt:  { type: Date, default: Date.now, index: true },
    reminderSentAt: { type: Date, default: null },
    abandonedAt:    { type: Date, default: null },

    // ── Conversation metadata (dashboard routes depend on this) ──
    conversation: {
      firstMessageAt:      { type: Date, default: Date.now },
      lastIncomingMessage: { type: String, default: '' },
      lastOutgoingMessage: { type: String, default: '' },
      unreadCount:         { type: Number, default: 0 },
      totalMessages:       { type: Number, default: 0 },
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

// Compound index for the inactivity sweeper, which queries
// state + lastMessageAt on every tick.
sessionSchema.index({ state: 1, lastMessageAt: 1 });

sessionSchema.pre('save', function (next) {
  this.lastMessageAt = new Date();
  next();
});

// ── Safe writers for the Mixed field ──────────────────────────

sessionSchema.methods.setAnswer = function (key, value) {
  if (!this.answers) this.answers = {};
  this.answers[key] = value;
  this.markModified('answers');
  return this;
};

sessionSchema.methods.clearAnswer = function (key) {
  if (this.answers && key in this.answers) {
    delete this.answers[key];
    this.markModified('answers');
  }
  return this;
};

// Reset conversation position without losing identity or opt-out.
sessionSchema.methods.resetFlow = function () {
  this.flowId = null;
  this.stepIndex = 0;
  this.answers = {};
  this.invalidAttempts = 0;
  this.awaitingTypedMobile = false;
  this.awaitingIntroAck = false;
  this.reminderSentAt = null;
  this.markModified('answers');
  return this;
};

module.exports = mongoose.model('Session', sessionSchema);