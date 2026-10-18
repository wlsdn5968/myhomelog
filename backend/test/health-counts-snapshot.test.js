/**
 * Plan 161 — health 의 무거운 건수 조회를 하루 1회 DB 스냅샷으로 읽는다.
 *
 * db/client·services/redisCache·services/snapshotStore 는 require.cache 스텁으로 끊어
 * 실제 Supabase·Redis 로 나가는 호출이 전혀 없다. healthCounts 모듈만 직접 require 한다.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_CLIENT_PATH = require.resolve('../db/client');
const REDIS_CACHE_PATH = require.resolve('../services/redisCache');
const SNAP_PATH = require.resolve('../services/snapshotStore');
const HC_PATH = require.resolve('../services/healthCounts');
const cache = require('../cache');

const state = { admin: null, fromCalls: 0, snaps: new Map(), puts: [], gets: [] };

/** 모든 체인 메서드를 받는 최소 admin 스텁. opts.failTable 이면 그 테이블 count 는 오류. */
function makeAdmin({ failTable = null, failFacilityIdx = -1 } = {}) {
  let facIdx = 0;
  return {
    from(table) {
      state.fromCalls += 1;
      const isFac = table === 'apt_master';
      const myIdx = isFac ? facIdx++ : -1;
      let isCount = false;
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (res, rej) => {
              let r;
              if (table === 'molit_ingest_runs') r = { data: { finished_at: '2026-10-18T17:30:00Z' }, error: null };
              else if (failTable === table) r = { count: null, error: { message: 'timeout' } };
              else if (isFac && myIdx === failFacilityIdx) r = { count: null, error: { message: 'timeout' } };
              else r = { count: 100, error: null };
              return Promise.resolve(r).then(res, rej);
            };
          }
          if (prop === 'maybeSingle') return () => Promise.resolve({ data: { finished_at: '2026-10-18T17:30:00Z' }, error: null });
          return (...a) => { if (prop === 'select' && a[1] && a[1].count) isCount = true; return chain; };
        },
      });
      return chain;
    },
  };
}

let hc;
before(() => {
  require.cache[DB_CLIENT_PATH] = {
    id: DB_CLIENT_PATH, filename: DB_CLIENT_PATH, loaded: true,
    exports: { getSupabaseAdmin: () => state.admin },
  };
  require.cache[REDIS_CACHE_PATH] = {
    id: REDIS_CACHE_PATH, filename: REDIS_CACHE_PATH, loaded: true,
    exports: { rget: async () => undefined, rset: async () => {} },
  };
  require.cache[SNAP_PATH] = {
    id: SNAP_PATH, filename: SNAP_PATH, loaded: true,
    exports: {
      getLastSnapshot: async (k) => { state.gets.push(k); return state.snaps.get(k) || null; },
      getSnapshot: async (k) => state.snaps.get(k) || null,
      putSnapshot: async (k, p) => { state.puts.push(k); state.snaps.set(k, { payload: p, computedAt: new Date().toISOString() }); return true; },
    },
  };
  delete require.cache[HC_PATH];
  hc = require('../services/healthCounts');
});

after(() => {
  delete require.cache[DB_CLIENT_PATH];
  delete require.cache[REDIS_CACHE_PATH];
  delete require.cache[SNAP_PATH];
  delete require.cache[HC_PATH];
});

beforeEach(() => {
  state.admin = makeAdmin();
  state.fromCalls = 0;
  state.snaps = new Map();
  state.puts = [];
  state.gets = [];
  cache.del('meta:dataCounts:v2');
  cache.del('meta:dataCounts:txHistCount:v1');
  cache.del('meta:facilityQuality');
});

test('(a) readDataCounts — 스냅샷이 있으면 DB 를 부르지 않고 그 값을 메모리에 둔다', async () => {
  const snap = { tx: 100, apt: 10, lastIngestedAt: '2026-10-18T17:30:00Z' };
  state.snaps.set(hc.SNAP_COUNTS, { payload: snap, computedAt: 'x' });
  const r = await hc.readDataCounts();
  assert.deepEqual(r, snap);
  assert.equal(state.fromCalls, 0);
  assert.deepEqual(cache.get('meta:dataCounts:v2'), snap);
});

test('(b) readDataCounts — 스냅샷이 없으면 기존 getDataCounts 경로(admin from 호출)', async () => {
  const r = await hc.readDataCounts();
  assert.ok(state.fromCalls > 0, 'admin.from() 이 호출돼야 한다');
  assert.ok(r && r.lastIngestedAt);
});

test('(c) getFacilityQuality — 7개 중 하나가 오류면 null 이고 캐시하지 않는다', async () => {
  state.admin = makeAdmin({ failFacilityIdx: 3 });
  const r = await hc.getFacilityQuality();
  assert.equal(r, null);
  assert.equal(cache.get('meta:facilityQuality'), undefined);
});

test('(d) refreshHealthSnapshots — 정상이면 두 키 각 1회 기록, tx 오류면 counts 키는 기록 안 함', async () => {
  const ok = await hc.refreshHealthSnapshots();
  assert.deepEqual(ok, { counts: true, facility: true });
  assert.equal(state.puts.filter(k => k === 'health:dataCounts:v1').length, 1);
  assert.equal(state.puts.filter(k => k === 'health:facilityQuality:v1').length, 1);

  state.puts = [];
  cache.del('meta:dataCounts:v2');
  cache.del('meta:facilityQuality');
  state.admin = makeAdmin({ failTable: 'molit_transactions' });
  const bad = await hc.refreshHealthSnapshots();
  assert.equal(bad.counts, false);
  assert.equal(state.puts.filter(k => k === 'health:dataCounts:v1').length, 0);
});

test('(e) 소스 고정 — health 핸들러는 스냅샷 읽기 함수를 쓰고 server.js 에 직접 계산 호출이 없다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(src, /await readDataCounts\(\)/);
  assert.match(src, /await readFacilityQuality\(\)/);
  assert.equal(/getFacilityQuality\(\)\.catch/.test(src), false);
});
