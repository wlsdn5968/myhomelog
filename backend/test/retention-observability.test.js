/**
 * Plan 110 — molit_ingest_runs 정리가 90일간 조용히 전부 실패하던 문제의 회귀 고정.
 *
 * [배경] molit_ingest_runs_status_chk 가 'timeout' 을 금지하고 있었는데
 *   runIngestRunsRetention 의 1단계(고아 running → timeout UPDATE)는 그 값을 쓴다 →
 *   CHECK 위반으로 항상 throw. 기존 코드는 1단계·2단계(프루닝 RPC)를 하나의 try 로 묶어
 *   1단계가 throw 하면 2단계가 통째로 건너뛰어졌다. 게다가 실패 결과가 중첩 객체
 *   (summary.ingestRuns)에만 남아 cronStats._pick 이 최상위 키만 보는 탓에 health 에
 *   전혀 드러나지 않았다. DDL 은 리뷰어가 이미 프로덕션에 적용해 CHECK 은 'timeout' 을
 *   허용하지만, 두 단계를 독립시키고 실패를 health 로 노출하는 코드 수정은 별개로 필요하다.
 *
 * [파일 분리 이유] backend/test/ingest-runs-retention.test.js 는 RPC 성공 경로·에러 그대로
 *   전달을 고정한 기존 테스트라 건드리지 않는다(Plan 110 범위 밖). 이 파일은 "두 단계가
 *   서로 독립적으로 실패·기록되는지"와 "cronStats._pick 평탄화" 만 새로 고정한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runIngestRunsRetention } = require('../jobs/retention');
const { _pick } = require('../services/cronStats');

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

test('runIngestRunsRetention — 1단계(고아 running 정리)가 실패해도 2단계(프루닝 RPC)는 호출되고 okPruned 가 채워진다', async () => {
  const { admin, rpcCalls } = _makeFakeAdmin({
    rpcData: 5,
    staleError: { message: 'new row for relation "molit_ingest_runs" violates check constraint "molit_ingest_runs_status_chk"' },
  });
  const out = await runIngestRunsRetention(admin);

  assert.equal(rpcCalls.length, 1, '1단계가 던져도 프루닝 RPC 는 여전히 정확히 1회 호출돼야 한다');
  assert.equal(rpcCalls[0].name, 'prune_molit_ingest_runs');
  assert.equal(out.okPruned, 5, '2단계는 1단계 실패와 무관하게 정상 결과를 담아야 한다');
  assert.equal(out.staleRunningFixed, 0, '1단계 실패 시 staleRunningFixed 는 초기값 0 을 유지해야 한다');
  assert.match(out.error, /^staleRunning:/, '1단계 실패는 staleRunning: 접두사로 기록돼야 한다');
});

test('runIngestRunsRetention — 2단계(프루닝 RPC)가 실패해도 예외가 밖으로 나가지 않고 prune: 접두사로 기록된다', async () => {
  const { admin, rpcCalls } = _makeFakeAdmin({
    rpcError: { message: 'function prune_molit_ingest_runs does not exist' },
    staleCount: 3,
  });
  const out = await runIngestRunsRetention(admin); // 예외 없이 완료돼야 한다

  assert.equal(rpcCalls.length, 1, '프루닝 RPC 시도 자체는 있어야 한다');
  assert.equal(out.staleRunningFixed, 3, '2단계 실패와 무관하게 1단계 성공 결과는 유지돼야 한다');
  assert.equal(out.okPruned, 0, 'RPC 실패 시 okPruned 는 초기값 0 을 유지해야 한다(지어낸 값이 아니어야 한다)');
  assert.match(out.error, /^prune:/, '2단계 실패는 prune: 접두사로 기록돼야 한다');
});

test('cronStats._pick — ingestRuns 평탄화 키(okPruned·staleRunningFixed)를 통과시킨다(중첩만 있을 때는 통과되지 않는다)', () => {
  const flattened = _pick({
    durationMs: 1,
    ingestRuns: { okPruned: 7, staleRunningFixed: 2 },
    okPruned: 7,
    staleRunningFixed: 2,
  });
  assert.equal(flattened.okPruned, 7, '평탄화 키가 있으면 통과해야 한다');
  assert.equal(flattened.staleRunningFixed, 2, '평탄화 키가 있으면 통과해야 한다');

  // 회귀 고정: 중첩된 ingestRuns 객체 자체는 NUM 화이트리스트가 숫자만 받으므로 절대 통과되면 안 된다.
  assert.equal(flattened.ingestRuns, undefined, 'ingestRuns 중첩 객체 자체는 _pick 을 통과하지 않아야 한다');

  const nestedOnly = _pick({ durationMs: 1, ingestRuns: { okPruned: 7, staleRunningFixed: 2 } });
  assert.equal(nestedOnly.okPruned, undefined, '평탄화 키가 없으면(중첩만 있으면) okPruned 는 통과되지 않아야 한다 — 90일간 실제로 이 상태였다');
  assert.equal(nestedOnly.staleRunningFixed, undefined, '평탄화 키가 없으면(중첩만 있으면) staleRunningFixed 는 통과되지 않아야 한다');
});
