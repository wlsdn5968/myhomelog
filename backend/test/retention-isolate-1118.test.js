/**
 * RETENTION-ISOLATE-1118 (plans/208) 회귀 고정.
 *
 * [배경] run() 의 첫 단계(runSoftDeleteExpiry)만 실패를 감싸지 않아, 계정 삭제 대상 조회가
 *   한 번 실패하면 run() 이 던져 같은 예약 작업의 뒤 단계가 그날 돌지 않았다.
 *   이제 실패는 요약의 error 에 'soft-delete: ...' 로 남고 뒤 단계는 계속 돈다.
 *
 * 실행: cd backend && node --test test/retention-isolate-1118.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/** 아무 메서드 사슬이나 받아 자기 자신을 돌려주고, await 되면 주어진 결과를 주는 가짜 */
function _chain(result) {
  const handler = {
    get(_t, prop) {
      if (prop === 'then') return (resolve) => resolve(result);
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy;
}

function _makeFakeAdmin() {
  return {
    from(table) {
      if (table === 'account_deletion_requests') {
        return _chain({ data: null, error: { message: 'boom-soft-delete' } });
      }
      return _chain({ data: [], count: 0, error: null });
    },
    rpc() { return _chain({ data: 0, count: 0, error: null }); },
  };
}

async function _runWithFakeDb(fn) {
  const clientPath = require.resolve('../db/client');
  const retentionPath = require.resolve('../jobs/retention');
  const saved = { client: require.cache[clientPath], retention: require.cache[retentionPath] };
  const real = require('../db/client');
  const stub = { ...real, requireSupabaseAdmin: () => _makeFakeAdmin() };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };
  try {
    delete require.cache[retentionPath];
    const retention = require('../jobs/retention');
    return await fn(retention);
  } finally {
    if (saved.client) require.cache[clientPath] = saved.client; else delete require.cache[clientPath];
    if (saved.retention) require.cache[retentionPath] = saved.retention; else delete require.cache[retentionPath];
  }
}

test('retention.run — 계정 삭제 대상 조회가 실패해도 던지지 않고 뒤 단계가 돌며 error 에 soft-delete 사유가 실린다', async () => {
  await _runWithFakeDb(async (retention) => {
    const summary = await retention.run();
    assert.equal(summary.softDelete.error, 'boom-soft-delete');
    assert.equal(summary.error, 'soft-delete: boom-soft-delete');
    assert.notEqual(summary.searchHistory, undefined, '뒤 단계(search_history)가 돌아야 한다');
    assert.notEqual(summary.chat, undefined, '뒤 단계(chat)가 돌아야 한다');
    assert.notEqual(summary.ingestRuns, undefined, '뒤 단계(ingestRuns)가 돌아야 한다');
    assert.notEqual(summary.attribution, undefined, '뒤 단계(attribution)가 돌아야 한다');
  });
});

test('retention.run — soft-delete 실패 사유가 cronStats._pick 결과의 error 로 남아 health 에 보인다', async () => {
  await _runWithFakeDb(async (retention) => {
    const summary = await retention.run();
    const picked = require('../services/cronStats')._pick(summary);
    assert.equal(picked.error, 'soft-delete: boom-soft-delete');
  });
});
