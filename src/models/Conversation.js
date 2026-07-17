const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────
//  Conversation Schema
//  One document per WhatsApp message (incoming or outgoing).
// ─────────────────────────────────────────────────────────────

const conversationSchema = new mongoose.Schema(
  {
    phone:       { type: String, required: true },   // wa_id
    direction:   { type: String, required: true },    // Incoming | Outgoing
    message:     { type: String, required: true },
    messageType: { type: String, default: 'text' },
    state:       { type: String, default: '' },        // bot state at time of message

    sessionId: { type: String, default: '' },
    messageId: { type: String, default: '' },

    status: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'received', 'failed'],
      default: function () {
        return this.direction === 'Incoming' ? 'received' : 'sent';
      },
    },

    source: { type: String, default: 'whatsapp' },

    createdBy: {
      type: String,
      enum: ['bot', 'user', 'agent'],
      default: function () {
        return this.direction === 'Incoming' ? 'user' : 'bot';
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Conversation', conversationSchema);
