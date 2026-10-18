/**
 * backend/test/aptlist-memo.test.js
 *
 * APTLIST-MEMO-2026-10-18: 운영 계측(collectDetail) — 추천 수집 구간의 임계 경로가 단지 목록 조회였다
 * (서울 aptListMs 1,752 > 구별 거래 최대 1,658 · 경기 2,365 > 2,255). apt_master 는 주 1회만 바뀌므로 지역 묶음별 1시간 메모.
 * 가짜 DB 클라이언트로 실제 함수를 돌려 DB 호출 횟수를 센다(recommend-memo.test.js 와 같은 방식).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeAdmin(resultFor) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const res = resultFor(table, calls.length);
      const chain = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') return (ok, ko) => Promise.resolve(res).then(ok, ko);
          return () => chain;
        },
      });
      return chain;
    },
  };
}

function withClient(admin) {
  const clientPath = require.resolve('../db/client');
  const savedClient = require.cache[clientPath];
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseAdmin: () => admin, getSupabasePublic: () => null, hasAdminEnv: () => !!admin } };
  const p = require.resolve('../services/aptFacilityService');
  delete require.cache[p];
  const mod = require('../services/aptFacilityService');
  return { mod, restore: () => { delete require.cache[p]; if (savedClient) require.cache[clientPath] = savedClient; else delete require.cache[clientPath]; } };
}

test('같은 지역 묶음은 두 번째부터 DB 를 부르지 않는다(순서 무관) · 다른 묶음은 부른다', async () => {
  const admin = fakeAdmin(() => ({ data: [{ kapt_code: 'A1', apt_name: '상계벽산', umd_nm: '상계동', kaptAddr: null, kaptUsedate: '19880101' }], error: null }));
  const { mod, restore } = withClient(admin);
  try {
    const o1 = await mod.getAptListByLawdFromDb(['11350', '11320']);
    assert.equal(o1.length, 1);
    assert.equal(o1[0].kaptCode, 'A1');
    const n1 = admin.calls.length;
    assert.ok(n1 >= 1);
    const o2 = await mod.getAptListByLawdFromDb(['11320', '11350']);
    assert.equal(o2, o1, '같은 목록 객체를 돌려준다');
    assert.equal(admin.calls.length, n1, '두 번째 호출에서 DB 를 다시 불렀다');
    await mod.getAptListByLawdFromDb(['11680']);
    assert.ok(admin.calls.length > n1, '다른 지역 묶음은 DB 를 불러야 한다');
  } finally { restore(); }
});

test('빈 결과(오류 포함)는 메모하지 않는다', async () => {
  const admin = fakeAdmin(() => ({ data: null, error: { message: 'boom' } }));
  const { mod, restore } = withClient(admin);
  try {
    const o1 = await mod.getAptListByLawdFromDb(['11110']);
    assert.deepEqual(o1, []);
    const n1 = admin.calls.length;
    await mod.getAptListByLawdFromDb(['11110']);
    assert.ok(admin.calls.length > n1, '빈 결과를 메모했다');
  } finally { restore(); }
});
