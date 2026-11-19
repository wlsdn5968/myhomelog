/**
 * SPLIT-1119 (plans/202 4단계 둘째 묶음): 청약 화면의 함수 넷(cpSubs, fmtMoveIn, loadSubs, calcSubsScore)을 frontend/js/subs.js 로 옮겼다.
 *  옮기기만 했다(2026-11-19, 옮긴 98줄이 새 파일에 글자 그대로 있는지 옮기는 스크립트가 대조했다).
 *  fmtSubsDate, dDayLabel 은 브리핑 화면도 써서 본체에 남겼다.
 * 실행: cd backend && TZ=UTC node --test test/split-1119.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const js = readFrontendJs('subs.js');
const MOVED = ['cpSubs', 'fmtMoveIn', 'loadSubs', 'calcSubsScore'];

test('subs.js 는 본체보다 먼저 부르는 일반 스크립트다', () => {
  const tag = '<script src="/js/subs.js"></script>';
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(html.indexOf('<script src="/js/data.js"></script>') < html.indexOf(tag));
  assert.ok(!/<script[^>]*(type=["']module["']|defer|async)[^>]*subs\.js/.test(html));
  assert.ok(html.indexOf(tag) < html.indexOf('function fmtSubsDate('), '본체 스크립트보다 앞');
});

test('옮긴 함수는 subs.js 에 한 번씩만 있고 본체에는 정의가 없다', () => {
  for (const n of MOVED) {
    assert.equal(js.split(new RegExp(`function ${n}\\(`)).length - 1, 1, `${n} 가 subs.js 에 한 번 있어야 한다`);
    assert.ok(!new RegExp(`function ${n}\\(`).test(html), `${n} 정의가 본체에 남아 있다`);
  }
  // 브리핑이 함께 쓰는 두 함수는 본체에 남는다(subs.js 를 못 받아도 브리핑이 그려진다)
  for (const n of ['fmtSubsDate', 'dDayLabel']) {
    assert.ok(new RegExp(`^function ${n}\\(`, 'm').test(html), `${n} 는 본체에 있어야 한다`);
    assert.ok(!new RegExp(`function ${n}\\(`).test(js), `${n} 가 subs.js 에 또 있다`);
  }
});

test('subs.js 는 실행되는 순간 화면 요소나 본체 값을 읽지 않는다', () => {
  // 함수 정의만 있으면 빈 환경에서 실행해도 오류가 없다
  const sandbox = {};
  vm.runInNewContext(js + '\nthis.f={cpSubs,fmtMoveIn,loadSubs,calcSubsScore};', sandbox, { filename: 'subs.js' });
  for (const n of MOVED) assert.equal(typeof sandbox.f[n], 'function', n);
  assert.equal(sandbox.f.fmtMoveIn('202711'), '2027.11');
  assert.equal(sandbox.f.fmtMoveIn(''), '-');
});

test('가점 계산은 옮기기 전과 같게 합을 내고 청약Home 안내를 남긴다', () => {
  const els = { cs_noHome: { value: '16' }, cs_dep: { value: '20' }, cs_bank: { value: '12' }, cs_total: { textContent: '' }, cs_tier: { innerHTML: '' } };
  const sandbox = { document: { getElementById: (id) => els[id] || null }, parseInt };
  vm.runInNewContext(js, sandbox, { filename: 'subs.js' });
  sandbox.calcSubsScore();
  assert.equal(els.cs_total.textContent, 48);
  assert.ok(els.cs_tier.innerHTML.includes('>중하위권<'), '48점은 35점 이상 50점 미만 구간');
  assert.ok(els.cs_tier.innerHTML.includes('applyhome.co.kr'));
});

test('파일을 못 받으면 청약 화면 전환에서 알리고 loadSubs 를 부르지 않는다', () => {
  const guard = "if(v==='subs'&&typeof loadSubs!=='function'){try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');";
  const call = "if(v==='subs' && !document.getElementById('subsList').dataset.loaded){loadSubs();}";
  assert.equal(html.split(guard).length - 1, 1);
  assert.ok(html.indexOf(guard) < html.indexOf(call), '알림 줄이 부르는 줄보다 앞');
  assert.ok(html.slice(html.indexOf(guard), html.indexOf(call)).includes('return;}'), '못 받았으면 그 자리에서 돌아간다');
});
