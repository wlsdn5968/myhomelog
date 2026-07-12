/**
 * 국토교통부 실거래가 API 서비스
 * 공공데이터포털 (data.go.kr) 무료 API
 * API 신청: data.go.kr → '아파트매매 실거래가 상세자료' 검색 → 활용신청
 */
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cache = require('../cache');
const logger = require('../logger');
// TXAPT-MATCH-2026-05-13 (Sprint Z + Z+): master 정식명 ↔ MOLIT raw 매칭
//   - Z: 양방향 contains + baseAptName (suffix 정규화)
//   - Z+: LCS insertion (builder/지역명 중간 삽입 case — 서강쌍용예가↔서강예가, 한신코아↔한신잠실코아)
const { baseAptName, normalizeAptName, isInsertionMatch } = require('../utils/aptName');

const MOLIT_DETAIL_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
// MOLIT API 성공 코드: '00'(구버전) 또는 '000'(신버전) — 다른 서비스에서도 재사용
const MOLIT_OK_CODES = new Set(['00', '000']);

// DB 사용 여부 — Supabase 설정되어 있고, MOLIT_DB_FIRST 가 'false' 가 아니면 DB 우선
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const DB_FIRST = (process.env.MOLIT_DB_FIRST !== 'false')
  && !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * DB 에서 region-month 거래 조회. molit_ingest_runs 로 ingest 이력 확인.
 * 이력 없거나 rows 0 이면 null 반환 → 호출자가 MOLIT API fallback 트리거.
 */
async function getTransactionsFromDb(lawdCd, dealYm) {
  const admin = dbClient();
  if (!admin) return null;
  try {
    // 이 region-month 가 한 번이라도 성공적으로 ingest 됐는지 확인
    const run = await admin
      .from('molit_ingest_runs')
      .select('status, rows_fetched, finished_at')
      .eq('lawd_cd', lawdCd)
      .eq('deal_ym', dealYm)
      .eq('status', 'ok')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run.error || !run.data) return null; // 아직 ingest 안 됨 → API fallback

    const dy = parseInt(dealYm.slice(0, 4), 10);
    const dm = parseInt(dealYm.slice(4, 6), 10);
    // PERF-2026-06-13: deal_year+deal_month equality 는 idx_molit_lawd_date(lawd_cd, deal_date DESC) 의
    //   deal_date 부분을 못 써 lawd_cd 의 전체 행을 bitmap heap 으로 긁고 month 필터+정렬 (실측 10.2ms).
    //   deal_date 범위로 변경 → 동일 결과(검증: 276,473행 중 deal_date NULL 0 · year/month 불일치 0)이며
    //   인덱스 (lawd_cd, deal_date) 완전 활용 + 정렬 제거 (실측 1.5ms, 7배 단축).
    const _mFrom = `${dy}-${String(dm).padStart(2, '0')}-01`;
    const _mNext = dm === 12 ? `${dy + 1}-01-01` : `${dy}-${String(dm + 1).padStart(2, '0')}-01`;
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
      .eq('lawd_cd', lawdCd)
      .gte('deal_date', _mFrom)
      .lt('deal_date', _mNext)
      .order('deal_date', { ascending: false })
      .limit(1000);
    if (error) throw error;
    return (data || []).map(r => ({
      aptName: r.apt_name,
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      excluUseAr: Number(r.exclu_use_ar) || 0,
      buildYear: r.build_year || 0,
      floor: r.floor || 0,
      dealYear: r.deal_year,
      dealMonth: r.deal_month,
      dealDay: r.deal_day,
      dealAmount: Number(r.deal_amount) || 0,
      lawdCd: r.lawd_cd || lawdCd,
      aptSeq: r.apt_seq || '',
    }));
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, dealYm }, 'molit DB 조회 실패 → API fallback');
    return null;
  }
}

/**
 * REC-PERF-2026-07-10 (Sprint EEEE): 지역 최근 N개월 거래를 단일 쿼리로 — recommend 전용.
 *   [근본원인 실측] recommend 콜드 22.4s 중 ~10.8s가 "지역 집계" 단계. 기존 경로는
 *   getTransactionsByApt(lawd,'') → 월별 getTransactions × 6 → 각 월마다 ingest-run 확인 1 + 데이터 1
 *   = 지역당 12왕복, 3지역 36왕복. 동일 데이터를 단일 range 쿼리로 받으면 131ms(EXPLAIN 실측,
 *   idx_molit_lawd_date 완전 활용) · pgrst.db_max_rows 미설정(무제한) 실측 확인.
 *   [안전장치] 빈 결과(미ingest 지역)면 null 반환 → 호출부가 기존 월별 경로(MOLIT API 폴백 포함)로
 *   fallback. 매핑은 getTransactionsFromDb 와 동일 포맷 → analyzeTransactions 그대로 호환.
 */
async function getRegionRecentTransactions(lawdCd, monthsBack = 6) {
  const admin = dbClient();
  if (!admin) return null;
  const ck = `txregion:${lawdCd}:${monthsBack}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - (monthsBack - 1));
    since.setDate(1);
    const sinceStr = since.toISOString().slice(0, 10);
    // REST-CAP-FIX-2026-07-10: Supabase REST 는 응답당 1000행 cap — .limit(12000) 요청도 서버가
    //   1000으로 자름(라이브 실측: analyzedCount 581→490, "구당 최근 1000행 cap" SQL 재현으로 490 정확 일치).
    //   → 1000행 range 페이징. 2차 정렬키 id 로 같은 deal_date 동점의 페이지 경계 중복/누락 차단.
    //   최대 지역(구로 6mo 2,007행 실측) = 3왕복 — 기존 월별 12왕복 대비 여전히 1/4.
    const PAGE = 1000;
    let data = [];
    for (let from = 0; from <= 11000; from += PAGE) {
      const { data: page, error } = await admin
        .from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
        .eq('lawd_cd', lawdCd)
        .gte('deal_date', sinceStr)
        .order('deal_date', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (page && page.length) data = data.concat(page);
      if (!page || page.length < PAGE) break;
    }
    if (!data.length) { cache.set(ck, null, 300); return null; } // 미ingest → 기존 경로 폴백
    const mapped = data.map(r => ({
      aptName: r.apt_name,
      sigungu: r.sigungu || '',
      umdNm: r.umd_nm || '',
      excluUseAr: Number(r.exclu_use_ar) || 0,
      buildYear: r.build_year || 0,
      floor: r.floor || 0,
      dealYear: r.deal_year,
      dealMonth: r.deal_month,
      dealDay: r.deal_day,
      dealAmount: Number(r.deal_amount) || 0,
      lawdCd: r.lawd_cd || lawdCd,
      aptSeq: r.apt_seq || '',
    }));
    cache.set(ck, mapped, 21600); // 6h — daily ingest 주기 기준
    return mapped;
  } catch (e) {
    logger.warn({ err: e.message, lawdCd }, 'txregion 단일쿼리 실패 → 기존 월별 경로 폴백');
    return null;
  }
}

// 서울/경기 주요 구 법정동코드 (앞 5자리)
// Phase 4 (2026-04-26): 전국 광역시 + 주요 시군구 확장 (32 → 82 region)
// 핵심 신축 단지가 광역시 신도시에 많음. 사용자 검색 누락 해소.
// 도 단위는 거래량 적은 시군구 제외. MOLIT API 호출 최적화.
const LAWD_CODES = {
  // ── 서울 25개 구 ──
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
  // ── 인천 10 ──
  '인천중구': '28110', '인천동구': '28140', '인천미추홀구': '28177',
  '인천연수구': '28185', '인천남동구': '28200', '인천부평구': '28237',
  '인천계양구': '28245', '인천서구': '28260',
  '인천강화군': '28710', '인천옹진군': '28720',
  // ── 부산 16 ──
  '부산중구': '26110', '부산서구': '26140', '부산동구': '26170',
  '부산영도구': '26200', '부산진구': '26230', '부산동래구': '26260',
  '부산남구': '26290', '부산북구': '26320', '해운대구': '26350',
  '부산사하구': '26380', '부산금정구': '26410', '부산강서구': '26440',
  '부산연제구': '26470', '부산수영구': '26500', '부산사상구': '26530',
  '부산기장군': '26710',
  // ── 대구 8 ──
  '대구중구': '27110', '대구동구': '27140', '대구서구': '27170',
  '대구남구': '27200', '대구북구': '27230', '대구수성구': '27260',
  '대구달서구': '27290', '대구달성군': '27710',
  // ── 광주 5 ──
  '광주동구': '29110', '광주서구': '29140', '광주남구': '29155',
  '광주북구': '29170', '광주광산구': '29200',
  // ── 대전 5 ──
  '대전동구': '30110', '대전중구': '30140', '대전서구': '30170',
  '대전유성구': '30200', '대전대덕구': '30230',
  // ── 울산 5 ──
  '울산중구': '31110', '울산남구': '31140', '울산동구': '31170',
  '울산북구': '31200', '울산울주군': '31710',
  // ── 세종 1 ──
  '세종특별자치시': '36110',
  // ── 경기 (수도권 신축 핵심) ──
  '과천시': '41290', '광명시': '41210', '성남시분당구': '41135',
  '수원시영통구': '41117', '안양시동안구': '41173', '하남시': '41450',
  '용인시수지구': '41465',
  // REG-UPDATE-2026-06-30: 국토부 6.29 주정심 신규 규제지역(투기과열+조정, 7.1 효력) → ingest 대상 편입.
  //   코드 공식 2중검증(AptInfo get_region_code + get_apt_price 실거래 실측): 구리 41310·기흥 41463·화성 동탄구 41597.
  //   ※ 화성시는 2025 행정구 분리로 동탄구가 자체 시군구코드 41597 보유(구 화성시 41590은 현재 0건).
  //     41597이 동탄 실거래를 직접 서빙(202606 10건 실측: 동탄린스트라우스·동탄역동원 등) → 법정동 필터 불요, 규제구역(동탄구)만 정확 편입.
  //   다음 daily cron에 거래+KAPT마스터 자동 적재. sigungu에 '동탄구' 포함 → isRegFront 정상 규제 판정.
  '구리시': '41310', '용인시기흥구': '41463', '화성시동탄구': '41597',
};

function isMolitKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * 실거래가 조회 (월별)
 */
async function getTransactions(lawdCd, dealYm) {
  const cacheKey = `tx:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached || []; // null/[] 캐시도 hit 처리

  // ── DB-first: ingest 된 region-month 은 DB 로만 응답 (latency ~20ms) ──
  if (DB_FIRST) {
    const fromDb = await getTransactionsFromDb(lawdCd, dealYm);
    if (fromDb && fromDb.length > 0) {
      cache.set(cacheKey, fromDb, 21600); // REC-PERF-2026-07-10 (Sprint EEEE): 1h→6h — 데이터는 daily cron(17:00 UTC)만 갱신, 콜드 빈도 축소
      return fromDb;
    }
    // fromDb === null (미ingest 또는 실패) 또는 빈 배열 → API fallback 으로 진행
  }

  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키가 설정되지 않았습니다. data.go.kr에서 무료 발급 후 환경변수 MOLIT_API_KEY에 설정하세요.');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  try {
    // ── 페이징 완전 구현 ────────────────────────────────────
    // 기존: 1페이지(1000건)만 → 강남·송파·성동 등 월 1000+건 거래 구에서 최근 거래 누락
    // 개선: 최대 10페이지(1만건) 까지 순차 조회. totalCount 기반 조기 종료.
    // 왜 10페이지 상한: 서울 최대 월 거래 구(강남)도 통상 1500~2500건 수준
    //                  → 10페이지는 충분한 안전마진. Serverless 타임아웃 방어 상한.
    const MAX_PAGES = 10;
    const NUM_ROWS = 1000;
    const allItems = [];
    let header = null;
    let totalCount = null;
    let cancelledCount = 0;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const response = await axios.get(MOLIT_DETAIL_URL, {
        params: {
          serviceKey: process.env.MOLIT_API_KEY,
          LAWD_CD: lawdCd,
          DEAL_YMD: dealYm,
          pageNo,
          numOfRows: NUM_ROWS,
          _type: 'json',
        },
        timeout: 7000,
        headers: { Accept: 'application/json' },
      });

      const body = response.data?.response?.body;
      header = response.data?.response?.header || header;
      totalCount = body?.totalCount != null ? parseInt(body.totalCount, 10) : totalCount;
      const items = body?.items?.item;
      const pageItems = Array.isArray(items) ? items : items ? [items] : [];

      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          resultCode: header.resultCode, resultMsg: header.resultMsg,
        }, 'MOLIT 거래 조회 비정상 응답코드');
        break; // 에러 응답이면 페이지 루프 중단
      } else if (!header && typeof response.data === 'string') {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          sample: String(response.data).slice(0, 200),
        }, 'MOLIT 거래 비-JSON 응답');
        break;
      }

      allItems.push(...pageItems);

      // 페이지가 덜 채워졌거나 totalCount 초과 시 종료
      if (pageItems.length < NUM_ROWS) break;
      if (totalCount != null && allItems.length >= totalCount) break;
    }

    if (totalCount != null && allItems.length < totalCount) {
      logger.warn({
        source: 'molit', lawdCd, dealYm,
        fetched: allItems.length, total: totalCount, maxPages: MAX_PAGES,
      }, 'MOLIT 거래 일부 페이징 미완료 — MAX_PAGES 상한 도달');
    }

    // ── 해제(취소) 거래 필터링 ───────────────────────────
    // MOLIT 응답에 cdealType 이 있으면 해제 거래. 기본 제외.
    // 왜 제외: 네이버는 취소된 거래를 숨기지만 MOLIT 은 해제 플래그만 달고 유지 →
    //          필터 안 하면 "네이버엔 없는 거래가 여기엔 있다" 는 불일치 원인 (Bug #3)
    const result = allItems
      .filter(item => {
        const cancelled = String(item.cdealType || '').trim();
        if (cancelled) {
          cancelledCount++;
          return false;
        }
        return true;
      })
      .map(item => ({
        aptName: item.aptNm?.trim() || '',
        sigungu: item.sggNm?.trim() || '',
        umdNm: item.umdNm?.trim() || '',
        excluUseAr: parseFloat(item.excluUseAr) || 0,
        buildYear: parseInt(item.buildYear) || 0,
        floor: parseInt(item.floor) || 0,
        dealYear: parseInt(item.dealYear) || 0,
        dealMonth: parseInt(item.dealMonth) || 0,
        dealDay: parseInt(item.dealDay) || 0,
        dealAmount: parseInt((item.dealAmount || '0').replace(/,/g, '')) || 0,
        lawdCd: item.regionCode || lawdCd,
        aptSeq: item.aptSeq || '',
      }));

    if (cancelledCount > 0) {
      logger.info({ source: 'molit', lawdCd, dealYm, cancelledCount, activeCount: result.length },
        'MOLIT 해제 거래 필터링');
    }

    cache.set(cacheKey, result, 86400);
    return result;
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') throw err;
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.set(cacheKey, [], 300);
    const apiErr = new Error(`국토부 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
}

/**
 * 단지명 기반 최근 N개월 실거래가 조회 (기본 6개월)
 * COMPARE-12MO-2026-06-21 (단지 비교 Phase1): monthsBack 파라미터 추가.
 *   배경: 단지 비교 평당가는 "동일 전용면적대·n>=8·최근 12개월" 룰. 기존 6개월 윈도우는
 *         활성단지 n>=8 충족률 32% 에 그쳐(12개월=54%) 룰을 못 지킴 → 12개월 옵션 필요.
 *   하위호환: 미전달 호출자는 6개월 유지(회귀 0). cacheKey 에 monthsBack 포함해 6/12 분리 캐시.
 */
async function getTransactionsByApt(lawdCd, aptName, monthsBack = 6) {
  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키 미설정');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `txapt:${lawdCd}:${aptName}:${monthsBack}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const months = [];
  // 최근 N개월 조회 — 거래 희소 단지까지 커버
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch(() => []))
  );

  const flat = allResults.flat();
  // TXAPT-MATCH-2026-05-13 (Sprint Z — 운영자 발견 "안 맞는 아파트 너무 많아" [VERIFIED]):
  //   기존: 한방향 contains — `MOLIT_raw.includes(user_query)` 만.
  //         "잠실파크리오" (KAPT 정식명 master 클릭) → MOLIT raw "파크리오" 매칭 실패 (substring 아님).
  //   변경: 양방향 contains + baseAptName (Sprint S helper) 으로 동/letter/층 suffix 제거 후 비교.
  //
  //   false-positive 가드:
  //     - lawdCd 가 같은 (구 안 데이터만) 이므로 sigungu 안에서 match — 동명이지 단지 위험 미미
  //     - normalize 후 길이 >= 3 만 매칭 (너무 짧은 단지명 차단)
  let filtered = flat;
  if (aptName) {
    const qStripped = String(aptName).replace(/\s/g, '');
    const qBase = baseAptName(aptName).replace(/\s/g, '');
    filtered = flat.filter(t => {
      const rawName = String(t.aptName || '');
      const rawStripped = rawName.replace(/\s/g, '');
      const rawBase = baseAptName(rawName).replace(/\s/g, '');
      // 1) 양방향 contains (raw ↔ query, base 양쪽)
      if (rawStripped.includes(qStripped)) return true;
      if (qStripped.length >= 3 && qStripped.includes(rawStripped) && rawStripped.length >= 3) return true;
      if (rawBase.includes(qBase) && qBase.length >= 3) return true;
      if (qBase.includes(rawBase) && rawBase.length >= 3) return true;
      // 2) LCS insertion (서강쌍용예가↔서강예가 같이 builder/지역명 중간 삽입 case)
      //    Sprint Z+ (2026-05-13) — Sprint T 의 KAPT-LOOKUP 알고리즘과 동일.
      //    sigungu 안에서만 적용되니 false-positive 위험 미미.
      if (isInsertionMatch(aptName, rawName)) return true;
      return false;
    });
  }

  const sorted = filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });

  // P1-12 (2026-05-04): cache TTL 3600s → 1800s (30분)
  //   기존: 1시간 — 신규 거래 발생 시 1시간 stale data 노출
  //   변경: 30분 — 매일 17:00 UTC molit-ingest 후 30분이면 모든 사용자가 최신 받음
  cache.set(cacheKey, sorted, 1800);
  return sorted;
}

// ── ALIAS-MERGE-2026-05-21 (전수조사: BUG2/가격시그널 동일 클래스) ─────────────────
//   master 단지(KAPT 정식명)의 MOLIT 신고명이 다를 때(예: 공릉풍림아이원 → 풍림아파트A/B),
//   이름 유사도 매칭이 실패 → 거래 부분 집계 → 가격시그널/분석 "표본부족" 불일치(실거래가 탭과 어긋남).
//   apt_master.molit_aliases (공식 매핑) 로 보강. 검색 path(openAptDetail) 와 동일 집합을 만들어 일관성 확보.

// (a) 단일 단지: canonical + alias 거래 fetch + 병합 (analysisService 가격시그널용)
//   COMPARE-12MO-2026-06-21: monthsBack 패스스루 (단지 비교 12개월). 미전달 시 6개월(회귀 0).
async function getTransactionsByAptInclAliases(lawdCd, aptName, monthsBack = 6) {
  const base = await getTransactionsByApt(lawdCd, aptName, monthsBack);
  if (!aptName) return base;
  const admin = dbClient();
  if (!admin) return base;
  try {
    const sigungu = LAWD_CODE_TO_NAME[lawdCd] || null;
    let q = admin.from('apt_master').select('molit_aliases')
      .eq('apt_name', aptName).not('molit_aliases', 'is', null).limit(1);
    if (sigungu) q = q.eq('sigungu', sigungu);
    const { data } = await q;
    const aliases = (data && data[0] && Array.isArray(data[0].molit_aliases)) ? data[0].molit_aliases : [];
    if (!aliases.length) return base;
    // master(공릉풍림아이원)는 canonical 명으로 MOLIT 실거래가 없음(전부 alias 로 신고) → base 의
    //   느슨한 매칭(insertion 등)은 spurious 일 수 있어 제외. alias 거래만 병합(검색 path 와 동일 = 정확).
    const aliasArrays = await Promise.all(
      aliases.slice(0, 5).map(a => getTransactionsByApt(lawdCd, a, monthsBack).catch(() => []))
    );
    const merged = [];
    const seen = new Set();
    for (const arr of aliasArrays) {
      for (const t of arr) {
        const k = `${t.dealYear}|${t.dealMonth}|${t.dealDay}|${t.excluUseAr}|${t.floor}|${t.dealAmount}|${t.aptName}`;
        if (!seen.has(k)) { seen.add(k); merged.push(t); }
      }
    }
    return merged.length ? merged : base; // alias 거래 0건이면 base fallback
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, aptName }, 'getTransactionsByAptInclAliases alias 병합 실패 — base 반환');
    return base;
  }
}

// (b) 지역 단위: raw MOLIT명 → canonical master명 매핑 (propertyService 추천 relabel용)
//   key: `${rawAliasName}|${umdNm}` (동까지 매칭해 동명이지 오병합 차단).
//   ALIAS-REGION-FIX-2026-07-12 (Sprint RRRR): sigungu 명이 아니라 lawd_cd 로 조회.
//     [근본원인] propertyService 는 REGION_KEYWORDS 축약명('노원')을 넘기는데 apt_master.sigungu
//     값은 '노원구' → `.in('sigungu',['노원'])` 0건 → 맵 비어서 풍림아파트A/B relabel 미발동(raw 표시).
//     lawd_cd 는 숫자코드라 축약/전체명 모호성 없음. apt_master.lawd_cd 10,638/10,638 채움(검증).
async function getAliasCanonicalMap(lawdCds) {
  const admin = dbClient();
  if (!admin || !Array.isArray(lawdCds) || !lawdCds.length) return new Map();
  const map = new Map();
  try {
    const { data } = await admin.from('apt_master')
      .select('apt_name, umd_nm, molit_aliases')
      .in('lawd_cd', [...new Set(lawdCds.filter(Boolean))])
      .not('molit_aliases', 'is', null);
    for (const r of (data || [])) {
      const al = Array.isArray(r.molit_aliases) ? r.molit_aliases : [];
      for (const a of al) map.set(`${a}|${r.umd_nm || ''}`, r.apt_name);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'getAliasCanonicalMap 조회 실패 — 빈 맵');
  }
  return map;
}

// ── 통계 헬퍼 (P1 2026-04-25) ───────────────────────────────────
// 감사 보고서 1-3 (🔴 치명):
//   - 기존: 단순 산술평균. 30억 이상치 1건이 8억 단지 평균 +10% 왜곡.
//   - 개선: trimmed mean (상하 10% 제거) + median 동시 노출.
//   - 시간 가중: 최근 거래에 가중치 (90일 half-life) — 6개월 전 가격이 현재 시세 행세하는 문제 차단.
//   - 층 보정 안내: 1층/탑층 프리미엄/디스카운트는 MOLIT 데이터로 자동 보정 어려움 → "임장 확인 필수" 라벨.
function _median(sorted) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}
function _trimmedMean(values, trimRatio = 0.1) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trimRatio);
  const trimmed = sorted.slice(cut, sorted.length - cut);
  if (!trimmed.length) return Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
}
// 시간 가중 평균 — 최근 거래일수록 높은 가중치 (반감기 90일)
function _weightedMean(transactions) {
  if (!transactions.length) return 0;
  const now = Date.now();
  let totalW = 0, sumW = 0;
  for (const t of transactions) {
    const d = new Date(t.dealYear, (t.dealMonth || 1) - 1, t.dealDay || 1).getTime();
    const daysAgo = Math.max(0, (now - d) / (1000 * 60 * 60 * 24));
    const w = Math.exp(-daysAgo / 90); // half-life 90일
    sumW += w * t.dealAmount;
    totalW += w;
  }
  return totalW > 0 ? Math.round(sumW / totalW) : 0;
}

/**
 * 지역별 시세 분석 — 단지 + 평형별 분리
 */
function analyzeTransactions(transactions) {
  if (!transactions || !transactions.length) return [];

  const byApt = {};
  for (const t of transactions) {
    // GENERIC-NAME-SPLIT-2026-05-21 (운영자 발견 "단지 정리 목록이 이상"):
    //   기존: aptName 단독 키 → "현대"·"벽산"·"청구" 등 동명 단지가 동/구를 넘어 1개로 합산 →
    //     가격범위 왜곡 (예: 현대 5.65~12.1억 = 상계동·중계동 별개 현대 단지 합산).
    //   변경: aptName|lawdCd|umdNm 복합키로 물리적 단지 분리 (report path fetchCandidateApts 와 동일 정책).
    //   주: BUG2 의 alias 병합(서로 다른 이름 = 같은 단지)과는 반대 방향 — 같은 이름 = 다른 단지를 분리.
    const gkey = `${t.aptName}|${t.lawdCd || ''}|${t.umdNm || ''}`;
    if (!byApt[gkey]) byApt[gkey] = [];
    byApt[gkey].push(t);
  }

  return Object.entries(byApt).map(([, list]) => {
    const sorted = [...list].sort((a, b) => {
      const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
      const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
      return db - da;
    });
    const prices = sorted.map(t => t.dealAmount);
    const sortedPrices = [...prices].sort((a, b) => a - b);
    // P1: 단순 평균 → trimmed mean (상하 10% 제거) + median + 시간 가중
    //     기본 avgPrice 는 weighted (사용자 노출용 — 가장 현재 시세 근접)
    const avg = _weightedMean(sorted);
    const median = _median(sortedPrices);
    const trimmed = _trimmedMean(prices, 0.1);

    const byPyeong = {};
    for (const t of sorted) {
      const py = Math.round(t.excluUseAr / 3.3);
      if (!byPyeong[py]) byPyeong[py] = [];
      byPyeong[py].push(t);
    }
    const pyeongStats = Object.entries(byPyeong).map(([py, txs]) => {
      const ps = txs.map(t => t.dealAmount);
      const psSorted = [...ps].sort((a, b) => a - b);
      // 층 분포 — 1층(low)/탑층(high) 비율 노출 → 사용자에게 "RR 보정 안 됨" 인지
      const floors = txs.map(t => t.floor || 0).filter(f => f > 0);
      const minFloor = floors.length ? Math.min(...floors) : null;
      const maxFloor = floors.length ? Math.max(...floors) : null;
      return {
        pyeong: parseInt(py),
        excluUseAr: parseFloat((txs[0].excluUseAr).toFixed(2)),
        dealCount: txs.length,
        avgPrice:    _weightedMean(txs), // 시간 가중 평균 (사용자 노출 기본)
        medianPrice: _median(psSorted),  // 중앙값 (이상치 강건)
        trimmedAvgPrice: _trimmedMean(ps, 0.1),
        minPrice: Math.min(...ps),
        maxPrice: Math.max(...ps),
        floorRange: minFloor !== null ? { min: minFloor, max: maxFloor } : null,
        recentTx: txs.slice(0, 5).map(t => ({
          date: `${t.dealYear}.${String(t.dealMonth).padStart(2, '0')}.${String(t.dealDay).padStart(2, '0')}`,
          floor: t.floor,
          price: t.dealAmount,
          excluUseAr: t.excluUseAr,
        })),
      };
    }).sort((a, b) => a.pyeong - b.pyeong);

    return {
      aptName: sorted[0].aptName,
      sigungu: sorted[0].sigungu,
      umdNm: sorted[0].umdNm,
      buildYear: sorted[0].buildYear,
      lawdCd: sorted[0].lawdCd,
      aptSeq: sorted[0].aptSeq,
      dealCount: sorted.length,
      avgPrice: avg,           // 시간 가중 (사용자 노출)
      medianPrice: median,     // 중앙값
      trimmedAvgPrice: trimmed,// trimmed mean (상하 10% 제거)
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      avgPriceAuk: (avg / 10000).toFixed(2),
      areas: pyeongStats.map(p => p.pyeong).join('·') + '평',
      recentDeal: `${sorted[0].dealYear}.${String(sorted[0].dealMonth).padStart(2, '0')}.${String(sorted[0].dealDay).padStart(2, '0')}`,
      pyeongStats,
      rawList: sorted.slice(0, 10),
      // P1 (2026-04-25): 층·향 자동 보정 불가 — 사용자에게 "RR/저층 임장 필수" 인지 강제
      floorAdjustmentNote: 'MOLIT 데이터는 층별 가격 변동(저층 -3%·탑층 +5%·RR 프리미엄)을 자동 보정할 수 없습니다. 동·층·향은 임장 확인 필수.',
    };
  }).sort((a, b) => b.dealCount - a.dealCount);
}

// 역매핑 — lawd_cd → 구이름 (ETL sigungu 채우기 / 검색 필터에서 사용)
// Phase 4 (2026-04-26): 광역시 prefix 제거 — DB sigungu 는 "해운대구" "연수구" 등 짧은 이름.
//   원본 LAWD_CODES 키는 "부산해운대구" 같이 광역시 prefix 가 있어 frontend 표시 시 중복 → 마지막 "구/시/군"부분만.
const _stripCityPrefix = (k) => {
  // 광역시 prefix (인천·부산·대구·광주·대전·울산) 제거. "성남시분당구" 같이 시 단위 명칭은 보존.
  return k.replace(/^(인천|부산|대구|광주|대전|울산)/, '');
};
const LAWD_CODE_TO_NAME = Object.fromEntries(
  Object.entries(LAWD_CODES).map(([name, code]) => [code, _stripCityPrefix(name)])
);

module.exports = { getTransactions, getTransactionsByApt, getTransactionsByAptInclAliases, getAliasCanonicalMap, analyzeTransactions, getRegionRecentTransactions, LAWD_CODES, LAWD_CODE_TO_NAME };
