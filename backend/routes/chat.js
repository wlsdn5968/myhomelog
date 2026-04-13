const express = require('express');
const router = express.Router();
const { callAI } = require('../services/aiService');
const { validateChatInput } = require('../middleware/validation');

/**
 * POST /api/chat
 * AI 채팅 엔드포인트
 */
router.post('/', validateChatInput, async (req, res) => {
  const { message, context } = req.body;

  const messages = [
    ...(context?.history || []),
    { role: 'user', content: message },
  ];

  // 최대 10턴 유지 (토큰 절약)
  const trimmed = messages.slice(-20);

  const result = await callAI(trimmed, trimmed.length === 1).catch(err => {
    throw Object.assign(new Error(err.message), { status: 502 });
  });

  res.json({
    reply: result.content,
    fromCache: result.fromCache || false,
    usage: process.env.NODE_ENV === 'development' ? result.usage : undefined,
  });
});

module.exports = router;
