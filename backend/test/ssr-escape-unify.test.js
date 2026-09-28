/**
 * backend/test/ssr-escape-unify.test.js
 *
 * ESC-UNIFY-2026-09-28 (Plan 124): aptPage.js·regionPage.js·briefing.js 가 각자 갖고 있던
 * 동일한 로컬 esc() 3벌을 backend/utils/htmlEscape.js 하나로 합치고, regionPage.js·briefing.js
 * 에서 이스케이프 없이 나가던 og:image/twitter:image 4곳을 이스케이프한다. share.js 의
 * escapeHtml 은 별도 함수로 남기되(SHARE-REPLACE-LITERAL-2026-09-06 의 '$' 방어층 때문에
 * 통합 대상이 아니다) 0·false 를 빈 문자열로 만들던 `s || ''` 를 다른 SSR escape 와 같은
 * null 기준(`s == null ? '' : s`)으로만 맞춘다. 출력은 문자열 입력 기준 바이트 동일이다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');



test('escHtml — null/undefined 는 빈 문자열, 0·false 는 String() 그대로', () => {
  const { escHtml } = require('../utils/htmlEscape');
  assert.equal(escHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escHtml(0), '0');
  assert.equal(escHtml(false), 'false');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});



test('세 SSR 라우트 — 로컬 function esc( 정의가 사라지고 공용 htmlEscape 모듈을 정확히 1회 require 한다', () => {
  const files = ['../routes/aptPage.js', '../routes/regionPage.js', '../routes/briefing.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.equal((src.match(/function esc\(/g) || []).length, 0,
      `${rel} 에 로컬 function esc( 정의가 남아 있다 — 공용 모듈로 옮겨졌어야 한다`);
    assert.equal((src.match(/require\('\.\.\/utils\/htmlEscape'\)/g) || []).length, 1,
      `${rel} 가 '../utils/htmlEscape' 를 정확히 1회 require 하지 않는다`);
  }
});



test('regionPage.js·briefing.js — og:image/twitter:image 4곳이 esc(ogImg) 로 이스케이프된다', () => {
  const files = ['../routes/regionPage.js', '../routes/briefing.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.equal((src.match(/content="\$\{ogImg\}"/g) || []).length, 0,
      `${rel} 에 이스케이프 없는 content="\${ogImg}" 가 남아 있다`);
    assert.equal((src.match(/content="\$\{esc\(ogImg\)\}"/g) || []).length, 2,
      `${rel} 의 og:image/twitter:image 중 esc(ogImg) 로 이스케이프된 곳이 2곳이 아니다`);
  }
});



test('share.js escapeHtml — s || \'\' 를 s == null 기준으로 통일(모듈이 escapeHtml 을 export 하지 않아 소스 문자열로 확인)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/share.js'), 'utf8');
  // share.js 는 escapeHtml 을 module.exports 로 내보내지 않는다 — 직접 호출 대신 소스로 확인.
  assert.equal(typeof require('../routes/share').escapeHtml, 'undefined',
    '이 테스트는 escapeHtml 미노출을 전제로 소스 문자열을 검사한다 — export 가 생겼으면 escapeHtml(0) 직접 호출로 갱신할 것');
  assert.equal((src.match(/String\(s == null \? '' : s\)/g) || []).length, 1,
    "share.js 의 escapeHtml 첫 줄이 String(s == null ? '' : s) 기준으로 바뀌지 않았다");
  assert.equal((src.match(/String\(s \|\| ''\)/g) || []).length, 0,
    'share.js 에 0·false 를 빈 문자열로 만들던 String(s || \'\') 가 여전히 남아 있다');
  // 함수 이름·문자 클래스·매핑표는 그대로여야 한다(share-ssr.test.js 가 이미 이 배선을 고정한다).
  assert.ok(src.includes('function escapeHtml(s) {'), 'escapeHtml 함수 이름이 바뀌었다 — 이 변경 범위 밖이다');
});



// ESC-UNIFY-2026-09-28 (Plan 124) 출력 불변 확인: aptPage.js·regionPage.js·briefing.js 는
// escHtml 을 직접 호출하는 별도 export 된 렌더 함수가 없다(esc 는 파일 내부 클로저로만 쓰인다).
// 그래서 "옛 esc 소스"(변경 전 세 파일에 있던 정의 그대로 — 이동만 했을 뿐 한 글자도 바꾸지
// 않았다)를 이 테스트 안에 고정해 두고, 같은 입력 20종(특수문자·한글·숫자·빈 값)에서
// escHtml 과 바이트 단위로 동일한 출력을 내는지 직접 비교한다.
test('escHtml 출력이 옛 aptPage/regionPage/briefing 로컬 esc 와 20종 입력에서 바이트 동일', () => {
  const { escHtml } = require('../utils/htmlEscape');
  // 변경 전 aptPage.js:30-34 / regionPage.js:27-31 / briefing.js:19-23 에 있던 정의 그대로(옮기기 전 원문).
  function oldEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const inputs = [
    '', null, undefined, 0, false, true, NaN, -123, 3.14,
    '<script>alert(1)</script>',
    '<a href="x">&\'</a>',
    '한글 테스트',
    '아파트&이름<특수문자>',
    '가격 "10억" 이상',
    'It\'s a "test"',
    '&amp;&lt;&gt;&quot;&#39;',
    '   공백   ',
    'Tab\tNewline\n혼합',
    '반포자이 84㎡ · 25.5억',
    '이모지 🏠 테스트',
  ];
  assert.equal(inputs.length, 20, '입력 표본이 20종이 아니다 — 표본 수 자체가 계획 범위다');
  for (const input of inputs) {
    assert.equal(escHtml(input), oldEsc(input),
      `입력 ${JSON.stringify(input)} 에서 escHtml 출력이 옛 esc 와 달라졌다 — 출력 불변이 깨졌다`);
  }
});
