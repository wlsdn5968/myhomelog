/**
 * backend/test/bnav-selected-only.test.js
 *
 * BNAV-SEL-2026-10-18 — 모바일 하단 탭에서 선택되지 않은 탭이 고정색으로 칠해지면
 * 라이트에선 선택 탭이 둘인 것처럼 보이고(보고서 #1F4F9C · 선택 --acc #173A63),
 * 다크에선 배경(#151E2B) 대비 2.12:1 로 읽기 어려웠다(미리보기 실측).
 * 하단 탭 글자색은 기본 --t3, 선택 .on 의 --acc 두 가지뿐이어야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

test('하단 탭 색 규칙은 기본(.bnav-item)과 선택(.bnav-item.on)뿐이다', () => {
  const rules = [...html.matchAll(/([^{}\n]*\.bnav-item[^{}\n]*)\{([^}]*)\}/g)]
    .filter(m => /(^|;)\s*color\s*:/.test(m[2]))
    .map(m => m[1].trim());
  assert.deepEqual(rules.sort(), ['.bnav-item', '.bnav-item.on']);
});

test('선택되지 않은 탭에 고정 강조색을 주는 규칙이 없다', () => {
  assert.doesNotMatch(html, /\.bnav-feature[^{}\n]*\{[^}]*color/);
});
