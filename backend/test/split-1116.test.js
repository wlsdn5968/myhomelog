/**
 * backend/test/split-1116.test.js
 *
 * SPLIT-1116 (plans/202 0단계와 1단계): 거래 체크리스트와 갈아타기 계산을 frontend/js/swap-checklist.js 로 옮겼다.
 * 옮긴 파일이 본체보다 먼저 불리고, 경로와 검사 범위가 그 파일을 덮는지 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs, readFrontend, frontendJsFiles } = require('../testSupport/readFrontend');
const ROOT = path.join(__dirname, '../..');
const html = readIndexHtml();
const js = readFrontendJs('swap-checklist.js');

test('옮긴 스크립트는 본체 스크립트보다 먼저, 일반 스크립트로 불린다', () => {
  const tag = '<script src="/js/swap-checklist.js"></script>';
  const a = html.indexOf(tag);
  const b = html.indexOf('// ── CONFIG & STATE');
  assert.ok(a > 0 && b > a, '태그가 본체 앞에 있다');
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(!/<script[^>]*type=["']module["'][^>]*swap-checklist/.test(html), '모듈로 바꾸면 onclick 이 부르는 전역 이름이 사라진다');
  assert.ok(!/<script[^>]*(defer|async)[^>]*swap-checklist/.test(html), '늦게 불리면 본체가 먼저 실행된다');
});

test('옮긴 함수는 새 파일에만 있고, 본체에는 남아 있지 않다', () => {
  for (const name of ['_dclData', '_dclRender', '_dclOpen', '_swpCalc', '_swpRender', '_swpComm', 'goSwapFromCurrentDetail']) {
    assert.ok(js.includes(`\nfunction ${name}(`), `${name} 가 새 파일에 있다`);
    assert.ok(!html.includes(`\nfunction ${name}(`), `${name} 가 본체에 두 번 있지 않다`);
  }
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'swap-checklist.js' }), '구문 오류가 없다');
  assert.ok(readFrontend().includes('function _swpCalc('), '검사 도우미가 두 파일을 함께 돌려준다');
  assert.deepEqual(frontendJsFiles(), ['briefing.js', 'calc.js', 'data.js', 'policy-data.js', 'policy.js', 'subs.js', 'swap-checklist.js'], '새 파일을 더하면 index.html 의 script 태그와 eslint.config.mjs 의 전역 목록도 같이 본다');
});

test('새 파일은 맨 위에서 본체의 값을 읽지 않는다(본체보다 먼저 실행된다)', () => {
  // 본체 전역을 하나도 주지 않고 실행해도 예외 없이 끝나야 한다. 필요한 것은 브라우저 내장뿐이다.
  const listeners = [];
  const sandbox = {
    window: { matchMedia: () => ({ matches: false, addEventListener: () => {} }), addEventListener: (t) => listeners.push(t) },
    document: { readyState: 'loading', addEventListener: (t) => listeners.push(t), getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    getComputedStyle: () => ({ display: 'none' }),
  };
  assert.doesNotThrow(() => vm.runInNewContext(js, sandbox, { filename: 'swap-checklist.js' }));
  assert.ok(listeners.includes('DOMContentLoaded') && listeners.includes('resize'));
});

test('파일을 못 받았을 때 빈 화면 대신 알린다', () => {
  assert.ok(html.includes("if((v==='deal'||v==='swap')&&typeof _dclOpen!=='function'){try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');"));
});

test('경로, 린트, CI, 보안 검사가 frontend/js 를 덮는다', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const i = v.routes.findIndex((r) => r.src === '/js/([a-z0-9-]+)\\.js');
  const last = v.routes.findIndex((r) => r.src === '/(.*)');
  assert.ok(i > 1 && i < last, '새 경로가 첫 두 경로 뒤, 마지막 404 경로 앞에 있다');
  const r = v.routes[i];
  assert.equal(r.dest, '/frontend/js/$1.js');
  assert.equal(r.headers['Cache-Control'], 'public, max-age=0, must-revalidate', '새 화면이 옛 스크립트와 섞이지 않게 매번 확인한다');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  const re = new RegExp('^' + r.src + '$');
  assert.ok(re.test('/js/swap-checklist.js'));
  assert.ok(!re.test('/js/../index.html') && !re.test('/js/a/b.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.lint.endsWith('.lint-tmp frontend/js'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8').includes("files: ['.lint-tmp/**/*.js', 'frontend/js/**/*.js'],"));
  assert.ok(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').includes('Frontend external JS syntax check (frontend/js)'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts/security-regression-check.js'), 'utf8').includes("if (c.file === 'frontend/index.html') {"));
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts/check-regexp-ratchet.js'), 'utf8').includes("'frontend/js']"));
});
