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

// ── kapt_code normalize ────────────────────────────────────
// P1 (2026-04-25): 동명 단지(래미안 등) 충돌 방지
//   - 기존: 프론트가 `b.aptName` 을 kapt_code 로 보냄 → "래미안" UNIQUE 충돌로
//     서로 다른 구의 동일명 단지를 한 사용자가 두 번 저장 불가
//   - 개선: 정확한 식별자 (K-apt code 또는 MOLIT aptSeq) 우선,
//     없으면 (이름+주소) 합성 키로 정규화
//   - 백엔드 단일 normalize 로 프론트 변경 없이도 안전망
//
// 매칭 규칙 (우선순위):
//   1) ^[A-Z]\d{6,}$       — K-apt 공식 (예: A10020255)
//   2) ^\d{5}-\d+$          — MOLIT aptSeq (예: 11680-102)
//   3) composite:NAME|ADDR  — 이미 정규화된 합성 키 (프론트가 미리 만든 경우)
//   4) 그 외                 — display_name+address 로 composite 생성
function _normCompositePart(s) {
  return String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
}
function normalizeKaptCode(item) {
  const raw = String(item.kapt_code || '').trim();
  if (!raw) return null;
  if (/^[A-Z]\d{6,}$/.test(raw)) return raw;
  if (/^\d{5}-\d+$/.test(raw)) return raw;
  if (raw.startsWith('composite:')) return raw;
  const name = item.display_name || raw;
  const addr = item.address || '';
  return `composite:${_normCompositePart(name)}|${_normCompositePart(addr)}`;
}

// ── GET: 본인 북마크 전체 ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('bookmarks')
      .select('id, kapt_code, display_name, address, memo, tags, avg_price, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ bookmarks: data || [] });
  } catch (e) { next(e); }
});

// ── POST: 신규 북마크 ────────────────────────────────────
// P1 (Agent 3차 audit, 2026-05-04): bookmarks PII 차단 — memo/address 에 주민번호·계좌 입력 차단
//   사용자 음성 입력 시 무심결 PII 입력 → DB 평문 저장 + JSON export 시 노출 risk
const _PII_RE = /(\d{6}\s*-\s*[1-4]\d{6}|\d{3,4}-\d{3,4}-\d{4}|\d{4}-\d{2,4}-\d{2,4}-\d{4})/;
function _detectPII(s) { return typeof s === 'string' && _PII_RE.test(s); }

router.post('/', async (req, res, next) => {
  try {
    const { kapt_code, display_name, address, memo, tags, avg_price } = req.body || {};
    if (!kapt_code || !display_name) {
      return res.status(400).json({ error: 'kapt_code, display_name 필수' });
    }
    // P1 (Agent 3차): PII 차단 + 길이 제한
    if (_detectPII(memo) || _detectPII(address)) {
      return res.status(400).json({
        error: '메모·주소에 주민번호·계좌·카드 같은 개인정보는 입력하지 말아주세요.',
        code: 'pii_blocked',
      });
    }
    const sb = userScopedClient(req.accessToken);
    const normalizedKapt = normalizeKaptCode({ kapt_code, display_name, address });
    if (!normalizedKapt) return res.status(400).json({ error: 'kapt_code 정규화 실패' });
    const { data, error } = await sb
      .from('bookmarks')
      .insert({
        user_id: req.user.id, // RLS 가 동일성 검증
        kapt_code: normalizedKapt,
        display_name: String(display_name).trim(),
        address: address ? String(address).slice(0, 200) : null, // 길이 제한
        memo: memo ? String(memo).slice(0, 500) : null, // P1: 500자 제한
        tags: Array.isArray(tags) ? tags.slice(0, 20).map(String) : [],
        avg_price: typeof avg_price === 'number' && isFinite(avg_price) ? avg_price : null,
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
    const { memo, tags, display_name, address, avg_price } = req.body || {};
    const patch = {};
    if (memo !== undefined) patch.memo = memo || null;
    if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.slice(0, 20).map(String) : [];
    if (display_name !== undefined) patch.display_name = String(display_name).trim();
    if (address !== undefined) patch.address = address || null;
    if (avg_price !== undefined) patch.avg_price = typeof avg_price === 'number' && isFinite(avg_price) ? avg_price : null;
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
        kapt_code: normalizeKaptCode(it),  // P1: 동명 단지 충돌 방지
        display_name: String(it.display_name).trim(),
        address: it.address || null,
        memo: it.memo || null,
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 20).map(String) : [],
        avg_price: typeof it.avg_price === 'number' && isFinite(it.avg_price) ? it.avg_price : null,
      }))
      .filter(r => r.kapt_code);  // normalize 실패 항목 제외

    // BATCH-DEDUP (Sprint HHHHHH, Sentry NODE-8 실측): 클라 로컬에 같은 단지가 중복이면 normalize 후
    //   같은 kapt_code 가 한 배치에 2행 → Postgres 21000 "ON CONFLICT cannot affect row a second time".
    //   배치 내 마지막 항목(최신) 승리로 사전 dedup.
    const _byKey = new Map();
    for (const r of rows) _byKey.set(r.kapt_code, r);
    const dedupedRows = [..._byKey.values()];

    if (dedupedRows.length === 0) return res.json({ migrated: 0, skipped: items.length, items: [] });

    const sb = userScopedClient(req.accessToken);
    // upsert on (user_id, kapt_code) — 중복은 갱신 (PIPA 관점에서 user_id 일치만 보장)
    // 반환 컬럼: 클라가 _serverId 매핑할 수 있도록 전체 필드 반환
    const { data, error } = await sb
      .from('bookmarks')
      .upsert(dedupedRows, { onConflict: 'user_id,kapt_code', ignoreDuplicates: false })
      .select('id, kapt_code, display_name, address, memo, tags, avg_price, created_at, updated_at');
    if (error) throw error;

    logger.info({ userId: req.user.id, migrated: data?.length || 0 }, '북마크 이관');
    res.json({ migrated: data?.length || 0, skipped: items.length - rows.length, items: data || [] });
  } catch (e) { next(e); }
});

module.exports = router;
