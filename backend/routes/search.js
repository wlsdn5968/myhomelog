/**
 * 검색 이력 API (search_history)
 *
 * 보안:
 *   - 모든 엔드포인트 requireAuth (JWT 필수)
 *   - userScopedClient 로 생성 → RLS 자동 적용 ((select auth.uid()) = user_id)
 *
 * 엔드포인트:
 *   POST /api/search/history  — 검색 1건 기록 (fire-and-forget)
 *   GET  /api/search/history  — 최근 50건 (최신순)
 *   DELETE /api/search/history — 내 이력 전체 삭제
 *
 * 설계 노트:
 *   - 북마크와 달리 "로컬 캐시 + 서버 진실" 이중화 안 함 — 검색 로그는
 *     서버 전용. 비로그인 시엔 그냥 기록 안 함 (401 삼키고 진행).
 *   - queryType 허용 값: 'recommend' | 'address' | 'kapt' | 'keyword'
 *   - resultCount 는 선택. 0 은 "결과 없음" 을 명시적으로 기록하는 의미.
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');
const { resolveCoordBatch } = require('../services/geocodeCacheService');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

const ALLOWED_TYPES = new Set(['recommend', 'address', 'kapt', 'keyword']);
const MAX_QUERY_LEN = 200;
const HISTORY_LIMIT = 50;

function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── GET: 단지명·동명 검색 (자동완성) — 인증 불필요 (공개 데이터) ──
// P0 (2026-04-25 Phase 2 시나리오 A): 호갱노노 핵심 사용 패턴 — 단지명 직접 검색.
// molit_transactions 의 pg_trgm 인덱스 (idx_molit_aptname_trgm) 활용 — ILIKE 고속.
function adminClient() {
  if (!SUPABASE_URL) return null;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.service_role;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
router.get('/apt', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);
  if (q.length < 1) return res.json({ results: [] });
  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '검색 서비스 일시 불가' });
  try {
    // 단지명 + 동명 동시 매칭 — 사용자가 "공덕" 입력 시 "공덕동" + "공덕래미안" 모두 노출
    // DISTINCT 처리 + 최근 거래일 우선
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date')
      .or(`apt_name.ilike.%${q}%,umd_nm.ilike.%${q}%`)
      .order('deal_date', { ascending: false })
      .limit(limit * 5); // 중복 제거 후 상위 limit 추출
    if (error) throw error;
    const seen = new Set();
    const out = [];
    for (const row of (data || [])) {
      const key = `${row.apt_name}|${row.sigungu}|${row.umd_nm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        aptName: row.apt_name,
        sigungu: row.sigungu,
        umdNm: row.umd_nm,
        lawdCd: row.lawd_cd,
        buildYear: row.build_year,
        recentDealDate: row.deal_date,
      });
      if (out.length >= limit) break;
    }
    res.json({ results: out, query: q });
  } catch (e) {
    logger.warn({ err: e.message, q }, '단지 검색 실패');
    res.status(500).json({ error: '검색 실패', detail: e.message });
  }
});

// ── GET: 인기 단지 (마커 prefill) — 인증 불필요 ──────────
// P0 (Phase 2 3-2): 첫 진입 시 빈 지도 첫인상 차단.
// 최근 60일 거래량 top 단지 + apt_geocache 좌표 보유 단지.
router.get('/popular', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 30);
  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });
  try {
    // 최근 60일 + 인기 구 (서울 핵심) + 좌표 있는 단지만
    const { data, error } = await admin.rpc('search_popular_apts', { p_limit: limit }).single().then(
      r => ({ data: r.data ? [r.data] : [], error: r.error }),
      () => ({ data: null, error: { message: 'rpc fallback' } })
    ).catch(() => ({ data: null, error: { message: 'rpc fallback' } }));
    // RPC 실패 시 단순 query fallback
    if (error || !data) {
      const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: rows, error: e2 } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date, deal_amount')
        .gte('deal_date', sinceIso)
        .in('sigungu', ['강남구','서초구','송파구','마포구','성동구','용산구','강동구'])
        .order('deal_date', { ascending: false })
        .limit(200);
      if (e2) throw e2;
      // apt_name 별 거래수 집계
      const byApt = {};
      for (const r of (rows||[])) {
        const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
        if (!byApt[k]) byApt[k] = { ...r, count: 0, latest: r.deal_date };
        byApt[k].count++;
        if (r.deal_date > byApt[k].latest) byApt[k].latest = r.deal_date;
      }
      const top = Object.values(byApt).sort((a,b) => b.count - a.count).slice(0, limit);
      // apt_geocache 좌표 join (DB 우선)
      const names = top.map(t => t.apt_name);
      const { data: coords } = await admin.from('apt_geocache')
        .select('apt_name, sigungu, umd_nm, lat, lng')
        .in('apt_name', names);
      const coordMap = new Map();
      for (const c of (coords||[])) {
        coordMap.set(`${c.apt_name}|${c.sigungu||''}|${c.umd_nm||''}`, c);
      }

      // P0 (2026-04-25 Phase 2 후속): 좌표 lazy fill — 인기 단지 중 캐시 miss 만 즉시 geocode.
      //   apt_geocache 가 cold start 시 비어 있으면 popular 마커가 영원히 안 뜸 →
      //   첫 호출만 ~3s 추가 (12건 × 카카오 200~500ms, concurrency=4) 후엔 캐시 hit.
      const missing = [];
      for (const t of top) {
        const k = `${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`;
        if (!coordMap.has(k) && ![...coordMap.values()].find(x => x.apt_name === t.apt_name)) {
          missing.push(t);
        }
      }
      if (missing.length) {
        const filled = await resolveCoordBatch(missing.map(t => ({
          aptName: t.apt_name, sigungu: t.sigungu, umdNm: t.umd_nm,
        })), 4);
        missing.forEach((t, i) => {
          const f = filled[i];
          if (f) coordMap.set(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`, f);
        });
      }

      const out = top.map(t => {
        const c = coordMap.get(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`)
               || coordMap.get(`${t.apt_name}|${t.sigungu||''}|`)
               || [...coordMap.values()].find(x => x.apt_name === t.apt_name);
        return {
          aptName: t.apt_name,
          sigungu: t.sigungu,
          umdNm: t.umd_nm,
          lawdCd: t.lawd_cd,
          buildYear: t.build_year,
          recentDealDate: t.latest,
          dealCount60d: t.count,
          avgDealAmount: t.deal_amount,
          lat: c?.lat ? Number(c.lat) : null,
          lng: c?.lng ? Number(c.lng) : null,
        };
      }).filter(x => x.lat && x.lng);
      return res.json({ results: out });
    }
    res.json({ results: data });
  } catch (e) {
    logger.warn({ err: e.message }, '인기 단지 조회 실패');
    res.status(500).json({ error: '조회 실패' });
  }
});

router.use(requireAuth);

// ── POST: 검색 1건 기록 ────────────────────────────────────
router.post('/history', async (req, res, next) => {
  try {
    const { query, queryType, resultCount } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query 필수 (string)' });
    }
    const qt = String(queryType || 'keyword');
    if (!ALLOWED_TYPES.has(qt)) {
      return res.status(400).json({ error: `queryType 은 ${[...ALLOWED_TYPES].join('|')} 중 하나` });
    }
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('search_history')
      .insert({
        user_id: req.user.id,
        query: String(query).trim().slice(0, MAX_QUERY_LEN),
        query_type: qt,
        result_count: Number.isInteger(resultCount) ? resultCount : null,
      })
      .select('id, created_at')
      .single();
    if (error) throw error;
    res.status(201).json({ id: data.id, createdAt: data.created_at });
  } catch (e) { next(e); }
});

// ── GET: 최근 50건 ────────────────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('search_history')
      .select('id, query, query_type, result_count, created_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (e) { next(e); }
});

// ── DELETE: 내 이력 전체 삭제 ─────────────────────────────
// 개별 삭제는 의미 없음 — 로그성 데이터
router.delete('/history', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    // RLS 가 본인 row 만 보장하므로 user_id 필터는 불필요하지만
    // 안전망으로 명시 (방어적 코딩 — RLS 실수 시 피해 최소화)
    const { error } = await sb
      .from('search_history')
      .delete()
      .eq('user_id', req.user.id);
    if (error) throw error;
    logger.info({ userId: req.user.id }, '검색 이력 전체 삭제');
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
