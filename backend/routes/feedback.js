/**
 * AI 답변 사용자 피드백 (Phase 3 결정사항, 2026-04-25)
 *
 * 책임:
 *   - POST /api/feedback/ai — AI 응답에 대한 👍/👎 + 선택 코멘트 수집
 *   - 메시지 내용은 SHA-256 해시로 저장 (PII 직접 저장 X)
 *   - 비로그인 사용자도 가능 (anon insert)
 *
 * 사용 흐름:
 *   1) frontend chat 응답 옆에 👍/👎 버튼 (이미 받은 응답 reply_preview 와 함께)
 *   2) 클릭 → POST /api/feedback/ai { rating, messageHash, replyPreview, comment? }
 *   3) DB ai_feedback 적재 → 운영자 주간 리뷰
 */
const express = require('express');
const crypto = require('crypto');
const { getSupabaseAdmin } = require('../db/client');
const { optionalAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

const MAX_COMMENT_LEN = 500;
const MAX_PREVIEW_LEN = 200;

router.post('/ai', optionalAuth, async (req, res) => {
  const { rating, messageText, replyPreview, comment, source } = req.body || {};

  // 입력 검증
  if (rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'rating은 1(👍) 또는 -1(👎)이어야 해요.' });
  }
  if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
    return res.status(400).json({ error: '원본 메시지가 필요해요.' });
  }

  const messageHash = crypto.createHash('sha256').update(messageText).digest('hex');
  const cleanComment = comment && typeof comment === 'string'
    ? comment.trim().slice(0, MAX_COMMENT_LEN)
    : null;
  const cleanPreview = replyPreview && typeof replyPreview === 'string'
    ? replyPreview.trim().slice(0, MAX_PREVIEW_LEN)
    : null;
  const cleanSource = ['chat', 'clause', 'recommend'].includes(source) ? source : 'chat';

  const admin = getSupabaseAdmin();
  if (!admin) {
    // DB 미설정이어도 사용자엔 성공 응답 (피드백 수집 실패가 사용자 흐름 막으면 안 됨)
    logger.warn({ source: cleanSource, rating }, 'feedback: Supabase 미설정 — skip');
    return res.json({ ok: true, persisted: false });
  }

  try {
    const { error } = await admin.from('ai_feedback').insert({
      user_id: req.user?.id || null,
      message_hash: messageHash,
      rating,
      comment: cleanComment,
      reply_preview: cleanPreview,
      source: cleanSource,
    });
    if (error) throw error;
    return res.json({ ok: true, persisted: true });
  } catch (e) {
    logger.warn({ err: e.message }, 'feedback insert 실패');
    return res.json({ ok: true, persisted: false }); // 사용자 흐름엔 성공 처리
  }
});

module.exports = router;
