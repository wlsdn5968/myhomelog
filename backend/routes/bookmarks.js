/**
 * 북마크 CRUD API
 *
 * 보안 모델:
 *   - 모든 엔드포인트는 requireAuth (JWT 필수)
 *   - Supabase 클라이언트 생성 시 사용자 JWT 를 헤더에 주입 → RLS 자동 적용
 *   - 즉, 백엔드가 user_id 를 위조해도 Postgres RLS 가 차단
 *
 * 엔드포인트:
 *   GET    /api/bookmarks         — 본인 북마크 전체
 *   POST   /api/bookmarks         — 신규 (kapt_code 중복 시 409)
 *   PATCH  /api/bookmarks/:id     — memo/tags 업데이트
 *   DELETE /api/bookmarks/:id     — 삭제
 *   POST   /api/bookmarks/migrate — localStorage 일괄 이관 (upsert, 멱등)
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

// 사용자 JWT 가 주입된 Supabase 클라이언트 (요청별)
// → PostgREST 가 JWT 의 sub 를 auth.uid() 로 사용 → RLS 정책 자동 적용
function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Supabase 미설정');
  }
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// 모든 라우트 인증 필수
router.use(requireAuth);

// ── GET: 본인 북마크 전체 ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('bookmarks')
      .select('id, kapt_code, display_name, address, memo, tags, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ bookmarks: data || [] });
  } catch (e) { next(e); }
});

// ── POST: 신규 북마크 ────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { kapt_code, display_name, address, memo, tags } = req.body || {};
    if (!kapt_code || !display_name) {
      return res.status(400).json({ error: 'kapt_code, display_name 필수' });
    }
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('bookmarks')
      .insert({
        user_id: req.user.id, // RLS 가 동일성 검증
        kapt_code: String(kapt_code).trim(),
        display_name: String(display_name).trim(),
        address: address || null,
        memo: memo || null,
        tags: Array.isArray(tags) ? tags.slice(0, 20).map(String) : [],
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: '이미 추가된 단지입니다.' });
      throw error;
    }
    res.status(201).json({ bookmark: data });
  } catch (e) { next(e); }
});

// ── PATCH: 북마크 부분 업데이트 ──────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { memo, tags, display_name, address } = req.body || {};
    const patch = {};
    if (memo !== undefined) patch.memo = memo || null;
    if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.slice(0, 20).map(String) : [];
    if (display_name !== undefined) patch.display_name = String(display_name).trim();
    if (address !== undefined) patch.address = address || null;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '업데이트할 필드 없음' });
    }
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('bookmarks')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '북마크를 찾을 수 없음' });
    res.json({ bookmark: data });
  } catch (e) { next(e); }
});

// ── DELETE: 북마크 삭제 ──────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const sb = userScopedClient(req.accessToken);
    const { error } = await sb.from('bookmarks').delete().eq('id', id);
    if (error) throw error;
    res.status(204).end();
  } catch (e) { next(e); }
});

// ── POST: localStorage 일괄 이관 (멱등 upsert) ───────────
// body: { items: [{ kapt_code, display_name, address?, memo?, tags? }, ...] }
router.post('/migrate', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.json({ migrated: 0, skipped: 0 });
    if (items.length > 200) return res.status(413).json({ error: '한 번에 200개 초과 불가' });

    const rows = items
      .filter(it => it && it.kapt_code && it.display_name)
      .map(it => ({
        user_id: req.user.id,
        kapt_code: String(it.kapt_code).trim(),
        display_name: String(it.display_name).trim(),
        address: it.address || null,
        memo: it.memo || null,
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 20).map(String) : [],
      }));

    if (rows.length === 0) return res.json({ migrated: 0, skipped: items.length });

    const sb = userScopedClient(req.accessToken);
    // upsert on (user_id, kapt_code) — 중복은 갱신 (PIPA 관점에서 user_id 일치만 보장)
    const { data, error } = await sb
      .from('bookmarks')
      .upsert(rows, { onConflict: 'user_id,kapt_code', ignoreDuplicates: false })
      .select('id');
    if (error) throw error;

    logger.info({ userId: req.user.id, migrated: data?.length || 0 }, '북마크 이관');
    res.json({ migrated: data?.length || 0, skipped: items.length - rows.length });
  } catch (e) { next(e); }
});

module.exports = router;
