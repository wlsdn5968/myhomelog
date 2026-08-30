/**
 * INTEREST-2026-08-30 (Sprint PPPPPPP): 단지별 **장기 검색 관심도**.
 *
 * 운영자 요구: "호갱노노 순위 같은 것도 중요할 것 같다. 단기 일주일 순위보다는
 *   1년 이상·3년 이상 오랫동안 사람들이 검색 많이 하는 그런 곳이 좋다."
 *
 * ⚠ 호갱노노·아실은 공개 API 가 없고 스크래핑은 이용약관 위반이라 쓰지 않는다.
 *   같은 목적(사람들의 관심이 지속되는 단지인가)을 **네이버 데이터랩 검색어트렌드**
 *   공식 API 로 달성한다. 36개월 월별 검색 지수를 준다.
 *
 * ── 왜 앵커(기준 키워드)가 필요한가 ──────────────────────────────────────
 *   데이터랩 `ratio` 는 **그 요청 안에서의 상대값**이다(요청 내 최대치가 100).
 *   [실측] 같은 '서동탄역파크자이' 가 요청 A 에서 43, 요청 B 에서 1.1 로 나왔다 —
 *   B 요청에 검색량이 큰 은마아파트가 함께 있었기 때문이다.
 *   그래서 **모든 요청에 같은 앵커를 넣고 그 값 대비 비율**로 환산해야 요청 간 비교가 된다.
 *
 * ── 왜 평균이 아니라 중앙값인가 ──────────────────────────────────────────
 *   [실측] 은마아파트는 2026-02 에 100(뉴스 이벤트로 추정되는 단발 급등)을 찍는다.
 *   평균을 쓰면 그 한 달이 기준선을 밀어올려 다른 단지가 통째로 과소평가된다.
 *   36개월 **중앙값**은 "오랫동안 꾸준히" 라는 운영자의 기준과도 정확히 맞는다.
 *
 * ── 부하 설계 (운영자: "최대한 부하가 안 걸리게") ────────────────────────
 *   · 데이터랩 일일 호출 한도가 있다. 단지는 14,660개 → 전수 조회는 불가능.
 *   · 요청 1건에 **앵커 1 + 대상 4** (API 최대 5그룹) → 15개 단지면 4회.
 *   · **요청 경로에서는 캐시만 읽는다.** 미스면 중간값을 주고 백그라운드로 채운다 —
 *     사용자 응답 지연 0, 두 번째 검색부터 실값. [[degraded-response-cached-at-edge]] 와 달리
 *     이건 점수 항목 하나라 열화가 응답 전체를 망가뜨리지 않는다.
 *   · 캐시 90일(apt_amenities 재사용, category='naver_interest').
 *     ⚠ `count` 에 **지수×10000** 을 정수로 담는다(카운트가 아니다). 해석은 이 파일에서만.
 *
 * ⚠ 한계 — 정직하게 적어둔다
 *   · 동명 단지가 있으면 검색량이 합산된다(지역을 붙이면 검색량이 0 이 되어 더 나쁘다).
 *   · 검색량은 '좋은 단지' 가 아니라 '많이 회자되는 단지' 다. 점수 근거 문구에 그대로 쓴다.
 */
const axios = require('axios');
const logger = require('../logger');
const cache = require('../cache');

let lastFetchError = null;
/**
 * NAVER API HUB (NCP) 규격 — 2026-08-30 공식 문서 실측으로 확정.
 *
 * ⚠ **구형 openapi.naver.com + X-Naver-Client-* 는 이 계정에서 401 이다.**
 *   네이버 오픈 API 발급이 개발자센터 → **NAVER Cloud Platform 의 NAVER API HUB** 로 이관됐다.
 *   운영자가 넣은 40자 Secret 은 틀린 값이 아니라 **NCP Client Secret 으로 정상**이었고,
 *   틀린 쪽은 우리 코드였다(구형 호스트·구형 헤더).
 *
 * [출처 — api.ncloud-docs.com 원문 그대로]
 *   검색어트렌드: POST https://naverapihub.apigw.ntruss.com/search-trend/v1/search
 *   뉴스 검색  : GET  https://naverapihub.apigw.ntruss.com/search/v1/news
 *   공통 헤더  : X-NCP-APIGW-API-KEY-ID: {Client ID} · X-NCP-APIGW-API-KEY: {Client Secret}
 *   요청 바디는 구형과 동일(startDate·endDate·timeUnit·keywordGroups).
 */
const DATALAB_URL = 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search';

/** NAVER API HUB 공통 인증 헤더. 값은 로그·응답에 절대 싣지 않는다. */
function ncpHeaders() {
  return {
    'X-NCP-APIGW-API-KEY-ID': String(process.env.NAVER_CLIENT_ID || '').trim(),
    'X-NCP-APIGW-API-KEY': String(process.env.NAVER_CLIENT_SECRET || '').trim(),
  };
}

/** 요청 간 비교를 가능하게 하는 고정 기준 키워드. 전국구 인지도 + 36개월 내내 비어 있지 않다(실측). */
const ANCHOR = '은마아파트';
/** 앵커 자신의 캐시 키(앵커 값은 요청마다 스케일이 달라 저장하지 않는다 — 비율만 쓴다). */
const MAX_TARGETS_PER_CALL = 4;   // API 그룹 상한 5 = 앵커 1 + 대상 4
const CACHE_DAYS = 90;

function hasKeys() {
  return Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
}

function median(arr) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 36개월 창 — 오늘 기준 3년. 운영자 기준("1년 이상·3년 이상")에 맞춘다. */
function windowDates() {
  const end = new Date();
  const start = new Date(end.getTime());
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  const f = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return { startDate: f(start), endDate: f(end) };
}

/**
 * 검색 키워드 후보 만들기 — ⚠ **DB 원본명 그대로 물으면 검색량이 안 잡힌다.**
 *
 * [실측 2026-08-30, 36개월 중앙값]
 *   "서동탄역파크자이아파트"(DB 원본) 0.003  ↔  "서동탄역파크자이"(정규화) **1.10** — 355배 차이
 *   "SK VIEW Park 2차 아파트"          **데이터 없음(빈 배열)**
 *   "에스케이뷰파크2차"+"SK뷰파크2차"   0.207
 * 사람들은 등기부상 이름이 아니라 **부르는 이름**으로 검색한다.
 *
 * 데이터랩은 한 그룹의 키워드들을 합산하므로, 안전한 기계적 변형을 함께 넣는다.
 * ⚠ 추측 변형(음역 SK↔에스케이 등)은 넣지 않는다 — 없는 단지를 끌어올 위험이 있다.
 * ⚠ 정규화 후 3자 이하는 아예 묻지 않는다("현대"·"삼성" 같은 일반명이 남의 검색량을 삼킨다).
 */
function buildKeywords(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const noParen = raw.replace(/[([{<][^)\]}>]*[)\]}>]/g, ' ').replace(/\s+/g, ' ').trim();
  const noApt = noParen.replace(/\s*아파트\s*$/, '').trim();
  const noSpace = noApt.replace(/\s+/g, '');
  const set = new Set([raw, noParen, noApt, noSpace].filter(v => v && v.length >= 4));
  // 정규화 결과가 너무 짧으면(일반명) 통째로 포기한다 — 잘못된 값보다 '모름'이 낫다.
  if (!noApt || noApt.length < 4) return [];
  return [...set].slice(0, 5);
}

/**
 * 데이터랩 1회 호출 — 앵커 + 대상 최대 4개.
 * @param {string[]} names 단지명
 * @returns {Promise<Map<string, number>|null>} 이름 → 앵커 대비 비율. 실패면 null(⚠ 0 아님)
 */
async function fetchBatch(names) {
  if (!hasKeys() || !names.length) return null;
  names = names.filter(n => buildKeywords(n).length);   // 물어봐야 의미 있는 것만
  if (!names.length) return new Map();
  const { startDate, endDate } = windowDates();
  const keywordGroups = [{ groupName: '__anchor__', keywords: [ANCHOR] }]
    .concat(names.slice(0, MAX_TARGETS_PER_CALL).map(n => ({ groupName: n, keywords: buildKeywords(n) })));
  try {
    const r = await axios.post(DATALAB_URL,
      { startDate, endDate, timeUnit: 'month', keywordGroups },
      {
        headers: Object.assign({ 'Content-Type': 'application/json' }, ncpHeaders()),
        timeout: 8000,
      });
    const results = r.data?.results || [];
    const byName = new Map();
    let anchorMed = null;
    for (const g of results) {
      const med = median((g.data || []).map(d => Number(d.ratio)));
      if (g.title === '__anchor__') anchorMed = med;
      else byName.set(g.title, med);
    }
    // 앵커가 비면 스케일을 모른다 → 판정 불가(0 으로 만들지 않는다).
    if (!anchorMed || anchorMed <= 0) {
      logger.warn({ anchorMed }, '데이터랩 앵커 값이 비어 정규화 불가 — 관심도 판정 보류');
      return null;
    }
    const out = new Map();
    for (const [name, med] of byName) {
      // ⚠ 0·빈 데이터는 '인기 없음' 이 아니라 **우리 키워드가 안 맞는다는 신호**일 때가 많다
      //   (실측: "SK VIEW Park 2차 아파트" 는 아예 빈 배열이었다).
      //   0 으로 저장하면 멀쩡한 단지가 관심도 최저점을 받는다 → null(모름)로 두고 중간값을 받게 한다.
      if (med == null || med <= 0) { out.set(name, null); continue; }
      out.set(name, med / anchorMed);
    }
    return out;
  } catch (e) {
    logger.warn({ err: e.message, status: e.response?.status, n: names.length },
      '네이버 데이터랩 조회 실패 — 관심도는 중간값 처리');
    lastFetchError = { status: e.response?.status || null, message: e.response?.data?.errorMessage || e.message };
    return null;
  }
}

// ── 캐시 (apt_amenities 재사용) ──────────────────────────────────────────
/**
 * ⚠ KEY-MISMATCH-2026-08-30: 캐시를 채우는 쪽(apt_geocache 이름)과 읽는 쪽(MOLIT 이름)이
 *   **다른 문자열**이라 히트가 0 이었다 — 1,551건을 채워놓고 점수는 전부 중간값이었다.
 *   실측: geocache "서동탄역파크자이아파트" ↔ 추천 "서동탄역파크자이".
 *   → 키를 **정규화형**으로 통일한다(괄호 제거 · 끝의 '아파트' 제거 · 공백 정리).
 *   검색 키워드를 만들 때 쓰는 것과 같은 규칙이라 사본이 생기지 않는다.
 */
function normalizeAptName(name) {
  return String(name || '')
    .replace(/[([{<][^)\]}>]*[)\]}>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*아파트\s*$/, '')
    .trim();
}

function cacheKeyFor(name, sigungu) {
  return `ni:${normalizeAptName(name)}|${String(sigungu || '').trim()}`;
}

async function readCache(key) {
  const mem = cache.get(`dlni:${key}`);
  if (mem !== undefined) return mem;
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return undefined;
    const { data } = await admin.from('apt_amenities')
      .select('count, fetched_at').eq('cache_key', key).maybeSingle();
    if (!data) return undefined;
    const ageDays = (Date.now() - new Date(data.fetched_at).getTime()) / 86400000;
    if (ageDays > CACHE_DAYS) return undefined;
    const ratio = Number(data.count) / 10000;
    cache.set(`dlni:${key}`, ratio, 86400);
    return ratio;
  } catch (_) { return undefined; }
}

/**
 * 캐시 존재 여부를 **한 번의 쿼리로** 확인한다.
 * ⚠ 단건 readCache 를 목록에 돌리면 단지 수만큼 DB 왕복이 생긴다 —
 *   실측으로 999건에 20초가 걸렸다(운영자: "최대한 부하가 안 걸리게").
 * @returns {Promise<Map<string, number>>} cache_key → 비율(유효 기간 내인 것만)
 */
async function readCacheBulk(keys) {
  const out = new Map();
  if (!keys.length) return out;
  // 메모리 히트 먼저 걷어낸다.
  const miss = [];
  for (const k of keys) {
    const mem = cache.get(`dlni:${k}`);
    if (mem !== undefined) out.set(k, mem); else miss.push(k);
  }
  if (!miss.length) return out;
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return out;
    for (let i = 0; i < miss.length; i += 200) {
      const chunk = miss.slice(i, i + 200);
      const { data } = await admin.from('apt_amenities')
        .select('cache_key, count, fetched_at').in('cache_key', chunk).limit(chunk.length);
      for (const row of data || []) {
        const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
        if (ageDays > CACHE_DAYS) continue;
        const ratio = Number(row.count) / 10000;
        out.set(row.cache_key, ratio);
        cache.set(`dlni:${row.cache_key}`, ratio, 86400);
      }
    }
  } catch (_) { /* 캐시 미스로 진행 — 조회 실패가 점수를 망가뜨리면 안 된다 */ }
  return out;
}

async function writeCache(key, ratio, lat, lng) {
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin || lat == null || lng == null) return;
    await admin.from('apt_amenities').upsert({
      cache_key: key, lat, lng, category: 'naver_interest', radius: 0,
      count: Math.round(ratio * 10000),
      fetched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'cache_key' });
    cache.set(`dlni:${key}`, ratio, 86400);
  } catch (e) {
    logger.warn({ err: e.message }, '관심도 캐시 저장 실패');
  }
}

/**
 * 캐시에 있는 것만 즉시 반환한다(**요청 경로 전용 — 외부 호출 없음**).
 * @param {Array<{aptName:string, sigungu:string}>} items
 * @returns {Promise<Map<string, number>>} `name|sigungu` → 앵커 대비 비율
 */
async function getCachedInterest(items) {
  const list = (items || []).filter(it => it && it.aptName);
  const keys = list.map(it => cacheKeyFor(it.aptName, it.sigungu));
  const byKey = await readCacheBulk(keys);
  const out = new Map();
  list.forEach((it, i) => {
    const v = byKey.get(keys[i]);
    if (v !== undefined) out.set(`${it.aptName}|${it.sigungu || ""}`, v);
  });
  return out;
}

/**
 * 캐시에 없는 단지를 배치로 채운다 — **백그라운드 전용**(await 하지 말 것).
 * 한 번에 도는 총량을 제한해 데이터랩 일일 한도를 지킨다.
 */
async function warmInterest(items, maxCalls = 4) {
  if (!hasKeys()) return { skipped: 'no-key' };
  const usable = (items || []).filter(it => it && it.aptName && it.lat != null && it.lng != null);
  const keys = usable.map(it => cacheKeyFor(it.aptName, it.sigungu));
  const have = await readCacheBulk(keys);   // ⚠ 단건 조회를 돌리면 단지 수만큼 DB 왕복이 생긴다
  const todo = usable.filter((it, i) => have.get(keys[i]) === undefined);
  let calls = 0, filled = 0, lastError = null;
  for (let i = 0; i < todo.length && calls < maxCalls; i += MAX_TARGETS_PER_CALL) {
    const chunk = todo.slice(i, i + MAX_TARGETS_PER_CALL);
    const res = await fetchBatch(chunk.map(c => c.aptName));
    calls++;
    if (!res) { lastError = lastFetchError; break; } // 실패하면 더 두드리지 않는다(한도·부하 보호)
    for (const c of chunk) {
      const ratio = res.get(c.aptName);
      if (ratio == null) continue;   // 모름은 저장하지 않는다 — 이름이 나아지면 다시 시도한다
      await writeCache(cacheKeyFor(c.aptName, c.sigungu), ratio, c.lat, c.lng);
      filled++;
    }
  }
  if (calls) logger.info({ calls, filled, pending: Math.max(0, todo.length - filled) }, '관심도 워밍');
  return { calls, filled, pending: Math.max(0, todo.length - filled), lastError };
}

/**
 * 키 **형태만** 진단한다 — 값은 절대 반환하지 않는다.
 * 401 을 만났을 때 "키가 틀렸다" 와 "권한이 없다" 를 가르기 위한 최소 정보다.
 * 실측상 가장 흔한 사고는 복사·붙여넣기로 들어간 앞뒤 공백/개행이다.
 */
function keyShape() {
  const shape = (v) => {
    if (v == null) return { set: false };
    const s = String(v);
    return {
      set: true,
      len: s.length,
      trimmedLen: s.trim().length,
      hasSpace: /\s/.test(s),          // 공백·개행이 섞였는가
      hasQuote: /["']/.test(s),        // 따옴표까지 같이 붙여넣었는가
    };
  };
  return { id: shape(process.env.NAVER_CLIENT_ID), secret: shape(process.env.NAVER_CLIENT_SECRET) };
}

module.exports = { normalizeAptName, getCachedInterest, warmInterest, hasKeys, keyShape, ANCHOR, fetchBatch, median };
