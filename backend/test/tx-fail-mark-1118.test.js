'use strict';
// TX-FAIL-MARK-1118 (plans/204): 국토부 매매 조회의 실패를 "거래 0건"으로 기억하지 않는다.
// 가짜 dataGoKrClient 만 쓰고 외부 호출은 하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');

// 가짜 클라이언트를 끼워 넣고 서비스를 새로 읽어 콜백을 돌린 뒤 모두 원래대로 돌린다.
async function withStub(getImpl, fn) {
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const txPath = require.resolve('../services/transactionService');
  const saved = {
    dgk: require.cache[dgkPath], tx: require.cache[txPath],
    key: process.env.MOLIT_API_KEY, dbFirst: process.env.MOLIT_DB_FIRST,
  };
  const calls = { n: 0 };
  const dgkStub = {
    get: async (...a) => { calls.n++; return getImpl(...a); },
    _isBlockedPattern: () => false, _buildFullUrl: () => '', ALLOWED_HOSTS: new Set(),
  };
  process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key';
  process.env.MOLIT_DB_FIRST = 'false';
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: dgkStub };
  const cache = require('../cache');
  try {
    delete require.cache[txPath];
    const tx = require('../services/transactionService');
    await fn(tx, calls);
  } finally {
    for (const k of cache.keys()) if (k.startsWith('tx:99994:')) cache.del(k);
    if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
    if (saved.tx) require.cache[txPath] = saved.tx; else delete require.cache[txPath];
    if (saved.key === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = saved.key;
    if (saved.dbFirst === undefined) delete process.env.MOLIT_DB_FIRST; else process.env.MOLIT_DB_FIRST = saved.dbFirst;
  }
}

test('매매 조회 비정상 응답코드는 MOLIT_API_ERROR 로 거절된다', async () => {
  await withStub(
    async () => ({ status: 200, data: { response: { header: { resultCode: '22', resultMsg: '일 트래픽 제한 초과' }, body: {} } } }),
    async (tx) => {
      await assert.rejects(tx.getTransactions('99994', '202610'), (e) => e.code === 'MOLIT_API_ERROR');
    },
  );
});

test('매매 조회 실패 직후 5분 캐시 경로에서도 API 를 다시 부르지 않고 거절된다(빈 배열이 아님)', async () => {
  await withStub(
    async () => ({ status: 200, data: { response: { header: { resultCode: '22', resultMsg: '일 트래픽 제한 초과' }, body: {} } } }),
    async (tx, calls) => {
      await assert.rejects(tx.getTransactions('99994', '202610'), (e) => e.code === 'MOLIT_API_ERROR');
      const before = calls.n;
      await assert.rejects(tx.getTransactions('99994', '202610'), (e) => e.code === 'MOLIT_API_ERROR');
      assert.equal(calls.n, before, '캐시된 실패인데 외부 API 를 다시 불렀다');
    },
  );
});

test('매매 조회 응답이 문자열(JSON 아님)이면 거절된다', async () => {
  await withStub(
    async () => ({ status: 200, data: '<html>error</html>' }),
    async (tx) => {
      await assert.rejects(tx.getTransactions('99994', '202610'), (e) => e.code === 'MOLIT_API_ERROR');
    },
  );
});

test('매매 조회 정상 응답코드에 항목 0개면 [] 를 돌려주고 다시 불러도 [] 다', async () => {
  await withStub(
    async () => ({ status: 200, data: { response: { header: { resultCode: '000', resultMsg: 'OK' }, body: { totalCount: 0, items: '' } } } }),
    async (tx, calls) => {
      assert.deepEqual(await tx.getTransactions('99994', '202610'), []);
      const before = calls.n;
      assert.deepEqual(await tx.getTransactions('99994', '202610'), []);
      assert.equal(calls.n, before, '진짜 0건은 종전대로 기억해야 한다');
    },
  );
});
