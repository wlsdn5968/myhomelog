/**
 * PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): "최근 실거래 최고·최저 경신" 재료 조회.
 *
 * [무엇인가] 최근 N일 거래 중, **같은 단지·같은 전용면적의 직전 최고가를 넘은 거래**와
 *   **직전 최저가를 밑돈 거래**를 사실 그대로 센다. 양방향을 함께 낸다 —
 *   최고가만 보여주면 그 자체가 매수 신호처럼 읽히기 때문이다(절대 룰 ①).
 *
 * [왜 캐시가 전제인가] 계산은 DB 함수 get_price_records 가 하는데 라이브 실측 2.5초대다.
 *   원자료(molit_transactions)는 daily cron 으로만 바뀌므로 하루 1회 계산이면 충분하다.
 *   Redis(공유) → node-cache(인스턴스) 2단 — hfRates·dataCounts 와 같은 계열.
 *
 * [왜 "역대"라고 쓰지 않는가] 적재 시작이 2025-05-01 이다(DB 실측). 그 이전 거래는 우리에게 없다.
 *   함수가 sinceDate 를 함께 돌려주고, 소비자는 그 날짜를 반드시 문구에 노출한다.
 */
'use strict';

const cache = require('../cache');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
const { rget, rset } = require('./redisCache');
const { LAWD_CODES } = require('./transactionService');

const CK = 'records:price:v1';
const CK_REGION = 'records:priceByRegion:v1';
const TTL_LOCAL = 6 * 3600;      // 인스턴스 캐시
const TTL_REDIS = 30 * 3600;     // daily cron(24h) + Hobby ±59분 지연 여유

const DEF_DAYS = 7;
const DEF_MIN_PRIOR = 3;         // 거래 1~2건짜리는 통계가 아니라 잡음 — TRUST 게이트와 같은 취지
const DEF_LIMIT = 5;

// ⚠ 지역별은 **30일**이다. 7일로 쪼개면 지역당 표본이 없다 — 실측:
//   7일 기준 107개 지역 중 **54곳이 경신 0~2건**(평균 3.3). 30일이면 118곳 중 110곳이 3건 이상(평균 31.1).
//   창이 다르므로 응답의 windowDays 를 화면에 그대로 노출해 전국(7일)과 섞이지 않게 한다.
const REGION_DAYS = 30;
const REGION_LIMIT = 3;

// ── 지역 표시명 ──────────────────────────────────────────────────────────────
// ⚠ 지역 판정은 **lawd_cd 로만** 한다. molit 의 sigungu 문자열은 광역이 없어
//   '남구'(부산·대구·울산)·'연수구'·'중구' 가 서로 구별되지 않는다(동명 구 오판 6회 재발 이력).
// 표는 새로 만들지 않고 LAWD_CODES 에서 파생한다.
const CODE_TO_FULLNAME = Object.fromEntries(
  Object.entries(LAWD_CODES).map(([name, code]) => [code, name])
);

// 2자리 시도코드 그룹이 **실제로 공유하는 접두**를 표에서 계산한다(접두 목록 하드코딩 금지).
//   예) '28' → '인천', '26' → '부산', '43' → '청주시'. 서울(11)·경기(41)는 공유 접두가 없어 빈값.
const SIDO_PREFIX = (() => {
  const g = {};
  for (const [name, code] of Object.entries(LAWD_CODES)) (g[code.slice(0, 2)] ||= []).push(name);
  const lcp = (arr) => arr.reduce((p, n) => { let i = 0; while (i < p.length && i < n.length && p[i] === n[i]) i++; return p.slice(0, i); });
  const out = {};
  for (const [sd, names] of Object.entries(g)) {
    if (names.length < 2) continue;
    // 그룹의 과반이 공유하는 2글자 접두를 먼저 찾고(부산 16곳 중 '해운대구' 처럼 예외가 있어
    //   전원 공통접두로는 빈값이 된다), 그 접두를 가진 이름들끼리 다시 최장공통으로 늘린다
    //   ('청주' → '청주시'). 접두 목록을 손으로 적지 않기 위한 절차다.
    const cnt = {};
    for (const n of names) cnt[n.slice(0, 2)] = (cnt[n.slice(0, 2)] || 0) + 1;
    const [best, hits] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    if (hits * 2 < names.length) continue;
    const p2 = lcp(names.filter(n => n.startsWith(best)));
    if (p2.length >= 2) out[sd] = p2;
  }
  return out;
})();

// 서울 25개 구는 LAWD_CODES 에서 접두 없이 등재돼 있다(실측: '11' 그룹 25건 전부 맨이름).
//   그대로 두면 '중구'·'강서구' 가 어느 시의 것인지 화면에서 알 수 없다.
const SEOUL = '서울';

function regionLabel(lawdCd, fallback) {
  const code = String(lawdCd || '');
  const raw = CODE_TO_FULLNAME[code];
  if (!raw) return String(fallback || '');   // 표에 없는 코드 → 원본 sigungu (전수대조 결과 현재 0건)
  if (code.startsWith('11')) return `${SEOUL} ${raw}`;
  const p = SIDO_PREFIX[code.slice(0, 2)];
  if (p && raw.startsWith(p) && raw.length > p.length) return `${p} ${raw.slice(p.length)}`;
  return raw.replace(/^([가-힣]{2,}시)([가-힣]+[구군])$/, '$1 $2');
}

function shapeRow(r) {
  if (!r) return null;
  const amt = Number(r.deal_amount);
  const prevMax = Number(r.prev_max);
  const prevMin = Number(r.prev_min);
  return {
    aptName: r.apt_name || '',
    region: regionLabel(r.lawd_cd, r.sigungu),  // 화면 표시용(광역 포함)
    sigungu: r.sigungu || '',                   // 원본 — 단지 검색 진입(goSearchResult)이 기존 카드와 같은 형태를 받게
    umdNm: r.umd_nm || '',
    lawdCd: r.lawd_cd || '',
    excluUseAr: Number(r.exclu_use_ar) || null,
    floor: Number.isFinite(Number(r.floor)) ? Number(r.floor) : null,
    buildYear: Number(r.build_year) || null,
    dealDate: r.deal_date || null,
    dealAmount: Number.isFinite(amt) ? amt : null,          // 만원
    prevMax: Number.isFinite(prevMax) ? prevMax : null,
    prevMin: Number.isFinite(prevMin) ? prevMin : null,
    priorCount: Number(r.prev_n) || null,                    // 비교에 쓴 직전 거래 건수 — 신뢰도를 사용자가 판단하게
  };
}

/**
 * @returns {object|null} null 이면 조회 실패 — 소비자는 카드를 통째로 생략한다(0·추정값 금지)
 */
async function getPriceRecords({ force = false } = {}) {
  if (!force) {
    const local = cache.get(CK);
    if (local !== undefined) return local;
    try {
      const shared = await rget(CK);
      if (shared) { cache.set(CK, shared, TTL_LOCAL); return shared; }
    } catch (_) { /* Redis 미구성·장애는 계산으로 폴백 */ }
  }

  const admin = getSupabaseAdmin();
  if (!admin) return null;

  let payload = null;
  try {
    const { data, error } = await admin.rpc('get_price_records', {
      p_days: DEF_DAYS, p_min_prior: DEF_MIN_PRIOR, p_limit: DEF_LIMIT,
    });
    if (error) throw error;
    if (!data) return null;
    payload = {
      latestDeal: data.latestDeal || null,
      sinceDate: data.sinceDate || null,        // "역대"가 아님을 밝히는 근거 — 문구에 반드시 노출
      windowDays: data.windowDays || DEF_DAYS,
      minPrior: data.minPrior || DEF_MIN_PRIOR,
      comparedCount: Number(data.comparedCount) || 0,
      highCount: Number(data.highCount) || 0,
      lowCount: Number(data.lowCount) || 0,
      high: (data.high || []).map(shapeRow).filter(Boolean),
      low: (data.low || []).map(shapeRow).filter(Boolean),
      computedAt: new Date().toISOString(),
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'price records 조회 실패');
    return null;
  }

  cache.set(CK, payload, TTL_LOCAL);
  try { await rset(CK, payload, TTL_REDIS); } catch (_) { /* 공유 캐시 실패는 삼킨다 */ }
  return payload;
}

/**
 * 지역별(시군구) 경신 — 하루 1회 계산한 **전체 블롭**을 캐시하고, 요청마다 한 지역만 잘라 준다.
 * 블롭 실측 147kB / 118개 지역 / 계산 1.24초 — 지역마다 온디맨드로 돌리면 감당이 안 된다.
 * @returns {object|null} { windowDays, minPrior, latestDeal, sinceDate, regions: {lawdCd: {...}} }
 */
async function getPriceRecordsByRegion({ force = false } = {}) {
  if (!force) {
    const local = cache.get(CK_REGION);
    if (local !== undefined) return local;
    try {
      const shared = await rget(CK_REGION);
      if (shared) { cache.set(CK_REGION, shared, TTL_LOCAL); return shared; }
    } catch (_) { /* Redis 미구성·장애는 계산으로 폴백 */ }
  }
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  let data = null;
  try {
    const res = await admin.rpc('get_price_records_by_region', {
      p_days: REGION_DAYS, p_min_prior: DEF_MIN_PRIOR, p_limit: REGION_LIMIT,
    });
    if (res.error) throw res.error;
    data = res.data || null;
  } catch (e) {
    logger.warn({ err: e.message }, 'price records(지역) 조회 실패');
    return null;
  }
  if (!data || !data.regions) return null;
  cache.set(CK_REGION, data, TTL_LOCAL);
  try { await rset(CK_REGION, data, TTL_REDIS); } catch (_) { /* 공유 캐시 실패는 삼킨다 */ }
  return data;
}

/** 드롭다운용 지역 목록 — 표시명은 lawd_cd 파생(동명 구 구별), 이름순 정렬. */
function regionMenu(blob) {
  if (!blob || !blob.regions) return [];
  return Object.entries(blob.regions)
    .map(([lawdCd, v]) => ({
      lawdCd,
      name: regionLabel(lawdCd, ''),
      highCount: Number(v.highCount) || 0,
      lowCount: Number(v.lowCount) || 0,
    }))
    .filter(r => r.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 한 지역 슬라이스를 전국 응답과 **같은 모양**으로 — 프론트가 한 코드로 렌더하게. */
function sliceRegion(blob, lawdCd) {
  if (!blob || !blob.regions) return null;
  const r = blob.regions[String(lawdCd)];
  if (!r) return null;
  return {
    scope: 'region',
    lawdCd: String(lawdCd),
    regionName: regionLabel(lawdCd, ''),
    latestDeal: blob.latestDeal || null,
    sinceDate: blob.sinceDate || null,
    windowDays: Number(blob.windowDays) || REGION_DAYS,
    minPrior: Number(blob.minPrior) || DEF_MIN_PRIOR,
    comparedCount: Number(r.comparedCount) || 0,
    highCount: Number(r.highCount) || 0,
    lowCount: Number(r.lowCount) || 0,
    high: (r.high || []).map(shapeRow).filter(Boolean),
    low: (r.low || []).map(shapeRow).filter(Boolean),
  };
}

module.exports = {
  getPriceRecords, getPriceRecordsByRegion, regionMenu, sliceRegion,
  regionLabel, _SIDO_PREFIX: SIDO_PREFIX,
};
