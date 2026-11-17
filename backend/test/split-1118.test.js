/**
 * SPLIT-1118 (plans/202 4단계 첫 묶음): 함수 안에서만 읽는 자료 상수 세 개를 frontend/js/data.js 로 옮겼다.
 *  옮기기만 했다(2026-11-18, 옮기기 전 본체의 값과 JSON 으로 견줘 같았고 빠진 53줄이 새 파일에 글자 그대로 있었다).
 *  여기서는 나눈 구조가 깨지지 않는지와, 본체에 남겨야 하는 값이 남아 있는지를 본다.
 * 실행: cd backend && TZ=UTC node --test test/split-1118.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const js = readFrontendJs('data.js');
const NAMES = ['POLICY_TIMELINE', 'PERSONAS', 'FN_CHECKS'];

test('data.js 는 본체보다 먼저 부르는 일반 스크립트다', () => {
  const tag = '<script src="/js/data.js"></script>';
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(html.indexOf('<script src="/js/calc.js"></script>') < html.indexOf(tag), 'calc.js 가 맨 앞이다');
  assert.ok(!/<script[^>]*(type=["']module["']|defer|async)[^>]*data\.js/.test(html));
  // 본체 스크립트(옮긴 상수를 쓰는 줄)보다 앞에 있어야 한다
  assert.ok(html.indexOf(tag) < html.indexOf('POLICY_TIMELINE.forEach('));
});

test('옮긴 상수는 data.js 에 한 번씩만 정의되고 본체에는 정의가 없다', () => {
  for (const n of NAMES) {
    assert.equal(js.split(new RegExp(`^const ${n}\\b`, 'm')).length - 1, 1, `${n} 가 data.js 에 한 번 있어야 한다`);
    assert.ok(!new RegExp(`^(const|let|var) ${n}\\b`, 'm').test(html), `${n} 정의가 본체에 남아 있다(같은 이름을 두 번 선언하면 본체 스크립트가 통째로 멈춘다)`);
  }
});

test('data.js 는 본체 없이 실행되고, 화면 요소나 본체 함수를 읽지 않는다', () => {
  assert.ok(!/document\.|getElementById|querySelector|function /.test(js), '자료만 둔다');
  const sandbox = {};
  vm.runInNewContext(js + '\nthis.T=POLICY_TIMELINE;this.P=PERSONAS;this.F=FN_CHECKS;', sandbox, { filename: 'data.js' });
  assert.equal(sandbox.T.length, 8);
  for (const p of sandbox.T) {
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.title && p.desc && p.tag, p.date);
  }
  assert.equal(JSON.stringify(sandbox.T.map((p) => p.date)), JSON.stringify(sandbox.T.map((p) => p.date).slice().sort()), '날짜순');
  assert.equal(Object.keys(sandbox.P).join(','), 'first,newlywed,newborn,upgrade,school,senior');
  // PERSONA-NW-2026-10-30: 신혼부부 예시는 신혼 디딤돌 기준(소득 8.5천만 이하, 집값 6억 이하) 안의 값
  assert.ok(sandbox.P.newlywed.bp <= 6 && sandbox.P.newlywed.inc <= 8500);
  assert.equal(sandbox.F.map((c) => c.id).join(','), 'light,noise,park,elev,mgmt,store,school,trans');
});

test('본체는 옮긴 상수를 함수 안에서만 읽는다', () => {
  // 본체가 실행되는 순간(함수 밖) 읽으면 파일을 못 받았을 때 화면 전체가 멈춘다
  for (const n of NAMES) {
    const uses = html.split(/\r?\n/).filter((l) => new RegExp(`\\b${n}\\b`).test(l) && !/^\s*\/\//.test(l) && !l.includes('_dataMissSent'));
    assert.ok(uses.length >= 1, `${n} 를 쓰는 줄이 없다`);
    for (const l of uses) assert.match(l, /^\s+\S/, `${n} 를 함수 밖에서 읽는다: ${l.trim().slice(0, 80)}`);
  }
});

test('파일을 못 받아도 살아 있어야 하는 값은 본체에 그대로 있다', () => {
  assert.ok(/^const REGION_SUB_FALLBACK = \{/m.test(html), '본체가 실행되는 순간 읽는 값');
  assert.ok(/^const SEOUL_GU_KW = \[/m.test(html), '규제지역 판정의 안전판');
  assert.ok(!js.includes('const REGION_SUB_FALLBACK') && !js.includes('const SEOUL_GU_KW'));
});

test('파일을 못 받았을 때 한 번 알린다', () => {
  assert.ok(html.includes("if(typeof PERSONAS==='undefined'&&!window._dataMissSent){window._dataMissSent=true;try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');"));
});
