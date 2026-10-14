/**
 * backend/test/br-candidates-retry.test.js
 *
 * Plan 134 — 건축물대장 백필의 후보 조회 오류 분류.
 *   [배경] get_br_backfill_candidates 가 06:15Z 회차마다 8초 statement timeout(57014)으로 취소됐는데
 *   (postgres 로그 2026-10-04~14), 잡은 **모든** RPC 오류를 "함수 미생성(게이트)" 으로 보고 gated:true 로
 *   조용히 넘겼다 — 수집이 매일 0건인데 health 에는 '미생성' 으로만 보였다.
 *   규칙: 함수 미존재(PGRST202 · 42883)만 게이트, 그 밖의 오류는 1회 재시도 뒤 ok:false + error.
 *   외부 의존(DB 클라이언트·건축물대장 API)은 require.cache 스텁으로 끊는다(facility.test.js 와 같은 방식).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const jobPath = require.resolve('../jobs/buildingRegisterBackfill');
const clientPath = require.resolve('../db/client');
const brSvcPath = require.resolve('../services/buildingRegisterService');

async function runWith(rpcResults) {
  const saved = { job: require.cache[jobPath], client: require.cache[clientPath], br: require.cache[brSvcPath] };
  const rpcCalls = [];
  const apiCalls = [];
  const queue = rpcResults.slice();
  const admin = {
    // 되쓰기·밀도 단계는 from() 을 쓴다 — 여기서 던지면 잡이 각자 try 로 삼키고 후보 조회로 넘어간다.
    from() { throw new Error('test: no table access'); },
    rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return queue.length ? queue.shift() : { data: [], error: null }; },
  };
  const stub = (q, exp) => { require.cache[q] = { id: q, filename: q, loaded: true, exports: exp }; };
  stub(clientPath, { getSupabaseAdmin: () => admin });
  stub(brSvcPath, {
    getBuildingTitle: async () => { apiCalls.push('title'); return null; },
    fetchRecapOnly: async () => { apiCalls.push('recap'); return null; },
  });
  delete require.cache[jobPath];
  try {
    const { run } = require(jobPath);
    const res = await run({ candidateRetryDelayMs: 0, densityCap: 0, densityBudgetMs: 1 });
    return { res, rpcCalls, apiCalls };
  } finally {
    delete require.cache[jobPath];
    if (saved.job) require.cache[jobPath] = saved.job;
    if (saved.client) require.cache[clientPath] = saved.client; else delete require.cache[clientPath];
    if (saved.br) require.cache[brSvcPath] = saved.br; else delete require.cache[brSvcPath];
  }
}

const TIMEOUT = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
const brRpc = (calls) => calls.filter((c) => c.fn === 'get_br_backfill_candidates');

test('함수 미존재(PGRST202) → 게이트(gated:true), 재시도 없음', async () => {
  const { res, rpcCalls } = await runWith([{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }]);
  assert.equal(res.gated, true);
  assert.equal(res.ok, true);
  assert.equal(brRpc(rpcCalls).length, 1, '함수가 없으면 재시도할 이유가 없다');
});

test('함수 미존재(42883) → 게이트(gated:true), 재시도 없음', async () => {
  const { res, rpcCalls } = await runWith([{ data: null, error: { code: '42883', message: 'function does not exist' } }]);
  assert.equal(res.gated, true);
  assert.equal(brRpc(rpcCalls).length, 1);
});

test('statement timeout 2회 → 게이트가 아니라 ok:false + error, 정확히 1회 재시도', async () => {
  const { res, rpcCalls, apiCalls } = await runWith([TIMEOUT, TIMEOUT]);
  assert.notEqual(res.gated, true, "시간 초과를 '함수 미생성' 으로 분류하면 수집 0 이 health 에서 안 보인다");
  assert.equal(res.ok, false);
  assert.match(String(res.error), /^get_br_backfill_candidates: canceling statement due to statement timeout/);
  assert.ok(String(res.error).length <= 120, 'error 는 120자 이하(cronStats 와 같은 제한)');
  assert.equal(brRpc(rpcCalls).length, 2, '첫 실패 뒤 정확히 1회 재시도');
  assert.deepEqual(apiCalls, [], '후보가 없으면 건축물대장 API 를 부르지 않는다');
});

test('statement timeout 뒤 재시도 성공(후보 0) → ok:true · 후보 없음', async () => {
  const { res, rpcCalls } = await runWith([TIMEOUT, { data: [], error: null }]);
  assert.equal(res.ok, true);
  assert.notEqual(res.gated, true);
  assert.equal(res.error, undefined);
  assert.equal(brRpc(rpcCalls).length, 2);
});

test('첫 호출 성공(후보 0) → 재시도 없음', async () => {
  const { res, rpcCalls } = await runWith([{ data: [], error: null }]);
  assert.equal(res.ok, true);
  assert.equal(brRpc(rpcCalls).length, 1);
});
