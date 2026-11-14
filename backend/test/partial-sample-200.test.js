'use strict';
// Plan 200: 일부 달이 빠진 거래 표본 표식 + 완전한 응답만 CDN 캐시
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('PARTIAL-200: 표식은 열거되지 않아 JSON, 펼치기, filter 에 따라가지 않는다', () => {
  const { _markPartial, isPartialSample } = require('../services/transactionService');
  const arr = _markPartial([{ a: 1 }]);
  assert.equal(isPartialSample(arr), true);
  assert.equal(arr.partial, true);
  assert.equal(isPartialSample(JSON.parse(JSON.stringify(arr))), false);
  assert.equal(isPartialSample([...arr]), false);
  assert.equal(isPartialSample(arr.filter(() => true)), false);
  assert.equal(isPartialSample([]), false);
  assert.equal(isPartialSample(null), false);
});

test('PARTIAL-200: 소스 계약 (서비스, 분석, 라우트)', () => {
  const svc = read('../services/transactionService.js');
  assert.ok(svc.includes('_markPartial(sorted)'));
  assert.ok(svc.includes('.catch(() => { partial = true;'));
  assert.ok(svc.includes('if (_amErr) partial = true;'));
  const ana = read('../services/analysisService.js');
  assert.ok(ana.includes('molitAvailable && !_samplePartial && !_jeonsePartial'));
  assert.ok(ana.includes('saleTx.partial === true'));
  const ra = read('../routes/analysis.js');
  assert.ok(ra.includes('result.molitAvailable && !result.samplePartial && !result.jeonsePartial'));
  const rt = read('../routes/transactions.js');
  assert.ok(rt.includes('list.partial === true'));
  assert.ok(rt.includes('(!_partial && items.length > 0)'));
});

function stubModule(rel, exportsObj) {
  const resolved = require.resolve(rel);
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return () => { if (saved) require.cache[resolved] = saved; else delete require.cache[resolved]; };
}

async function runAnalysis(fixture) {
  const restore = stubModule('../services/analysisService', {
    analyzeApt: async () => fixture, getLawdCdFromArea: () => null, compareBatch: async () => ({}),
  });
  const routePath = require.resolve('../routes/analysis');
  delete require.cache[routePath];
  try {
    const router = require('../routes/analysis');
    const layer = router.stack.find(l => l.route && l.route.path === '/' && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const headers = {};
    const res = {
      set(k, v) { headers[k] = v; return res; },
      status() { return res; },
      json() { return res; },
    };
    await handler({ query: { aptName: '은마', lawdCd: '11680' } }, res, () => {});
    return headers['Cache-Control'];
  } finally {
    delete require.cache[routePath];
    restore();
  }
}

test('PARTIAL-200: GET /api/analysis 캐시 헤더', async () => {
  const ok = { molitAvailable: true, samplePartial: false, jeonsePartial: false, txCount: 5 };
  assert.match(await runAnalysis(ok), /s-maxage=1800/);
  assert.equal(await runAnalysis({ ...ok, samplePartial: true }), 'no-store');
  assert.equal(await runAnalysis({ ...ok, jeonsePartial: true }), 'no-store');
  assert.equal(await runAnalysis({ ...ok, txCount: 0 }), 'no-store');
  assert.equal(await runAnalysis({ ...ok, molitAvailable: false }), 'no-store');
});
