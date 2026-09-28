/**
 * backend/test/market-signal-score.test.js (Plan 121)
 *
 * summarizeMarketSignal(가격 위치·거래량·전세가율 가산 → score/signal/veto, analysisService.js:265)
 * 의 입력→출력을 손으로 계산한 값으로 고정한다. 기존 테스트(frontend-contracts.test.js:296~,
 * rent-jeonse.test.js:324~)는 조건 카드의 desc 문구만 확인했고, score·maxScore·signal·metCount·
 * vetoApplied·tone 을 직접 단언하는 테스트가 없었다 — 점수표·등급 임계값을 손대도 아무것도
 * 깨지지 않는 상태였다. 이 파일은 desc 문구를 다시 확인하지 않는다(중복 방지).
 *
 * ⚠ 이 테스트가 드러내는 사실(계획서 §2) — veto 강등은 현재 산식으로 도달 불가:
 *   percentile > 65 면 가격 조건이 항상 0점이 된다. 그 상태에서 나올 수 있는 최고 점수는
 *   3조건(가격+거래량+전세) 만점이어도 4/6 = 0.6667 < 0.67, 2조건(전세 없음) 만점이어도
 *   2/4 = 0.5 — 어느 쪽도 green(ratio>=0.67) 기준을 넘지 못한다. 즉 "green 이었다가 veto 로
 *   yellow 강등"이 될 입력 조합 자체가 존재하지 않아 vetoApplied 는 이 산식에서 항상 false 다.
 *   veto 블록이 실제로 하는 일은 이미 yellow 인 신호에 경고 문구(' · ⚠ 시세 상단 — 매수 단가
 *   주의')를 붙이는 것뿐이다. 아래 C·H 가 이를 직접 단언한다 — 나중에 임계값·가산이 바뀌어
 *   veto 가 실제로 살아나면 이 테스트가 깨져서 알려준다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../services/analysisService');
const { calcBuySignal } = _internals;

test('A: percentile 20(green)+거래량 up/비성수기(green)+전세 70(green) → 6/6 만점 green, metCount 3', () => {
  const r = calcBuySignal(20, { signal: 'up', seasonalBias: false }, 70);
  assert.equal(r.score, 6);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'green');
  assert.equal(r.metCount, 3); // 가격 위치 green + 거래량 green + 전세가율 green = 3
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'active');
});

test('B: percentile 20(green)+거래량 up/성수기 감쇄(yellow)+전세 70(green) → 5/6 green, metCount 2', () => {
  const r = calcBuySignal(20, { signal: 'up', seasonalBias: true }, 70);
  assert.equal(r.score, 5);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'green');
  assert.equal(r.metCount, 2);
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'active');
  // 성수기 감쇄로 거래량 조건 자체가 green→yellow 로 내려간 것이 metCount=2(3 아님)의 근거.
  const vol = r.conditions.find(c => c.label === '거래량 추이');
  assert.equal(vol.status, 'yellow');
  assert.equal(vol.desc, '최근 3개월 거래 증가 (성수기 영향 감쇄)');
});

test('C: percentile 80(veto 조건 성립)+거래량 up(green)+전세 70(green) → 4/6=0.6667<0.67 라 green 불가 — veto 강등 도달 불가(yellow+경고문구만)', () => {
  const r = calcBuySignal(80, { signal: 'up', seasonalBias: false }, 70);
  assert.equal(r.score, 4);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'yellow');
  assert.equal(r.metCount, 2);
  // originalSignal 이 애초에 green 이 아니었으므로(4/6<0.67) veto if(signal==='green') 분기에
  // 들어가지 못한다 — vetoApplied 는 항상 false. 이 산식에서 veto 가 실제로 "강등"한 적은 없다.
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'neutral');
  assert.equal(r.signalDesc, '3개 조건 중 2개 긍정 · ⚠ 시세 상단 — 매수 단가 주의');
  assert.equal(r.summaryDesc, '3개 조건 중 2개 데이터 부합 · ⚠ 시세 상단 — 매수 단가 주의');
});

test('D: percentile 50(yellow)+거래량 neutral 문자열 인자(yellow)+전세 50(yellow) → 3/6 yellow, metCount 0', () => {
  const r = calcBuySignal(50, 'neutral', 50);
  assert.equal(r.score, 3);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'yellow');
  assert.equal(r.metCount, 0);
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'neutral');
});

test('E: percentile 50(yellow)+거래량 down(red)+전세 50(yellow) → 2/6=0.333<0.34 라 전체 red, metCount 0', () => {
  const r = calcBuySignal(50, { signal: 'down' }, 50);
  assert.equal(r.score, 2);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'red');
  assert.equal(r.metCount, 0);
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'cautious');
});

test('F: percentile 90(red)+거래량 down(red)+전세 30(red) → 0/6 red, veto 블록에 들어가도 red 라 경고 문구가 붙지 않는다', () => {
  const r = calcBuySignal(90, { signal: 'down' }, 30);
  assert.equal(r.score, 0);
  assert.equal(r.maxScore, 6);
  assert.equal(r.signal, 'red');
  assert.equal(r.metCount, 0);
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'cautious');
  assert.equal(r.signalDesc, '3개 조건 중 0개 긍정');
});

test('G: percentile null(조건 제외)+거래량 neutral(yellow)+전세 null(조건 제외) → 1/2 yellow, metCount 0', () => {
  const r = calcBuySignal(null, { signal: 'neutral' }, null);
  assert.equal(r.totalCount, 1);
  assert.equal(r.score, 1);
  assert.equal(r.maxScore, 2);
  assert.equal(r.signal, 'yellow');
  assert.equal(r.metCount, 0);
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'neutral');
});

test('H: percentile 80(veto 조건 성립)+거래량 up(green)+전세 null(조건 제외, 2조건) → 2/4=0.5 로도 green 불가 — veto 도달 불가', () => {
  const r = calcBuySignal(80, { signal: 'up' }, null);
  assert.equal(r.totalCount, 2);
  assert.equal(r.score, 2);
  assert.equal(r.maxScore, 4);
  assert.equal(r.signal, 'yellow');
  assert.equal(r.metCount, 1);
  // 조건이 2개뿐이라도(전세 없음) 만점 2/4=0.5 는 여전히 0.67 미만이다 — veto 는 여기서도 불가능.
  assert.equal(r.vetoApplied, false);
  assert.equal(r.tone, 'neutral');
  assert.equal(r.signalDesc, '2개 조건 중 1개 긍정 · ⚠ 시세 상단 — 매수 단가 주의');
});

test('경계값 — 가격 위치 percentile 30/31/65/66 (green/yellow/yellow/red 전환)', () => {
  const statusAt = (p) => calcBuySignal(p, { signal: 'neutral' }, null)
    .conditions.find(c => c.label === '가격 위치').status;
  assert.equal(statusAt(30), 'green', 'percentile 30 은 <=30 이라 green 이어야 한다');
  assert.equal(statusAt(31), 'yellow', 'percentile 31 은 <=65 라 yellow 여야 한다');
  assert.equal(statusAt(65), 'yellow', 'percentile 65 는 <=65 경계라 yellow 여야 한다');
  assert.equal(statusAt(66), 'red', 'percentile 66 은 >65 라 red 여야 한다');
});

test('경계값 — 전세가율 60/59.9/45/44.9 (green/yellow/yellow/red 전환)', () => {
  const statusAt = (j) => calcBuySignal(null, { signal: 'neutral' }, j)
    .conditions.find(c => c.label === '전세가율').status;
  assert.equal(statusAt(60), 'green', '전세가율 60 은 >=60 이라 green 이어야 한다');
  assert.equal(statusAt(59.9), 'yellow', '전세가율 59.9 는 <60 이라 yellow 여야 한다');
  assert.equal(statusAt(45), 'yellow', '전세가율 45 는 >=45 경계라 yellow 여야 한다');
  assert.equal(statusAt(44.9), 'red', '전세가율 44.9 는 <45 라 red 여야 한다');
});

test('알 수 없는 거래량 신호({signal:"weird"})는 neutral 과 동일하게 1점 yellow 로 처리된다', () => {
  const r = calcBuySignal(null, { signal: 'weird' }, null);
  const vol = r.conditions.find(c => c.label === '거래량 추이');
  assert.equal(vol.status, 'yellow');
  assert.equal(r.score, 1);
  assert.equal(r.maxScore, 2);
});
