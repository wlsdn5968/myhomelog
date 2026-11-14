/**
 * CMP-CUTOFF-2026-11-14: 단지 비교의 기간 시작일이 31일에 달을 넘쳤다.
 *   new Date().setMonth(getMonth() - 3) 은 5/31 에서 "2/31" = 3/3 이 되어 창 앞쪽 사흘 거래가 빠졌다(로컬 재현).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _internals } = require('../services/analysisService');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('기간 시작일: 31일에도 달이 넘치지 않고 그 달 마지막 날로 자른다(윤년 포함)', () => {
  const f = _internals.monthsAgoClamped;
  assert.equal(ymd(f(3, new Date(2026, 4, 31, 12))), '2026-02-28');
  assert.equal(ymd(f(6, new Date(2026, 7, 31, 12))), '2026-02-28');
  assert.equal(ymd(f(3, new Date(2028, 4, 31, 12))), '2028-02-29');
  assert.equal(ymd(f(1, new Date(2026, 2, 31, 12))), '2026-02-28');
  assert.equal(ymd(f(12, new Date(2026, 4, 31, 12))), '2025-05-31');
  assert.equal(ymd(f(6, new Date(2026, 6, 15, 12))), '2026-01-15', '넘치지 않는 날은 그대로');
});

test('비교 함수는 넘치는 옛 계산을 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.doesNotMatch(src, /cutoff\.setMonth\(cutoff\.getMonth\(\) - dealMonths\)/);
  assert.match(src, /const cutoffMs = _monthsAgoClamped\(dealMonths\)\.getTime\(\);/);
});
