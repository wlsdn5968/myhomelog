/**
 * 임장노트 클라우드 동기화 (Phase 4, 2026-04-26)
 *
 * 기존: localStorage only → 기기 변경 시 분실
 * 신규: 로그인 사용자는 DB 자동 sync, 비로그인은 localStorage 유지
 *
 * Endpoints:
 *   GET    /api/field-notes              — 내 모든 노트 list
 *   GET    /api/field-notes/:aptName     — 특정 단지 노트
 *   PUT    /api/field-notes/:aptName     — upsert (checks/rating/memo/visit_date)
 *   DELETE /api/field-notes/:aptName     — 삭제
 *
 * 인증: requireAuth (JWT 필수, RLS 자동)
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');
const { captureRouteError: _cap } = require('../utils/captureError'); // SENTRY-GAP (Sprint XXXXX)
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
const { getUserScopedClient: userScopedClient } = require('../db/client');

const router = express.Router();
router.use(requireAuth);

function _client(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return userScopedClient(token);
}

// GET / — 내 모든 노트
router.get('/', async (req, res) => {
  try {
    const sb = _client(req);
    const { data, error } = await sb.from('field_notes').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (e) {
    logger.warn({ err: e.message }, 'field-notes GET 실패');
    _cap(e, 'field-notes/list'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: '조회 실패' });
  }
});

// GET /:aptName — 특정 단지
router.get('/:aptName', async (req, res) => {
  try {
    const sb = _client(req);
    const { data, error } = await sb
      .from('field_notes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('apt_name', req.params.aptName)
      .maybeSingle();
    if (error) throw error;
    res.json({ note: data });
  } catch (e) {
    logger.warn({ err: e.message }, 'field-notes GET(:aptName) 실패'); // SENTRY-GAP: 무로그였던 catch — 로깅+캡처 추가
    _cap(e, 'field-notes/get');
    res.status(500).json({ error: '조회 실패' });
  }
});

// PUT /:aptName — upsert
// AUDIT4-1114 (user-owned-tables-unbounded-rows-and-size): 단지 이름을 바꿔 가며 행을 무한히 만들 수 있었고 checks 는 길이 제한이 없었다.
//   이름 100자, checks 50개(각 200자), 사용자당 300개로 묶는다(운영 실측 2026-11-14: 현장 메모 0행).
const FIELD_NOTE_MAX = 300;
router.put('/:aptName', async (req, res) => {
  const { checks, rating, memo, visitDate } = req.body || {};
  try {
    const sb = _client(req);
    // 독립 검토(2026-11-14) 반영: 잘라서 저장하면 GET/DELETE(원문 이름)와 어긋나므로 100자를 넘으면 거절한다
    const aptName = String(req.params.aptName || '');
    if (!aptName || aptName.length > 100) return res.status(400).json({ error: '단지 이름은 1~100자여야 해요.' });
    const { data: exists } = await sb.from('field_notes').select('apt_name').eq('user_id', req.user.id).eq('apt_name', aptName).limit(1);
    if (!(exists && exists.length)) {
      const { count, error: cErr } = await sb.from('field_notes').select('apt_name', { count: 'exact', head: true }).eq('user_id', req.user.id);
      if (cErr) throw cErr;
      if ((count || 0) >= FIELD_NOTE_MAX) return res.status(429).json({ error: `현장 메모는 ${FIELD_NOTE_MAX}개까지 저장할 수 있어요.`, code: 'field_note_cap' });
    }
    const payload = {
      apt_name: aptName,
      checks: Array.isArray(checks)
        ? checks.slice(0, 50)
          .map((c) => (typeof c === 'string' ? c.slice(0, 200) : c))
          .filter((c) => typeof c !== 'object' || c === null || JSON.stringify(c).length <= 400)
        : [],
      rating: rating ? Math.max(0, Math.min(5, parseInt(rating))) : null,
      memo: typeof memo === 'string' ? memo.slice(0, 2000) : null,
      visit_date: visitDate || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from('field_notes').upsert({ ...payload, user_id: req.user.id }, { onConflict: 'user_id,apt_name' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, 'field-notes PUT 실패');
    _cap(e, 'field-notes/put'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: '저장 실패' });
  }
});

// DELETE /:aptName
router.delete('/:aptName', async (req, res) => {
  try {
    const sb = _client(req);
    const { error } = await sb.from('field_notes').delete().eq('user_id', req.user.id).eq('apt_name', req.params.aptName);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, 'field-notes DELETE 실패'); // SENTRY-GAP: 무로그였던 catch — 로깅+캡처 추가
    _cap(e, 'field-notes/delete');
    res.status(500).json({ error: '삭제 실패' });
  }
});

module.exports = router;
