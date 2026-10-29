const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');
// SEC-1030-GEOCACHE (C15): 공용 cache.js(maxKeys 2000, 40+ 호출부 공유)를 쓰면 요청 텍스트로 키를 무한 생성해
//   다른 서비스의 장기 캐시(KAPT 30일 등)를 밀어낸다 -> 이 라우트 전용 캐시로 분리. 가득 차면 set 실패는 삼킨다(최적화일 뿐).
const _geoMem = new NodeCache({ stdTTL: 86400, checkperiod: 600, maxKeys: 1000 });
const cache = {
  get: (k) => _geoMem.get(k),
  set: (k, v, ttl) => { try { return ttl === undefined ? _geoMem.set(k, v) : _geoMem.set(k, v, ttl); } catch (_) { return false; } },
};
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');
const { getRedis } = require('../redis');
// GEO-VALIDATE-SSOT-2026-08-09 (Sprint GGGGGGG): 이 라우트의 kakaoGeocode 는 서비스 경로
//   (geocodeCacheService)의 복붙본으로 ca9fcf7(Sprint LL) 1회 동기화 후 방치 — 충전소·주차장·
//   중개사 차단, AMBIGUOUS_SGG(동명 구) umd 하드필터, 상가 소프트 강등이 빠진 채 드리프트됨.
//   검증 상수·정책을 서비스 모듈에서 import 해 동일화(재드리프트 원천 차단).
const { NON_APT_PATTERNS, NON_APT_CATEGORY, AMBIGUOUS_SGG } = require('../services/geocodeCacheService');

// ── GEOCAP-2026-08-09 (Plan 002): 서비스 전역 일일 Kakao 호출 상한 ─────────────────────
// 이 라우트는 인증 없이 열려 있고 캐시 키가 요청 텍스트라 캐시 미스를 강제할 수 있어,
// 배치 50 × 다단계 폴백으로 요청당 수백 회 Kakao 호출 증폭이 가능했다(쿼터 고갈 → 지도 전면 다운).
// IP 일일 캡(server.js 의 dailyLimit scope 'geocode')과 별개로, 전역 카운터로 총량 천장을 둔다.
// SEC-1030-GEOCAP (C13): 상한의 단위는 **Kakao HTTP 호출 수**(kakaoGeocode 의 axios 시도 1회 = 1)다.
//   종전엔 항목당 1 로 세어 실제 호출은 최대 6배(시도 6단계)까지 새 나갔다.
//   상한 20,000 근거: Kakao 경고선 60,000/일의 약 33% - 종전 8,000 항목 x 평균 2~3 시도와 비슷한 실사용을 덮으면서
//   백필 cron 등 다른 소비자 여유(2/3)를 남긴다. 도달 시 Kakao 를 부르지 않고 null 좌표 반환(프론트는 마커 생략).
//   Redis 미설정/실패 시엔 인스턴스 메모리 카운터로 같은 상한을 적용한다(fail-open 아님 - 인스턴스별이라 총량은 인스턴스 수배까지 가능).
const GEOCODE_GLOBAL_DAILY_CAP = 20000;
const _memCap = { day: '', n: 0 };

/** 카운트 → 차단 여부 (순수 판정 — 테스트 고정). null/undefined = Redis 미설정 → 허용 */
function _geocodeCapExceeded(count, cap) {
  if (count === null || count === undefined) return false;
  return Number(count) > cap;
}

/** Kakao 실호출 직전에만 호출 — 전역 카운터 증가 후 현재값 반환(실패/미설정 시 null) */
const _geoDay = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
function _bumpMemCap(by = 1) {
  const day = _geoDay();
  if (_memCap.day !== day) { _memCap.day = day; _memCap.n = 0; }
  _memCap.n += by;
  return _memCap.n;
}
// SEC-1030-GEOCAP 보정(적대 리뷰 2026-10-30): 시도마다 INCR 하면 배치 1회(50항목 × 시도 6)가 Redis 명령 300개였다
//   (무료 한도 월 50만 — 2026-10 소진 전례). 항목당 '시작 1회 INCR + 끝난 뒤 남은 시도 INCRBY 1회' 로 최대 2개,
//   상한에 닿은 날은 이 인스턴스에서 Redis 를 더 부르지 않는다(_capHitDay).
let _capHitDay = '';
async function _bumpGeoCap(by = 1) {
  const redis = getRedis();
  if (!redis) return _bumpMemCap(by); // Redis 미설정 -> 메모리 카운터
  const key = `geocap:${_geoDay()}`;
  let n;
  try { n = Number(await redis.incrby(key, by)); } catch (_) { return _bumpMemCap(by); } // Redis 실패 -> 메모리 카운터
  // 만료 설정 실패는 카운트와 무관 — 메모리 카운터로 내려가 이중 집계하지 않는다(키에 날짜가 있어 고아 키만 남는다)
  if (n === by) { try { await redis.expire(key, 2 * 24 * 3600); } catch (_) { /* 무시 */ } }
  return n;
}

// REGION-CENTROID-2026-10-29: 장소 이름이 없고 주소가 번지(숫자)로 끝나지 않으면 '지역 이름뿐' 결과(동·구 중심점)다.
function _isRegionOnly(d, addrText) {
  return !(d && d.place_name) && !/\s\d+(-\d+)?$/.test(String(addrText || '').trim());
}

// Kakao 좌표 조회: keyword → address fallback
// STAB-AUDIT-2026-05-06: sigungu·umdNm 명시 시 결과 검증 강제 (동명이지 환각 차단)
async function kakaoGeocode(key, aptName, area, sigungu, umdNm, state = {}) {
  // SEC-1030-GEOCAP: 상한 단위는 카카오 HTTP 호출 수. 시작 전 1을 세어 판정하고, 실제 시도 수는 끝난 뒤 한 번에 더한다.
  if (_capHitDay === _geoDay()) { state.capped = true; return null; }
  if (_geocodeCapExceeded(await _bumpGeoCap(1), GEOCODE_GLOBAL_DAILY_CAP)) { _capHitDay = _geoDay(); state.capped = true; return null; }
  const ctr = { n: 0 };
  try {
    return await _kakaoGeocodeTries(key, aptName, area, sigungu, umdNm, ctr);
  } finally {
    if (ctr.n > 1) {
      const total = await _bumpGeoCap(ctr.n - 1);
      if (_geocodeCapExceeded(total, GEOCODE_GLOBAL_DAILY_CAP)) _capHitDay = _geoDay();
    }
  }
}

async function _kakaoGeocodeTries(key, aptName, area, sigungu, umdNm, ctr) {
  const headers = { Authorization: `KakaoAK ${key}` };
  // sigungu+umdNm 우선 query (가장 정확) → 그 외 fallback
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  const tries = [
    sgg && umd ? { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: `${sgg} ${umd} ${aptName}`.trim() } : null,
    sgg ? { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: `${sgg} ${aptName}`.trim() } : null,
    { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: `${area||''} ${aptName}`.trim() },
    { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: aptName },
    { url: 'https://dapi.kakao.com/v2/local/search/address.json',  q: `${area||''} ${aptName}`.trim() },
    { url: 'https://dapi.kakao.com/v2/local/search/address.json',  q: area || '' },
  ].filter(Boolean);
  const attempts = [];
  for (const t of tries) {
    if (!t.q) continue;
    ctr.n += 1; // SEC-1030-GEOCAP: 실제 시도 수(카카오 호출) — kakaoGeocode 가 끝난 뒤 전역 카운터에 더한다
    try {
      const r = await axios.get(t.url, { headers, params: { query: t.q, size: 5 }, timeout: 5000 });  // size 1 → 5
      const docs = r.data?.documents || [];
      attempts.push({ url: t.url.split('/').pop(), q: t.q, total: r.data?.meta?.total_count || 0, status: r.status });
      if (!docs.length) continue;

      // STAB-AUDIT-2026-05-06: 환각 차단 — sgg 명시 시 결과 address 가 sgg 포함하는지 검증
      // Sprint LL (2026-05-16): umdNm + place_name + category 추가 검증.
      //   Audit 결과 (apt_geocache 7195 rows 중 199건 의심):
      //     - 73건 non-apt place_name (어린이집/사우나/마트 등)
      //     - 110건 umdNm 불일치 (같은 sigungu 내 다른 동)
      //     - 16건 sigungu 불일치
      //   3-tier 점수 매칭:
      //     - umdMatch: +2, aptCategory: +2, nonAptPenalty: -5
      //     - bestScore < 0 차단
      // GEO-VALIDATE-SSOT-2026-08-09: 검증 상수·판정식을 geocodeCacheService 와 동일화
      //   (AMBIGUOUS_SGG umd 하드필터 + sanggaPenalty 추가 — 서비스 경로와 같은 정책).
      let chosen = null;
      let bestScore = -1;
      for (const d of docs) {
        const lat = parseFloat(d.y);
        const lng = parseFloat(d.x);
        if (!isValidKoreaCoord(lat, lng)) {
          attempts.push({ skipped: 'out_of_korea', lat, lng });
          continue;
        }
        const addrText = d.address_name || d.address?.address_name || '';
        // REGION-CENTROID-2026-10-29 (운영 실측): 마지막 주소 검색(q=area "노원구 공릉동")은 번지 없는 '지역' 결과 = 동 중심점을
        //   돌려준다. 그 좌표를 단지 좌표로 답해 공릉풍림아이원 핀이 본체에서 약 800m 떨어진 동 한가운데 찍혔다.
        //   주소 검색 결과는 번지(숫자)로 끝날 때만 단지 위치로 받는다 — 지역 이름뿐이면 "찾지 못함"이 정직하다.
        if (_isRegionOnly(d, addrText)) { attempts.push({ skipped: 'region_only', addr: addrText }); continue; }
        const placeName = d.place_name || '';
        const categoryName = d.category_name || '';
        // SIGUNGU-SPACE-FIX-2026-06-14: molit "안양시동안구"(붙임) vs Kakao "안양시 동안구"(띄어쓰기) → 공백 무시 비교 (경기 시+구 좌표 갭 해소)
        if (sgg && !addrText.replace(/\s+/g, '').includes(sgg.replace(/\s+/g, ''))) continue; // sigungu 불일치 → 환각 reject
        // CROSS-CITY-FIX-2026-06-03 동일화: 중복 시군구명(서구/중구 등)은 umd(법정동) 하드 필터 필수
        if (sgg && umd && AMBIGUOUS_SGG.has(sgg) && !addrText.replace(/\s+/g, '').includes(umd.replace(/\s+/g, ''))) continue;
        const isNonApt = (placeName && NON_APT_PATTERNS.test(placeName))
                      || (categoryName && NON_APT_CATEGORY.test(categoryName));
        const umdMatch = umd && addrText.replace(/\s+/g, '').includes(umd.replace(/\s+/g, '')) ? 2 : 0;
        const aptCategory = categoryName.includes('아파트') ? 2 : 0;
        const nonAptPenalty = isNonApt ? -5 : 0;
        // SANGGA-SOFT-2026-07-17 동일화: '상가' place 는 소프트 강등(-1) — 본체 후보가 있으면 그쪽 우선
        const sanggaPenalty = (!isNonApt && /상가/.test(placeName)) ? -1 : 0;
        const score = umdMatch + aptCategory + nonAptPenalty + sanggaPenalty;
        if (score > bestScore) {
          bestScore = score;
          chosen = { d, lat, lng, addrText, score };
        }
      }
      // Sprint LL: bestScore < 0 차단 — 매칭 신뢰도 부족 (非아파트 카테고리 등)
      if (!chosen || chosen.score < 0) continue;

      return {
        lat: chosen.lat, lng: chosen.lng,
        address: chosen.addrText,
        placeName: chosen.d.place_name,
      };
    } catch (e) {
      attempts.push({ url: t.url.split('/').pop(), q: t.q, err: e.response?.status ? `HTTP ${e.response.status} ${e.response?.data?.message||''}` : e.message });
    }
  }
  logger.warn({ source: 'geocode', aptName, area, sigungu, attempts }, 'Kakao geocode 결과 없음');
  return null;
}

// POST /api/geocode  - 단건
router.post('/', async (req, res) => {
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  const { aptName, area, sigungu, umdNm } = req.body || {};
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });
  // STAB-AUDIT-2026-05-06: 캐시 키에 sigungu·umdNm 포함 — 동명 단지 충돌 차단
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  // SEC-1030-GEOCACHE: area 는 DB 캐시 조회에 안 쓰이므로 길이 60 으로 잘라 키 폭주를 막는다
  const ck = `geo:${aptName}|${sgg}|${umd}|${String(area||'').slice(0, 60)}`.trim();
  const hit = cache.get(ck);
  if (hit) return res.json({ ...hit, fromCache: true });
  // CACHE-FIRST-2026-08-19 (Sprint NNNNNNN-3, 라이브 실측 확정 결함): 반포자이 요청이 캐시의
  //   정답(반포자이아파트 127.0132)을 두고 Kakao 이름검색으로 '반포자이플라자'(127.0099, ~290m
  //   오프셋 상가)를 반환하고 있었다 — 이 라우트가 apt_geocache 를 전혀 조회하지 않았기 때문.
  //   검증된 DB 캐시를 먼저 본다(Kakao 비용 0 → GEOCAP 미소모). 미스일 때만 기존 경로 그대로.
  try {
    const fromDb = await require('../services/geocodeCacheService').resolveCoordFromCacheOnly({ aptName, sigungu: sgg, umdNm: umd });
    // NAME-HEAL-2026-10-22: 재검색으로도 위치를 확인하지 못한 단지 — 가게 자리에 핀을 찍지 않고 "찾지 못함"으로 답한다(카카오 재호출 없음)
    if (fromDb && fromDb.untrusted) return res.json({ lat: null, lng: null, error: '위치 확인 중' });
    if (fromDb && fromDb.lat != null) {
      const out = { lat: fromDb.lat, lng: fromDb.lng, address: fromDb.address || null, placeName: fromDb.place_name || fromDb.placeName || null, fromGeocache: true };
      cache.set(ck, out, 86400);
      return res.json(out);
    }
  } catch (_) { /* 캐시 조회 실패는 기존 Kakao 경로로 계속 — 응답을 막지 않는다 */ }
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key || key === 'your_kakao_rest_key') return res.json({ lat: null, lng: null, error: 'KAKAO_REST_API_KEY 미설정' });
  // GEOCAP-2026-08-09 (Plan 002): 캐시 히트는 무과금 - 전역 카운터는 kakaoGeocode 의 시도마다 올린다(SEC-1030-GEOCAP)
  const st = {};
  const out = await kakaoGeocode(key, aptName, area, sgg, umd, st);
  if (st.capped) return res.json({ lat: null, lng: null, error: 'quota' });
  if (!out) return res.json({ lat: null, lng: null, error: '결과없음' });
  cache.set(ck, out, 86400);
  res.json(out);
});

// POST /api/geocode/batch - 배치
// P2-1 (2026-05-22): 공개 endpoint 요청당 fan-out 방지 — item 상한(초과 시 400 명시 거절) +
//   동시성 제한(청크 순차). 정상 프론트 호출(needGeo 수십 건 이하)엔 영향 없음.
//   geocodeCacheService 통합 등 범위 확장 X.
const MAX_BATCH_ITEMS = 50;
const BATCH_CONCURRENCY = 5;
router.post('/batch', async (req, res) => {
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] 필수' });
  if (items.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ error: 'too_many_items', max: MAX_BATCH_ITEMS });
  }
  const key = process.env.KAKAO_REST_API_KEY;
  const geocodeOne = async (item) => {
    // STAB-AUDIT-2026-05-06: 캐시 키 + Kakao 검색에 sigungu·umdNm 추가 — 동명 환각 차단
    const sgg = String(item.sigungu || '').trim();
    const umd = String(item.umdNm || '').trim();
    const id = item.id || `${item.aptName}|${sgg}|${umd}`;
    const ck = `geo:${item.aptName}|${sgg}|${umd}|${String(item.area||'').slice(0, 60)}`.trim();
    const hit = cache.get(ck);
    if (hit) return { id, ...hit };
    // CACHE-FIRST-2026-08-19: 단건 라우트와 동일 — 검증된 DB 캐시 선조회(비용 0). 주석은 위 참조.
    try {
      const fromDb = await require('../services/geocodeCacheService').resolveCoordFromCacheOnly({ aptName: item.aptName, sigungu: sgg, umdNm: umd });
      if (fromDb && fromDb.untrusted) return { id, lat: null, lng: null }; // NAME-HEAL-2026-10-22
      if (fromDb && fromDb.lat != null) {
        const out = { lat: fromDb.lat, lng: fromDb.lng, address: fromDb.address || null, placeName: fromDb.place_name || fromDb.placeName || null, fromGeocache: true };
        cache.set(ck, out, 86400);
        return { id, ...out };
      }
    } catch (_) { /* 미스/실패 → 기존 경로 */ }
    if (!key || key === 'your_kakao_rest_key') return { id, lat: null, lng: null };
    // GEOCAP-2026-08-09 (Plan 002): 캐시 히트 무과금 - 카운트는 kakaoGeocode 시도마다(SEC-1030-GEOCAP), 초과 시 null 반환
    const out = await kakaoGeocode(key, item.aptName, item.area, sgg, umd);
    if (!out) return { id, lat: null, lng: null };
    cache.set(ck, out, 86400);
    return { id, ...out };
  };
  // 동시성 제한 — BATCH_CONCURRENCY 개씩 청크 순차 처리 (전체 Promise.all fan-out 제거). 순서 보존.
  const results = [];
  for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
    const chunkResults = await Promise.all(items.slice(i, i + BATCH_CONCURRENCY).map(geocodeOne));
    results.push(...chunkResults);
  }
  res.json({ results });
});

module.exports = router;
// 순수 판정 함수 노출 — 계약 테스트 고정용 (Plan 002)
module.exports._geocodeCapExceeded = _geocodeCapExceeded;
module.exports._isRegionOnly = _isRegionOnly;
module.exports._kakaoGeocode = kakaoGeocode;
module.exports._bumpGeoCap = _bumpGeoCap;
module.exports._memCap = _memCap;
module.exports._resetCapHit = () => { _capHitDay = ''; };
module.exports.GEOCODE_GLOBAL_DAILY_CAP = GEOCODE_GLOBAL_DAILY_CAP;
