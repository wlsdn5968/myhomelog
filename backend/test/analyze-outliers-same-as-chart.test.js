/**
 * Plan 174 (2026-10-30, 운영자 승인 "권고대로"): 단지 상세 분석(가격 위치 백분위·시세 요약)의 동떨어진 거래 기준도
 *   가격 차트·비교 창과 같은 localOutliers 하나로. 분석 표본은 예전과 같은 최근 6개월, 판정은 앞 6개월 이웃 포함.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('상세 분석: 12개월을 받아 판정하고, 표본·건수는 최근 6개월만 — 앞쪽 이웃으로만 판정되는 거래도 뺀다', async () => {
  const svcPath = require.resolve('../services/analysisService');
  const txPath = require.resolve('../services/transactionService');
  const rentPath = require.resolve('../services/rentService');
  const saved = { svc: require.cache[svcPath], tx: require.cache[txPath], rent: require.cache[rentPath] };
  const realTx = require(txPath), realRent = require(rentPath);
  const { txWindowMonths } = require('../utils/txWindow');
  const win = txWindowMonths(6); // 최근 6개월(한국 시간 기준 달) — 가장 오래된 달이 끝
  const oldest = win[win.length - 1];
  const ym = (k) => { const y = +oldest.slice(0, 4), m = +oldest.slice(4, 6) - 1 + k; const d = new Date(Date.UTC(y, m, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; };
  const deal = (k, day, amt) => { const [y, m] = ym(k); return { aptName: '배선단지', dealYear: y, dealMonth: m, dealDay: day, dealAmount: amt, excluUseAr: 45.9 }; };
  // 표본 첫 달(k=0) 3일의 3.60억은 표본 안쪽 이웃이 2건뿐(90일 안 1건·180일 안 2건)이라 앞쪽 달(k<0) 이웃이 있어야 판정된다
  const deals = [deal(-2, 5, 52000), deal(-2, 20, 52500), deal(-1, 10, 53000), deal(-1, 25, 52800),
    deal(0, 3, 36000), deal(3, 15, 55000), deal(5, 10, 56000)];
  const calls = [];
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: Object.assign({}, realTx, {
    getTransactionsByAptInclAliases: async (l, n, months) => { calls.push(months); return deals; },
  }) };
  require.cache[rentPath] = { id: rentPath, filename: rentPath, loaded: true, exports: Object.assign({}, realRent, { getJeonseByApt: async () => [] }) };
  delete require.cache[svcPath];
  try {
    const { analyzeApt } = require(svcPath);
    const r = await analyzeApt('11350', '배선단지', 5.5, null, null);
    assert.deepEqual(calls, [12], '6개월 표본 + 앞쪽 6개월');
    assert.equal(r.txCount, 3, '앞쪽 6개월 거래는 표본 건수에 넣지 않는다');
    assert.equal(r.anomalyCount, 1, '표본 첫 달 3.60억은 앞쪽 이웃으로 판정돼 빠진다');
    assert.equal(r.filteredTxCount, 2);
  } finally {
    for (const [k, p] of [['svc', svcPath], ['tx', txPath], ['rent', rentPath]]) {
      if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p];
    }
  }
});

test('옛 기준(filterAnomalies·±30%)이 코드와 화면에 남아 있지 않다 · 백분위는 다시 거르지 않는다', () => {
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.doesNotMatch(ana, /function filterAnomalies|filterAnomalies\((saleTx|transactions)\)/); // 설명 주석의 이름은 허용
  assert.match(ana, /function calcPricePercentile\(transactions, currentPrice, currentArea = null\) \{[\s\S]{0,400}const filtered = transactions;/);
  assert.doesNotMatch(html, /±30% 초과 가격|이상거래 '\+d\.anomalyCount/);
  assert.match(html, /가격 그래프의 빈 원과 같은 기준이에요/);
  assert.match(ana, /return `analysis:v2:/, '기준이 바뀌었으니 분석 캐시 키 판을 올린다');
});
