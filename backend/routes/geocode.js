const express = require('express');
const router = express.Router();
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

// Kakao 좌표 조회: keyword → address fallback
async function kakaoGeocode(key, aptName, area) {
  const headers = { Authorization: `KakaoAK ${key}` };
  const tries = [
    { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: `${area||''} ${aptName}`.trim() },
    { url: 'https://dapi.kakao.com/v2/local/search/keyword.json', q: aptName },
    { url: 'https://dapi.kakao.com/v2/local/search/address.json',  q: `${area||''} ${aptName}`.trim() },
    { url: 'https://dapi.kakao.com/v2/local/search/address.json',  q: area || '' },
  ];
  const attempts = [];
  for (const t of tries) {
    if (!t.q) continue;
    try {
      const r = await axios.get(t.url, { headers, params: { query: t.q, size: 1 }, timeout: 5000 });
      const d = r.data?.documents?.[0];
      attempts.push({ url: t.url.split('/').pop(), q: t.q, total: r.data?.meta?.total_count || 0, status: r.status });
      if (d) {
        return {
          lat: parseFloat(d.y), lng: parseFloat(d.x),
          address: d.address_name || d.address?.address_name,
          placeName: d.place_name,
        };
      }
    } catch (e) {
      attempts.push({ url: t.url.split('/').pop(), q: t.q, err: e.response?.status ? `HTTP ${e.response.status} ${e.response?.data?.message||''}` : e.message });
    }
  }
  logger.warn({ source: 'geocode', aptName, area, attempts }, 'Kakao geocode 결과 없음');
  return null;
}

// POST /api/geocode  - 단건
router.post('/', async (req, res) => {
  const { aptName, area } = req.body;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });
  const query = `${area||''} ${aptName}`.trim();
  const ck = `geo:${query}`;
  const hit = cache.get(ck);
  if (hit) return res.json({ ...hit, fromCache: true });
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key || key === 'your_kakao_rest_key') return res.json({ lat: null, lng: null, error: 'KAKAO_REST_API_KEY 미설정' });
  const out = await kakaoGeocode(key, aptName, area);
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
    const query = `${item.area||''} ${item.aptName}`.trim();
    const ck = `geo:${query}`;
    const hit = cache.get(ck);
    if (hit) return { id: item.id || item.aptName, ...hit };
    if (!key || key === 'your_kakao_rest_key') return { id: item.id || item.aptName, lat: null, lng: null };
    const out = await kakaoGeocode(key, item.aptName, item.area);
    if (!out) return { id: item.id || item.aptName, lat: null, lng: null };
    cache.set(ck, out, 86400);
    return { id: item.id || item.aptName, ...out };
  }));
  res.json({ results });
});

module.exports = router;
