/**
 * backend/test/landing-data-pill-placeholder.test.js
 *
 * PLACEHOLDER-2026-09-27 (Plan 118): 랜딩 정적 건수 → 사실인 하한 표기.
 * /api/health.dataCounts 실패 시 남는 fallback 이 옛 값(277K·27만)이었으나,
 * 실제(1,767K·176만)와 달라서 사실과 다른 숫자가 노출된다(114 F4 유형).
 * 정적 값 6개를 단조 증가하는 지표의 하한("+") 표기로 바꿨다: 1.7M+·10K+·170만+·1만+.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

// ── ① 옛 정적 숫자 277K, 27만 제거 확인 ──────────────────
test('정적 fallback 숫자 — 옛 277K 가 0회여야 함 (Plan 118)', () => {
  const count = (html.match(/277K/g) || []).length;
  assert.equal(count, 0, `277K 가 ${count}회 남아 있다 — 1.7M+ 로 바뀌었어야 한다`);
});

test('정적 fallback 숫자 — 옛 "27만</span>" 가 0회여야 함 (Plan 118)', () => {
  const count = (html.match(/27만<\/span>/g) || []).length;
  assert.equal(count, 0, `"27만</span>" 이 ${count}회 남아 있다 — 170만+ 로 바뀌었어야 한다`);
});

// ── ② 새 하한 표기 정적 값 6개 확인 ──────────────────
test('정적 하한 표기 — <span class="jstxk">1.7M+</span> 정확히 2회 (hero-tag·lv-tag, Plan 118)', () => {
  const count = (html.match(/<span class="jstxk">1\.7M\+<\/span>/g) || []).length;
  assert.equal(count, 2, `<span class="jstxk">1.7M+</span> 가 ${count}회여야 함 (hero-tag·lv-tag 각 1회씩)`);
});

test('정적 하한 표기 — <span class="japtk">10K+</span> 정확히 2회 (hero-tag·lv-tag, Plan 118)', () => {
  const count = (html.match(/<span class="japtk">10K\+<\/span>/g) || []).length;
  assert.equal(count, 2, `<span class="japtk">10K+</span> 가 ${count}회여야 함 (hero-tag·lv-tag 각 1회씩)`);
});

test('정적 하한 표기 — <span class="jstxm">170만+</span> 정확히 1회 (lv-hero-sub, Plan 118)', () => {
  const count = (html.match(/<span class="jstxm">170만\+<\/span>/g) || []).length;
  assert.equal(count, 1, `<span class="jstxm">170만+</span> 가 ${count}회여야 함 (lv-hero-sub 안)`);
});

test('정적 하한 표기 — <span class="japtm">1만+</span> 정확히 1회 (lv-hero-sub, Plan 118)', () => {
  const count = (html.match(/<span class="japtm">1만\+<\/span>/g) || []).length;
  assert.equal(count, 1, `<span class="japtm">1만+</span> 가 ${count}회여야 함 (lv-hero-sub 안)`);
});

// ── ③ 계획서·근거 주석 확인 ──────────────────
test('주석 갱신 — "PLACEHOLDER-2026-09-27" 마크 1회 (Plan 118)', () => {
  const count = (html.match(/PLACEHOLDER-2026-09-27/g) || []).length;
  assert.equal(count, 1, `"PLACEHOLDER-2026-09-27" 마크가 ${count}회여야 함 (_applyStatTags 주석 위)`);
});

test('코드 무결성 — function _applyStatTags 여전히 1회 (로직 변경 없음)', () => {
  const count = (html.match(/function _applyStatTags/g) || []).length;
  assert.equal(count, 1, `function _applyStatTags 가 ${count}회 — _applyStatTags 로직을 건드리면 안 된다`);
});
