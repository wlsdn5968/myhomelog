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
const { resolveFacility } = require('../services/aptFacilityService');

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
    // Phase 4 (2026-04-26): molit_transactions + apt_master 두 출처 병합 검색.
    //   1) molit: 실거래 있는 단지 (recent deal_date·build_year 노출 — 우선)
    //   2) apt_master: 거래 0건 단지도 검색에 노출 (기존엔 영원히 안 나옴)
    //   같은 단지가 두 출처에 모두 있으면 molit 우선 (거래 정보 풍부).
    const [molitRes, masterRes] = await Promise.all([
      admin.from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date')
        .or(`apt_name.ilike.%${q}%,umd_nm.ilike.%${q}%`)
        .order('deal_date', { ascending: false })
        .limit(limit * 5),
      admin.from('apt_master')
        .select('apt_name, sigungu, umd_nm, lawd_cd, kapt_code')
        .or(`apt_name.ilike.%${q}%,umd_nm.ilike.%${q}%`)
        .limit(limit * 3),
    ]);
    if (molitRes.error) throw molitRes.error;
    if (masterRes.error) {
      // apt_master 미존재/접근 실패는 fallback (molit 만 사용)
      logger.warn({ err: masterRes.error.message }, 'apt_master 조회 실패 — molit only');
    }

    const seen = new Set();
    const out = [];
    // molit 우선 (실거래 있는 단지)
    for (const row of (molitRes.data || [])) {
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
        source: 'molit',
      });
      if (out.length >= limit) break;
    }
    // apt_master 보충 (거래 0건 단지)
    if (out.length < limit) {
      for (const row of (masterRes.data || [])) {
        const key = `${row.apt_name}|${row.sigungu}|${row.umd_nm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          aptName: row.apt_name,
          sigungu: row.sigungu,
          umdNm: row.umd_nm,
          lawdCd: row.lawd_cd,
          buildYear: null,
          recentDealDate: null,
          kaptCode: row.kapt_code,
          source: 'master',
        });
        if (out.length >= limit) break;
      }
    }

    // Phase 4 (2026-04-26): master 단지 buildYear/recentDealDate 토큰 매칭 자동 채우기
    // 사용자 지적: '왜 ?년 이지? 정보 못 찾았냐?' — apt_master 에 build_year 컬럼 없음.
    // 같은 (lawd_cd, umd_nm) molit_transactions 중 토큰 매칭 단지의 buildYear/dealDate 사용.
    const masterEmpty = out.filter(r => r.source === 'master' && !r.buildYear && r.lawdCd && r.umdNm);
    if (masterEmpty.length) {
      // 같은 (lawd_cd, umd_nm) 그룹 별 1번 fetch
      const groups = {};
      for (const r of masterEmpty) {
        const gk = `${r.lawdCd}|${r.umdNm}`;
        if (!groups[gk]) groups[gk] = { lawdCd: r.lawdCd, umdNm: r.umdNm, items: [] };
        groups[gk].items.push(r);
      }
      await Promise.all(Object.values(groups).map(async g => {
        const { data: txs } = await admin
          .from('molit_transactions')
          .select('apt_name, build_year, deal_date')
          .eq('lawd_cd', g.lawdCd).eq('umd_nm', g.umdNm)
          .order('deal_date', { ascending: false })
          .limit(200);
        if (!txs?.length) return;
        // distinct apt_name (가장 최근 거래의 build_year 사용)
        const aptInfo = {};
        for (const t of txs) {
          if (!aptInfo[t.apt_name]) aptInfo[t.apt_name] = { build_year: t.build_year, deal_date: t.deal_date };
        }
        for (const m of g.items) {
          // 정식명에서 핵심 토큰 추출 (3글자 이상)
          const baseName = m.aptName
            .replace(new RegExp(`^(${m.sigungu||''}|${m.umdNm||''})\\s*`, 'g'), '')
            .replace(/\s+/g, '');
          const tokens = [];
          for (let len = 4; len >= 3; len--) {
            for (let i = 0; i <= baseName.length - len; i++) {
              const t = baseName.substring(i, i + len);
              if (!tokens.includes(t)) tokens.push(t);
            }
          }
          // 최고 점수 단지 찾기
          let best = null, bestScore = 0;
          for (const [aptName, info] of Object.entries(aptInfo)) {
            let score = 0;
            for (const tok of tokens) {
              if (aptName.includes(tok)) score = Math.max(score, tok.length);
            }
            if (score > bestScore) { best = info; bestScore = score; }
          }
          if (best && bestScore >= 3) {
            m.buildYear = best.build_year;
            m.recentDealDate = best.deal_date;
          }
        }
      }));
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

// ── GET /api/search/in-bounds — 지도 영역 단지 조회 (Phase 4, 2026-04-26) ──
//   ?south=&west=&north=&east=&limit= → apt_geocache 좌표 기반 영역 필터
//   사용자가 지도 panning 후 "이 영역 단지 보기" 클릭 → 호갱노노 패턴
router.get('/in-bounds', async (req, res) => {
  const south = parseFloat(req.query.south);
  const west = parseFloat(req.query.west);
  const north = parseFloat(req.query.north);
  const east = parseFloat(req.query.east);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  if (!south || !west || !north || !east) return res.status(400).json({ error: 'bounds 필수' });
  if (north - south > 1 || east - west > 1) return res.status(400).json({ error: '영역 너무 큼 (1도 이내)' });

  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });

  try {
    // apt_geocache 좌표 범위 필터 + molit_transactions 평균가 join
    const { data: coords, error } = await admin
      .from('apt_geocache')
      .select('apt_name, sigungu, umd_nm, lat, lng')
      .gte('lat', south).lte('lat', north)
      .gte('lng', west).lte('lng', east)
      .limit(limit);
    if (error) throw error;
    if (!coords?.length) return res.json({ results: [] });

    // 단지별 최근 거래 평균가 fetch
    const names = [...new Set(coords.map(c => c.apt_name))];
    const { data: txs } = await admin
      .from('molit_transactions')
      .select('apt_name, deal_amount, build_year, deal_date, lawd_cd')
      .in('apt_name', names)
      .gte('deal_date', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0,10))
      .order('deal_date', { ascending: false })
      .limit(500);
    const aptStats = {};
    for (const t of (txs || [])) {
      if (!aptStats[t.apt_name]) aptStats[t.apt_name] = { sum: 0, n: 0, buildYear: t.build_year, lawdCd: t.lawd_cd };
      aptStats[t.apt_name].sum += t.deal_amount || 0;
      aptStats[t.apt_name].n++;
    }

    const out = coords.map(c => {
      const s = aptStats[c.apt_name];
      return {
        aptName: c.apt_name,
        sigungu: c.sigungu,
        umdNm: c.umd_nm,
        lat: Number(c.lat),
        lng: Number(c.lng),
        avgPrice: s ? +(s.sum / s.n / 10000).toFixed(2) : 0,
        buildYear: s?.buildYear || null,
        lawdCd: s?.lawdCd || null,
      };
    });
    res.json({ results: out, count: out.length });
  } catch (e) {
    logger.warn({ err: e.message }, '영역 검색 실패');
    res.status(500).json({ error: '영역 검색 실패' });
  }
});

// ── GET /api/search/facility — 단지 상세 풍부화 (Phase 4, 2026-04-26) ──
//   인증 불필요 (단지 공공정보) — requireAuth 앞에 마운트
router.get('/facility', async (req, res) => {
  const aptName = String(req.query.aptName || '').trim();
  const sigungu = String(req.query.sigungu || '').trim() || null;
  const umdNm = String(req.query.umdNm || '').trim() || null;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });

  try {
    const facility = await resolveFacility({ aptName, sigungu, umdNm });

    // 같은 동의 다른 MOLIT 단지명 — alias 후보 (사용자 표시용)
    // Phase 4 (2026-04-26): 토큰 매칭 우선순위 — 정식명 핵심 단어가 MOLIT 신고명에 포함되면
    //   같은 단지일 가능성 높음 (예: '공릉풍림아이원' 의 '풍림' → '풍림아파트A/B' 우선).
    //   이전: 거래량 순 50건 안에 풍림아파트B(14건) 누락 → 사용자 거래 누락.
    let altCandidates = [];
    if (sigungu && umdNm) {
      const { data: alts } = await admin
        .from('molit_transactions')
        .select('apt_name, build_year')
        .eq('sigungu', sigungu)
        .eq('umd_nm', umdNm)
        .neq('apt_name', aptName)
        .limit(500);
      const seen = new Set();
      // 정식명에서 핵심 토큰 추출 (행정구역 prefix 제거 후 길이 2+ 단어들)
      const baseName = aptName
        .replace(new RegExp(`^(${sigungu}|${umdNm})\\s*`, 'g'), '')
        .replace(/\s+/g, '');
      // 부분 문자열 (3+ 글자) 추출 — '공릉풍림아이원' → ['풍림', '아이원', '풍림아이원']
      const tokens = [];
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= baseName.length - len; i++) {
          const t = baseName.substring(i, i + len);
          if (!tokens.includes(t)) tokens.push(t);
        }
      }
      const candidates = [];
      for (const r of (alts || [])) {
        if (seen.has(r.apt_name)) continue;
        seen.add(r.apt_name);
        // 토큰 매칭 점수 — 더 긴 토큰 매칭 = 우선
        let score = 0;
        for (const tok of tokens) {
          if (tok.length >= 3 && r.apt_name.includes(tok)) score = Math.max(score, tok.length);
        }
        // Phase 4 (2026-04-26): score >= 3 (3글자 이상 매칭) 만 진짜 alias 후보.
        // 이전: score 0도 포함 → '67디벨리움', '건영아파트' 같은 무관 단지가 alias 매칭됨.
        // '공릉풍림아이원' 의 '풍림아' (3글자) 가 '풍림아파트A/B' 와 매칭 — 정확.
        if (score >= 3) {
          candidates.push({ aptName: r.apt_name, buildYear: r.build_year, _score: score });
        }
      }
      // 점수 ↓ → 단지명 ↑ 정렬, 상위 8개 (12 → 8 — false positive 차단)
      candidates.sort((a, b) => b._score - a._score || a.aptName.localeCompare(b.aptName));
      altCandidates = candidates.slice(0, 8).map(({ _score, ...c }) => c);
    }
    res.json({ facility, altCandidates });
  } catch (e) {
    logger.warn({ err: e.message, aptName }, 'facility 조회 실패');
    res.status(500).json({ error: 'facility 조회 실패' });
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
