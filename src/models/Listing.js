const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Marketplace Listing (Doc §9B)
//
//  Seller submissions are deliberately NOT stored as Leads. The doc
//  routes them to a separate "Marketplace Listings" review queue for
//  manual verification before publication, and mixing them into the
//  service-lead collection would corrupt the sales team's pipeline
//  counts — a vendor asking to be listed is not a customer.
// ─────────────────────────────────────────────────────────────

const listingSchema = new mongoose.Schema(
  {
    productName:     { type: String, required: true, index: true },
    productCategory: { type: String, default: '' },
    pricingPlan:     { type: String, default: '' },

    contactName: { type: String, default: '' },
    workEmail:   { type: String, default: '' },
    mobile:      { type: String, required: true, index: true },
    phone:       { type: String, default: '' },   // WhatsApp number it came from

    queue:  { type: String, default: 'marketplace_listings' },

    // pending_review | update_requested | approved | rejected | published
    status: { type: String, default: 'pending_review', index: true },

    // Doc §9B: a repeat submission of the same product from the same
    // mobile is logged here as an update request rather than creating
    // a duplicate listing record.
    updateRequests: [
      {
        submittedAt: { type: Date, default: Date.now },
        changes:     { type: mongoose.Schema.Types.Mixed },
      },
    ],

    answers: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    source:  { type: String, default: 'whatsapp_bot' },
  },
  { timestamps: true }
);

// Backs the duplicate check in submitListing()
listingSchema.index({ mobile: 1, productName: 1 });

module.exports = mongoose.model('Listing', listingSchema);