/**
 * backend/test/cron-runs-db-fallback.test.js (Plan 162)
 * cron 실행 기록이 Redis 와 DB 스냅샷 양쪽에 남고, 읽을 때 합쳐지는지 고정한다. 실제 Redis/Supabase 에는 닿지 않는다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const redisPath = path.join(__dirname, '../redis.js');
const snapPath = path.join(__dirname, '../services/snapshotStore.js');
const cronPath = path.join(__dirname, '../services/cronStats.js');

function load({ redis, snapshot }) {
  const saved = [redisPath, snapPath, cronPath].map((p) => [p, require.cache[p]]);
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { getRedis: () => redis } };
  require.cache[snapPath] = { id: snapPath, filename: snapPath, loaded: true, exports: snapshot };
  delete require.cache[cronPath];
  const mod = require(cronPath);
  return { mod, restore() { for (const [p, c] of saved) { if (c) require.cache[p] = c; else delete require.cache[p]; } } };
}

function snapStub(initial) {
  const puts = [];
  return {
    puts,
    getLastSnapshot: async () => (initial == null ? null : { payload: initial, computedAt: new Date().toISOString() }),
    putSnapshot: async (key, payload) => { puts.push({ key, payload }); },
  };
}

test('(a) Redis 가 없어도 DB 스냅샷(cronstat:db:v1)에 기록된다', async () => {
  const snapshot = snapStub(null);
  const { mod, restore } = load({ redis: null, snapshot });
  try {
    await mod.recordCronRun('retention', { ok: true });
    assert.equal(snapshot.puts.length, 1);
    assert.equal(snapshot.puts[0].key, 'cronstat:db:v1');
    assert.equal(snapshot.puts[0].payload.retention[0].name, 'retention');
  } finally { restore(); }
});

test('(b) Redis set 이 throw 해도 DB 저장은 된다', async () => {
  const snapshot = snapStub(null);
  const redis = { get: async () => null, set: async () => { throw new Error('limit exceeded'); } };
  const { mod, restore } = load({ redis, snapshot });
  try {
    await mod.recordCronRun('retention', { ok: true });
    assert.equal(snapshot.puts.length, 1);
    assert.equal(snapshot.puts[0].payload.retention[0].name, 'retention');
  } finally { restore(); }
});

test('(c) getCronRuns — Redis 의 옛 기록보다 DB 의 최신 기록이 이긴다', async () => {
  const snapshot = snapStub({ retention: [{ name: 'retention', at: '2026-10-18T18:00:00Z' }] });
  const redis = { get: async () => ({ retention: [{ name: 'retention', at: '2026-10-05T18:00:00Z' }] }) };
  const { mod, restore } = load({ redis, snapshot });
  try {
    const runs = await mod.getCronRuns();
    assert.equal(runs.retention[0].at, '2026-10-18T18:00:00Z');
    assert.equal(runs.retention.length, 2);
    const latest = await mod.getCronLatest();
    assert.equal(latest.retention.at, '2026-10-18T18:00:00Z');
  } finally { restore(); }
});

test('(d) 둘 다 비면 getCronRuns·getCronLatest 는 null', async () => {
  const { mod, restore } = load({ redis: { get: async () => null }, snapshot: snapStub(null) });
  try {
    assert.equal(await mod.getCronRuns(), null);
    assert.equal(await mod.getCronLatest(), null);
  } finally { restore(); }
});

test('(e) 같은 at 이 양쪽에 있으면 한 번만 나온다', async () => {
  const e = { name: 'retention', at: '2026-10-18T18:00:00Z' };
  const { mod, restore } = load({ redis: { get: async () => ({ retention: [e] }) }, snapshot: snapStub({ retention: [e] }) });
  try {
    const runs = await mod.getCronRuns();
    assert.equal(runs.retention.length, 1);
  } finally { restore(); }
});
