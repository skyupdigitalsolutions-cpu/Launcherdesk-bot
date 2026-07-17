const express = require('express');
const router = express.Router();

const Session      = require('../models/Session');
const Conversation = require('../models/Conversation');

// ─────────────────────────────────────────────────────────────
//  Conversation API
//  Read-only access to logged conversations, plus marking a
//  customer's unread count as read.
// ─────────────────────────────────────────────────────────────

// POST /api/conversations/read
router.post('/read', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    const session = await Session.findOneAndUpdate(
      { phone },
      { $set: { 'conversation.unreadCount': 0 } },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.status(200).json({ success: true, session });
  } catch (err) {
    console.error('[API] POST /api/conversations/read error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/conversations/:phone
router.get('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    const conversations = await Conversation.find({ phone }).sort({ createdAt: 1 });

    res.status(200).json({ phone, count: conversations.length, conversations });
  } catch (err) {
    console.error('[API] GET /api/conversations/:phone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
