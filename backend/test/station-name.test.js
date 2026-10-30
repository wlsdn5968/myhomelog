/**
 * STATION-NAME-2026-10-30 (Plan 157): 최근접 역 이름을 DB 캐시에도 남긴다.
 *  ① 카카오 조회 → 거리와 이름을 함께 저장 ② DB 에 이름이 있으면 그대로(카카오 안 부름)
 *  ③ 이름 없는 옛 저장분: needName 호출만 다시 불러 이름을 채운다 · 기본 호출(추천 계산)은 다시 부르지 않는다
 *  ④ 이름 채우기 재조회가 실패하면 저장된 거리를 그대로(실패를 '역 없음'으로 바꾸지 않음) ⑤ 시설 개수 행은 이름 칸을 싣지 않는다
 * 실행: cd backend && TZ=UTC node --test test/station-name.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

function withKakao(rows, kakao, fn) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/kakaoService');
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath], get: axios.get, key: process.env.KAKAO_REST_API_KEY };
  const upserts = [];
  let calls = 0;
  const admin = {
    from() {
      return {
        select() { return { eq: (_c, key) => ({ maybeSingle: async () => ({ data: rows[key] || null }) }) }; },
        upsert(payload) { upserts.push(payload); return Promise.resolve({ error: null }); },
      };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { hasAdminEnv: () => true, getSupabaseAdmin: () => admin } };
  delete require.cache[svcPath];
  process.env.KAKAO_REST_API_KEY = 'test-key';
  axios.get = async () => { calls++; if (kakao instanceof Error) throw kakao; return { data: { documents: kakao } }; };
  const svc = require('../services/kakaoService');
  return Promise.resolve().then(() => fn(svc, { upserts, calls: () => calls })).finally(() => {
    axios.get = saved.get;
    if (saved.key === undefined) delete process.env.KAKAO_REST_API_KEY; else process.env.KAKAO_REST_API_KEY = saved.key;
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  });
}
const now = new Date().toISOString();
// 테스트마다 다른 좌표 — 메모리 캐시(3일)를 서로 섞지 않는다
const key = (lat, lng) => `${lat},${lng}:sw8near:3000`;

test('① 카카오 조회 결과는 거리와 이름을 함께 저장한다', async () => {
  await withKakao({}, [{ place_name: '공릉역 7호선', distance: '680' }], async (svc, t) => {
    const r = await svc.nearestSubway(37.1001, 127.0001, 3000);
    assert.deepEqual(r, { name: '공릉역 7호선', distance: 680 });
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(t.upserts.length, 1);
    assert.equal(t.upserts[0].count, 680);
    assert.equal(t.upserts[0].name, '공릉역 7호선');
  });
});

test('② DB 에 이름이 있으면 카카오를 부르지 않고 이름까지 돌려준다', async () => {
  await withKakao({ [key(37.1002, 127.0002)]: { count: 437, name: '상계역', fetched_at: now } }, [], async (svc, t) => {
    const r = await svc.nearestSubway(37.1002, 127.0002, 3000, { needName: true });
    assert.deepEqual(r, { name: '상계역', distance: 437 });
    assert.equal(t.calls(), 0);
  });
});

test('③ 이름 없는 옛 저장분: needName 이면 다시 불러 이름을 채우고, 기본 호출은 다시 부르지 않는다', async () => {
  const rows = { [key(37.1003, 127.0003)]: { count: 512, name: null, fetched_at: now }, [key(37.1004, 127.0004)]: { count: 300, name: null, fetched_at: now } };
  await withKakao(rows, [{ place_name: '노원역', distance: '512' }], async (svc, t) => {
    const plain = await svc.nearestSubway(37.1004, 127.0004, 3000);
    assert.deepEqual(plain, { name: null, distance: 300 });
    assert.equal(t.calls(), 0, '추천 계산 경로는 카카오를 더 부르지 않는다');
    const named = await svc.nearestSubway(37.1003, 127.0003, 3000, { needName: true });
    assert.deepEqual(named, { name: '노원역', distance: 512 });
    assert.equal(t.calls(), 1);
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(t.upserts[0].name, '노원역');
  });
});

test('④ 이름 채우기 재조회가 실패하면 저장된 거리를 그대로 — 실패를 역 없음·모름으로 바꾸지 않는다', async () => {
  await withKakao({ [key(37.1005, 127.0005)]: { count: 900, name: null, fetched_at: now } }, new Error('kakao down'), async (svc) => {
    const r = await svc.nearestSubway(37.1005, 127.0005, 3000, { needName: true });
    assert.deepEqual(r, { name: null, distance: 900 });
  });
  // 역 없음(-1) 저장분은 이름이 필요 없으니 다시 부르지 않는다
  await withKakao({ [key(37.1006, 127.0006)]: { count: -1, name: null, fetched_at: now } }, [], async (svc, t) => {
    assert.equal(await svc.nearestSubway(37.1006, 127.0006, 3000, { needName: true }), null);
    assert.equal(t.calls(), 0);
  });
});

test('⑤ 시설 개수 행 저장은 이름 칸을 싣지 않는다(칸 4개 그대로), 비교 창만 needName', async () => {
  await withKakao({}, [], async (svc, t) => {
    await svc._dbSetAmenityCount('35.8663,128.693:MT1:1500', 35.8663, 128.693, 'MT1', 1500, 7);
    assert.deepEqual(Object.keys(t.upserts[0]).sort(), ['cache_key', 'count', 'fetched_at', 'updated_at']);
  });
  const fs = require('fs');
  const path = require('path');
  const an = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.match(an, /nearestSubway\(c\.lat, c\.lng, 3000, \{ needName: true \}\)/);
  const ps = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.match(ps, /dists\[i \+ k\] = await nearestSubway\(c\.lat, c\.lng, 3000\);/, '추천 계산은 기본 호출 유지');
});
