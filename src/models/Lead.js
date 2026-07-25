const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Lead Schema
//  Saved when a user taps Submit on the summary card (Doc §11),
//  or written as a partial lead by the inactivity sweeper.
// ─────────────────────────────────────────────────────────────

const leadSchema = new mongoose.Schema(
  {
    name:  { type: String, default: 'Unknown' },
    phone: { type: String, required: true, index: true },  // WhatsApp id

    // The number the user confirmed for callbacks. Usually identical
    // to `phone`, but the flow lets them nominate a different one.
    mobile: { type: String, default: '' },

    email:        { type: String, default: '' },
    businessName: { type: String, default: '' },
    city:         { type: String, default: '' },

    flowId:        { type: String, required: true },
    category:      { type: String, required: true },
    categoryLabel: { type: String, required: true },

    // Every raw answer, keyed by step. Mixed so that adding a
    // question to flows.js never requires a migration here.
    answers: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    // Routing queue: service_leads | marketplace_buyer | expert
    queue: { type: String, default: 'service_leads', index: true },

    tags: [{ type: String }],

    source: { type: String, default: 'whatsapp_bot' },

    // new | partial | contacted | converted | lost
    status: { type: String, default: 'new', index: true },

    // Set on leads written by the 24h inactivity sweeper so the sales
    // team can tell a finished submission from an abandoned one.
    isPartial:      { type: Boolean, default: false },
    abandonedAtStep: { type: String, default: '' },

    sheetRow: { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lead', leadSchema);