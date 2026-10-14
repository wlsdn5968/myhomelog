/**
 * backend/test/chat-limiter-split.test.js
 *
 * Plan 133 — 무료 챗(/api/chat)을 유료 경로의 fail-closed 리미터에서 분리.
 *   [배경] 2026-10-14 Upstash 무료 한도(월 500,000 명령) 초과로 모든 Redis 명령이 실패했다.
 *   /api/chat 은 룰베이스(유료 AI 호출 0)인데 유료 /api/report·/api/clause 와 같은 chatLimiter
 *   (scope 'chat' = COST_SENSITIVE → fail-closed)를 써서 챗이 전원 503 이었다(운영 실측).
 *   1~3 은 이 저장소의 확립된 패턴대로 소스를 정적으로 검사하고, 4~5 는 실제 makeRateLimiter 를
 *   "모든 명령이 실패하는 Redis" 스텁으로 돌려 동작을 본다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('server.js — chatDataLimiter 정의가 1회이고 scope chatdata · failClosed 없음', () => {
  const start = SERVER_SRC.indexOf('const chatDataLimiter = makeRateLimiter({');
  assert.ok(start > 0, 'chatDataLimiter 정의를 찾지 못했다');
  assert.equal(SERVER_SRC.split('const chatDataLimiter = makeRateLimiter({').length - 1, 1, 'chatDataLimiter 정의는 정확히 1회');
  const end = SERVER_SRC.indexOf('});', start);
  const block = SERVER_SRC.slice(start, end);
  assert.match(block, /scope:\s*'chatdata'/, "scope 는 'chatdata' 여야 한다(COST_SENSITIVE 가 아닌 이름)");
  assert.ok(!/failClosed/.test(block), '무료 챗 리미터에 failClosed 가 있으면 Redis 장애 때 다시 전원 503 이 된다');
});

test('server.js — /api/chat 은 chatDataLimiter, 유료 /api/report·/api/clause 는 chatLimiter 그대로', () => {
  assert.equal((SERVER_SRC.match(/app\.use\('\/api\/chat',\s*optionalAuth,\s*chatDataLimiter,/g) || []).length, 1,
    "app.use('/api/chat', optionalAuth, chatDataLimiter, ...) 가 정확히 1회여야 한다");
  assert.equal((SERVER_SRC.match(/app\.use\('\/api\/chat',\s*optionalAuth,\s*chatLimiter,/g) || []).length, 0,
    '/api/chat 이 아직 유료용 chatLimiter(fail-closed)를 쓴다');
  assert.equal((SERVER_SRC.match(/app\.use\('\/api\/clause',\s*optionalAuth,\s*chatLimiter,/g) || []).length, 1,
    '/api/clause(유료 Anthropic)는 chatLimiter(fail-closed)를 유지해야 한다');
  assert.equal((SERVER_SRC.match(/app\.use\('\/api\/report',\s*optionalAuth,\s*chatLimiter,/g) || []).length, 1,
    '/api/report(유료 Anthropic)는 chatLimiter(fail-closed)를 유지해야 한다');
});

test("server.js — chatLimiter 정의는 그대로 scope 'chat'", () => {
  const start = SERVER_SRC.indexOf('const chatLimiter = makeRateLimiter({');
  assert.ok(start > 0, 'chatLimiter 정의를 찾지 못했다');
  const block = SERVER_SRC.slice(start, SERVER_SRC.indexOf('});', start));
  assert.match(block, /scope:\s*'chat'/, "유료 경로 리미터의 scope 'chat'(fail-closed 강제)이 바뀌었다");
});

// ── 동작: Redis 명령이 전부 실패할 때 ─────────────────────────────────────
function loadRateLimitWithFailingRedis() {
  const rlPath = require.resolve('../middleware/rateLimit');
  const redisPath = require.resolve('../redis');
  const saved = { rl: require.cache[rlPath], redis: require.cache[redisPath] };
  const fail = () => { throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500001'); };
  // 실제 @upstash/redis 클라이언트처럼: Ratelimit 생성자가 동기 메서드 addTelemetry 를 부르고(실패 시
  //   처리되지 않은 rejection 이 생기므로 no-op), limit() 은 evalsha(NOSCRIPT 면 eval)로 명령을 보낸다.
  const failingRedis = { addTelemetry() {}, evalsha: async () => fail(), eval: async () => fail() };
  delete require.cache[rlPath];
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { getRedis: () => failingRedis } };
  const mod = require('../middleware/rateLimit');
  const restore = () => {
    delete require.cache[rlPath];
    if (saved.rl) require.cache[rlPath] = saved.rl;
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
  };
  return { mod, restore };
}

function run(mw) {
  return new Promise((resolve) => {
    const req = { ip: '203.0.113.7', headers: {}, user: null, method: 'POST' };
    const res = {
      statusCode: 200, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ next: false, status: this.statusCode, body: b }); return this; },
    };
    mw(req, res, () => resolve({ next: true, status: res.statusCode }));
  });
}

test("Redis 전면 실패 — scope 'chatdata' 는 통과(fail-open)", async () => {
  const { mod, restore } = loadRateLimitWithFailingRedis();
  try {
    const mw = mod.makeRateLimiter({ limit: 20, windowSec: 60, scope: 'chatdata', keySuffix: ':chat', message: 'x' });
    const r = await run(mw);
    assert.equal(r.next, true, `무료 챗 리미터가 Redis 실패 때 요청을 막았다(status ${r.status})`);
  } finally { restore(); }
});

test("Redis 전면 실패 — scope 'chat'(유료 경로)은 503 ratelimit_unavailable(fail-closed 유지)", async () => {
  const { mod, restore } = loadRateLimitWithFailingRedis();
  try {
    const mw = mod.makeRateLimiter({ limit: 20, windowSec: 60, scope: 'chat', keySuffix: ':chat', message: 'x' });
    const r = await run(mw);
    assert.equal(r.next, false, '유료 경로 리미터가 Redis 실패 때 요청을 통과시켰다 — 비용 보호가 풀렸다');
    assert.equal(r.status, 503);
    assert.equal(r.body && r.body.code, 'ratelimit_unavailable');
  } finally { restore(); }
});
