const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Lead Schema
//  Saved when user confirms their details in the capture flow.
// ─────────────────────────────────────────────────────────────

const leadSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true },
    phone:         { type: String, required: true },   // wa_id — auto-captured
    email:         { type: String, default: '' },
    businessName:  { type: String, default: '' },
    city:          { type: String, default: '' },
    category:      { type: String, required: true },   // key e.g. 'biz_reg'
    categoryLabel: { type: String, required: true },   // '🏢 Business Registration'
    source:        { type: String, default: 'whatsapp_bot' },
    status:        { type: String, default: 'new' },   // new | contacted | converted
    sheetRow:      { type: Number, default: null },    // row number in Google Sheet
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lead', leadSchema);
