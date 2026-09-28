/**
 * backend/test/share-og-rate-limit.test.js
 *
 * Plan 122 — `/share`·`/api/og` 전용 레이트리밋.
 *   [배경] `/share` 는 `/api/` 밖이라 어떤 리미터도 거치지 않았고(무제한), `/api/og` 는
 *   PNG 렌더(CPU 비용)가 general(60/분)만 거쳐 서로 다른 aptSeq 를 돌면 엣지 캐시가
 *   소용없었다(IP 하나가 시간당 약 3,600장). 이 파일은 그 fix 의 계약을 고정한다.
 *   프로덕션 코드(server.js·rateLimit.js)는 이 파일에서 한 줄도 바꾸지 않는다 — 이 저장소의
 *   확립된 패턴대로 소스를 fs.readFileSync 로 읽어 정적으로 검사하고(1~4), 5번만 동작을 본다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const RATELIMIT_SRC = fs.readFileSync(path.join(__dirname, '../middleware/rateLimit.js'), 'utf8');



// ── §3-1 ──────────────────────────────────────────────────────────────────
test('server.js — /share 마운트가 shareLimiter 를 거친다(레거시 무제한 마운트는 없다)', () => {
  const mounted = SERVER_SRC.match(/app\.use\('\/share',\s*shareLimiter,\s*shareRouter\);/g) || [];
  assert.equal(mounted.length, 1, "app.use('/share', shareLimiter, shareRouter); 가 정확히 1회 있어야 한다");

  const legacy = SERVER_SRC.match(/app\.use\('\/share',\s*shareRouter\);/g) || [];
  assert.equal(legacy.length, 0, "리미터 없는 옛 마운트 app.use('/share', shareRouter); 가 남아 있다 — /share 가 다시 무제한이 된다");
});



// ── §3-2 ──────────────────────────────────────────────────────────────────
test('server.js — /api/og 마운트가 ogLimiter 를 거친다', () => {
  const mounted = SERVER_SRC.match(/app\.use\('\/api\/og',\s*ogLimiter,\s*require\('\.\/routes\/ogImage'\)\);/g) || [];
  assert.equal(mounted.length, 1, "app.use('/api/og', ogLimiter, require('./routes/ogImage')); 가 정확히 1회 있어야 한다");
});



// ── §3-3 ──────────────────────────────────────────────────────────────────
test('server.js — shareLimiter·ogLimiter 정의가 각 1회이고 failClosed 를 쓰지 않는다', () => {
  const start = SERVER_SRC.indexOf('const shareLimiter = makeRateLimiter(');
  assert.ok(start > 0, 'shareLimiter 정의를 찾지 못했다 — 테스트를 갱신할 것');

  // 정의부 뒤의 경계 — dataLimiter 정의 바로 뒤에 shareLimiter/ogLimiter 를 두고
  // 그 다음에 generalLimiter 마운트가 오는 구조(계획 122 §2)를 그대로 경계로 쓴다.
  const end = SERVER_SRC.indexOf("app.use('/api/', generalLimiter);", start);
  assert.ok(end > start, 'shareLimiter/ogLimiter 정의부 뒤의 generalLimiter 마운트를 찾지 못했다 — 테스트를 갱신할 것');
  const block = SERVER_SRC.slice(start, end);
  assert.ok(block.includes('const ogLimiter = makeRateLimiter('), 'ogLimiter 정의가 shareLimiter 와 같은 블록에 없다');

  const shareScope = block.match(/scope:\s*'share'/g) || [];
  assert.equal(shareScope.length, 1, "scope: 'share' 정의가 정확히 1회여야 한다");

  const ogScope = block.match(/scope:\s*'og'/g) || [];
  assert.equal(ogScope.length, 1, "scope: 'og' 정의가 정확히 1회여야 한다");

  assert.ok(!/failClosed/.test(block),
    'shareLimiter/ogLimiter 정의에 failClosed 가 있으면 안 된다 — 유료 AI 경로가 아니므로 fail-open 을 유지해야 한다');
});



// ── §3-4 ──────────────────────────────────────────────────────────────────
test('rateLimit.js — COST_SENSITIVE_SCOPES 에 share·og 가 없다(fail-open 의도 고정)', () => {
  const m = RATELIMIT_SRC.match(/const COST_SENSITIVE_SCOPES = new Set\(\[([^\]]*)\]\);/);
  assert.ok(m, 'COST_SENSITIVE_SCOPES 정의를 찾지 못했다 — 테스트를 갱신할 것');
  const members = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  // 회귀 기준선 — 이 계획은 rateLimit.js 를 바꾸지 않는다. 기존 3개가 그대로 있어야
  // 아래 부재 단언이 "애초에 아무것도 못 찾아서 통과"하는 위양성이 아님을 보장한다.
  for (const known of ['chat', 'report', 'clause']) {
    assert.ok(members.includes(known), `COST_SENSITIVE_SCOPES 에서 기존 scope '${known}' 이 사라졌다 — rateLimit.js 는 변경 범위 밖이다`);
  }
  assert.ok(!members.includes('share'), "COST_SENSITIVE_SCOPES 에 'share' 가 들어가면 안 된다 — /share 는 유료 AI 경로가 아니라 fail-open 이어야 한다");
  assert.ok(!members.includes('og'), "COST_SENSITIVE_SCOPES 에 'og' 가 들어가면 안 된다 — /api/og 는 유료 AI 경로가 아니라 fail-open 이어야 한다");
});



// ── §3-5 ────────────────────────────────────────────────────────────────────
// Redis 미설정(in-memory) 경로에서 makeRateLimiter 가 실제로 한도를 넘기면 429 를 주는지.
//
//   [왜 require.cache 스텁인가] 이 저장소의 확립된 패턴(backend/testSupport/_helpers.js 의
//   _withBillingStub·cron-observability.test.js 의 redis 스텁 등) — 의존 모듈의 require.cache
//   항목을 고정 exports 로 갈아치운 뒤, 그 모듈을 구조분해로 가져다 쓰는 상위 모듈의 캐시를
//   지워 재로드시켜야 스텁이 반영된다. 프로덕션 코드(redis.js·rateLimit.js)는 바꾸지 않는다.
//   ../redis 를 스텁하는 이유: 이 worktree 에는 UPSTASH_REDIS_REST_URL/TOKEN 이 없어
//   getRedis() 가 이미 null 을 돌려주지만(네트워크 미설정), 로컬 .env 유무에 기대지 않고
//   in-memory 경로를 강제해 이 테스트가 어떤 환경에서도 네트워크를 타지 않게 한다.
//
//   [express-rate-limit 8.7.0 in-memory 경로가 req/res 에서 실제로 쓰는 것 — 추측이 아니라
//   backend/node_modules/express-rate-limit/dist/index.cjs 실측]
//     - keyGenerator 는 rateLimit.js 가 넘기는 커스텀 함수라 기본 keyGenerator(req.ip 검증·
//       trust proxy 검증 등)는 아예 실행되지 않는다 — 실행되는 건 getRateLimitIdentity(req) 뿐이고,
//       이건 req.user?.id 없으면 req.ip(또는 'unknown')만 읽는다.
//     - config.store(MemoryStore).increment(key) 는 req/res 를 전혀 보지 않는다.
//     - standardHeaders:true(draft-6) 이므로 매 요청마다 res.setHeader(...) 를 4회 호출한다.
//     - skipFailedRequests/skipSuccessfulRequests 를 안 쓰므로(rateLimit.js 가 안 넘김)
//       res.once('finish'|'close'|'error') 는 전혀 호출되지 않는다.
//     - 한도 초과 시 기본 handler 가 res.status(429) 뒤 res.send(message) 를 호출한다
//       (message 가 함수가 아니므로 그 사이의 await 분기는 실행되지 않는다 — 동기 완료).
//   따라서 가짜 res 는 setHeader/status/send 와 headersSent(false)/writableEnded(false) 만
//   있으면 되고, 가짜 req 는 ip 만 있으면 된다(user 는 없음 = 비로그인 취급, 정상 경로).
test('rateLimit.js — Redis 미설정(in-memory)에서 makeRateLimiter 가 한도 초과 시 429 를 반환한다', async () => {
  const redisPath = require.resolve('../redis');
  const rateLimitPath = require.resolve('../middleware/rateLimit');
  const saved = { redis: require.cache[redisPath], rl: require.cache[rateLimitPath] };

  require.cache[redisPath] = {
    id: redisPath, filename: redisPath, loaded: true,
    exports: { getRedis: () => null }, // Upstash 미설정 상태를 강제 — 실네트워크 호출 없음
  };
  delete require.cache[rateLimitPath]; // getRedis 구조분해가 위 스텁을 보도록 재로드 강제

  try {
    const { makeRateLimiter } = require('../middleware/rateLimit');
    const limiter = makeRateLimiter({ limit: 2, windowSec: 60, scope: 'og' });

    const SAME_IP = '203.0.113.5';
    const mkReq = () => ({ ip: SAME_IP }); // user 없음 → getRateLimitIdentity 가 IP 로 식별
    const mkRes = () => ({
      statusCode: 200, headersSent: false, writableEnded: false, body: undefined,
      setHeader() {}, // RateLimit-* 헤더 값 자체는 이 테스트의 관심사가 아니다
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; return this; },
    });

    for (let n = 1; n <= 2; n++) {
      let nextCalled = false;
      const res = mkRes();
      await limiter(mkReq(), res, () => { nextCalled = true; });
      assert.ok(nextCalled, `${n}번째 요청(한도 2 이내)이 next() 로 통과하지 못했다`);
      assert.equal(res.statusCode, 200, `${n}번째 요청이 429 를 받았다 — 한도 이내인데 차단됐다`);
    }

    const res3 = mkRes();
    let thirdNextCalled = false;
    await limiter(mkReq(), res3, () => { thirdNextCalled = true; });
    assert.equal(res3.statusCode, 429, '한도(2)를 넘긴 3번째 같은 IP 요청이 429 가 아니다');
    assert.equal(thirdNextCalled, false, '한도 초과 요청이 next() 로 새어나갔다');
  } finally {
    if (saved.redis) require.cache[redisPath] = saved.redis; else delete require.cache[redisPath];
    if (saved.rl) require.cache[rateLimitPath] = saved.rl; else delete require.cache[rateLimitPath];
  }
});
