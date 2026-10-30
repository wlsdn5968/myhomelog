/**
 * Plan 173 (2026-10-30, 운영자 승인 "권고대로"): 비교 창의 동떨어진 거래 기준 = 단지 상세 가격 차트(Plan 171)와 같은 규칙.
 *   두 구현(frontend _pcOutliers · backend localOutliers)이 같은 거래를 고르는지 같은 입력으로 대조한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
function frontOutliers() {
  const a = html.indexOf('function _pcDayNum(d)');
  const src = html.slice(a, html.indexOf('\n// 순수 함수: 개별 거래', a));
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { _pcOutliers, _pcPy };`)();
}
const { localOutliers } = require('../services/analysisService')._internals;

// 결정적 의사 난수(LCG) — 매번 같은 입력
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeDeals(seed) {
  const r = rng(seed), out = [];
  const types = [[41.3, 48000], [45.9, 50000], [49.94, 60000], [84.86, 90000]];
  const start = Date.UTC(2023, 9, 1);
  for (let k = 0; k < 420; k++) {
    const [ar, base] = types[Math.floor(r() * types.length)];
    const day = Math.floor(r() * 1100);
    const trend = base * (1 + 0.25 * day / 1100);
    let a = Math.round(trend * (0.93 + r() * 0.14));
    const u = r();
    if (u < 0.03) a = Math.round(a * 0.65); else if (u < 0.05) a = Math.round(a * 1.35); // 일부러 넣은 동떨어진 거래
    const d = new Date(start + day * 864e5).toISOString().slice(0, 10);
    out.push({ d, a, ar });
  }
  return out;
}

test('대조: 같은 거래 묶음에서 차트(_pcOutliers)와 비교 창(localOutliers)이 같은 거래를 고른다(시드 3개)', () => {
  const { _pcOutliers, _pcPy } = frontOutliers();
  for (const seed of [7, 2026, 1030]) {
    const deals = makeDeals(seed);
    const front = new Set();
    const by = {};
    deals.forEach((x, i) => { (by[_pcPy(x.ar)] = by[_pcPy(x.ar)] || []).push(Object.assign({ i }, x)); });
    Object.values(by).forEach(rows => _pcOutliers(rows).forEach(x => front.add(x.i)));
    const back = new Set();
    const tx = deals.map((x, i) => ({ i, dealYear: +x.d.slice(0, 4), dealMonth: +x.d.slice(5, 7), dealDay: +x.d.slice(8, 10), dealAmount: x.a, excluUseAr: x.ar }));
    localOutliers(tx).forEach(t => back.add(t.i));
    assert.ok(front.size > 0, `시드 ${seed}: 판정이 하나도 없으면 대조가 의미 없다`);
    assert.deepEqual([...back].sort((a, b) => a - b), [...front].sort((a, b) => a - b), `시드 ${seed}`);
  }
});

test('실측(상계주공7 14평 2025-11~2026-03): 3.60억만 고른다', () => {
  const rows = [['2025-11-21', 52500, 45.77], ['2025-12-05', 51500, 45.9], ['2025-12-11', 54500, 45.9], ['2025-12-11', 53000, 45.55],
    ['2025-12-16', 51300, 45.55], ['2026-01-07', 50000, 45.9], ['2026-01-15', 52200, 45.9], ['2026-01-26', 54800, 45.55],
    ['2026-01-28', 51900, 45.9], ['2026-01-29', 36000, 45.55], ['2026-01-31', 50000, 45.77], ['2026-01-31', 54000, 45.55],
    ['2026-02-12', 56000, 45.9], ['2026-02-19', 53000, 45.77], ['2026-02-20', 54000, 45.55], ['2026-03-10', 58750, 45.55]]
    .map(([d, a, ar]) => ({ dealYear: +d.slice(0, 4), dealMonth: +d.slice(5, 7), dealDay: +d.slice(8, 10), dealAmount: a, excluUseAr: ar }));
  assert.deepEqual([...localOutliers(rows)].map(t => t.dealAmount), [36000]);
});

test('비교 계산: 기간 앞 6개월은 이웃 판정에만 쓰고, 건수·면적대에는 넣지 않는다', async () => {
  // 의존 모듈 흉내(같은 프로세스 안에서 analysisService 를 새로 불러온다)
  const svcPath = require.resolve('../services/analysisService');
  const txPath = require.resolve('../services/transactionService');
  const facPath = require.resolve('../services/aptFacilityService');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const saved = { svc: require.cache[svcPath], tx: require.cache[txPath], fac: require.cache[facPath], geo: require.cache[geoPath] };
  const realTx = require(txPath);
  const calls = [];
  const now = new Date();
  const ago = (days) => { const d = new Date(now.getTime() - days * 864e5); return { dealYear: d.getFullYear(), dealMonth: d.getMonth() + 1, dealDay: d.getDate() }; };
  // 기간(12개월) 첫머리 거래 1건(3.60억)은 기간 앞쪽(13~15개월 전) 이웃만 있다 — 앞쪽 이웃이 없으면 판정할 수 없다
  const deals = [
    ...[400, 410, 420, 430].map(d => Object.assign(ago(d), { dealAmount: 52000, excluUseAr: 45.9 })),
    Object.assign(ago(355), { dealAmount: 36000, excluUseAr: 45.9 }),
    ...[200, 150, 100, 60, 30].map(d => Object.assign(ago(d), { dealAmount: 55000, excluUseAr: 45.9 })),
  ];
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: Object.assign({}, realTx, {
    getTransactionsByAptInclAliases: async (lawdCd, aptName, months) => { calls.push(months); return deals; },
  }) };
  require.cache[facPath] = { id: facPath, filename: facPath, loaded: true, exports: { resolveFacility: async () => null } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: { resolveCoord: async () => null } };
  delete require.cache[svcPath];
  try {
    const { _internals } = require(svcPath);
    const r = await _internals.compareOne({ aptName: '상계주공7단지', lawdCd: '11350' }, 12);
    assert.deepEqual(calls, [18], '12개월 + 앞쪽 6개월을 받아야 한다');
    assert.equal(r.totalTx, 6, '기간 밖(13개월 넘은) 4건은 세지 않는다');
    assert.equal(r.excludedTx, 1, '기간 첫머리 3.60억은 앞쪽 이웃으로 판정돼 빠진다');
    assert.equal(r.bands[0].n, 5);
    assert.equal(r.bands[0].minDealManwon, 55000);
  } finally {
    for (const [k, p] of [['svc', svcPath], ['tx', txPath], ['fac', facPath], ['geo', geoPath]]) {
      if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p];
    }
  }
});

test('비교 면책 문구가 빼는 기준을 밝힌다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.match(src, /같은 평형의 앞뒤 3개월 거래보다 20% 넘게 벗어난 거래는 단지 상세 가격 그래프와 같은 기준으로 빼고 셌어요/);
  assert.doesNotMatch(src.slice(src.indexOf('async function _compareOne')), /filterAnomalies\(saleTx\)/, '비교 창이 옛 기준을 다시 쓰면 안 된다');
});
