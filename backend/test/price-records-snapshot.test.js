/**
 * backend/test/price-records-snapshot.test.js (Plan 142)
 *
 * Redis 공유 캐시가 죽어 있어도(rget 항상 null/throw) 신고가 기록이 DB 스냅샷(computed_snapshots)에서 읽혀
 * 콜드 인스턴스의 RPC 재계산(4~5초)이 일어나지 않는지 — 국가·지역 양쪽.
 */
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const H = 3600 * 1000;
const root = require.resolve('../services/priceRecordsService');
const store = require.resolve('../services/snapshotStore');
const redisPath = require.resolve('../services/redisCache');
const dbPath = require.resolve('../db/client');
const cachePath = require.resolve('../cache');

let rows, rpcCalls, upserts, rpcResult, redisMode;

function fakeAdmin() {
  return {
    rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return rpcResult(fn); },
    from: (table) => {
      assert.equal(table, 'computed_snapshots');
      return {
        select: () => ({ eq: (_c, key) => ({ maybeSingle: async () => ({ data: rows[key] || null, error: null }) }) }),
        upsert: async (row, opts) => { upserts.push({ row, opts }); rows[row.key] = { payload: row.payload, computed_at: row.computed_at }; return { error: null }; },
      };
    },
  };
}

function load() {
  for (const p of [root, store]) delete require.cache[p];
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: {
    rget: async () => { if (redisMode === 'throw') throw new Error('redis down'); return null; },
    rset: async () => { throw new Error('redis write failed'); },
  } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...require(dbPath), getSupabaseAdmin: () => fakeAdmin() } };
  const cache = require(cachePath);
  cache.flushAll && cache.flushAll();
  return require(root);
}

beforeEach(() => { rows = {}; rpcCalls = []; upserts = []; redisMode = 'null'; rpcResult = () => ({ data: null, error: { message: 'boom' } }); });

const natPayload = { latestDeal: '2026-10-13', sinceDate: '2025-05-01', windowDays: 7, minPrior: 3, comparedCount: 9, highCount: 1, lowCount: 0, high: [], low: [], computedAt: '2026-10-14T00:00:00.000Z' };
const regBlob = { windowDays: 30, minPrior: 3, latestDeal: '2026-10-13', sinceDate: '2025-05-01', regions: { '11680': { comparedCount: 5, highCount: 0, lowCount: 0, high: [], low: [] } } };

test('(a) Redis 비고 신선한 DB 스냅샷이 있으면 RPC 0회, 스냅샷 그대로 반환', async () => {
  rows['records:price:v2'] = { payload: natPayload, computed_at: new Date(Date.now() - 2 * H).toISOString() };
  const svc = load();
  assert.deepEqual(await svc.getPriceRecords(), natPayload);
  assert.equal(rpcCalls.length, 0);
  assert.deepEqual(await svc.getPriceRecords(), natPayload);   // 이후 메모리 캐시
  assert.equal(rpcCalls.length, 0);
});

test('(a) Redis 가 throw 해도 동일', async () => {
  redisMode = 'throw';
  rows['records:price:v2'] = { payload: natPayload, computed_at: new Date(Date.now() - H).toISOString() };
  const svc = load();
  assert.deepEqual(await svc.getPriceRecords(), natPayload);
  assert.equal(rpcCalls.length, 0);
});

test('(b) DB 스냅샷이 30시간 넘게 오래되면 RPC 호출 후 성공 결과를 upsert', async () => {
  rows['records:price:v2'] = { payload: natPayload, computed_at: new Date(Date.now() - 31 * H).toISOString() };
  rpcResult = () => ({ data: { latestDeal: '2026-10-14', sinceDate: '2025-05-01', windowDays: 7, minPrior: 3, comparedCount: 4, highCount: 0, lowCount: 0, high: [], low: [] }, error: null });
  const svc = load();
  const r = await svc.getPriceRecords();
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'get_price_records');
  assert.equal(r.latestDeal, '2026-10-14');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].row.key, 'records:price:v2');
  assert.deepEqual(upserts[0].opts, { onConflict: 'key' });
  assert.equal(upserts[0].row.payload.latestDeal, '2026-10-14');
  assert.ok(Date.now() - Date.parse(upserts[0].row.computed_at) < 5000);
});

test('(c) RPC 실패 + Redis LAST 없음 + DB 에 오래된 스냅샷 → stale:true 로 그것을 준다', async () => {
  rows['records:price:v2'] = { payload: natPayload, computed_at: new Date(Date.now() - 100 * H).toISOString() };
  const svc = load();
  const r = await svc.getPriceRecords();
  assert.equal(rpcCalls.length, 1);
  assert.equal(r.stale, true);
  assert.equal(r.latestDeal, natPayload.latestDeal);
  assert.equal(r.computedAt, natPayload.computedAt);
  assert.equal(upserts.length, 0);
});

test('(c) 스냅샷도 없으면 null (지어내지 않는다)', async () => {
  const svc = load();
  assert.equal(await svc.getPriceRecords(), null);
});

test('(d) 지역: 신선한 DB 스냅샷이면 RPC 0회, 블롭 그대로', async () => {
  rows['records:priceByRegion:v2'] = { payload: regBlob, computed_at: new Date(Date.now() - 5 * H).toISOString() };
  const svc = load();
  assert.deepEqual(await svc.getPriceRecordsByRegion(), regBlob);
  assert.equal(rpcCalls.length, 0);
});

test('(d) 지역: 30시간 넘게 오래되면 RPC 후 upsert', async () => {
  rows['records:priceByRegion:v2'] = { payload: { ...regBlob, latestDeal: 'old' }, computed_at: new Date(Date.now() - 40 * H).toISOString() };
  rpcResult = () => ({ data: regBlob, error: null });
  const svc = load();
  assert.deepEqual(await svc.getPriceRecordsByRegion(), regBlob);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'get_price_records_by_region');
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].row.payload, regBlob);
});

test('(d) 지역: RPC 실패 + 오래된 스냅샷 → stale:true + computedAt', async () => {
  const at = new Date(Date.now() - 90 * H).toISOString();
  rows['records:priceByRegion:v2'] = { payload: regBlob, computed_at: at };
  const svc = load();
  const r = await svc.getPriceRecordsByRegion();
  assert.equal(r.stale, true);
  assert.equal(r.computedAt, at);
  assert.deepEqual(r.regions, regBlob.regions);
});
