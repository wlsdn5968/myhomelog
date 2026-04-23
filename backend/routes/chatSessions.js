/**
 * 채팅 세션/메시지 저장 API (chat_sessions / chat_messages)
 *
 * 설계:
 *   - 메인 /api/chat 은 stateless 유지 (LLM 호출만)
 *   - 프론트가 로그인 상태일 때 선택적으로 이 API 로 세션/메시지 persist
 *   - 비로그인 시엔 호출하지 않음 (프론트 가드)
 *
 * 보안:
 *   - 전 엔드포인트 requireAuth
 *   - userScopedClient 로 RLS 자동 적용
 *   - 세션 소유권 검증은 DB 단 RLS 에서 처리
 *   - chat_messages INSERT 는 WITH CHECK(EXISTS session owner) 로 남의 세션 쓰기 차단
 *
 * 엔드포인트:
 *   GET    /api/chat/sessions              — 내 세션 최근 30개 (last_message_at desc)
 *   POST   /api/chat/sessions              — 새 세션 생성 ({title?})
 *   PATCH  /api/chat/sessions/:id          — 제목 변경 ({title})
 *   DELETE /api/chat/sessions/:id          — 세션 + 메시지 일괄 삭제 (ON DELETE CASCADE)
 *   GET    /api/chat/sessions/:id/messages — 세션 메시지 시간순 (max 200)
 *   POST   /api/chat/sessions/:id/messages — 메시지 1건 append ({role, content, meta?})
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const MAX_TITLE_LEN = 60;
const MAX_CONTENT_LEN = 8000; // LLM 응답 1회 상한 + 여유
const SESSIONS_LIMIT = 30;
const MESSAGES_LIMIT = 200;
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);

function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

router.use(requireAuth);

// ── GET /sessions ─────────────────────────────────────────
router.get('/sessions', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('chat_sessions')
      .select('id, title, last_message_at, created_at')
      .order('last_message_at', { ascending: false })
      .limit(SESSIONS_LIMIT);
    if (error) throw error;
    res.json({ sessions: data || [] });
  } catch (e) { next(e); }
});

// ── POST /sessions ────────────────────────────────────────
router.post('/sessions', async (req, res, next) => {
  try {
    const title = String(req.body?.title || '새 대화').trim().slice(0, MAX_TITLE_LEN);
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('chat_sessions')
      .insert({ user_id: req.user.id, title })
      .select('id, title, last_message_at, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// ── PATCH /sessions/:id — 제목 변경 ───────────────────────
router.patch('/sessions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE_LEN);
    if (!title) return res.status(400).json({ error: 'title 필수' });
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('chat_sessions')
      .update({ title })
      .eq('id', id)
      .select('id, title')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '세션 없음 (또는 권한 없음)' });
    res.json(data);
  } catch (e) { next(e); }
});

// ── DELETE /sessions/:id ──────────────────────────────────
// chat_messages 는 FK ON DELETE CASCADE — 함께 삭제됨
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const sb = userScopedClient(req.accessToken);
    const { error } = await sb
      .from('chat_sessions')
      .delete()
      .eq('id', id);
    if (error) throw error;
    logger.info({ userId: req.user.id, sessionId: id }, '채팅 세션 삭제');
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── GET /sessions/:id/messages ────────────────────────────
router.get('/sessions/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const sb = userScopedClient(req.accessToken);
    // RLS 가 세션 소유권 확인해줌 — 존재성만 별도로 안 묻고 바로 messages 조회
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, role, content, meta, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true })
      .limit(MESSAGES_LIMIT);
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (e) { next(e); }
});

// ── POST /sessions/:id/messages ───────────────────────────
// body: { role, content, meta? }
router.post('/sessions/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role, content, meta } = req.body || {};
    if (!role || !ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: `role 은 ${[...ALLOWED_ROLES].join('|')} 중 하나` });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content 필수 (string)' });
    }
    const trimmed = content.slice(0, MAX_CONTENT_LEN);
    const sb = userScopedClient(req.accessToken);

    // 메시지 INSERT — RLS WITH CHECK 가 세션 소유권 검증
    const { data: msg, error: msgErr } = await sb
      .from('chat_messages')
      .insert({ session_id: id, role, content: trimmed, meta: meta || {} })
      .select('id, created_at')
      .single();
    if (msgErr) {
      // RLS 위반이면 42501 / 세션 없음이면 23503
      if (msgErr.code === '42501' || msgErr.code === '23503') {
        return res.status(404).json({ error: '세션 없음 (또는 권한 없음)' });
      }
      throw msgErr;
    }

    // last_message_at touch — 실패해도 메시지는 저장됐으므로 조용히 무시
    sb.from('chat_sessions')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', id)
      .then(({ error }) => {
        if (error) logger.warn({ sessionId: id, err: error.message }, 'last_message_at 갱신 실패');
      });

    res.status(201).json({ id: msg.id, createdAt: msg.created_at });
  } catch (e) { next(e); }
});

module.exports = router;
