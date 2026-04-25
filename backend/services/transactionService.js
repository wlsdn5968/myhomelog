/**
 * 국토교통부 실거래가 API 서비스
 * 공공데이터포털 (data.go.kr) 무료 API
 * API 신청: data.go.kr → '아파트매매 실거래가 상세자료' 검색 → 활용신청
 */
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cache = require('../cache');
const logger = require('../logger');

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
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, exclu_use_ar, build_year, floor, deal_year, deal_month, deal_day, deal_amount, lawd_cd, apt_seq')
      .eq('lawd_cd', lawdCd)
      .eq('deal_year', dy)
      .eq('deal_month', dm)
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

// 서울/경기 주요 구 법정동코드 (앞 5자리)
const LAWD_CODES = {
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
  '과천시': '41290', '광명시': '41210', '성남시분당구': '41135',
  '수원시영통구': '41117', '안양시동안구': '41173', '하남시': '41450',
  '용인시수지구': '41465',
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
      cache.set(cacheKey, fromDb, 3600); // 1h (다음 cron 갱신 전까지 유효)
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
 * 단지명 기반 최근 6개월 실거래가 조회
 */
async function getTransactionsByApt(lawdCd, aptName) {
  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키 미설정');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `txapt:${lawdCd}:${aptName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const months = [];
  // 최근 6개월 조회 — 거래 희소 단지까지 커버
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch(() => []))
  );

  const flat = allResults.flat();
  const filtered = aptName
    ? flat.filter(t => t.aptName.includes(aptName.replace(/\s/g, '')))
    : flat;

  const sorted = filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });

  cache.set(cacheKey, sorted, 3600);
  return sorted;
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
    if (!byApt[t.aptName]) byApt[t.aptName] = [];
    byApt[t.aptName].push(t);
  }

  return Object.entries(byApt).map(([name, list]) => {
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
      aptName: name,
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
const LAWD_CODE_TO_NAME = Object.fromEntries(
  Object.entries(LAWD_CODES).map(([name, code]) => [code, name])
);

module.exports = { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES, LAWD_CODE_TO_NAME };
