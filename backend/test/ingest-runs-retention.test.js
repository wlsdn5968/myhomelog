/**
 * RETAIN-LATEST-OK-2026-09-20 (Plan 106) — molit_ingest_runs 의 ok 로그 파기 규칙 전환.
 *
 * [배경] 기존엔 status='ok' AND started_at < now()-90d 를 PostgREST 필터로 직접 지웠다.
 *   그런데 (지역,월)의 ok 기록이 하나도 안 남으면 getTransactionsFromDb(services/transactionService.js)
 *   가 "이 달은 적재된 적 없다"로 오판해 MOLIT API 로 직접 나간다(2026-09-20 실측 40지역×3개월이
 *   이미 이 상태). 그래서 (지역,월)별 최신 ok 1건 영구 보존 + 나머지 14일 규칙을 DB 함수
 *   prune_molit_ingest_runs(SECURITY DEFINER)로 옮기고, runIngestRunsRetention 은 그 RPC 를
 *   호출하기만 한다 — 불변식(최신 ok 보존)은 DB 함수 쪽 책임이라 여기서는 "정확한 이름·인자로
 *   호출되는지, 반환값이 okPruned 에 담기는지, 실패해도 예외가 새지 않는지"만 고정한다.
 *
 * [파일 분리 이유] 기존 테스트 파일은 병렬 작업 중이라 건드리지 않는다 — runIngestRunsRetention 은
 *   admin 을 인자로 직접 받아 exported 되어 있어(module.exports), popular-snapshot-shortfall.test.js
 *   처럼 require.cache 를 건드릴 필요 없이 스텁 admin 객체만으로 충분하다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runIngestRunsRetention } = require('../jobs/retention');

/** runIngestRunsRetention 이 실제로 부르는 체인만 구현한 최소 스텁. */
function _makeFakeAdmin({ rpcData, rpcError, staleCount = 0, staleError = null } = {}) {
  const rpcCalls = [];
  const admin = {
    from(table) {
      assert.equal(table, 'molit_ingest_runs', `예상 밖 테이블 조회: ${table}`);
      return {
        update() {
          return {
            eq() {
              return {
                lt() {
                  return Promise.resolve({ count: staleCount, error: staleError });
                },
              };
            },
          };
        },
      };
    },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: rpcData, error: rpcError || null });
    },
  };
  return { admin, rpcCalls };
}

test('runIngestRunsRetention — prune_molit_ingest_runs 를 p_keep_days:14 로 정확히 1회 호출하고 반환값을 okPruned 에 담는다', async () => {
  const { admin, rpcCalls } = _makeFakeAdmin({ rpcData: 36274 });
  const out = await runIngestRunsRetention(admin);

  assert.equal(rpcCalls.length, 1, 'prune_molit_ingest_runs RPC 가 정확히 1회 호출돼야 한다');
  assert.equal(rpcCalls[0].name, 'prune_molit_ingest_runs');
  assert.deepEqual(rpcCalls[0].args, { p_keep_days: 14 }, '기본 보관일 14 로 호출돼야 한다(90 → 14 전환, Plan 106)');
  assert.equal(out.okPruned, 36274, 'RPC 반환값(삭제 행수)이 okPruned 에 그대로 담겨야 한다');
  assert.equal(out.error, null);
});

test('runIngestRunsRetention — RPC 가 오류를 돌려주면 out.error 에 메시지가 남고 예외가 밖으로 나가지 않는다', async () => {
  const { admin } = _makeFakeAdmin({ rpcError: { message: 'function prune_molit_ingest_runs does not exist' } });
  const out = await runIngestRunsRetention(admin); // 예외 없이 완료돼야 한다(다른 retention 작업에 영향 없음)

  assert.equal(out.error, 'prune: function prune_molit_ingest_runs does not exist', 'Plan 110: 두 단계가 독립이라 어느 쪽이 실패했는지 접두사로 구분한다');
  assert.equal(out.okPruned, 0, 'RPC 실패 시 okPruned 는 초기값 0 을 유지해야 한다(지어낸 값이 아니어야 한다)');
});

test('runIngestRunsRetention — RPC 호출 자체가 reject 해도(네트워크 예외) 같은 규약을 따른다', async () => {
  const { admin } = _makeFakeAdmin({});
  admin.rpc = () => Promise.reject(new Error('fetch failed'));
  const out = await runIngestRunsRetention(admin);

  assert.equal(out.error, 'prune: fetch failed', 'Plan 110: 두 단계가 독립이라 어느 쪽이 실패했는지 접두사로 구분한다');
  assert.equal(out.okPruned, 0);
});
