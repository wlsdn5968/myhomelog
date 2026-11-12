/**
 * COLD-RETRY-2026-11-13: 보고서 후보 첫 페이지가 statement timeout(57014)이면 한 번 다시 묻는다.
 *   운영 실측(2026-11-13 00:11 KST): 서울 전체 첫 페이지가 차가운 상태에서 8초를 넘어 500, 다시 누르니 성공.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeAdmin(plan) {
  const calls = [];
  const admin = {
    from(table) {
      const st = { table, ops: [] };
      const b = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            const r = plan(st, calls.length);
            calls.push(st);
            return (res, rej) => Promise.resolve(r).then(res, rej);
          }
          return (...a) => { st.ops.push([prop, a]); return b; };
        },
      });
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { admin, calls };
}

test('후보 첫 페이지가 57014 이면 한 번만 다시 묻고, 두 번째 성공 결과로 이어 간다', async () => {
  const { fetchCandidateApts } = require('../routes/report');
  let molitFirstPageCalls = 0;
  const row = { apt_name: '테스트아파트', sigungu: '강남구', umd_nm: '대치동', lawd_cd: '11680', build_year: 2005,
    exclu_use_ar: 84.9, deal_amount: 50000, deal_date: '2026-10-01', apt_seq: '11680-1', jibun: '1' };
  const { admin } = fakeAdmin((st) => {
    if (st.table === 'molit_transactions' && st.ops.some(([op, a]) => op === 'range' && a[0] === 0)) {
      molitFirstPageCalls++;
      if (molitFirstPageCalls === 1) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      return { data: [row], error: null };
    }
    return { data: [], error: null };
  });
  let out; let err = null;
  try {
    out = await fetchCandidateApts(admin, { region: '서울', maxBudget: 6, myCash: 4, houseStatus: '무주택', pyeongMin: 23, pyeongMax: 33 }, 7);
  } catch (e) { err = e; }
  assert.equal(molitFirstPageCalls, 2, '첫 페이지를 정확히 두 번(원래 + 재시도) 물어야 한다');
  assert.ok(!err || !/statement timeout/.test(String(err && err.message)), `재시도 뒤에도 시간 초과로 실패: ${err && err.message}`);
  if (out) assert.ok(Array.isArray(out) || typeof out === 'object');
});

test('57014 가 아닌 오류는 재시도하지 않고 그대로 던진다', async () => {
  const { fetchCandidateApts } = require('../routes/report');
  let n = 0;
  const { admin } = fakeAdmin((st) => {
    if (st.table === 'molit_transactions' && st.ops.some(([op, a]) => op === 'range' && a[0] === 0)) {
      n++;
      return { data: null, error: { code: '42501', message: 'permission denied' } };
    }
    return { data: [], error: null };
  });
  await assert.rejects(() => fetchCandidateApts(admin, { region: '서울', maxBudget: 6, myCash: 4, houseStatus: '무주택' }, 7), (e) => e && e.code === '42501');
  assert.equal(n, 1);
});
