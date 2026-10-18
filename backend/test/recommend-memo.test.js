/**
 * backend/test/recommend-memo.test.js
 *
 * 2026-10-18 운영 스테이지 타이밍(서울 전체 추천 12.1초: collect 5.2초 중 alias 1.7초 · facility 6.7초)의 두 병목:
 *   ALIAS-MEMO    별칭 맵을 지역 묶음별로 1시간 메모(오류로 빈 맵이면 메모하지 않음)
 *   BR-MISS-MEMO  건축물대장 "없음"을 1시간 기억(같은 단지 외부 호출 반복 방지), 찾으면 기억을 지운다
 * 가짜 DB 클라이언트로 실제 함수를 돌려 DB 호출 횟수를 센다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 어떤 체인을 불러도 마지막에 await 하면 result 를 돌려주는 가짜 PostgREST 빌더
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

function withClient(admin, modPath) {
  const clientPath = require.resolve('../db/client');
  const savedClient = require.cache[clientPath];
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseAdmin: () => admin, getSupabasePublic: () => null, hasAdminEnv: () => !!admin } };
  const p = require.resolve(modPath);
  delete require.cache[p];
  const mod = require(modPath);
  const restore = () => {
    delete require.cache[p];
    if (savedClient) require.cache[clientPath] = savedClient; else delete require.cache[clientPath];
  };
  return { mod, restore };
}

test('ALIAS-MEMO: 같은 지역 묶음은 두 번째부터 DB 를 부르지 않는다(순서 무관)', async () => {
  const admin = fakeAdmin(() => ({ data: [{ kapt_code: 'A1', apt_name: '공릉풍림아이원', umd_nm: '공릉동', molit_aliases: ['풍림아파트A'] }], error: null }));
  const { mod, restore } = withClient(admin, '../services/transactionService');
  try {
    const m1 = await mod.getAliasCanonicalMap(['11350', '11320']);
    const n1 = admin.calls.length;
    const m2 = await mod.getAliasCanonicalMap(['11320', '11350']);
    assert.equal(m1.get('풍림아파트A|공릉동'), '공릉풍림아이원');
    assert.equal(m2, m1, '같은 맵을 돌려준다');
    assert.equal(admin.calls.length, n1, '두 번째 호출에서 DB 를 다시 불렀다');
    await mod.getAliasCanonicalMap(['11680']);
    assert.ok(admin.calls.length > n1, '다른 지역 묶음은 DB 를 불러야 한다');
  } finally { restore(); }
});

test('ALIAS-MEMO: 조회 오류로 빈 맵이면 메모하지 않는다', async () => {
  const admin = fakeAdmin(() => ({ data: null, error: { message: 'boom' } }));
  const { mod, restore } = withClient(admin, '../services/transactionService');
  try {
    const m1 = await mod.getAliasCanonicalMap(['11110']);
    assert.equal(m1.size, 0);
    const n1 = admin.calls.length;
    await mod.getAliasCanonicalMap(['11110']);
    assert.ok(admin.calls.length > n1, '오류 결과를 메모했다');
  } finally { restore(); }
});

test('BR-MISS-MEMO: 못 찾은 단지는 두 번째부터 DB·외부 호출 없이 null', async () => {
  // building_register 캐시 없음 · 지번을 못 찾음 → null
  const admin = fakeAdmin(() => ({ data: [], error: null }));
  const { mod, restore } = withClient(admin, '../services/buildingRegisterService');
  try {
    const a = { lawdCd: '11350', aptName: '없는단지', sigungu: '', umdNm: '' };
    assert.equal(await mod.getBuildingTitle(a), null);
    const n1 = admin.calls.length;
    assert.ok(n1 > 0);
    assert.equal(await mod.getBuildingTitle(a), null);
    assert.equal(admin.calls.length, n1, '못 찾은 단지를 다시 조회했다');
    await mod.getBuildingTitle({ ...a, aptName: '다른단지' });
    assert.ok(admin.calls.length > n1, '다른 단지는 조회해야 한다');
  } finally { restore(); }
});

test('BR-MISS-MEMO: DB 캐시에 있는 단지는 그대로 돌려준다(메모 무관)', async () => {
  const admin = fakeAdmin((table) => (table === 'building_register'
    ? { data: [{ title: { hhldCnt: 1590, bldNm: '상계벽산' } }], error: null }
    : { data: [], error: null }));
  const { mod, restore } = withClient(admin, '../services/buildingRegisterService');
  try {
    const t = await mod.getBuildingTitle({ lawdCd: '11350', aptName: '상계벽산' });
    assert.equal(t.hhldCnt, 1590);
    assert.equal(t.cached, true);
  } finally { restore(); }
});
