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
// LANDING-V5-2026-10-21 (운영자 "AI 느낌"): 영문 고정폭 배지 'DATA · 1.7M+ · 10K+ · DAILY'(소개·히어로 띠)를 지웠다 — 남는 정적 하한은
//   첫 화면 보조 문구의 실거래 건수 한 곳(사실인 하한 "170만+", 응답이 오면 _applyStatTags 가 실제 값으로 바꾼다).
test('영문 배지 제거 — DATA · … · DAILY 와 jstxk·japtk 칸이 0회 (LANDING-V5)', () => {
  assert.equal((html.match(/DATA · /g) || []).length, 0);
  assert.equal((html.match(/<span class="jstxk">/g) || []).length, 0);
  assert.equal((html.match(/<span class="japtk">/g) || []).length, 0);
});

test('정적 하한 표기 — <span class="jstxm">170만+</span> 정확히 1회 (첫 화면 보조 문구, Plan 118)', () => {
  const count = (html.match(/<span class="jstxm">170만\+<\/span>/g) || []).length;
  assert.equal(count, 1, `<span class="jstxm">170만+</span> 가 ${count}회여야 함 (lv-sub 안)`);
  assert.match(html, /<p class="lv-sub">국토교통부 실거래 신고 <span class="jstxm">170만\+<\/span>건 · 매일 새벽 갱신/);
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
