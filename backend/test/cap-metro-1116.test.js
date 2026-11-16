/**
 * backend/test/cap-metro-1116.test.js
 *
 * CAP-METRO-1116: 주담대 한도(15억 이하 6억, 25억 이하 4억, 초과 2억)는 "수도권·규제지역"에 적용된다.
 * 근거: 금융위원회 2025-10-15 보도자료(fsc.go.kr/no010101/85432) 원문을 2026-11-16 에 대조.
 * 전에는 규제지역에만 한도를 걸어 수도권 비규제 지역의 한도를 크게 보였다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const { computeLTV } = require('../services/propertyService');

function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error('끝을 찾지 못했다');
}

test('서버: 수도권이면 규제지역이 아니어도 한도가 걸리고, 지방 비규제는 한도가 없다', () => {
  assert.equal(computeLTV(10, false, false, '무주택', true).maxLoan, '6.00억', '수도권 비규제 10억: 70% 는 7억이지만 한도 6억');
  assert.equal(computeLTV(10, false, false, '무주택', false).maxLoan, '7.00억', '지방 비규제는 LTV 만');
  assert.equal(computeLTV(10, false, false, '무주택').maxLoan, '7.00억', '수도권 여부를 주지 않으면 예전과 같다');
  assert.equal(computeLTV(20, false, true, '무주택', true).maxLoan, '4.00억', '수도권 15억 초과 25억 이하는 4억');
  assert.equal(computeLTV(30, false, false, '무주택', true).maxLoan, '2.00억');
  assert.equal(computeLTV(7, false, false, '무주택', true).maxLoan, '4.90억', '한도에 닿지 않으면 LTV 그대로');
  assert.equal(computeLTV(7, true, false, '무주택', true).maxLoan, '2.80억', '규제지역은 전과 같다');
  const src = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(src.includes("computeLTV(avgAuk, aptIsRegulated, isFirstBuyer, houseStatus, /^(11|41|28)/.test(String(apt.lawdCd || '')))"), '추천 목록이 단지의 지역 코드로 수도권 여부를 넘긴다');
});

test('화면 계산(calcLTV): 수도권 비규제에도 한도가 걸리고, 지방과 그 밖은 걸리지 않는다', () => {
  const mk = (isReg) => new Function('isRegFront', '_loanBaseRate', `${fnSrc('calcLTV')}; return calcLTV;`)(() => isReg, () => 0.04);
  const nonReg = mk(false), reg = mk(true);
  assert.equal(nonReg(10, 0, 0, 0, '무주택', false, '인천').lL, 6, '인천 10억 무주택: 한도 6억');
  assert.equal(nonReg(10, 0, 0, 0, '무주택', false, '경기').lL, 6);
  assert.equal(nonReg(20, 0, 0, 0, '무주택', true, '경기').lL, 4);
  assert.equal(nonReg(10, 0, 0, 0, '무주택', false, '지방').lL, 7, '지방은 LTV 70% 그대로');
  assert.equal(nonReg(10, 0, 0, 0, '무주택', false, '', '28237').lL, 6, '지역 이름이 없어도 시군구 코드가 수도권이면 한도');
  assert.equal(nonReg(10, 0, 0, 0, '무주택', false, '', '26440').lL, 7, '부산 코드는 한도 없음');
  assert.equal(reg(9, 0, 0, 0, '무주택', false, '서울').lL, 3.6, '규제지역은 전과 같다(9억의 40%)');
  assert.equal(nonReg(8, 0, 0, 0, '무주택', false, '인천').lL, 5.6, '한도에 닿지 않으면 그대로');
});

test('상세 계산기와 안내: 지방이 아니면 한도를 걸고, 표와 칩이 그 사실을 알린다', () => {
  assert.ok(html.includes('if(isR||!isLoc)cap=buy<=15?6:buy<=25?4:2;'));
  assert.ok(html.includes('수도권은 한도<br>6억, 4억, 2억'));
  assert.ok(html.includes('수도권이면서 규제지역이 아닌 곳이에요. 한도 6억, 4억, 2억은 수도권 전체에 적용돼요'));
  const reg = fs.readFileSync(path.join(__dirname, '../services/regulationsService.js'), 'utf8');
  assert.equal((reg.match(/한도 15억 이하 6억, 25억 이하 4억, 초과 2억/g) || []).length, 2);
});

// ── FIRST-METRO-1116: 생애최초 LTV 는 "수도권·규제지역 70%, 그 외 80%" ──
// 근거: 금융위 2026-08-13 「부동산 시장 안정을 위한 금융 종합대책」 안건 인쇄 13쪽과 16쪽(fsc.go.kr/no010101/87517 첨부).
test('생애최초 LTV: 수도권이면 규제지역이 아니어도 70%, 지방은 80% (서버)', () => {
  assert.equal(computeLTV(5, false, true, '무주택', true).ltv, '70% (비규제)');
  assert.equal(computeLTV(5, false, true, '무주택', true).maxLoan, '3.50억');
  assert.equal(computeLTV(5, false, true, '무주택', false).ltv, '80% (비규제)', '지방 생애최초는 80%');
  assert.equal(computeLTV(5, false, false, '무주택', true).ltv, '70% (비규제)', '생애최초가 아니면 그대로 70%');
  assert.equal(computeLTV(5, true, true, '무주택', true).ltv, '70% (규제)');
});

test('생애최초 LTV: 화면 계산도 수도권 비규제는 70%, 지방은 80%', () => {
  const mk = (isReg) => new Function('isRegFront', '_loanBaseRate', `${fnSrc('calcLTV')}; return calcLTV;`)(() => isReg, () => 0.04);
  const nonReg = mk(false);
  assert.equal(nonReg(5, 0, 0, 0, '무주택', true, '인천').ltv, 0.7);
  assert.equal(nonReg(5, 0, 0, 0, '무주택', true, '경기').lL, 3.5);
  assert.equal(nonReg(5, 0, 0, 0, '무주택', true, '지방').ltv, 0.8);
  assert.equal(nonReg(5, 0, 0, 0, '무주택', false, '인천').ltv, 0.7);
  assert.equal(mk(true)(5, 0, 0, 0, '무주택', true, '서울').ltv, 0.7);
  assert.ok(html.includes("if(house==='무주택'&&isF&&!isR&&!isLoc){ltv=.7;warn='수도권 생애최초 LTV 70%';}"), '상세 계산기도 같다');
});

test('정책 문구: 2026년 증가율 목표는 3% 수준이고, 근거 없는 숫자(4조 1,000억)를 쓰지 않는다', () => {
  assert.ok(html.includes('가계대출 증가율 3% 수준 관리 (2026.8.13 대책에서 당초 1.5%를 올림)'));
  assert.ok(!html.includes('가계대출 증가율 1.5% 이내 관리 목표'));
  assert.ok(!html.includes('4조 1,000억 영향'), '2026-11-16 원문 대조에서 근거를 찾지 못한 숫자');
  const reg = fs.readFileSync(path.join(__dirname, '../services/regulationsService.js'), 'utf8');
  assert.ok(reg.includes("'2026년 가계부채 총량 증가율 3% 수준 관리 (2026.8.13 대책, 당초 1.5%)',"));
  assert.ok(reg.includes('무주택 세대가 규제지역에서 주택구입 목적 주담대를 받으면 6개월 안에 전입'));
});
