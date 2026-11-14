/**
 * Plan 196: 가격 위치 백분위를 대표 평형끼리만 비교한다.
 *   헤더 평균가는 대표 평형 기준인데 비교 분포가 전 평형이라 틀린 백분위가 나왔다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _internals } = require('../services/analysisService');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('백분위: 대표 평형을 주면 그 평형 거래끼리만 비교한다(만원 단위)', () => {
  const tx = [];
  for (let i = 0; i < 10; i++) tx.push({ excluUseAr: 59, dealAmount: 30000 + i * 100 });
  for (let i = 0; i < 10; i++) tx.push({ excluUseAr: 84, dealAmount: 55000 + i * 1000 });
  const withArea = _internals.calcPricePercentile(tx, 60000, 84);
  const without = _internals.calcPricePercentile(tx, 60000);
  assert.equal(withArea.value, 60);
  assert.equal(withArea.n, 10);
  assert.equal(without.value, 80);
  assert.equal(without.n, 20);
});

test('분석 캐시 키: 평형이 다르면 키가 다르고 가격 칸이 맨 끝에 남는다', () => {
  const k84 = _internals.analysisCacheKey('11350', '배선단지', '', '', 600, 84);
  const kNull = _internals.analysisCacheKey('11350', '배선단지', '', '', 600, null);
  assert.notEqual(k84, kNull);
  assert.ok(k84.startsWith('analysis:v3:'));
  assert.ok(k84.endsWith(':60000'));
  assert.ok(kNull.endsWith(':a:60000'));
});

test('소스 계약: 라우트가 exclArea 를 10~400 으로 검증해 analyzeApt 에 넘긴다', () => {
  const src = read('../routes/analysis.js');
  assert.match(src, /_ea >= 10 && _ea <= 400/);
  assert.match(src, /umdNm \|\| null, exclArea\)/);
});

test('소스 계약: 화면이 대표 평형을 분석 요청에 붙인다', () => {
  const html = read('../../frontend/index.html');
  const start = html.indexOf('async function loadAnalysis(p){');
  assert.ok(start >= 0);
  const end = html.indexOf('\n}', start);
  assert.match(html.slice(start, end), /&exclArea=/);
  assert.match(html, /_repSqm: _fromRec \? null : \(_repArea \? _repArea\.sqm : null\)/);
});
