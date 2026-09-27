/**
 * backend/test/hero-real-data-card.test.js
 *
 * Plan 116a — 랜딩 히어로 첫 카드를 예시(가짜) 그래프에서 1위 단지의 실제 24개월 월평균
 * 실거래가 선그래프로 교체(시안 "내집로그 히어로 카드 리디자인" 구현). 렌더 실행 환경이 없는
 * index.html 이라 public-deeplink-copy.test.js 와 같은 방식으로 **소스 정적 단언**만 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '../../frontend/index.html');

function readIndexHtml() {
  return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

// ① 예시(가짜) 카드 2장이 완전히 사라졌다 — 지어낸 값과 진짜 데이터가 한 화면에 섞이면 안 된다.
//   ⚠ "데이터 종합 점수" 문구 자체는 단지 모달의 실제 점수 기능(Sprint C-2)이 정당하게 쓰고 있어
//   전체 파일에서 0회를 요구할 수 없다(오탐) — 지워야 하는 건 그 문구를 "예시"로 라벨링한
//   랜딩의 lv-card lv-stat 카드뿐이므로, 그 카드의 고유 마크업(클래스 조합)을 정적으로 단언한다.
test('HERO-REAL — index.html 에 "실제 데이터 아님" 예시 문구·예시 종합 점수 카드(lv-card lv-stat)가 없다', () => {
  const html = readIndexHtml();
  const fakeChart = (html.match(/실제 데이터 아님/g) || []).length;
  const fakeScoreCard = (html.match(/lv-card lv-stat/g) || []).length;
  assert.equal(fakeChart, 0, `"실제 데이터 아님" 이 ${fakeChart}회 남아 있다 — 예시 가격 흐름 카드가 아직 있다`);
  assert.equal(fakeScoreCard, 0, `"lv-card lv-stat" 가 ${fakeScoreCard}회 남아 있다 — 예시 종합 점수 카드가 아직 있다`);
  // 진짜 점수 기능(단지 모달)은 그대로 남아 있어야 한다 — 이 Plan 은 그 기능을 건드리지 않는다.
  assert.ok(html.includes('데이터 종합 점수'),
    '단지 모달의 실제 "데이터 종합 점수" 기능 문구가 사라졌다 — 이 Plan 범위 밖이니 건드리면 안 된다');
});

// ② 실데이터 카드 컨테이너가 정확히 1개 — 중복 삽입도, 삭제만 되고 대체가 안 된 것도 아니다.
test('HERO-REAL — id="lv-heroChart" 카드 컨테이너가 1회만 있다', () => {
  const html = readIndexHtml();
  const count = (html.match(/id="lv-heroChart"/g) || []).length;
  assert.equal(count, 1, `id="lv-heroChart" 가 ${count}회 나온다 (기대: 1)`);
});

// ③ 로더가 실제 시계열 API 를 부르고, 표본 임계값이 상수 하나로만 정의돼 있다.
test('HERO-REAL — _loadHeroChart 가 /transactions/history 를 부르고, 표본 임계 12 가 상수 1곳에 정의된다', () => {
  const html = readIndexHtml();
  const fnStart = html.indexOf('async function _loadHeroChart(');
  assert.ok(fnStart >= 0, '_loadHeroChart 함수를 못 찾았다 — 함수명이 바뀌었으면 이 테스트도 갱신할 것');
  const fnEnd = html.indexOf('\nasync function ', fnStart + 1);
  const fnEndAlt = html.indexOf('\nfunction ', fnStart + 1);
  const boundary = [fnEnd, fnEndAlt].filter(i => i > fnStart).sort((a, b) => a - b)[0];
  assert.ok(boundary > fnStart, '_loadHeroChart 다음 함수 경계를 못 찾았다 — 구간 추출이 틀렸을 수 있다');
  const fnBody = html.slice(fnStart, boundary);
  assert.ok(fnBody.includes('/transactions/history'),
    '_loadHeroChart 가 /transactions/history 를 호출하지 않는다 — 실거래 시계열 소스(Plan 102)가 아니다');

  // 표본 임계 12는 상수 정의로 딱 1곳 — 매직넘버로 여기저기 흩어지면 안 된다.
  const constDefs = html.match(/const HERO_SAMPLE_MIN\s*=\s*12\s*;/g) || [];
  assert.equal(constDefs.length, 1, `HERO_SAMPLE_MIN=12 상수 정의가 ${constDefs.length}곳이다 (기대: 1)`);
  assert.ok(fnBody.includes('HERO_SAMPLE_MIN'),
    '_loadHeroChart 가 표본 임계 상수(HERO_SAMPLE_MIN)를 쓰지 않는다 — 매직넘버 12를 직접 썼을 수 있다');
});

// ④ 카드 블록 안에 매수·매도 추천이 아니라는 disclaimer 가 실제로 있다 (운영자 절대 룰 ①).
test('HERO-REAL — lv-heroChart 카드 블록 안에 "매수·매도 추천이 아닙니다" 캡션이 있다', () => {
  const html = readIndexHtml();
  const cardStart = html.indexOf('id="lv-heroChart"');
  assert.ok(cardStart >= 0, 'lv-heroChart 카드를 못 찾았다');
  // 이 카드 바로 다음 형제 카드(TOP 카드, lv-apt)가 블록의 끝 경계다.
  const cardEnd = html.indexOf('<div class="lv-card lv-apt">', cardStart);
  assert.ok(cardEnd > cardStart, 'lv-heroChart 다음 카드(lv-apt) 경계를 못 찾았다 — 카드 순서가 바뀌었을 수 있다');
  const cardBlock = html.slice(cardStart, cardEnd);
  assert.ok(cardBlock.includes('매수·매도 추천이 아닙니다'),
    'lv-heroChart 카드 블록 안에 "매수·매도 추천이 아닙니다" 캡션이 없다');
});
