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

test('geocode: 소스 계약 - 시도마다 카운트, 전용 캐시, area 60자', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../routes/geocode.js'), 'utf8');
  assert.doesNotMatch(src, /require\('\.\.\/cache'\)/);
  assert.match(src, /maxKeys: 1000/);
  assert.match(src, /slice\(0, 60\)/);
  const loopBody = src.slice(src.indexOf('for (const t of tries)'));
  assert.ok(loopBody.indexOf('_bumpGeoCap()') < loopBody.indexOf('axios.get('));
});
