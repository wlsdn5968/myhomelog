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
      let chosen = null;
      for (const d of docs) {
        const lat = parseFloat(d.y);
        const lng = parseFloat(d.x);
        if (!isValidKoreaCoord(lat, lng)) {
          attempts.push({ skipped: 'out_of_korea', lat, lng });
          continue;
        }
        const addrText = d.address_name || d.address?.address_name || '';
        if (sgg && !addrText.includes(sgg)) continue; // sigungu 불일치 → 환각 reject
        chosen = { d, lat, lng, addrText };
        break;
      }
      if (!chosen) continue;

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
  const out = await kakaoGeocode(key, aptName, area, sgg, umd);
  if (!out) return res.json({ lat: null, lng: null, error: '결과없음' });
  cache.set(ck, out, 86400);
  res.json(out);
});

// POST /api/geocode/batch - 배치
router.post('/batch', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] 필수' });
  const key = process.env.KAKAO_REST_API_KEY;
  const results = await Promise.all(items.map(async (item) => {
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
  }));
  res.json({ results });
});

module.exports = router;
