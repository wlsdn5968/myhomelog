const express = require('express');
const router = express.Router();
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');

// Kakao 좌표 조회: keyword → address fallback
// STAB-AUDIT-2026-05-06: sigungu·umdNm 명시 시 결과 검증 강제 (동명이지 환각 차단)
async function kakaoGeocode(key, aptName, area, sigungu, umdNm) {
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
      const NON_APT_PATTERNS = /빌라|사우나|어린이집|유치원|학원|마트|편의점|식당|카페|사옥|호텔|모텔|병원|약국|의원|학교|교회|성당|사찰|공원|체육관|주유소|미용실|세탁소|꽃집/;
      const NON_APT_CATEGORY = /빌라|사우나|어린이집|유치원|학원|마트|편의점|음식점|카페|호텔|모텔|병원|약국|학교|종교|공원|체육|주유소|미용|세탁|꽃집/;
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
        const placeName = d.place_name || '';
        const categoryName = d.category_name || '';
        // SIGUNGU-SPACE-FIX-2026-06-14: molit "안양시동안구"(붙임) vs Kakao "안양시 동안구"(띄어쓰기) → 공백 무시 비교 (경기 시+구 좌표 갭 해소)
        if (sgg && !addrText.replace(/\s+/g, '').includes(sgg.replace(/\s+/g, ''))) continue; // sigungu 불일치 → 환각 reject
        const isNonApt = (placeName && NON_APT_PATTERNS.test(placeName))
                      || (categoryName && NON_APT_CATEGORY.test(categoryName));
        const umdMatch = umd && addrText.replace(/\s+/g, '').includes(umd.replace(/\s+/g, '')) ? 2 : 0;
        const aptCategory = categoryName.includes('아파트') ? 2 : 0;
        const nonAptPenalty = isNonApt ? -5 : 0;
        const score = umdMatch + aptCategory + nonAptPenalty;
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
  const { aptName, area, sigungu, umdNm } = req.body;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });
  // STAB-AUDIT-2026-05-06: 캐시 키에 sigungu·umdNm 포함 — 동명 단지 충돌 차단
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  const ck = `geo:${aptName}|${sgg}|${umd}|${area||''}`.trim();
  const hit = cache.get(ck);
  if (hit) return res.json({ ...hit, fromCache: true });
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key || key === 'your_kakao_rest_key') return res.json({ lat: null, lng: null, error: 'KAKAO_REST_API_KEY 미설정' });
  // DIAG-2026-06-14 (임시): 단지명 geocode 전면 null 원인 규명. 진단 후 즉시 제거. (키 미노출 — 길이만)
  //   selftest = 서버 소스(UTF-8) 하드코딩 한글 → transport 인코딩 배제. fromBody = req.body 유래.
  if (req.query.debug === '1') {
    const SELF = '서울 송파구 헬리오시티';
    const kk = async (query) => {
      try {
        const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json',
          { headers: { Authorization: `KakaoAK ${key}` }, params: { query, size: 5 }, timeout: 5000 });
        return { query, qBytes: Buffer.byteLength(query, 'utf8'), status: r.status, total: r.data?.meta?.total_count,
          docs: (r.data?.documents || []).slice(0, 2).map(d => ({ name: d.place_name, addr: d.address_name, y: d.y, x: d.x })) };
      } catch (e) { return { query, errStatus: e.response?.status || null, errMsg: e.message }; }
    };
    const q = (`${sgg} ${umd} ${aptName}`).trim() || aptName;
    return res.json({ debug: true, keyLen: key.length,
      received: { aptName, bytes: Buffer.byteLength(String(aptName), 'utf8') },
      fromBody: await kk(q),
      selftest: await kk(SELF),
      // 경기 "시+구" sigungu 검증 reject 가설: realFn(검증 포함)=null 이고 rawGyeonggi(검증 없음)=결과 있으면 확정
      realFn_gyeonggi: await kakaoGeocode(key, '평촌어바인퍼스트', null, '안양시동안구', '호계동'),
      rawGyeonggi: await kk('안양시동안구 호계동 평촌어바인퍼스트') });
  }
  const out = await kakaoGeocode(key, aptName, area, sgg, umd);
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
  const { items } = req.body;
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
    const ck = `geo:${item.aptName}|${sgg}|${umd}|${item.area||''}`.trim();
    const hit = cache.get(ck);
    if (hit) return { id, ...hit };
    if (!key || key === 'your_kakao_rest_key') return { id, lat: null, lng: null };
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
