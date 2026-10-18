/**
 * backend/test/recommend-br-budget.test.js
 *
 * BR-BUDGET-2026-10-18: 운영 계측(facilityDetail) — 추천 enrich 5,441ms 중 건축물대장 10건 최대 5,311ms.
 * 추천 안에서는 건축물대장을 2초까지만 기다리고, 늦으면 그 단지 세대수는 미확인으로 두며 결과를 10분만 캐시한다.
 * 늦지 않으면 종전대로 세대수를 쓰고 3시간 캐시.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _withRecStubs } = require('../testSupport/_helpers');

const LAWD = '11350';
const FIX = (getBuildingTitle) => ({
  lawdCd: LAWD, sigungu: '노원구', umdNm: '상계동',
  // households 를 비워 "이름 매칭 실패 → 건축물대장으로 세대수" 경로를 탄다
  complexes: [{ name: '느린대장단지', buildYear: 2010, price: 50000, n: 3 }],
  getBuildingTitle,
});

function spyCacheSet() {
  const cache = require('../cache');
  const orig = cache.set;
  const ttls = [];
  cache.set = function (k, v, ttl) { if (String(k).startsWith('rec')) ttls.push(ttl); return orig.call(this, k, v, ttl); };
  return { ttls, restore: () => { cache.set = orig; } };
}

test('건축물대장이 2초를 넘기면 기다리지 않고 세대수 미확인 · 결과는 10분 캐시', async () => {
  const spy = spyCacheSet();
  try {
    await _withRecStubs(FIX(() => new Promise(r => setTimeout(() => r({ hhldCnt: 1500 }), 3500))), async (ps) => {
      const t0 = Date.now();
      const result = await ps.getAIRecommendations({ maxBudget: 6, lawdCd: LAWD, houseStatus: '무주택', isFirstBuyer: false });
      const ms = Date.now() - t0;
      assert.ok(ms < 3300, `건축물대장을 끝까지 기다렸다(${ms}ms)`);
      const rec = (result.recommendations || []).find(r => r.aptName === '느린대장단지');
      assert.ok(rec, '단지가 결과에서 빠졌다');
      assert.ok(!(rec.facility && rec.facility.totalHouseholds > 0), '늦은 세대수가 들어갔다');
    });
    assert.ok(spy.ttls.includes(600), `덜 채운 결과의 캐시가 짧지 않다: ${JSON.stringify(spy.ttls)}`);
  } finally { spy.restore(); }
});

test('건축물대장이 제때 오면 세대수를 쓰고 3시간 캐시', async () => {
  const spy = spyCacheSet();
  try {
    await _withRecStubs(FIX(() => new Promise(r => setTimeout(() => r({ hhldCnt: 1500 }), 100))), async (ps) => {
      const result = await ps.getAIRecommendations({ maxBudget: 6, lawdCd: LAWD, houseStatus: '무주택', isFirstBuyer: false });
      const rec = (result.recommendations || []).find(r => r.aptName === '느린대장단지');
      assert.ok(rec, '단지가 결과에서 빠졌다');
      assert.equal(rec.facility && rec.facility.totalHouseholds, 1500);
    });
    assert.ok(spy.ttls.includes(10800), `정상 결과가 3시간 캐시되지 않았다: ${JSON.stringify(spy.ttls)}`);
  } finally { spy.restore(); }
});
