/**
 * SEC-1030 한도 계열 결함 수정 검증 (C11 C13 C14 C15 C16)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const express = require('express');

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

function stub(rel, exports_) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports_ };
}

// ── C14 IPv6 정규화 ──
test('normalizeIpKey: IPv6 는 /64, IPv4 와 mapped 는 IPv4', () => {
  const { normalizeIpKey } = require('../utils/ipKey');
  assert.equal(normalizeIpKey('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIpKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIpKey('::ffff:0102:0304'), '1.2.3.4');
  const a = normalizeIpKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  const b = normalizeIpKey('2001:0DB8:1:2::1');
  assert.equal(a, b);
  assert.equal(a, '2001:db8:1:2::/64');
  assert.notEqual(a, normalizeIpKey('2001:db8:1:3::1'));
  assert.equal(normalizeIpKey('::1'), '0:0:0:0::/64');
  assert.equal(normalizeIpKey(undefined), 'unknown');
});

test('rateLimit/dailyLimit 식별자가 IPv6 /64 로 묶인다', () => {
  const { getRateLimitIdentity } = require('../middleware/rateLimit');
  const { getLimitIdentity } = require('../middleware/dailyLimit');
  assert.equal(getRateLimitIdentity({ ip: '2001:db8:1:2::5' }), getRateLimitIdentity({ ip: '2001:db8:1:2::9' }));
  assert.equal(getLimitIdentity({ ip: '2001:db8:1:2::5' }).value, getLimitIdentity({ ip: '2001:db8:1:2:ffff::1' }).value);
  assert.equal(getLimitIdentity({ ip: '9.9.9.9' }).value, '9.9.9.9');
});

// ── C16 timeout reason ──
test('Upstash reason=timeout: 비용 scope 는 503, 일반 scope 는 통과', async () => {
  const rlPath = require.resolve('../middleware/rateLimit');
  delete require.cache[rlPath];
  stub('@upstash/ratelimit', {
    Ratelimit: class { constructor() {} limit() { return Promise.resolve({ success: true, limit: 5, remaining: 5, reset: Date.now() + 1000, reason: 'timeout' }); } static slidingWindow() { return {}; } },
  });
  stub('../redis', { getRedis: () => ({}) });
  const { makeRateLimiter } = require('../middleware/rateLimit');
  const mkRes = () => ({ code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  const cost = makeRateLimiter({ limit: 5, windowSec: 60, scope: 'chat', message: 'm' });
  const r1 = mkRes(); let n1 = false;
  await cost({ ip: '1.1.1.1' }, r1, () => { n1 = true; });
  assert.equal(r1.code, 503); assert.equal(n1, false);
  assert.equal(r1.body.code, 'ratelimit_unavailable');

  const general = makeRateLimiter({ limit: 5, windowSec: 60, scope: 'general', message: 'm' });
  const r2 = mkRes(); let n2 = false;
  await general({ ip: '1.1.1.1' }, r2, () => { n2 = true; });
  assert.equal(n2, true); assert.equal(r2.code, null);
  delete require.cache[rlPath];
});

// ── C11 dailyLimit includeGet ──
test('dailyLimit: includeGet 없으면 GET 면제, 있으면 한도 적용', async () => {
  const { dailyLimit } = require('../middleware/dailyLimit');
  const mkRes = () => ({ code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } });
  const req = () => ({ method: 'GET', ip: '7.7.7.7', headers: {} });
  const skip = dailyLimit({ limit: 1, scope: 'sec1030-skip' });
  for (let i = 0; i < 3; i++) { let n = false; const r = mkRes(); await skip(req(), r, () => { n = true; }); assert.equal(n, true); assert.equal(r.code, null); }
  const inc = dailyLimit({ limit: 1, scope: 'sec1030-inc', includeGet: true });
  let n1 = false; await inc(req(), mkRes(), () => { n1 = true; }); assert.equal(n1, true);
  const r2 = mkRes(); let n2 = false; await inc(req(), r2, () => { n2 = true; });
  assert.equal(n2, false); assert.equal(r2.code, 429);
});

// ── C11 nearby 범위·반올림 ──
test('GET /nearby: 한국 밖 400, 좌표 소수 4자리 반올림', async () => {
  const seen = [];
  stub('../services/kakaoService', { getNearbyAmenities: async (la, ln) => { seen.push([la, ln]); return { school: 1 }; }, getTransitMinutes: async () => null, getCarMinutes: async () => null, keywordToCoord: async () => null });
  stub('../services/propertyService', { getAIRecommendations: async () => [] });
  const rp = require.resolve('../routes/properties');
  delete require.cache[rp];
  const router = require('../routes/properties');
  const app = express(); app.use('/p', router);
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/p/nearby`;
  try {
    assert.equal((await fetch(`${base}?lat=0&lng=0`)).status, 400);
    assert.equal((await fetch(`${base}?lat=37.5&lng=140`)).status, 400);
    const ok = await fetch(`${base}?lat=37.123456789&lng=127.987654321`);
    assert.equal(ok.status, 200);
    assert.deepEqual(seen[0], [37.1235, 127.9877]);
    // 적대 리뷰 2026-10-30: 거절되는 잘못된 입력은 일일 한도를 깎지 않는다(검사가 한도보다 앞)
    const before = Number(ok.headers.get('x-daily-remaining'));
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}?lat=x&lng=y`)).status, 400);
    const ok2 = await fetch(`${base}?lat=37.5&lng=127.0`);
    assert.equal(Number(ok2.headers.get('x-daily-remaining')), before - 1);
  } finally { srv.close(); delete require.cache[rp]; }
});

// ── C13 / C15 geocode ──
test('geocode: Redis 없으면 메모리 카운터가 상한을 적용(fail-open 아님)', async () => {
  const g = require('../routes/geocode');
  g._memCap.n = 0;
  const a = await g._bumpGeoCap();
  const b = await g._bumpGeoCap();
  assert.equal(a, 1); assert.equal(b, 2);
  g._memCap.n = g.GEOCODE_GLOBAL_DAILY_CAP;
  assert.equal(g._geocodeCapExceeded(await g._bumpGeoCap(), g.GEOCODE_GLOBAL_DAILY_CAP), true);
  g._memCap.n = 0;
});

test('geocode: 소스 계약 - 전용 캐시, area 60자', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../routes/geocode.js'), 'utf8');
  assert.doesNotMatch(src, /require\('\.\.\/cache'\)/);
  assert.match(src, /maxKeys: 1000/);
  assert.match(src, /slice\(0, 60\)/);
});

// 적대 리뷰 2026-10-30: 시도마다 INCR 하면 배치 1회가 Redis 명령 300개 — 항목당 카운터 호출 최대 2회, 상한 뒤엔 0회.
test('geocode: 카운터는 항목당 최대 2회 갱신, 실제 카카오 시도 수만큼 증가, 상한 도달 뒤엔 카카오·카운터 모두 멈춘다', async () => {
  const axios = require('axios');
  const realGet = axios.get;
  let kakaoCalls = 0;
  axios.get = async () => { kakaoCalls += 1; return { status: 200, data: { documents: [], meta: { total_count: 0 } } }; };
  const gp = require.resolve('../routes/geocode');
  delete require.cache[gp];
  const g = require('../routes/geocode');
  const bumps = [];
  const realBump = g._bumpGeoCap;
  try {
    g._memCap.day = ''; g._memCap.n = 0; g._resetCapHit();
    const kakaoGeocode = g._kakaoGeocode;
    const st = {};
    const out = await kakaoGeocode('k', '테스트단지', '노원구 공릉동', '노원구', '공릉동', st);
    assert.equal(out, null);
    assert.equal(kakaoCalls, 6);                 // 시도 6단계 전부 빈 결과
    assert.equal(g._memCap.n, 6);                // 카운터 = 실제 카카오 호출 수
    // 상한 도달
    g._memCap.n = g.GEOCODE_GLOBAL_DAILY_CAP;
    kakaoCalls = 0;
    const st2 = {};
    assert.equal(await kakaoGeocode('k', 'A', '', '', '', st2), null);
    assert.equal(st2.capped, true);
    assert.equal(kakaoCalls, 0);
    const before = g._memCap.n;
    const st3 = {};
    await kakaoGeocode('k', 'B', '', '', '', st3);
    assert.equal(st3.capped, true);
    assert.equal(g._memCap.n, before);           // 상한 표시 뒤엔 카운터도 더 부르지 않는다
  } finally {
    axios.get = realGet; g._memCap.n = 0; g._resetCapHit(); delete require.cache[gp];
  }
});
