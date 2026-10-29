/**
 * REDIS-BUDGET-2 (2026-10-30): Upstash 월 한도(50만 명령) 재소진 조사.
 *  ① /api/health 를 generalLimiter 에서 뺐다던 Plan 139 가 실제로는 작동하지 않았다(healthMemLimiter 가 next() → '/api/' 마운트에 또 걸림)
 *  ② 더 엄격한 Redis 리미터가 마운트된 경로가 generalLimiter 까지 이중으로 탔다(요청당 Redis 호출 2회)
 * 실제 server.js 앱을 띄우고 makeRateLimiter 만 계수기로 바꿔, 요청 1건이 지나는 Redis 리미터 수를 센다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const rlPath = require.resolve('../middleware/rateLimit');
const real = require(rlPath);
const hits = {};
require.cache[rlPath].exports = {
  ...real,
  makeRateLimiter: (opts) => (req, res, next) => { hits[opts.scope] = (hits[opts.scope] || 0) + 1; next(); },
};
process.env.VERCEL = '1'; // server.js 는 이 표시가 없으면 3001 포트로 listen 해 테스트 프로세스가 끝나지 않는다
const app = require('../server');

async function countFor(p, method = 'GET') {
  for (const k of Object.keys(hits)) delete hits[k];
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  try {
    await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }).catch(() => {});
  } finally { await new Promise(r => srv.close(r)); }
  return { ...hits };
}

test('상태 확인(/api/health)은 Redis 리미터를 하나도 지나지 않는다(메모리 제한만)', async () => {
  assert.deepEqual(await countFor('/api/health'), {});
});

test('데이터 경로는 Redis 리미터를 1개만 지난다(dataLimiter, generalLimiter 중복 제거)', async () => {
  for (const p of ['/api/transactions/codes', '/api/search/popular', '/api/visits/today', '/api/region/menu', '/api/analysis/compare']) {
    const h = await countFor(p, p.endsWith('compare') ? 'POST' : 'GET');
    assert.equal(h.general || 0, 0, `${p} 가 generalLimiter 를 또 탔다: ${JSON.stringify(h)}`);
    assert.equal(h.data, 1, `${p} 에 dataLimiter 가 없다: ${JSON.stringify(h)}`);
  }
});

test('다른 Redis 리미터가 없는 경로는 generalLimiter 를 그대로 지난다(보호 유지)', async () => {
  assert.equal((await countFor('/api/regulations')).general, 1);
  assert.equal((await countFor('/api/kakao/unlink-callback', 'POST')).general, 1); // 웹훅은 dataLimiter 앞
  assert.equal((await countFor('/api/does-not-exist')).general, 1);
});

test('건너뛰기 목록의 모든 경로는 server.js 마운트에서 Redis 리미터가 붙어 있다(목록·마운트 대조)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const re = app._GENERAL_SKIP_RE;
  const names = re.source.match(/\(([a-z|-]+)\)/)[1].split('|').filter(n => n !== 'health');
  for (const n of names) {
    const mount = new RegExp(`app\\.use\\('/api/${n}(?:/[a-z-]+)?',[^\\n]*\\b(dataLimiter|chatDataLimiter|chatLimiter|ogLimiter)\\b`);
    assert.match(src, mount, `/api/${n} 에 Redis 리미터 마운트가 없는데 generalLimiter 를 건너뛴다`);
  }
  // 반대로: dataLimiter 로 마운트된 경로는 목록에 있다(kakao 는 웹훅 때문에 의도적으로 제외)
  for (const m of src.matchAll(/app\.use\('\/api\/([a-z-]+)[^']*',[^\n]*\bdataLimiter\b/g)) {
    if (m[1] === 'kakao') continue;
    assert.ok(re.test('/' + m[1]), `/api/${m[1]} 는 dataLimiter 가 있는데 목록에 없어 Redis 를 두 번 쓴다`);
  }
});
