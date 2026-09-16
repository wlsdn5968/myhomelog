'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
function _withSnapshot(payload, fn) {
  const clientPath = require.resolve('../db/client');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], g: require.cache[geoPath], s: require.cache[svcPath] };
  const row = { payload, computed_at: new Date().toISOString() };
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }) };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { getSupabaseReadonly: () => client, getSupabaseAdmin: () => client } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: { resolveCoordBatch: async () => [] } };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require('../services/popularService'))).finally(() => {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  });
}
const mk = (n, i) => ({ aptName: n, sigungu: `시군구${i}`, umdNm: i === 10 ? '공항동' : `동${i}`, lawdCd: '11111', dealCount60d: 60 - i, recentDealDate: '2026-09-15', lat: 37.5, lng: 127.0 });

// SNAP-SLACK-2026-09-16 (Plan 097): 2026-09-15 18:56 실제 스냅샷 모양(12행 중 11번째가 "(50-5)") 재현.
test('readPopularSnapshot — 12행 스냅샷에서 이름 미등록 1행이 빠져 11행이어도 스냅샷을 쓴다(폴백으로 안 떨어진다)', async () => {
  const payload = Array.from({ length: 12 }, (_, i) => mk(i === 10 ? '(50-5)' : `단지${i}`, i));
  await _withSnapshot(payload, async ({ readPopularSnapshot }) => {
    const got = await readPopularSnapshot(12);
    assert.ok(Array.isArray(got), '11행 스냅샷이 null 이 되면 라이브 RPC→전국 표본 폴백으로 떨어진다(라이브 회귀 재현)');
    assert.equal(got.length, 11);
    assert.ok(!got.some(p => p.aptName === '(50-5)'));
    assert.ok(got.every(p => typeof p.displayName === 'string' && p.displayName));
    assert.equal(typeof got.computedAt, 'string');
  });
});
test('readPopularSnapshot — 이름 있는 행이 SNAPSHOT_MIN_ROWS(8) 미만이면 null (너무 빈 스냅샷은 안 쓴다)', async () => {
  const payload = Array.from({ length: 12 }, (_, i) => mk(i < 5 ? `단지${i}` : `(${100 + i}-1)`, i));
  await _withSnapshot(payload, async ({ readPopularSnapshot, SNAPSHOT_MIN_ROWS }) => {
    assert.equal(SNAPSHOT_MIN_ROWS, 8);
    assert.equal(await readPopularSnapshot(12), null);
  });
});
test('SNAPSHOT_SIZE — 저장 크기 18 (요구 12 + 여유 6)', () => {
  const { SNAPSHOT_SIZE } = require('../services/popularService');
  assert.equal(SNAPSHOT_SIZE, 18);
});
