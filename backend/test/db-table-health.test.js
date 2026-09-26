/**
 * Plan 111 2단계 — 테이블별 급증·autovacuum 정지 감시(get_table_health 배선).
 *
 * [배경] 전체 합계만 보는 용량 경보(checkDbCapacity, Plan 105)는 테이블 한 곳만 폭증하거나
 *   autovacuum 이 멈춰도 침묵한다 — apt_geocache 가 29일째 autovacuum 미실행(죽은 튜플 14%)
 *   이었는데 어떤 신호로도 안 보였다(plans/104 §8.4 실측). 리뷰어가 이미 프로덕션에 적용한
 *   RPC `get_table_health()`(컬럼: relname, total_mb, dead_pct, days_since_vacuum — 계획서의
 *   days_since_autovacuum 이 아니다)를 checkDbCapacity() 안에서 불러 두 조건(autovacuum 정지·
 *   직전 회차 대비 급증)을 본다. DDL 은 이 작업의 범위가 아니다(리뷰어 실측을 그대로 전제한다).
 *
 * [require.cache 스텁 방식] checkDbCapacity 는 module 최상단에서 `const Sentry =
 *   require('@sentry/node')` 로 한 번 바인딩하지만, db/client·services/redisCache 는 함수
 *   본문 안에서 매 호출마다 require 한다 — 그래서 Sentry 스텁은 cron.js 를 **처음** require
 *   하기 전에 걸어야 하고(이 파일이 처음이라 안전하다 — node:test 는 파일마다 별도 프로세스),
 *   db/client·redisCache 스텁은 매 테스트 전 상태 객체(state)만 바꿔주면 된다
 *   (backend/test/data-counts-sync.test.js 의 state 패턴과 동일).
 *
 * [파일 분리 이유] backend/test/db-capacity-observability.test.js(Plan 111 1단계)·
 *   backend/test/retention-observability.test.js(Plan 110)는 건드리지 않는다 — 이 파일은
 *   2단계(테이블별 감시) 범위만 새로 고정한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_CLIENT_PATH = require.resolve('../db/client');
const REDIS_CACHE_PATH = require.resolve('../services/redisCache');
const SENTRY_PATH = require.resolve('@sentry/node');
const CRON_PATH = require.resolve('../routes/cron');

// 여러 test() 가 한 프로세스(이 파일)를 공유하므로, 매 테스트가 admin/redis 동작을 바꿔치기할
// 수 있도록 고정된 스텁 뒤에 가변 상태를 하나 둔다(data-counts-sync.test.js 와 같은 방식).
const state = {
  admin: null,
  rget: async () => undefined,
  rset: async () => {},
};
const sentryCalls = [];

/** checkDbCapacity 가 실제로 부르는 admin.rpc 체인만 구현한 최소 스텁. */
function _makeAdmin({ usedBytes = 100 * 1048576, tableRows = [], tableError = null, tableThrow = false } = {}) {
  return {
    rpc(name) {
      if (name === 'get_db_size_bytes') return Promise.resolve({ data: usedBytes, error: null });
      if (name === 'get_table_health') {
        if (tableThrow) return Promise.reject(new Error('rpc get_table_health 실패(테스트 주입)'));
        return Promise.resolve({ data: tableRows, error: tableError });
      }
      return Promise.resolve({ data: null, error: { message: `예상 밖 rpc: ${name}` } });
    },
  };
}

let cron;

before(() => {
  require.cache[DB_CLIENT_PATH] = {
    id: DB_CLIENT_PATH, filename: DB_CLIENT_PATH, loaded: true,
    // cron.js 가 require.cache 로 통째 로드하는 동안 jobs/molitIngest → services/transactionService
    // 등도 같은 db/client 를 module 최상단에서 require 한다 — hasAdminEnv() 등 모양을 온전히
    // 갖춰야 한다(data-counts-sync.test.js 의 스텁과 동일 형태).
    exports: {
      getSupabaseAdmin: () => state.admin,
      getSupabasePublic: () => null,
      getSupabaseReadonly: () => null,
      getUserScopedClient: () => null,
      requireSupabaseAdmin: () => { throw new Error('stub: 이 테스트는 requireSupabaseAdmin 을 쓰지 않는다'); },
      hasAdminEnv: () => true,
      _pickReadonlyKey: () => null,
      schema: 'public',
    },
  };
  require.cache[REDIS_CACHE_PATH] = {
    id: REDIS_CACHE_PATH, filename: REDIS_CACHE_PATH, loaded: true,
    exports: { rget: (...a) => state.rget(...a), rset: (...a) => state.rset(...a) },
  };
  require.cache[SENTRY_PATH] = {
    id: SENTRY_PATH, filename: SENTRY_PATH, loaded: true,
    exports: {
      captureMessage: (msg, opts) => sentryCalls.push({ msg, opts }),
      captureException: () => {},
    },
  };
  delete require.cache[CRON_PATH]; // Sentry 스텁이 걸린 상태에서 cron.js 를 처음 로드해야 바인딩된다
  cron = require('../routes/cron');
  assert.equal(typeof cron._checkDbCapacity, 'function', 'cron.js 가 _checkDbCapacity 를 export 해야 한다(TEST-EXPORT-2026-09-26)');
});

after(() => {
  delete require.cache[DB_CLIENT_PATH];
  delete require.cache[REDIS_CACHE_PATH];
  delete require.cache[SENTRY_PATH];
  delete require.cache[CRON_PATH];
});

beforeEach(() => {
  state.admin = null;
  state.rget = async () => undefined;
  state.rset = async () => {};
  sentryCalls.length = 0;
});

test('① 두 RPC 모두 정상이고 임계 미만 — Sentry 0회, tableHealthWarns 0, usedMb 정상', async () => {
  const rsetCalls = [];
  state.rset = async (key, value, ttl) => { rsetCalls.push({ key, value, ttl }); };
  state.admin = _makeAdmin({
    usedBytes: 100 * 1048576, // 100MB / 500MB = 20% — 85% 경보 임계 밑
    tableRows: [
      { relname: 'molit_transactions', total_mb: 221.9, dead_pct: 0.00, days_since_vacuum: 0 },
      { relname: 'apt_master', total_mb: 28.1, dead_pct: 2.05, days_since_vacuum: 11 },
      { relname: 'building_register', total_mb: 6.0, dead_pct: 7.81, days_since_vacuum: 26 },
    ],
  });

  const out = await cron._checkDbCapacity();

  assert.equal(sentryCalls.length, 0, '임계 미만인데 Sentry 가 호출됐다');
  assert.equal(out.usedMb, 100, 'usedMb 계산이 정상이어야 한다');
  assert.equal(out.level, null, '20%는 85% 경보 임계 밑이라 level 이 없어야 한다');
  assert.equal(out.tableHealthWarns, 0, '임계 미만이면 tableHealthWarns 는 0 이어야 한다');
  assert.equal(rsetCalls.length, 1, '다음 회차 비교를 위해 이번 값을 1회 저장해야 한다');
  assert.equal(rsetCalls[0].ttl, 172800, 'prev 저장 TTL 은 48시간(172800초)이어야 한다');
  assert.deepEqual(
    rsetCalls[0].value.tables,
    { molit_transactions: 221.9, apt_master: 28.1, building_register: 6.0 },
    '저장하는 tables 맵은 relname → total_mb 여야 한다'
  );
});

test('② dead_pct 25·days_since_vacuum 30 인 테이블 1개 — Sentry 정확히 1회, extra.autovacuumStale 에 그 relname, tableHealthWarns 1', async () => {
  state.admin = _makeAdmin({
    usedBytes: 100 * 1048576,
    tableRows: [
      { relname: 'apt_geocache', total_mb: 10, dead_pct: 25, days_since_vacuum: 30 },
      { relname: 'apt_master', total_mb: 28.1, dead_pct: 2.05, days_since_vacuum: 11 }, // 임계 미만 — 섞여도 걸리면 안 된다
    ],
  });

  const out = await cron._checkDbCapacity();

  assert.equal(sentryCalls.length, 1, 'Sentry 는 정확히 1회 호출돼야 한다');
  const call = sentryCalls[0];
  assert.equal(call.msg, 'cron 감시: 특정 테이블 급증 또는 autovacuum 정지 — 용량 한도 전에 확인 필요');
  assert.equal(call.opts.level, 'warning');
  assert.equal(call.opts.tags.monitor, 'db-table-health');
  assert.equal(call.opts.tags.route, 'cron.retention');
  assert.deepEqual(
    call.opts.extra.autovacuumStale.map((t) => t.relname), ['apt_geocache'],
    'extra.autovacuumStale 에 걸린 테이블 relname 이 실려야 한다'
  );
  assert.equal(call.opts.extra.growth.length, 0, '급증 조건은 안 걸렸어야 한다');
  assert.equal(out.tableHealthWarns, 1, 'tableHealthWarns 는 1이어야 한다');
});

test('③ 직전 회차 대비 +20% 이상 증가 — growth 경보 1회·tableHealthWarns 1, prev 없으면(rget null) growth 경보 0회', async () => {
  state.admin = _makeAdmin({
    usedBytes: 100 * 1048576,
    tableRows: [{ relname: 'x', total_mb: 125, dead_pct: 0, days_since_vacuum: 0 }],
  });

  // prev 가 있고 +25% 증가(100 → 125) — 급증 경보가 나가야 한다.
  state.rget = async () => ({ tables: { x: 100 } });
  const grown = await cron._checkDbCapacity();
  assert.equal(sentryCalls.length, 1, '+25% 증가는 +20% 임계를 넘으므로 경보가 나가야 한다');
  assert.equal(sentryCalls[0].opts.extra.growth.length, 1);
  assert.equal(sentryCalls[0].opts.extra.growth[0].relname, 'x');
  assert.equal(sentryCalls[0].opts.extra.growth[0].growthPct, 25);
  assert.equal(grown.tableHealthWarns, 1);

  // prev 없음(rget 이 undefined 반환 — Redis 미설정과 동일) — 급증 비교 자체를 건너뛰어야 한다.
  sentryCalls.length = 0;
  state.rget = async () => undefined;
  const noPrev = await cron._checkDbCapacity();
  assert.equal(sentryCalls.length, 0, 'prev 가 없으면 급증 경보가 나가면 안 된다');
  assert.equal(noPrev.tableHealthWarns, 0);
});

test('④ get_table_health RPC 가 throw — 예외가 밖으로 안 나가고 usedMb 는 그대로, tableHealthWarns 0', async () => {
  state.admin = _makeAdmin({ usedBytes: 100 * 1048576, tableThrow: true });

  const out = await cron._checkDbCapacity();

  assert.ok(out, 'checkDbCapacity 가 null 을 반환하면 안 된다 — RPC 실패가 용량 본체 반환을 막아선 안 된다');
  assert.equal(out.usedMb, 100, 'RPC 실패와 무관하게 usedMb 는 정상 반환돼야 한다');
  assert.equal(out.tableHealthWarns, 0, 'RPC 실패 시 tableHealthWarns 는 0이어야 한다(지어낸 값이 아니어야 한다)');
  assert.equal(sentryCalls.length, 0, 'RPC 실패는 삼켜야 한다 — 오류 자체로 경보를 내면 안 된다');
});

test('⑤ 소스 정적 단언 — 임계 상수 3개가 각 1회, monitor 태그가 1회 등장한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cron.js'), 'utf8');

  const defCount = (re) => (src.match(re) || []).length;
  assert.equal(defCount(/TABLE_DEAD_PCT_WARN\s*=\s*20\b/g), 1, 'TABLE_DEAD_PCT_WARN 정의가 정확히 1회여야 한다(흩어지면 안 된다)');
  assert.equal(defCount(/TABLE_VACUUM_STALE_DAYS\s*=\s*14\b/g), 1, 'TABLE_VACUUM_STALE_DAYS 정의가 정확히 1회여야 한다');
  assert.equal(defCount(/TABLE_GROWTH_WARN_PCT\s*=\s*20\b/g), 1, 'TABLE_GROWTH_WARN_PCT 정의가 정확히 1회여야 한다');
  assert.equal(defCount(/monitor: 'db-table-health'/g), 1, "monitor: 'db-table-health' 태그가 정확히 1회여야 한다");
});
