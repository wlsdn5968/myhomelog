/**
 * Plan 184 — 유입 기록 180일 정리가 daily_visit 행을 지우지 않는지 고정한다.
 * 화면의 "2026-10-20 이후 누적 방문" 은 daily_visit 행 전체 개수라, 지우면 숫자가 줄어든다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAttributionRetention } = require('../jobs/retention');

test('runAttributionRetention: 오래된 행만 지우되 daily_visit 은 제외한다', async () => {
  const calls = [];
  const chain = {
    delete(opts) { calls.push(['delete', opts]); return chain; },
    lt(col, val) { calls.push(['lt', col, typeof val]); return chain; },
    neq(col, val) { calls.push(['neq', col, val]); return chain; },
    then(resolve) { resolve({ count: 3, error: null }); },
  };
  const admin = { from(table) { calls.push(['from', table]); return chain; } };

  const out = await runAttributionRetention(admin);

  assert.deepEqual(calls[0], ['from', 'visit_attribution']);
  assert.ok(calls.some((c) => c[0] === 'lt' && c[1] === 'created_at'), 'created_at 기준 삭제 조건이 있어야 한다');
  assert.ok(calls.some((c) => c[0] === 'neq' && c[1] === 'event' && c[2] === 'daily_visit'), 'daily_visit 제외 조건이 있어야 한다');
  assert.equal(out.pruned, 3);
  assert.equal(out.error, null);
});
