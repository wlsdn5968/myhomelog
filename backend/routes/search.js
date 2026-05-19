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
const { resolveCoordBatch, resolveCoord } = require('../services/geocodeCacheService');
const { resolveFacility } = require('../services/aptFacilityService');
const { resolveSchools } = require('../services/schoolService');
// STAB-AUDIT-2026-05-07 P1: 학교알리미 NEIS API 통합 — 학생수·학급수
const { resolveSchoolNeisBatch } = require('../services/schoolNeisService');
// STAB-AUDIT-2026-05-07 P2: 학구도 (배정 초·중) 매핑
const { resolveSchoolDistrict } = require('../services/schoolDistrictService');
// Sprint OO (2026-05-19): 강연 자료 적용 — 학군 권역 + 학원가
const { resolveSchoolCluster } = require('../services/schoolClusterService');
const { resolveAcademies } = require('../services/academyService');
// NAMEFIX-2026-05-11 + FACILITY-HELPER-2026-05-12: 검색 path 정규화 + facility schema 일관
// NAME-MERGE-2026-05-12 (Sprint S): baseAptName helper 로 동/letter/층 suffix 분리 신고 통합
const { normalizeAptName, baseAptName } = require('../utils/aptName');
const { buildFacility } = require('../utils/buildFacility');

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
    // Phase 21 (2026-05-04): SQL 병목 fix — OR 조건 제거 (umd_nm 인덱스 없음)
    //   진단 (EXPLAIN): apt_name ILIKE OR umd_nm ILIKE → Full Seq Scan (244k rows, 2.3s)
    //   원인: idx_molit_aptname_trgm GIN 있으나 umd_nm GIN 없음 → OR 시 둘 다 인덱스 X
    //   변경: molit_transactions 는 apt_name 만 (인덱스 활용 → ~50ms),
    //         umd_nm (동명) 검색은 apt_master 에 위임 (이미 idx_apt_master_umd_trgm 있음)
    const [molitRes, masterRes] = await Promise.all([
      admin.from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date, apt_seq')
        // APTSEQ-FALLBACK-2026-05-12: apt_seq 추가 — apt_master 미매칭 단지의 KAPT facility 호출용
        // NAME-MERGE-2026-05-12 (Sprint S+): limit *10 → *30 (한 단지가 동/면적 분리로 100+ row
        //   생성 시 일부 raw row 누락되어 grouping 불완전. 상계주공1(고층) 119건 case 검증 발견.
        .ilike('apt_name', `%${q}%`)  // OR 제거 — apt_name 만 (인덱스 활용)
        .order('deal_date', { ascending: false })
        .limit(limit * 30),
      admin.from('apt_master')
        .select('apt_name, sigungu, umd_nm, lawd_cd, kapt_code')
        .or(`apt_name.ilike.%${q}%,umd_nm.ilike.%${q}%`)  // apt_master 는 작아서 OR OK (9.7k rows)
        .limit(limit * 5),  // umd_nm 검색 보강 위해 *3 → *5
    ]);
    if (molitRes.error) throw molitRes.error;
    if (masterRes.error) {
      // apt_master 미존재/접근 실패는 fallback (molit 만 사용)
      logger.warn({ err: masterRes.error.message }, 'apt_master 조회 실패 — molit only');
    }

    // NAME-MERGE-2026-05-12 (Sprint S — 운영자 발견 + 3-source cross-check [VERIFIED]):
    //   MOLIT 가 한 단지를 동/letter/층 suffix 로 분리 신고 → dropdown 에 같은 단지 2+ row.
    //   해결: baseAptName + sigungu + umd_nm + build_year 로 group → 1 row.
    //
    //   group key 에 build_year 포함 이유: false-positive 방어
    //     예) "상계주공1" 1988 (P3 (고층)/(저층) 같이 그룹) vs "상계주공1" 다른 연도 → 별개.
    //   기존 raw_key 도 보관 (seen 매칭 변환 없도록) — dealCount 합산 + apt_seq 대표값 선택.
    //
    //   대표 row 선택:
    //     - aptName: baseAptName 으로 정규화한 결과 (P3 상계주공 1 → "상계주공1", P1 풍림아파트A → "풍림아파트")
    //     - dealCount: 그룹 전체 거래량 합산 (Phase 10 인기 배지 정확)
    //     - recentDealDate: 그룹 내 가장 최근
    //     - buildYear / lawdCd / sigungu / umd_nm: group key 동일
    //     - aptSeq: 거래 가장 많은 row 의 apt_seq (KAPT 직접 호출 대표값)
    //     - aliasNames: 합쳐진 원본 raw 이름들 (운영자 디버깅 + frontend 거래 fetch 시 base 매칭 보강용)
    const aptMap = new Map(); // mergeKey → group state
    for (const row of (molitRes.data || [])) {
      const base = baseAptName(row.apt_name) || normalizeAptName(row.apt_name) || row.apt_name;
      const mergeKey = `${base}|${row.sigungu}|${row.umd_nm}|${row.build_year || ''}`;
      const cur = aptMap.get(mergeKey);
      if (cur) {
        cur.count++;
        if (String(row.deal_date || '') > String(cur.firstRow.deal_date || '')) {
          cur.firstRow = row; // 최신 거래 row 를 firstRow 로 갱신
        }
        // apt_seq 별 거래량 counter (대표 apt_seq 선택용)
        const seqCnt = cur.seqCounts.get(row.apt_seq) || 0;
        cur.seqCounts.set(row.apt_seq, seqCnt + 1);
        // alias raw name 누적 (set 으로 중복 제거)
        cur.rawNames.add(row.apt_name);
      } else {
        const seqCounts = new Map();
        if (row.apt_seq) seqCounts.set(row.apt_seq, 1);
        aptMap.set(mergeKey, {
          count: 1,
          firstRow: row,
          baseName: base,
          seqCounts,
          rawNames: new Set([row.apt_name]),
        });
      }
    }
    // 정렬: (a) 거래량 desc, (b) 최근 거래 desc — 인기 + 최신성 균형
    const sortedMolit = Array.from(aptMap.values())
      .sort((a, b) => (b.count - a.count) || (String(b.firstRow.deal_date||'').localeCompare(String(a.firstRow.deal_date||''))));

    const seen = new Set();
    const out = [];
    // molit 우선 (실거래 있는 단지) — 인기순
    // NAMEFIX-2026-05-11: aptName 표시 시점에 `(고층)/(저층)/(중층)` suffix 제거.
    // NAME-MERGE-2026-05-12 (Sprint S): baseAptName 으로 동/letter 까지 통합.
    for (const grp of sortedMolit) {
      const row = grp.firstRow;
      const key = `${grp.baseName}|${row.sigungu}|${row.umd_nm}|${row.build_year||''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 대표 apt_seq: 거래 가장 많은 raw row 의 것
      let repSeq = row.apt_seq || null;
      let maxSeqCnt = 0;
      for (const [seq, cnt] of grp.seqCounts) {
        if (cnt > maxSeqCnt) { maxSeqCnt = cnt; repSeq = seq; }
      }
      out.push({
        aptName: grp.baseName, // base name 으로 표시 (예: "풍림아파트")
        sigungu: row.sigungu,
        umdNm: row.umd_nm,
        lawdCd: row.lawd_cd,
        buildYear: row.build_year,
        recentDealDate: row.deal_date,
        dealCount: grp.count, // 그룹 전체 거래량 합산
        aptSeq: repSeq, // 대표 apt_seq
        source: 'molit',
        // NAME-MERGE 디버깅 + 거래 fetch 시 base 매칭 보강
        aliasNames: grp.rawNames.size > 1 ? Array.from(grp.rawNames) : undefined,
      });
      if (out.length >= limit) break;
    }
    // apt_master 보충 (거래 0건 단지)
    // NAME-MERGE-2026-05-12 (Sprint S): master 도 동일 baseAptName 기준 dedupe.
    //   master 는 KAPT 정식명 (이미 base form) 이지만, molit 그룹과 collision (같은 base) 시
    //   molit 가 이미 seen 추가했으므로 자동 차단됨.
    if (out.length < limit) {
      for (const row of (masterRes.data || [])) {
        const base = baseAptName(row.apt_name) || normalizeAptName(row.apt_name) || row.apt_name;
        const key = `${base}|${row.sigungu}|${row.umd_nm}|`;  // master 는 buildYear 부재 → 빈 ''
        // molit out 의 seen key 와 collision 체크 (같은 base+sigungu+umd_nm 면 buildYear 무관 dedupe)
        let alreadyInOut = false;
        for (const exist of out) {
          if (exist.aptName === base && exist.sigungu === row.sigungu && exist.umdNm === row.umd_nm) {
            alreadyInOut = true; break;
          }
        }
        if (alreadyInOut) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          aptName: base,
          sigungu: row.sigungu,
          umdNm: row.umd_nm,
          lawdCd: row.lawd_cd,
          buildYear: null,
          recentDealDate: null,
          kaptCode: row.kapt_code,
          aptSeq: row.kapt_code || null, // master 는 kaptCode = aptSeq 동일 (KAPT 표준)
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
        // distinct apt_name + dealCount 누적 (Sprint BB: master 단지 dealCount 일관성)
        const aptInfo = {};
        for (const t of txs) {
          if (!aptInfo[t.apt_name]) aptInfo[t.apt_name] = { build_year: t.build_year, deal_date: t.deal_date, count: 0 };
          aptInfo[t.apt_name].count++;
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
          // 최고 점수 단지 찾기 + 매칭된 모든 단지의 dealCount 합산 (Sprint BB)
          let best = null, bestScore = 0, totalDeals = 0;
          for (const [aptName, info] of Object.entries(aptInfo)) {
            let score = 0;
            for (const tok of tokens) {
              if (aptName.includes(tok)) score = Math.max(score, tok.length);
            }
            if (score >= 3) totalDeals += info.count;
            if (score > bestScore) { best = info; bestScore = score; }
          }
          if (best && bestScore >= 3) {
            m.buildYear = best.build_year;
            m.recentDealDate = best.deal_date;
            // MASTER-DEAL-COUNT-2026-05-13 (Sprint BB — 운영자 발견 일관성):
            //   master dropdown row 도 dealCount 표시 (🔥 배지 등 molit 와 일관)
            //   매칭된 모든 raw apt_name 의 거래 합산
            if (totalDeals > 0) m.dealCount = totalDeals;
          }
        }
      }));
    }

    res.json({ results: out, query: q });
  } catch (e) {
    logger.warn({ err: e.message, q }, '단지 검색 실패');
    // MOB-AUDIT-2026-05-03: production 에선 detail 제거 — 내부 에러 누출 차단
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: '검색 실패',
      ...(isProd ? {} : { detail: e.message }),
    });
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
      // STAB-AUDIT-2026-05-06 (운영자 발견): 동명이지 단지 환각 차단
      //   "대우" 17곳·"현대" 64곳·"벽산" 15곳 등 같은 단지명 다중 위치 → apt_name only fallback 시
      //   다른 구 좌표 매칭 (예: 성동구 금호동4가 "대우" → 구로구 고척동 좌표).
      //   변경: missing 판정과 결과 매핑 모두 (apt_name|sigungu|umd_nm) 정확 키만 허용.
      //   대신 lazy fill 으로 정확한 (sigungu, umd_nm) 키워드로 Kakao 재검색 → apt_geocache 자동 백필.
      const missing = [];
      for (const t of top) {
        const k = `${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`;
        if (!coordMap.has(k)) {  // apt_name only fallback 제거 — 정확 키만 hit
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
        // 환각 차단 (2026-05-06): apt_name only fallback 제거.
        //   매칭 X 시 lat/lng null → filter 단계에서 자동 제외 (잘못된 마커 표시 X).
        const c = coordMap.get(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`);
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

    // MOB-AUDIT-2026-05-04: 거래 0건 단지 (apt_geocache 에 좌표만 있고 molit 매칭 X) 는
    //   avgPrice 0.00억 으로 노출되어 사용자 오인 → 결과에서 제외 (legal 보호)
    //   필요 시 frontend 에 "거래 정보 없음" 별도 표시 추가 가능
    const out = coords.map(c => {
      const s = aptStats[c.apt_name];
      if (!s || !s.n || !s.sum) return null; // 거래 0건 → 제외
      const avg = +(s.sum / s.n / 10000).toFixed(2);
      if (!avg || avg <= 0) return null;
      return {
        aptName: c.apt_name,
        sigungu: c.sigungu,
        umdNm: c.umd_nm,
        lat: Number(c.lat),
        lng: Number(c.lng),
        avgPrice: avg,
        dealCount: s.n,
        buildYear: s.buildYear || null,
        lawdCd: s.lawdCd || null,
      };
    }).filter(Boolean);
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
  // APTSEQ-FALLBACK-2026-05-12: aptSeq query param 받기 (apt_master 미매칭 단지 fallback)
  const aptSeq = String(req.query.aptSeq || '').trim() || null;
  // KAPT-LOOKUP-2026-05-12: lawdCd query param 받기 (SigunguAptList3 runtime lookup)
  const lawdCd = String(req.query.lawdCd || '').trim() || null;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });

  try {
    const facility = await resolveFacility({ aptName, sigungu, umdNm, aptSeq, lawdCd });

    // STAB-AUDIT-2026-05-07 P0+P1+P2: 학교 정보 통합 (검색 path 풍부화)
    //   - P0 카카오맵: 반경 1km 학교 list (이름·거리·종류)
    //   - P1 학교알리미 NEIS: 학생수·학급수·교사수 (학교명 매칭)
    //   - P2 학구도: 단지 좌표 → 배정 초·중 (서울 우선)
    // Sprint OO (2026-05-19): 강연 자료 적용 — 학군 권역 라벨 + 학원가 정보
    //   - schoolCluster: 3대 학원가 + 4권역 정적 라벨 (sigungu/umdNm 매핑)
    //   - nearbyAcademies: 반경 500m 학원 카운트 + 카테고리 분류
    let nearbySchools = [];
    let schoolDistrict = null;
    let nearbyAcademies = null;
    try {
      const coord = await resolveCoord({
        kaptCode: facility?.kaptCode,
        aptName, sigungu, umdNm,
        address: facility?.raw?.doroJuso || facility?.raw?.kaptAddr,
      });
      if (coord?.lat && coord?.lng) {
        // P0: 반경 1km 학교 fetch + 학원 fetch (병렬 P1·P2 와 함께)
        // Sprint OO+ (2026-05-19 verify): 각 promise .catch 추가 — 학원 실패가 학교 실패 캐스케이드 차단
        const [schools, district, academies] = await Promise.all([
          resolveSchools({ kaptCode: facility?.kaptCode, aptName, sigungu, umdNm, lat: coord.lat, lng: coord.lng }).catch(e => { logger.debug({err:e.message},'학교 실패'); return []; }),
          resolveSchoolDistrict({ lat: coord.lat, lng: coord.lng, sigungu, umdNm }).catch(e => { logger.debug({err:e.message},'학구도 실패'); return null; }),
          resolveAcademies({ kaptCode: facility?.kaptCode, aptName, sigungu, umdNm, lat: coord.lat, lng: coord.lng }).catch(e => { logger.debug({err:e.message},'학원 실패'); return null; }),
        ]);
        // P1: 학교알리미 NEIS 풍부화 (학생수·학급수)
        const enriched = schools && schools.length
          ? await resolveSchoolNeisBatch(schools, sigungu)
          : [];
        nearbySchools = enriched;
        schoolDistrict = district;
        nearbyAcademies = academies;
      }
    } catch (schoolErr) {
      logger.debug({ err: schoolErr.message, aptName }, '학교/학원 데이터 조회 실패 (무시)');
    }

    // Sprint OO: 학군 권역 라벨 (정적 강연 자료) — 좌표 없어도 sigungu/umdNm 만으로 매칭 가능
    const schoolCluster = resolveSchoolCluster({ sigungu, umdNm });

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
      // Sprint NN (2026-05-17, A 작업 sample 검증 중 발견):
      //   "고덕현대아파트" (명일동) 검색 → 명일동 모든 단지가 alt candidate 로 잡힘.
      //   원인: '아파트' (3글자) token 이 거의 모든 MOLIT 단지명에 substring 매칭 → false positive.
      //   결과: master fallback 으로 무관한 "고덕삼환/명일지에스/명일다성이즈빌" 거래 표시 → 환각.
      //   Fix: generic stop tokens 매칭 제외. 정체성 약한 일반 명사 단어 ('아파트', '오피스텔') 제거.
      //   '풍림아파트A' 매칭은 '풍림아' (3글자) 로 score=3 유지 — 회귀 0.
      const STOP_TOKENS = new Set(['아파트', '오피스텔']);
      const candidates = [];
      for (const r of (alts || [])) {
        if (seen.has(r.apt_name)) continue;
        seen.add(r.apt_name);
        // 토큰 매칭 점수 — 더 긴 토큰 매칭 = 우선
        let score = 0;
        for (const tok of tokens) {
          if (STOP_TOKENS.has(tok)) continue; // Sprint NN: generic stop token 제외
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

      // 작업 D (2026-05-20): apt_master.molit_aliases 자동 backfill (운영자 발견 미진행 항목)
      //   - facility 가 master 단지 (kaptCode 있음) 이면 alias name list 자동 저장
      //   - jsonb 타입 — Supabase JS 가 자동 JSON 인코딩
      //   - 매번 덮어쓰기 (altCandidates 알고리즘 변경 시 자동 반영, 부담 미미)
      //   - fire-and-forget (응답 지연 차단)
      if (facility?.kaptCode && altCandidates.length > 0) {
        const aliasNames = altCandidates.map(c => c.aptName);
        admin.from('apt_master')
          .update({ molit_aliases: aliasNames, updated_at: new Date().toISOString() })
          .eq('kapt_code', facility.kaptCode)
          .then(({ error }) => {
            if (error) {
              logger.debug({ err: error.message, kapt: facility.kaptCode }, 'molit_aliases backfill 실패 (무시)');
            }
          });
      }
    }
    // FACILITY-HELPER-2026-05-12 + DTL-INFO-2026-05-13 (Sprint X):
    //   resolveFacility 반환: { kaptCode, official, raw, detail } — Sprint X 부터 detail 동봉.
    //   buildFacility(info, kaptCode, detail) 로 표준 facility 객체 빌드 (주차 등 detail 필드 포함).
    const builtFacility = facility
      ? Object.assign(buildFacility(facility.raw, facility.kaptCode, facility.detail) || {}, {
          official: facility.official || null,
        })
      : null;
    res.json({ facility: builtFacility, altCandidates, nearbySchools, schoolDistrict, schoolCluster, nearbyAcademies });
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
