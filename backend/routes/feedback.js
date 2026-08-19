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
// MOB-AUDIT-2026-05-03: feedback insert 실패 시 사용자엔 200 응답 → 운영자 정량 데이터 누락
const Sentry = require('@sentry/node');
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
    // MOB-AUDIT-2026-05-03: insert fail 누적 시 운영자 알림 — Sentry capture
    try { Sentry.captureException(e, { tags: { route: 'feedback.ai', persisted: 'false' } }); } catch(_){}
    return res.json({ ok: true, persisted: false }); // 사용자 흐름엔 성공 처리
  }
});

// DATA-ERR-2026-08-19 (Sprint NNNNNNN-16): 데이터 오류 신고 — mailto 대체 인앱 폼.
// 저장소는 전용 테이블 data_error_reports(RLS on·정책 0 = service role 전용).
// 스팸 방지: IP 당 30초 1회(인스턴스 로컬 — 완화 목적이지 보안 경계 아님) + 길이 제한.
const _errRateCache = require('../cache');
const ERR_FIELDS = ['세대수', '주차', '실거래', '좌표', '학군', '기타'];
router.post('/data-error', optionalAuth, async (req, res) => {
  const { aptName, lawdCd, field, detail, page } = req.body || {};
  if (!detail || typeof detail !== 'string' || detail.trim().length < 5) {
    return res.status(400).json({ error: '내용을 5자 이상 적어주세요.' });
  }
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const rk = 'errRate:' + ip;
  if (_errRateCache.get(rk)) return res.status(429).json({ error: '잠시 후 다시 신고해주세요.' });
  _errRateCache.set(rk, 1, 30);
  const row = {
    apt_name: (typeof aptName === 'string' ? aptName.trim().slice(0, 50) : null) || null,
    lawd_cd: (typeof lawdCd === 'string' && /^\d{5}$/.test(lawdCd)) ? lawdCd : null,
    field: ERR_FIELDS.includes(field) ? field : '기타',
    detail: detail.trim().slice(0, 500),
    user_id: req.user?.id || null,
    page: (typeof page === 'string' ? page.slice(0, 30) : null) || null,
  };
  const admin = getSupabaseAdmin();
  if (!admin) return res.json({ ok: true, persisted: false });
  try {
    const { error } = await admin.from('data_error_reports').insert(row);
    if (error) throw error;
    return res.json({ ok: true, persisted: true });
  } catch (e) {
    logger.warn({ err: e.message }, 'data-error 신고 저장 실패');
    Sentry.captureException(e);
    return res.json({ ok: true, persisted: false }); // 신고 실패가 사용자 흐름을 막지 않는다
  }
});

module.exports = router;
