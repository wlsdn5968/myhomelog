/**
 * backend/test/toast-fit.test.js
 *
 * TOAST-FIT-2026-10-18 — 미리보기 실측: 다크에서 토스트 배경(--t1 #E8ECF1)에 고정 흰 글자라 대비 1.19:1,
 * 375 폭에서 긴 문구가 한 줄 고정이라 양쪽 5px 잘림. 글자색은 반전 토큰, 폭은 화면 안, 숨김은 자기 높이 기준.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const rule = (html.match(/\n\.toast\{([^}]*)\}/) || [])[1] || '';

test('토스트 규칙이 있다', () => { assert.ok(rule, '.toast 규칙을 찾지 못했다'); });

test('토스트 글자색은 테마 토큰(배경 --t1 의 반전)이다', () => {
  assert.match(rule, /background:var\(--t1\)/);
  assert.match(rule, /(^|;)color:var\(--bg-base\)/);
});

test('토스트는 화면 폭을 넘지 않고 줄바꿈된다', () => {
  assert.doesNotMatch(rule, /white-space:nowrap/);
  assert.match(rule, /max-width:calc\(100vw - 32px\)/);
});

test('숨김 위치는 고정 px 가 아니라 자기 높이 기준이다', () => {
  assert.match(rule, /translateY\(calc\(100% \+ \d+px\)\)/);
});
