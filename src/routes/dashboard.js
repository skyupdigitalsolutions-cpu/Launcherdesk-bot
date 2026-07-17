const express = require('express');
const router = express.Router();

const Session      = require('../models/Session');
const Lead         = require('../models/Lead');
const Conversation = require('../models/Conversation');

// ─────────────────────────────────────────────────────────────
//  Dashboard API
//  Read-only aggregate stats for the dashboard UI.
// ─────────────────────────────────────────────────────────────

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      totalCustomers,
      totalLeads,
      totalConversations,
      activeSessions,
      pausedBots,
      unreadAgg,
      todayMessages,
      todayLeads,
    ] = await Promise.all([
      Session.countDocuments(),
      Lead.countDocuments(),
      Conversation.countDocuments(),
      Session.countDocuments({ botPaused: false, optedOut: false }),
      Session.countDocuments({ botPaused: true }),
      Session.aggregate([
        { $group: { _id: null, total: { $sum: '$conversation.unreadCount' } } },
      ]),
      Conversation.countDocuments({ createdAt: { $gte: startOfToday } }),
      Lead.countDocuments({ createdAt: { $gte: startOfToday } }),
    ]);

    const unreadMessages = unreadAgg[0]?.total || 0;

    res.status(200).json({
      totalCustomers,
      totalLeads,
      totalConversations,
      activeSessions,
      pausedBots,
      unreadMessages,
      todayMessages,
      todayLeads,
    });
  } catch (err) {
    console.error('[API] GET /api/dashboard/stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
