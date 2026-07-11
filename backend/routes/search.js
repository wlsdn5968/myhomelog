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
// SEARCH-PERF-2026-07-10 (Sprint DDDD): 자동완성 결과 캐시 — 실측 웜 1.4~1.6s(은마 1,641ms).
//   EXPLAIN 확정: 2글자 한글은 pg_trgm GIN 이 후보 30.9만행(전테이블화)이라 seq scan 591ms 가 최선 —
//   인덱스로 해결 불가한 본질 비용 → 같은 검색어 재계산 제거(서버 10분 + CDN s-maxage).
//   molit 데이터는 daily cron 갱신이라 10분 캐시 무해. cache.set 은 safeSet(Sprint BBBB)이라 실패 무해.
const cache = require('../cache');
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
  // 2026-05-31: 최소 2글자 — 1글자 ILIKE %x% 는 수천 row 매칭 → cold start 시 DB 부하.
  //   프론트 자동완성(index.html L7958)은 빈 results 를 zero-result 제안 UI 로 정상 처리.
  if (q.length < 2) return res.json({ results: [] });
  // SEARCH-SUFFIX-2026-06-14: molit 은 "은마"/"헬리오시티"로 저장하나 사용자는 "은마아파트"로 검색 →
  //   긴 쿼리가 짧은 저장명을 substring ILIKE 로 못 찾음(은마아파트 → 0건). 끝 "아파트(단지)" 접미사 제거한
  //   검색어로 apt_name ILIKE (`%qApt%` 는 `%q%` 의 상위집합이라 결과 손실 0·일부 broaden). display·dedup 은 원본 보존.
  //   가드: 제거 후 2자 미만이면 원본 유지("아파트"만 입력 시 전체매칭 방지).
  const _qStrip = q.replace(/\s*아파트(?:단지)?\s*$/, '').trim();
  const qApt = _qStrip.length >= 2 ? _qStrip : q;
  // SEARCH-PERF-2026-07-10 (Sprint DDDD): q별 결과 캐시 + CDN 공유 캐시.
  //   자동완성은 인증 무관 동일 응답(공개 데이터) → Vercel edge s-maxage 로 전 사용자 공유(인기 검색어 즉시).
  const SEARCH_CDN = 'public, s-maxage=600, stale-while-revalidate=3600';
  const sck = `searchapt:${q.toLowerCase()}:${limit}`;
  const cached = cache.get(sck);
  if (cached) {
    res.set('Cache-Control', SEARCH_CDN);
    return res.json(cached);
  }
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
        .ilike('apt_name', `%${qApt}%`)  // OR 제거 — apt_name 만 (인덱스 활용) · qApt: 접미사 정규화
        .order('deal_date', { ascending: false })
        .limit(limit * 30),
      admin.from('apt_master')
        .select('apt_name, sigungu, umd_nm, lawd_cd, kapt_code')
        .or(`apt_name.ilike.%${qApt}%,umd_nm.ilike.%${q}%`)  // apt_name 은 접미사 정규화 / umd_nm(동명) 은 원본
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
    // 정렬: (0) 검색어 일치 우선, (a) 거래량 desc, (b) 최근 거래 desc — 인기 + 최신성 균형
    // SEARCH-RANK-2026-07-11 (Sprint HHHH, 라이브 재현 "은마" → 1위 화성 '시범다은마을월드반도'):
    //   부분매칭+거래량순뿐이라 정확일치 단지가 밀림 → 정확일치(0)·시작일치(1)·포함(2) 등급을 최우선.
    //   동명(umd) 검색은 전부 2등급 동률이라 기존 순서 그대로 (회귀 없음).
    const _qn = String(q).replace(/\s+/g, '').toLowerCase();
    const _qRank = (n) => {
      const s = String(n || '').replace(/\s+/g, '').toLowerCase();
      return s === _qn ? 0 : (s.startsWith(_qn) ? 1 : 2);
    };
    const sortedMolit = Array.from(aptMap.values())
      .sort((a, b) => (_qRank(a.baseName) - _qRank(b.baseName)) || (b.count - a.count) || (String(b.firstRow.deal_date||'').localeCompare(String(a.firstRow.deal_date||''))));

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
        // SEARCH-SUFFIX-2026-06-14: dedup 비교 시 끝 "아파트" 흡수 — molit "헬리오시티" ↔ master "헬리오시티아파트"
        //   (동일 단지, 이름 접미사만 차이) 1개로 병합. 표시명(aptName) 은 각자 원본 유지(비교에서만 정규화).
        const _baseNoApt = String(base).replace(/아파트$/, '');
        let alreadyInOut = false;
        for (const exist of out) {
          if (String(exist.aptName).replace(/아파트$/, '') === _baseNoApt && exist.sigungu === row.sigungu && exist.umdNm === row.umd_nm) {
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

    // SEARCH-RANK-2026-06-14: 결과를 거래량(dealCount) 내림차순 정렬 — 동명/브랜드 검색 시 거래 활발한 단지 우선.
    //   (기존: molit 이름매칭 → master 동매칭 순서라 "대치동" 검색에 1건짜리가 22건짜리보다 위로 뜸.)
    //   거래 없는 master 단지(dealCount 미정)는 0 으로 후순위. exact 단지명 검색은 결과 1~2개라 영향 없음.
    //   동률은 기존 순서 보존(JS sort stable) → molit 우선·이름매칭 순서 유지.
    // SEARCH-RANK-2026-07-11 (Sprint HHHH 보강): 이 최종 정렬이 위 molit 그룹 rank 정렬을 덮어써
    //   master 병합 항목("시범다은마을월드반도" 60건)이 정확일치 "은마"(44건)를 다시 이기던 것 —
    //   라이브 재검증으로 발각. 일치 등급(정확0·시작1·포함2)을 최종 정렬에서도 최우선으로.
    out.sort((a, b) => (_qRank(a.aptName) - _qRank(b.aptName)) || ((b.dealCount || 0) - (a.dealCount || 0)));

    const payload = { results: out, query: q };
    cache.set(sck, payload, 600); // 10분 — molit 데이터는 daily cron 갱신
    res.set('Cache-Control', SEARCH_CDN);
    res.json(payload);
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
// POPULAR-HONEST-2026-06-14 (운영자 결정 "전국 거래량순으로 정직하게"):
//   [근본 원인] 선정용 RPC search_popular_apts 가 DB 에 부재 → 코드가 항상 fallback 으로 떨어졌고,
//     그 fallback 이 (a) 강남4구+마용성 7개 구 하드코딩 + (b) 최근 200건 샘플 내 카운트 였음.
//     결과: 전국 60일 거래량 top25 중 84%(평촌어바인퍼스트 63건 1위 포함)가 화이트리스트 밖이라 제외,
//           화면엔 샘플 2~7건짜리 강남권 단지만 노출 → "인기"라 부르기 어려운 지역 편향.
//   [Fix] search_popular_apts RPC(전국 60일 GROUP BY count desc) 를 1차 소스로 사용. 지역 하드코딩·200샘플 제거.
//         좌표 join + lazy-fill 은 기존 검증 로직 그대로 재사용(소스만 교체) → 회귀 최소.
//   [회귀 위험] RPC 장애 시 fallback 도 지역 하드코딩 없이 전국 샘플 그룹핑으로 degrade (편향 재발 방지).
router.get('/popular', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 30);
  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });
  try {
    // POPULAR-COLD-2026-07-11 (Sprint HHHH, 실사고 00:44 UTC 재현): 새벽 ingest 후 콜드에서
    //   RPC statement timeout(8s) 대기 → fallback → 총 10,035ms > 프론트 타임아웃 → 첫 화면 마커 0.
    //   ① 서버 인메모리 캐시 30분 — 같은 인스턴스 내 CDN MISS 도 즉시 응답.
    const pck = `popular:${limit}`;
    const pcached = cache.get(pck);
    if (pcached) {
      res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
      return res.json(pcached);
    }
    // ① 전국 60일 실거래량 top — RPC 집계 (정직한 거래량순)
    //   GEOCODE-ROBUST-2026-06-14: 라이브 지오코딩(lazy-fill)이 불안정해도 마커를 꽉 채우기 위해
    //   limit 보다 넉넉히(×5, 최대 80) 받아 → 좌표 보유 단지를 거래량 순서대로 limit 개 선택.
    //   (미좌표 최상위 단지는 좌표 backfill/geocode 정상화 후 자연히 진입. 별도 추적 중인 좌표 갭 사안.)
    const fetchN = Math.min(limit * 5, 80);
    let top = null;
    //   ② RPC 4초 컷 (abortSignal) — 콜드 DB 에서 statement timeout(8s) 을 기다리지 않고
    //      빠르게 fallback 으로 전환 (fallback 은 인덱스 경로라 콜드에서도 ~2s).
    const { data: rpcRows, error: rpcErr } = await admin
      .rpc('search_popular_apts', { p_limit: fetchN })
      .abortSignal(AbortSignal.timeout(4000));
    if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length) {
      // RPC 행(camelCase) → 아래 좌표-join 로직이 기대하는 shape 로 정규화
      top = rpcRows.map(r => ({
        apt_name: r.aptName, sigungu: r.sigungu, umd_nm: r.umdNm,
        lawd_cd: r.lawdCd, build_year: r.buildYear,
        latest: r.recentDealDate, count: Number(r.dealCount60d) || 0,
        deal_amount: r.avgDealAmount,
      }));
    } else {
      // ② RPC 실패/빈 결과 시에만 degrade — 지역 하드코딩 없는 전국 최근거래 샘플 그룹핑
      if (rpcErr) logger.warn({ err: rpcErr.message }, 'search_popular_apts RPC 실패 — 전국 샘플 fallback');
      const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: rows, error: e2 } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, deal_date, deal_amount')
        .gte('deal_date', sinceIso)
        .order('deal_date', { ascending: false })
        .limit(1000); // 200→1000: 전국 범위라 표본 확대 (그래도 RPC 가 정상 경로)
      if (e2) throw e2;
      const byApt = {};
      for (const r of (rows||[])) {
        const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
        if (!byApt[k]) byApt[k] = { ...r, count: 0, latest: r.deal_date };
        byApt[k].count++;
        if (r.deal_date > byApt[k].latest) byApt[k].latest = r.deal_date;
      }
      top = Object.values(byApt).sort((a,b) => b.count - a.count).slice(0, fetchN);
    }
    if (!top || !top.length) return res.json({ results: [] });

    // ⑥ POPULAR-QUALITY-2026-07-11 (Sprint GGGG, 운영자 "기준이 이상해 보인다" 지적):
    //   원칙(2026-06-14 "전국 거래량순으로 정직하게")은 유지하되, 실측으로 확인된 3가지 왜곡 제거.
    //   (a) 지속 거래 필터: 마지막 거래 21일 초과 단지 제외 — 신축 일괄등기 버스트가 60일 창에
    //       잔존하며 "인기" 행세하는 것 차단 (실측: 에드가개봉 5/21 멈춤 53건, 백상앨리츠 5/14 멈춤 37건).
    //   (b) 시군구 다양성 캡(최대 2곳): 동탄구 신규 적재 후 전국 top13 중 8곳이 동탄 — 한 동네 도배 방지.
    //       캡 초과분은 뒤로 밀어 limit 미달 시에만 순위순 재투입 (기존 "항상 꽉 채움" 보장 유지).
    const activeCutoff = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fresh = top.filter(t => String(t.latest || '') >= activeCutoff);
    if (fresh.length >= limit) { // 필터 후에도 충분할 때만 적용 (데이터 희소 시 degrade 없이 원본 유지)
      const bySgg = {};
      const capped = [];
      const overflow = [];
      for (const t of fresh) {
        // 그룹 키 = lawd_cd (시군구 고유코드) — sigungu 문자열은 "서구"(대전/부산/인천) 충돌 (실측 확인)
        const g = String(t.lawd_cd || t.sigungu || '?');
        bySgg[g] = (bySgg[g] || 0) + 1;
        (bySgg[g] <= 2 ? capped : overflow).push(t);
      }
      top = capped.concat(overflow);
    }

    // ③ apt_geocache 좌표 join (DB)
    const names = [...new Set(top.map(t => t.apt_name))];
    const { data: coords } = await admin.from('apt_geocache')
      .select('apt_name, sigungu, umd_nm, lat, lng')
      .in('apt_name', names);
    const coordMap = new Map();
    for (const c of (coords||[])) {
      coordMap.set(`${c.apt_name}|${c.sigungu||''}|${c.umd_nm||''}`, c);
    }
    // 환각 차단(2026-05-06): (apt_name|sigungu|umd_nm) 정확 키만 — 동명 타지역 좌표 오매칭 차단.
    // POPULAR-QUALITY-2026-07-11 (c): MOLIT raw 접두 "산척동," 제거 — 표시용만 (좌표 join 키는 raw 유지,
    //   검색은 부분일치 ILIKE 라 정제명으로도 매칭됨. 실측: "산척동,동탄호수공원금강펜테리움센트럴파크Ⅱ").
    const _cleanName = (n) => String(n || '').replace(/^[가-힣0-9]{1,8}(동|리|가),\s*/, '');
    const _row = (t, c) => ({
      aptName: _cleanName(t.apt_name), sigungu: t.sigungu, umdNm: t.umd_nm,
      lawdCd: t.lawd_cd, buildYear: t.build_year,
      recentDealDate: t.latest, dealCount60d: t.count, avgDealAmount: t.deal_amount,
      lat: Number(c.lat), lng: Number(c.lng),
    });

    // ④ 거래량 top 후보의 좌표 확보 — DB 캐시 우선, 미보유 상위 단지는 즉시 lazy-fill (sigungu 공백 수정으로 경기 시+구도 해결됨).
    //   진짜 거래량 1위(예: 평촌어바인퍼스트)가 좌표 없다고 빠지지 않게 채워서 노출 → "좌표 있는 것만"이 아닌 정직한 top.
    //   비용 상한: 상위 limit 후보의 미좌표만 fill (첫 호출만 ~수초, 이후 apt_geocache 영속 캐시 hit).
    const head = top.slice(0, limit);
    const headMissing = head.filter(t => !coordMap.has(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`));
    if (headMissing.length) {
      const filled = await resolveCoordBatch(headMissing.map(t => ({
        aptName: t.apt_name, sigungu: t.sigungu, umdNm: t.umd_nm,
      })), 5);
      headMissing.forEach((t, i) => {
        const f = filled[i];
        if (f && f.lat && f.lng) coordMap.set(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`, f);
      });
    }
    // ⑤ 거래량 순서대로 좌표 보유 단지 limit 개 — 상위 lazy-fill 후에도 못 채운 자리는 다음 순위가 메움(항상 꽉).
    const out = [];
    for (const t of top) {
      const c = coordMap.get(`${t.apt_name}|${t.sigungu||''}|${t.umd_nm||''}`);
      if (c && c.lat && c.lng) out.push(_row(t, c));
      if (out.length >= limit) break;
    }
    // CDN-CACHE-2026-06-14: 인기 마커 = 전국 60일 거래량 집계(일 단위 변동) + lazy-fill 지오코딩(첫 호출 수초)
    //   → 엣지 캐시로 첫 진입 외 모든 사용자/세션 즉시 서빙. 빈/에러 응답은 무캐시(자연 재시도).
    res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
    const payload = { results: out };
    if (out.length) cache.set(pck, payload, 1800); // HHHH ①: 빈 응답은 캐시 안 함 (자연 재시도)
    return res.json(payload);
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
      .select('apt_name, sigungu, umd_nm, lat, lng, apt_key, place_name')
      .gte('lat', south).lte('lat', north)
      .gte('lng', west).lte('lng', east)
      .limit(limit);
    if (error) throw error;
    if (!coords?.length) return res.json({ results: [] });

    // 단지별 최근 거래 평균가 fetch
    const names = [...new Set(coords.map(c => c.apt_name))];
    // CROSS-REGION-FIX-2026-06-03 (운영자 발견 "지도 영역보기 단지가 검색과 다르고 실거래 0건"):
    //   [근본 원인] 아래 stats join 이 apt_name 만으로 매칭(.in('apt_name', names)) → 시군구/동 스코프 없음.
    //     "풍림아파트"/"현대"/"벽산"/"청구" 등 전국 동명 단지 거래가 1개 stats 로 뭉쳐짐 → geocache 의 노원구
    //     좌표가 용인(lawd 41465) 거래의 lawdCd·buildYear·평균가를 상속. 마커 클릭 → openAptDetail 이
    //     타지역 lawdCd 로 /transactions 호출 → sigungu 필터가 전부 제거 → "거래 데이터 부족"(검색과 불일치).
    //     실측(2026-06-03): 공릉동 in-bounds 41개 마커 중 16개(39%)가 타지역 lawd_cd. 749개 이름이 충돌 위험.
    //   [Fix] (apt_name, sigungu, umd_nm) 정확 키로 stats 집계 + 쿼리도 동(umd) 스코프로 한정.
    //     검색(/search/apt)이 molit row 자신의 sigungu/umd 로 스코프하는 것과 동일 기준 → 두 path 일관.
    //   [회귀 위험] geocache triple 8878 중 8816(99.3%)이 동일 (name,sigungu,umd) molit row 보유 →
    //     정상 단지 영향 0. 자기 지역 매칭 없는 유령 마커(예: 공릉동 "풍림아파트" — 실제는 공릉풍림아이원)만 사라짐.
    const umds = [...new Set(coords.map(c => c.umd_nm).filter(Boolean))];
    let _txQuery = admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, deal_amount, build_year, deal_date, lawd_cd')
      .in('apt_name', names);
    if (umds.length) _txQuery = _txQuery.in('umd_nm', umds); // 동 스코프 — 전국 동명 충돌 차단 + row budget 보호
    const { data: txs } = await _txQuery
      .gte('deal_date', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0,10))
      .order('deal_date', { ascending: false })
      .limit(1000);
    const aptStats = {};
    for (const t of (txs || [])) {
      // (apt_name|sigungu|umd_nm) 정확 키 — 동명 타지역 단지 합산 차단
      const _k = `${t.apt_name}|${t.sigungu}|${t.umd_nm}`;
      if (!aptStats[_k]) aptStats[_k] = { sum: 0, n: 0, buildYear: t.build_year, lawdCd: t.lawd_cd };
      aptStats[_k].sum += t.deal_amount || 0;
      aptStats[_k].n++;
    }

    // ALIAS-MERGE-2026-05-21 (운영자 발견 "검색 vs 지도 영역보기 매물 불일치"):
    //   apt_geocache 는 MOLIT raw 단지명 (예: "풍림아파트A"/"풍림아파트B") 으로 좌표 보유 →
    //   in-bounds 가 raw 명 그대로 노출 → 같은 단지(공릉풍림아이원)가 지도에 2~3개 별도 마커로 분리.
    //   검색(/search/apt)은 apt_master + molit_aliases 로 1개 단지로 병합 → 두 path 가 별개 물건처럼 보임.
    //   Fix: 영역 내 동(umd)의 apt_master.molit_aliases 로 raw→canonical 역매핑 → 같은 master 단지로 병합.
    //   master 단지는 source:'master' + aptSeq(kaptCode) 부여 → frontend 가 검색과 동일한 상세 모달 fetch 가능.
    //   (umds 는 위 CROSS-REGION-FIX 에서 이미 계산 — 재사용)
    const aliasToMaster = {}; // key: `${alias}|${umd}` → master row
    if (umds.length) {
      const { data: masters } = await admin
        .from('apt_master')
        .select('apt_name, sigungu, umd_nm, kapt_code, molit_aliases')
        .in('umd_nm', umds)
        .not('molit_aliases', 'is', null);
      for (const m of (masters || [])) {
        const al = Array.isArray(m.molit_aliases) ? m.molit_aliases : [];
        for (const a of al) aliasToMaster[`${a}|${m.umd_nm}`] = m;
      }
    }

    // CANON-COORD-FIX-2026-06-03 (운영자 발견 "공릉풍림아이원 마커가 단지 아닌 충전소 위치에 찍힘"):
    //   geocache 의 alias 좌표(풍림아파트A/B)는 Kakao 가 '전기차충전소'·'B상가주차장' 같은 하위시설로 매칭한
    //   오프셋 좌표(본체에서 158~392m). 같은 단지의 kapt 키(kapt:kaptCode) 좌표는 place_name=단지 본체("공릉풍림아파트")로
    //   정확. master 그룹 대표좌표를 kapt 본체 좌표로 교체(아래 grouping 후).
    const kaptCoord = {}; // kaptCode → {lat,lng} (본체 좌표)
    for (const c of coords) {
      if (typeof c.apt_key === 'string' && c.apt_key.startsWith('kapt:') && c.lat != null && c.lng != null) {
        const _kc = c.apt_key.slice(5);
        if (_kc) kaptCoord[_kc] = { lat: Number(c.lat), lng: Number(c.lng) };
      }
    }
    // CANON-COORD-FIX-2026-06-03: 하위시설 place_name (단지 본체서 오프셋된 좌표) 판별 — 대표좌표 선택 시 deprioritize.
    //   ("상가"·"입구"는 주상복합/"서울대입구" false-positive 로 제외 — 정확성 우선.)
    const SUBFEATURE_RE = /충전소|주차장|정류장|정문|후문|관리사무소|경비실|놀이터/;

    // MOB-AUDIT-2026-05-04: 거래 0건 단지 (apt_geocache 에 좌표만 있고 molit 매칭 X) 는
    //   avgPrice 0.00억 으로 노출되어 사용자 오인 → 결과에서 제외 (legal 보호)
    // ALIAS-MERGE-2026-05-21: canonical 단지명 기준으로 그룹화 (alias 거래 합산).
    const groups = {};
    for (const c of coords) {
      const master = aliasToMaster[`${c.apt_name}|${c.umd_nm}`] || null;
      const canonName = master ? master.apt_name : c.apt_name;
      const gkey = `${canonName}|${c.umd_nm}`;
      if (!groups[gkey]) groups[gkey] = {
        aptName: canonName,
        sigungu: master ? master.sigungu : c.sigungu,
        umdNm: c.umd_nm,
        lat: Number(c.lat), lng: Number(c.lng),
        sum: 0, n: 0, buildYear: null, lawdCd: null,
        aptSeq: master ? (master.kapt_code || null) : null,
        source: master ? 'master' : 'molit',
        _bestN: -1, _bestRank: -1,
      };
      const g = groups[gkey];
      // CROSS-REGION-FIX-2026-06-03: 정확 키(name|sigungu|umd)로 조회 — 동명 타지역 stats 상속 차단
      const s = aptStats[`${c.apt_name}|${c.sigungu}|${c.umd_nm}`];
      if (s && s.n && s.sum) {
        g.sum += s.sum; g.n += s.n;
        if (!g.buildYear) g.buildYear = s.buildYear;
        if (!g.lawdCd) g.lawdCd = s.lawdCd;
        // CANON-COORD-FIX-2026-06-03: 대표 좌표 = 본체 우선(비하위시설 > 하위시설), 동순위는 거래량.
        //   alias 좌표가 충전소/주차장 등 하위시설이면 오프셋 → 같은 그룹의 비하위시설(본체) 좌표를 우선 선택.
        const _rank = SUBFEATURE_RE.test(c.place_name || '') ? 0 : 1;
        if (_rank > g._bestRank || (_rank === g._bestRank && s.n > g._bestN)) {
          g._bestRank = _rank; g._bestN = s.n; g.lat = Number(c.lat); g.lng = Number(c.lng);
        }
      }
    }
    // CANON-COORD-FIX-2026-06-03: master 그룹 대표좌표를 kapt 본체 좌표로 교체 (alias 하위시설 오프셋 교정)
    for (const g of Object.values(groups)) {
      if (g.source === 'master' && g.aptSeq && kaptCoord[g.aptSeq]) {
        g.lat = kaptCoord[g.aptSeq].lat;
        g.lng = kaptCoord[g.aptSeq].lng;
      }
    }
    const out = Object.values(groups).map(g => {
      if (!g.n || !g.sum) return null; // 거래 0건 → 제외
      const avg = +(g.sum / g.n / 10000).toFixed(2);
      if (!avg || avg <= 0) return null;
      return {
        aptName: g.aptName,
        sigungu: g.sigungu,
        umdNm: g.umdNm,
        lat: g.lat,
        lng: g.lng,
        avgPrice: avg,
        dealCount: g.n,
        buildYear: g.buildYear || null,
        lawdCd: g.lawdCd || null,
        aptSeq: g.aptSeq || null,
        source: g.source,
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
      // 작업 D 철회 (2026-05-20, 총괄책임자 판단): molit_aliases DB backfill 제거.
      //   사유: altCandidates 가 이미 동적 계산 (작동 중) + read 로직 없어 저장해도 무의미.
      //   backend update 가 RLS/jsonb 이슈로 미작동 → 매 호출 실패 DB 호출 = 응답 지연만 유발.
      //   RLS 디버깅은 사용자 가치 낮음 + 보안 위험 → 중단. 동적 계산으로 충분.
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
