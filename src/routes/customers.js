const express = require('express');
const router = express.Router();

const Session      = require('../models/Session');
const Lead         = require('../models/Lead');
const Conversation = require('../models/Conversation');

// ─────────────────────────────────────────────────────────────
//  Customer API
//  Read-only access to Session (customer) data for the dashboard.
// ─────────────────────────────────────────────────────────────

// GET /api/customers?page=1&limit=20&search=
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page, 10)  || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
    const search = (req.query.search || '').trim();

    const filter = {};
    if (search) {
      filter.$or = [
        { phone:        { $regex: search, $options: 'i' } },
        { 'data.name':  { $regex: search, $options: 'i' } },
        { 'data.email': { $regex: search, $options: 'i' } },
      ];
    }

    const [customers, total] = await Promise.all([
      Session.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Session.countDocuments(filter),
    ]);

    res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      customers,
    });
  } catch (err) {
    console.error('[API] GET /api/customers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/customers/:phone
router.get('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    const session = await Session.findOne({ phone });
    if (!session) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const [lead, latestConversation] = await Promise.all([
      Lead.findOne({ phone }).sort({ createdAt: -1 }),
      Conversation.findOne({ phone }).sort({ createdAt: -1 }),
    ]);

    res.status(200).json({
      session,
      lead:               lead || null,
      latestConversation: latestConversation || null,
    });
  } catch (err) {
    console.error('[API] GET /api/customers/:phone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
