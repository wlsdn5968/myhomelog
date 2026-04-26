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
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();
router.use(requireAuth);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function _client(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return userScopedClient(token);
}

// GET / — 내 모든 노트
router.get('/', async (req, res) => {
  try {
    const sb = _client(req);
    const { data, error } = await sb.from('field_notes').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (e) {
    logger.warn({ err: e.message }, 'field-notes GET 실패');
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
      .eq('apt_name', req.params.aptName)
      .maybeSingle();
    if (error) throw error;
    res.json({ note: data });
  } catch (e) {
    res.status(500).json({ error: '조회 실패' });
  }
});

// PUT /:aptName — upsert
router.put('/:aptName', async (req, res) => {
  const { checks, rating, memo, visitDate } = req.body || {};
  try {
    const sb = _client(req);
    const payload = {
      apt_name: req.params.aptName,
      checks: Array.isArray(checks) ? checks : [],
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
    res.status(500).json({ error: '저장 실패' });
  }
});

// DELETE /:aptName
router.delete('/:aptName', async (req, res) => {
  try {
    const sb = _client(req);
    const { error } = await sb.from('field_notes').delete().eq('apt_name', req.params.aptName);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '삭제 실패' });
  }
});

module.exports = router;
