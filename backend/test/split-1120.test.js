/**
 * SPLIT-1120 (plans/202 4단계 셋째 묶음): 오늘의 브리핑 함수 일곱 개를 frontend/js/briefing.js 로 옮겼다.
 *  loadNews, loadNewsSummary, _renderRecordsCard, _recPickRegion, renderBriefing, openYesterdayBrief, copyBriefLink.
 *  옮기기만 했다(2026-11-20, 옮긴 280줄이 새 파일에 글자 그대로 있는지 옮기는 스크립트가 대조했다).
 *  같은 구역에 섞여 있던 데이터 상태, 오류 신고, 활동 기록, 지도 시트 함수와 최상위 let 은 본체에 남겼다.
 * 실행: cd backend && TZ=UTC node --test test/split-1120.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const js = readFrontendJs('briefing.js');
const MOVED = ['loadNews', 'loadNewsSummary', '_renderRecordsCard', '_recPickRegion', 'renderBriefing', 'openYesterdayBrief', 'copyBriefLink'];

test('briefing.js 는 subs.js 바로 뒤, 본체보다 먼저 부르는 일반 스크립트다', () => {
  const tag = '<script src="/js/briefing.js"></script>';
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(html.indexOf('<script src="/js/subs.js"></script>') < html.indexOf(tag));
  assert.ok(!/<script[^>]*(type=["']module["']|defer|async)[^>]*briefing\.js/.test(html));
  assert.ok(html.indexOf(tag) < html.indexOf('function fmtSubsDate('), '본체 스크립트보다 앞');
});

test('옮긴 함수는 briefing.js 에 한 번씩만 있고 본체에는 정의가 없다', () => {
  for (const n of MOVED) {
    assert.equal(js.split(new RegExp(`function ${n}\\(`)).length - 1, 1, `${n} 가 briefing.js 에 한 번 있어야 한다`);
    assert.ok(!new RegExp(`^(async\\s+)?function ${n}\\(`, 'm').test(html), `${n} 정의가 본체에 남아 있다`);
  }
  // 같은 구역에 있던 다른 기능은 본체에 남는다
  for (const n of ['openDataStatus', 'openErrReport', '_bumpActivity', 'closeMapSheet', 'fmtSubsDate', 'dDayLabel']) {
    assert.ok(new RegExp(`^(async\\s+)?function ${n}\\(`, 'm').test(html), `${n} 는 본체에 있어야 한다`);
  }
  assert.ok(html.includes('// ============ /MSHEET ============'), '지도 시트 구역 끝 표시는 본체에 남는다');
});

test('briefing.js 는 실행되는 순간 화면 요소나 본체 값을 읽지 않는다(빈 환경에서 실행)', () => {
  const sb = {};
  vm.runInNewContext(js + `\nthis.f={${MOVED.join(',')}};`, sb, { filename: 'briefing.js' });
  for (const n of MOVED) assert.equal(typeof sb.f[n], 'function', n);
  // 블록 주석이 반쯤 잘려 본체에 남지 않았다(남으면 본체 스크립트가 통째로 멈춘다)
  // (index.html 3293줄의 같은 꼬리표는 CSS 주석이라 대상이 아니다. 옮긴 자바스크립트 주석의 첫 문장으로 찾는다)
  assert.ok(!html.includes('/* PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최고·최저 경신 카드 렌더.'), '기록 경신 카드 설명 주석은 통째로 옮겨졌다');
  assert.ok(js.includes('/* PRICE-RECORDS-2026-08-29') && js.includes('오독을 막는 유일한 장치다. */'));
});

test('파일을 못 받으면 브리핑 화면 전환에서 알리고 loadNews 와 renderBriefing 을 부르지 않는다', () => {
  const guard = "if(v==='news'&&typeof loadNews!=='function'){try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');";
  const call = "if(v==='news' && !document.getElementById('newsList').dataset.loaded){loadNews();}";
  assert.equal(html.split(guard).length - 1, 1);
  assert.ok(html.indexOf(guard) < html.indexOf(call));
  assert.ok(html.indexOf(call) < html.indexOf("if(v==='news'){ try{ renderBriefing(); }catch(_e){} }"));
  assert.ok(html.slice(html.indexOf(guard), html.indexOf(call)).includes('return;}'));
});

test('인기 단지 실시간 응답은 옮긴 뒤에도 _popRows 를 거친다(저장소 금지 사항)', () => {
  const rb = js.slice(js.indexOf('async function renderBriefing('));
  if (/search\/popular/.test(rb)) assert.ok(/_popRows\(/.test(rb), 'renderBriefing 이 인기 단지 응답을 _popRows 로 거른다');
});
