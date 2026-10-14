/**
 * backend/test/redis-command-budget.test.js — Plan 139
 * 요청 경로 Redis 명령 수 절감 계약: (a) health·cron 이 generalLimiter 앞 + health 메모리 제한,
 * (b) health 관측값 5분 캐시, (c) 챗 관측 expire 는 hincrby=1 일 때만.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const CRON_SRC = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');

test('(a) server.js — health·cron 마운트가 generalLimiter 마운트보다 앞서고 health 는 메모리 제한이다', () => {
  const iGeneral = SERVER_SRC.indexOf("app.use('/api/', generalLimiter);");
  const iHealth = SERVER_SRC.indexOf("app.use('/api/health', healthMemLimiter);");
  const iCron = SERVER_SRC.indexOf("app.use('/api/cron', require('./routes/cron'));");
  assert.ok(iGeneral > 0 && iHealth > 0 && iCron > 0, '마운트 줄을 찾지 못했다');
  assert.ok(iHealth < iGeneral, 'health 마운트가 generalLimiter 보다 앞이어야 한다');
  assert.ok(iCron < iGeneral, 'cron 마운트가 generalLimiter 보다 앞이어야 한다');
  const def = SERVER_SRC.slice(SERVER_SRC.indexOf('const healthMemLimiter = rateLimit('), iHealth);
  assert.ok(def.includes('const healthMemLimiter = rateLimit('), 'healthMemLimiter 는 express-rate-limit(메모리)이어야 한다');
  assert.ok(/limit:\s*60/.test(def) && /windowMs:\s*60\s*\*\s*1000/.test(def), '분당 60');
  assert.ok(!/makeRateLimiter|upstash/i.test(def), 'health 제한이 Redis 를 쓰면 안 된다');
  // cron 은 라우터 최상단 router.use(authorizeCron) 으로 보호돼야 제외가 안전하다
  const iAuth = CRON_SRC.indexOf('router.use(authorizeCron);');
  const iFirstRoute = CRON_SRC.search(/router\.(get|post|put|delete|all)\(/);
  assert.ok(iAuth > 0 && iAuth < iFirstRoute, 'authorizeCron 이 첫 라우트보다 앞에 전역 적용돼야 한다');
  assert.equal((SERVER_SRC.match(/app\.use\('\/api\/cron'/g) || []).length, 1, 'cron 마운트는 1회');
});

function makeRedis() {
  const calls = {};
  const bump = (n) => { calls[n] = (calls[n] || 0) + 1; };
  return {
    calls,
    async hgetall() { bump('hgetall'); return { greeting: '3' }; },
    async lrange() { bump('lrange'); return []; },
    async get() { bump('get'); return null; },
  };
}

test('(b) health 관측값 캐시 — 두 번째 호출은 getCronLatest·hgetall 0회, 5분 뒤 다시 조회', async () => {
  const { createHealthObserveCache } = require('../services/healthObserveCache');
  const redis = makeRedis();
  let cronCalls = 0, t = Date.UTC(2026, 9, 14, 12, 0, 0);
  const c = createHealthObserveCache({
    getRedis: () => redis,
    getCronLatest: async () => { cronCalls++; return { 'molit-ingest': { at: 'x' } }; },
    now: () => t,
  });
  await c.cronLatest(); const a = await c.intentCounters();
  assert.equal(cronCalls, 1); assert.equal(redis.calls.hgetall, 4);
  assert.deepEqual(a.chatIntents.today, { greeting: '3' });
  await c.cronLatest(); await c.intentCounters();
  assert.equal(cronCalls, 1, '두 번째 호출에서 getCronLatest 0회');
  assert.equal(redis.calls.hgetall, 4, '두 번째 호출에서 hgetall 0회');
  t += 5 * 60 * 1000 + 1;
  await c.cronLatest(); await c.intentCounters();
  assert.equal(cronCalls, 2); assert.equal(redis.calls.hgetall, 8);
  // 날짜가 바뀌면 TTL 안에서도 다시 읽는다
  t = Date.UTC(2026, 9, 15, 0, 0, 1);
  await c.intentCounters();
  assert.equal(redis.calls.hgetall, 12, '자정 넘어 어제 값을 오늘로 보이면 안 된다');
});

test('(b) 캐시 — Redis 실패는 null 로 흘리고 캐시하지 않는다', async () => {
  const { createHealthObserveCache } = require('../services/healthObserveCache');
  let fail = true, n = 0;
  const redis = { async hgetall() { n++; if (fail) throw new Error('quota'); return {}; } };
  const c = createHealthObserveCache({ getRedis: () => redis, getCronLatest: async () => { if (fail) throw new Error('x'); return { a: 1 }; } });
  assert.equal(await c.intentCounters(), null);
  assert.equal(await c.cronLatest(), null);
  fail = false;
  assert.ok(await c.intentCounters(), '복구 직후 바로 다시 시도');
  assert.deepEqual(await c.cronLatest(), { a: 1 });
});

test('(b) server.js — health 가 캐시 모듈을 쓰고 getUsage 는 그대로 요청마다 부른다', () => {
  assert.ok(SERVER_SRC.includes('_healthObs.cronLatest()') && SERVER_SRC.includes('_healthObs.intentCounters()'));
  assert.ok(!/r\.hgetall\(`chatint/.test(SERVER_SRC), 'health 핸들러에 직접 hgetall 이 남아 있다');
  assert.ok(SERVER_SRC.includes("getUsage(req, 'search')") && SERVER_SRC.includes("getUsage(req, 'chat')"));
});

async function runObserve(hincrbyResults) {
  const redisPath = require.resolve('../redis');
  const routerPath = require.resolve('../services/chatDataRouter');
  const saved = { redis: require.cache[redisPath], router: require.cache[routerPath] };
  const calls = { hincrby: 0, expire: 0, lpush: 0, ltrim: 0 };
  const stub = {
    async hincrby() { return hincrbyResults[calls.hincrby++]; },
    async expire() { calls.expire++; return 1; },
    async lpush() { calls.lpush++; return 1; },
    async ltrim() { calls.ltrim++; return 'OK'; },
  };
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { getRedis: () => stub } };
  delete require.cache[routerPath];
  try {
    const { route } = require('../services/chatDataRouter');
    for (let i = 0; i < hincrbyResults.length; i++) await route('안녕', {});
    return calls;
  } finally {
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
    if (saved.router) require.cache[routerPath] = saved.router; else delete require.cache[routerPath];
  }
}

test('(c) _observe — hincrby=1 일 때만 expire, 2 이상이면 expire 0', async () => {
  const first = await runObserve([1]);
  assert.equal(first.expire, 1);
  const later = await runObserve([2, 3, 57]);
  assert.equal(later.hincrby, 3); assert.equal(later.expire, 0);
});

test('(c) _observe — fallback 링버퍼 lpush/ltrim 은 hincrby 결과와 무관하게 유지', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  const i = src.indexOf('async function _observe');
  const body = src.slice(i, src.indexOf('async function route', i));
  assert.ok(/if \(intent === 'fallback'\) \{[\s\S]*lpush[\s\S]*ltrim/.test(body));
  assert.ok(!/if \(Number\(n\) === 1\) \{[\s\S]*lpush/.test(body), 'lpush 가 expire 조건 안에 들어가면 안 된다');
});
