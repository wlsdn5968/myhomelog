const express = require('express');
const router = express.Router();
const axios = require('axios');
const cache = require('../cache');

// 임시 디버그: Kakao 응답 원문 확인
router.get('/debug', async (req, res) => {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return res.json({ error: 'no key' });
  try {
    const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
      headers: { Authorization: `KakaoAK ${key}` },
      params: { query: '강남구 역삼동', size: 1 },
      timeout: 5000,
      validateStatus: () => true,
    });
    res.json({
      status: r.status,
      headers: r.headers,
      keyHead: key.substring(0, 8) + '...',
      keyLen: key.length,
      keyHasWhitespace: /\s/.test(key),
      data: r.data,
    });
  } catch (e) {
    res.json({ error: e.message, code: e.code });
  }
});

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
  try {
    const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
      headers: { Authorization: `KakaoAK ${key}` },
      params: { query, size: 1 }, timeout: 5000,
    });
    const d = r.data?.documents?.[0];
    if (!d) return res.json({ lat: null, lng: null, error: '결과없음' });
    const out = { lat: parseFloat(d.y), lng: parseFloat(d.x), address: d.address_name, placeName: d.place_name };
    cache.set(ck, out, 86400);
    res.json(out);
  } catch (e) { res.json({ lat: null, lng: null, error: e.message }); }
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
    try {
      const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        headers: { Authorization: `KakaoAK ${key}` },
        params: { query, size: 1 }, timeout: 5000,
      });
      const d = r.data?.documents?.[0];
      if (!d) return { id: item.id || item.aptName, lat: null, lng: null };
      const out = { lat: parseFloat(d.y), lng: parseFloat(d.x), address: d.address_name };
      cache.set(ck, out, 86400);
      return { id: item.id || item.aptName, ...out };
    } catch { return { id: item.id || item.aptName, lat: null, lng: null }; }
  }));
  res.json({ results });
});

module.exports = router;
