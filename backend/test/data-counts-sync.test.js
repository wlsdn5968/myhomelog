/**
 * Plan 113 — health `dataSyncedAt`/`dataCounts.lastIngestedAt` 가 null 로 굳던 회귀의 고정.
 *
 * [배경] server.js `getDataCounts()` 의 3번째 조회(마지막 적재 시각)가
 *   `molit_transactions.select('ingested_at').order('ingested_at', desc).limit(1)` 였는데
 *   이 컬럼에 인덱스가 없어 476K 행 병렬 seq scan(웜 3,945ms 실측)이었다. authenticator 의
 *   statement_timeout 8s 에 콜드·동시부하로 걸리면 supabase-js 는 throw 없이 `{data:null}` 을
 *   주고, 그 null 이 6시간 메모리 캐시 + Redis(인스턴스 간 공유)에 그대로 굳어 랜딩·브리핑의
 *   "동기화" 표기가 조용히 사라졌다(2026-09-26 실사고). 고친 내용:
 *   ① 3번째 조회를 인덱스 있는 `molit_ingest_runs.finished_at`(status='ok')로 교체.
 *   ② null 결과는 60초만 메모리 캐시하고 Redis 에는 쓰지 않는다.
 *   ③ Redis 에서 읽은 값의 lastIngestedAt 이 null 이면 히트로 쓰지 않고 DB 를 재조회한다
 *      (오염 복구 — 이게 없으면 배포 후에도 이미 Redis 에 박힌 null 이 최대 6시간 더 나간다).
 *   DDL(ingested_at 인덱스 추가)은 하지 않는다 — 결정은 "무료 소스로 대체"로 끝났다.
 *
 * [왜 server.js 를 통째로 require 하는가] `getDataCounts` 는 server.js 안에 있고 이번 계획
 *   전까지 export 되지 않았다 — `module.exports._getDataCounts`(TEST-EXPORT-2026-09-26, Plan 113)
 *   를 새로 추가했다. server.js 는 require 시 `app.listen()` 을 호출하지만
 *   `process.env.VERCEL !== '1'` 일 때만이라 — 이 파일에서 require 전에 VERCEL='1' 을 세팅해
 *   피한다(server.js 자체의 기존 가드, 이 파일은 값만 설정한다). db/client·services/redisCache 는
 *   `require.cache` 스텁으로 끊어 실제 Supabase·Redis 로 나가는 호출이 전혀 없다
 *   (backend/test/unused-column-reclaim.test.js 의 `_withFakeAdminKakao` 와 같은 방식).
 *
 * [파일 분리 이유] 계획 범위가 `getDataCounts` 하나뿐이라 이웃 함수(getDbUsage 등)를 다루는
 *   기존 테스트는 건드리지 않는다. 이 파일은 이 함수 하나만 고정한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const CK = 'meta:dataCounts:v2'; // getDataCounts 내부 캐시 키 — server.js 와 동일 리터럴이어야 한다.
const DB_CLIENT_PATH = require.resolve('../db/client');
const REDIS_CACHE_PATH = require.resolve('../services/redisCache');
const SERVER_PATH = require.resolve('../server');

// 여러 test() 가 하나의 프로세스(이 파일)를 공유하므로, 매 테스트가 admin/redis 동작을
// 바꿔치기할 수 있도록 고정된 스텁 뒤에 가변 상태를 하나 둔다 — server.js 를 매번 다시
// require(30+ 모듈 그래프, 실측 ~1s)하지 않기 위함이다.
const state = {
  admin: null,
  rget: async () => undefined,
  rset: async () => {},
};

/** getDataCounts 가 실제로 부르는 체인만 구현한 최소 admin 스텁 — from() 호출 테이블과 체인을 기록한다. */
function _makeFakeAdmin({ txCount = 0, aptCount = 0, ingestResult = { data: null, error: null } } = {}) {
  const calls = [];
  function makeChain(table) {
    const ops = [];
    calls.push({ table, ops });
    const chain = {
      select(cols, opts) {
        ops.push({ select: cols, opts: opts || null });
        if (opts && opts.count) {
          const count = table === 'molit_transactions' ? txCount : aptCount;
          return Promise.resolve({ count, error: null });
        }
        return chain;
      },
      eq(col, val) { ops.push({ eq: [col, val] }); return chain; },
      order(col, o) { ops.push({ order: [col, o] }); return chain; },
      limit(n) { ops.push({ limit: n }); return chain; },
      maybeSingle() { ops.push({ maybeSingle: true }); return Promise.resolve(ingestResult); },
    };
    return chain;
  }
  return { admin: { from: (table) => makeChain(table) }, calls };
}

let savedVercelEnv;
let app;

before(() => {
  savedVercelEnv = process.env.VERCEL;
  process.env.VERCEL = '1'; // server.js 의 app.listen() 가드 회피(TEST-EXPORT-2026-09-26 주석 참고)

  require.cache[DB_CLIENT_PATH] = {
    id: DB_CLIENT_PATH, filename: DB_CLIENT_PATH, loaded: true,
    exports: {
      getSupabaseAdmin: () => state.admin,
      getSupabasePublic: () => null,
      getSupabaseReadonly: () => null,
      getUserScopedClient: () => null,
      requireSupabaseAdmin: () => { throw new Error('stub: getDataCounts 는 requireSupabaseAdmin 을 쓰지 않는다'); },
      hasAdminEnv: () => true,
      _pickReadonlyKey: () => null,
      schema: 'public',
    },
  };
  require.cache[REDIS_CACHE_PATH] = {
    id: REDIS_CACHE_PATH, filename: REDIS_CACHE_PATH, loaded: true,
    exports: {
      rget: (...a) => state.rget(...a),
      rset: (...a) => state.rset(...a),
    },
  };

  app = require(SERVER_PATH);
  assert.equal(typeof app._getDataCounts, 'function', 'server.js 가 _getDataCounts 를 export 해야 한다(TEST-EXPORT-2026-09-26)');
});

after(() => {
  delete require.cache[DB_CLIENT_PATH];
  delete require.cache[REDIS_CACHE_PATH];
  delete require.cache[SERVER_PATH];
  if (savedVercelEnv === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercelEnv;
});

beforeEach(() => {
  app.cache.del(CK); // 메모리 캐시 히트로 DB/Redis 호출이 가려지지 않도록 매 테스트 전 비운다.
  state.admin = null;
  state.rget = async () => undefined;
  state.rset = async () => {};
});

test('getDataCounts — 3번째 조회는 molit_ingest_runs 를 eq(status, ok) 로 부르고, molit_transactions 에는 order(ingested_at) 를 걸지 않는다', async () => {
  const { admin, calls } = _makeFakeAdmin({
    txCount: 5, aptCount: 7,
    ingestResult: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
  });
  state.admin = admin;

  await app._getDataCounts();

  assert.equal(calls.length, 3, 'from() 호출이 정확히 3회(tx count, apt count, 마지막 적재 시각)여야 한다');
  const [txCall, aptCall, ingestCall] = calls;
  assert.equal(txCall.table, 'molit_transactions');
  assert.equal(aptCall.table, 'apt_master');
  assert.equal(ingestCall.table, 'molit_ingest_runs', '3번째 조회는 molit_ingest_runs 테이블이어야 한다');
  assert.ok(
    ingestCall.ops.some((op) => op.eq && op.eq[0] === 'status' && op.eq[1] === 'ok'),
    "3번째 조회가 eq('status', 'ok') 를 걸어야 한다"
  );
  assert.ok(
    ingestCall.ops.some((op) => op.order && op.order[0] === 'finished_at'),
    "3번째 조회의 정렬 기준은 finished_at 이어야 한다(ingested_at 아님)"
  );
  for (const call of calls) {
    assert.ok(
      !call.ops.some((op) => op.order && op.order[0] === 'ingested_at'),
      `${call.table} 조회에 order('ingested_at'…) 가 남아 있으면 안 된다(인덱스 없는 옛 경로로 회귀)`
    );
  }
});

test('getDataCounts — 성공 시 lastIngestedAt 은 finished_at 값이고, 캐시 TTL 은 21600, Redis rset 이 1회 호출된다', async () => {
  const { admin } = _makeFakeAdmin({
    txCount: 476716, aptCount: 14661,
    ingestResult: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
  });
  state.admin = admin;
  let rsetCalls = 0;
  let rsetTtl = null;
  state.rset = async (key, value, ttl) => { rsetCalls++; rsetTtl = ttl; };

  const out = await app._getDataCounts();

  assert.deepEqual(out, { tx: 476716, apt: 14661, lastIngestedAt: '2026-09-25T17:45:12Z' });
  const ttlAt = app.cache.getTtl(CK);
  assert.ok(ttlAt, '캐시에 TTL 이 설정돼 있어야 한다');
  const remainingMs = ttlAt - Date.now();
  assert.ok(remainingMs > 21590 * 1000 && remainingMs <= 21600 * 1000 + 5000, `TTL 이 21600초 근처여야 한다 (실측 잔여 ${remainingMs}ms)`);
  assert.equal(rsetCalls, 1, '성공 시 Redis rset 이 정확히 1회 호출돼야 한다');
  assert.equal(rsetTtl, 21600, 'Redis rset 의 TTL 도 21600 이어야 한다');
});

test('getDataCounts — 3번째 조회가 {data:null,error} 를 돌려주면 lastIngestedAt 은 null 이되 캐시 TTL 은 60초 이하이고 Redis rset 은 호출되지 않는다', async () => {
  const { admin } = _makeFakeAdmin({
    txCount: 476716, aptCount: 14661,
    ingestResult: { data: null, error: { message: 'canceling statement due to statement timeout' } },
  });
  state.admin = admin;
  let rsetCalls = 0;
  state.rset = async () => { rsetCalls++; };

  const out = await app._getDataCounts();

  assert.equal(out.lastIngestedAt, null, '3번째 조회 실패 시 lastIngestedAt 은 null 이어야 한다');
  assert.equal(out.tx, 476716, 'tx 집계는 3번째 조회 실패와 무관하게 그대로 반환돼야 한다(범위 밖 — 바뀌면 안 된다)');
  assert.equal(out.apt, 14661, 'apt 집계도 그대로 반환돼야 한다(범위 밖 — 바뀌면 안 된다)');
  const ttlAt = app.cache.getTtl(CK);
  assert.ok(ttlAt, 'null 결과도 짧게나마 메모리 캐시에는 들어가야 한다(완전 무캐시면 매 요청 DB 재조회)');
  const remainingMs = ttlAt - Date.now();
  assert.ok(remainingMs > 0 && remainingMs <= 60 * 1000 + 2000, `null 결과의 캐시 TTL 은 60초 이하여야 한다 (실측 잔여 ${remainingMs}ms) — 6시간 굳힘 회귀 방지`);
  assert.equal(rsetCalls, 0, 'null 결과는 Redis 에 쓰면 안 된다(인스턴스 간 오염 전파 방지)');
});

test('getDataCounts — Redis 에서 읽은 값의 lastIngestedAt 이 null 이면(과거 오염) 히트로 쓰지 않고 DB 를 재조회한다', async () => {
  state.rget = async () => ({ tx: 1, apt: 1, lastIngestedAt: null }); // 과거 사고로 굳은 오염 캐시 재현
  const { admin, calls } = _makeFakeAdmin({
    txCount: 476716, aptCount: 14661,
    ingestResult: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
  });
  state.admin = admin;

  const out = await app._getDataCounts();

  assert.equal(calls.length, 3, 'Redis 히트를 미스로 취급하고 DB 3종 조회로 넘어가야 한다(오염 복구)');
  assert.deepEqual(
    out,
    { tx: 476716, apt: 14661, lastIngestedAt: '2026-09-25T17:45:12Z' },
    '오염된 Redis 값(tx:1, apt:1)이 아니라 새로 조회한 DB 값을 반환해야 한다'
  );
});
