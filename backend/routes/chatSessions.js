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
 *
 * MOUNT-FIX-2026-07-11 (Sprint HHHH, 전수조사 라이브 404 재현으로 발견):
 *   server.js 가 '/api/chat/sessions' 에 마운트하는데 라우터 내부 경로도 '/sessions...' 로 시작
 *   → 실제 유효 경로가 /api/chat/sessions/sessions 가 되어 프론트 호출 전부 404 (이력 저장 전멸,
 *   미스매치 요청이 /api/chat 마운트로 흘러 chat dailyLimit 까지 오소모). 내부 경로에서 prefix 제거.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
const { getUserScopedClient: userScopedClient } = require('../db/client');

const router = express.Router();

const MAX_TITLE_LEN = 60;
const MAX_CONTENT_LEN = 8000; // LLM 응답 1회 상한 + 여유
const SESSIONS_LIMIT = 30;
const MESSAGES_LIMIT = 200;
// 컨텍스트 무결성 (2026-05): 클라이언트가 system role 메시지를 저장하지 못하도록 user|assistant 만 허용
const ALLOWED_ROLES = new Set(['user', 'assistant']);
// SEC-1030-C2 (보안 감사 2026-10-30): 저장 상한이 없어 로그인 사용자 1명이 세션·메시지·meta 를 무제한으로 쌓아
//   무료 DB(500MB) 를 채울 수 있었다(채우면 전 서비스 읽기 전용). 운영 실측 최대치(사용자당 세션 7·세션당 메시지 20·
//   meta 전부 빈 객체, 2026-10-30)의 수십 배로 잡는다. 메시지 상한은 GET 이 읽는 개수(MESSAGES_LIMIT)와 같다 —
//   그 너머는 저장해도 다시 보이지 않는다. meta 는 프런트가 보내지 않는다(빈 객체 기본).
const MAX_SESSIONS_PER_USER = 200;
const MAX_MESSAGES_PER_SESSION = MESSAGES_LIMIT;
const MAX_META_BYTES = 2048;


router.use(requireAuth);

// ── GET / (마운트 /api/chat/sessions) ─────────────────────
router.get('/', async (req, res, next) => {
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

// ── POST / ────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const title = String(req.body?.title || '새 대화').trim().slice(0, MAX_TITLE_LEN);
    const sb = userScopedClient(req.accessToken);
    // SEC-1030-C2: 사용자당 세션 수 상한 (RLS 로 본인 행만 센다)
    const { count, error: cntErr } = await sb
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true });
    if (cntErr) throw cntErr;
    if ((count || 0) >= MAX_SESSIONS_PER_USER) {
      return res.status(429).json({ error: '저장할 수 있는 대화 수를 넘었어요. 지난 대화를 지운 뒤 다시 시도해 주세요.', code: 'chat_session_cap' });
    }
    const { data, error } = await sb
      .from('chat_sessions')
      .insert({ user_id: req.user.id, title })
      .select('id, title, last_message_at, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// ── PATCH /:id — 제목 변경 ────────────────────────────────
router.patch('/:id', async (req, res, next) => {
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
router.delete('/:id', async (req, res, next) => {
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

// ── GET /:id/messages ─────────────────────────────────────
router.get('/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const sb = userScopedClient(req.accessToken);
    // RLS 가 세션 소유권 확인해줌 — 존재성만 별도로 안 묻고 바로 messages 조회
    // Phase 34 #7 (2026-05-04, Agent 3차 #7): tie-break — 동일 microsecond 시 id 순서로 결정성 보장
    //   기존: .order('created_at', asc) — same microsecond user-assistant 쌍 비결정 정렬 risk
    //   변경: .order('id', asc) 추가 — UUID 정렬 안정 (insertion 시간 tie 시 일관성)
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, role, content, meta, created_at')
      .eq('session_id', id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MESSAGES_LIMIT);
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (e) { next(e); }
});

// ── POST /sessions/:id/messages ───────────────────────────
// body: { role, content, meta?, clientMsgId? }
// Phase 4.3: clientMsgId(UUID) 전송 시 같은 (session, clientMsgId) 중복 INSERT → 기존 행 반환 (idempotent)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role, content, meta, clientMsgId } = req.body || {};
    if (!role || !ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: `role 은 ${[...ALLOWED_ROLES].join('|')} 중 하나` });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content 필수 (string)' });
    }
    const trimmed = content.slice(0, MAX_CONTENT_LEN);
    // SEC-1030-C2: meta 는 일반 객체 + 직렬화 2KB 이하만
    if (meta != null && (typeof meta !== 'object' || Array.isArray(meta)
        || Buffer.byteLength(JSON.stringify(meta), 'utf8') > MAX_META_BYTES)) {
      return res.status(400).json({ error: 'meta 형식이 올바르지 않아요.' });
    }
    const validClientId = clientMsgId && UUID_RE.test(String(clientMsgId).trim()) ? String(clientMsgId).trim() : null;
    const sb = userScopedClient(req.accessToken);

    // Idempotency: 같은 client_msg_id 가 이미 있으면 그 행을 그대로 반환
    if (validClientId) {
      const { data: existing } = await sb
        .from('chat_messages')
        .select('id, created_at')
        .eq('session_id', id)
        .eq('client_msg_id', validClientId)
        .maybeSingle();
      if (existing) {
        return res.status(200).json({ id: existing.id, createdAt: existing.created_at, dedup: true });
      }
    }

    // SEC-1030-C2: 세션당 메시지 수 상한 (RLS 로 남의 세션은 0 으로 보이고, 아래 INSERT 가 404 로 막는다)
    const { count: msgCount, error: msgCntErr } = await sb
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', id);
    if (msgCntErr) throw msgCntErr;
    if ((msgCount || 0) >= MAX_MESSAGES_PER_SESSION) {
      return res.status(429).json({ error: '한 대화에 저장할 수 있는 메시지 수를 넘었어요. 새 대화를 시작해 주세요.', code: 'chat_message_cap' });
    }

    // 메시지 INSERT — RLS WITH CHECK 가 세션 소유권 검증
    const insertRow = { session_id: id, role, content: trimmed, meta: meta || {} };
    if (validClientId) insertRow.client_msg_id = validClientId;
    const { data: msg, error: msgErr } = await sb
      .from('chat_messages')
      .insert(insertRow)
      .select('id, created_at')
      .single();
    if (msgErr) {
      // 23505 = unique_violation (client_msg_id 동시 INSERT race) — 기존 행 재조회
      if (msgErr.code === '23505' && validClientId) {
        const { data: row } = await sb
          .from('chat_messages')
          .select('id, created_at')
          .eq('session_id', id)
          .eq('client_msg_id', validClientId)
          .maybeSingle();
        if (row) return res.status(200).json({ id: row.id, createdAt: row.created_at, dedup: true });
      }
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
module.exports._limits = { MAX_SESSIONS_PER_USER, MAX_MESSAGES_PER_SESSION, MAX_META_BYTES };
