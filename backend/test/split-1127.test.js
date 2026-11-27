/**
 * SPLIT-1127 (plans/202 4단계 넷째 묶음): 데이터 도우미(채팅) 함수 스물한 개를 frontend/js/chat.js 로 옮겼다.
 *  옮기기만 했다(2026-11-27, 옮긴 427줄이 새 파일에 글자 그대로 있는지 옮기는 스크립트가 대조했다).
 *  실행 순간 도는 줄(let _chatSessionId, 로그인 변화 등록, 이력 창 바깥 클릭)과 _toggleChatHistoryButtons, gt, toast 는 본체에 남겼다.
 * 실행: cd backend && TZ=UTC node --test test/split-1127.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const js = readFrontendJs('chat.js');
const MOVED = ['buildChatContext', 'qSend', 'sM', '_ensureChatSession', '_genUuid', '_persistChatMessage',
  'openChatHistory', 'closeChatHistory', 'filterChatHistory', 'loadChatSession', 'deleteChatSession', 'newChatSession',
  'sQ', 'askP', 'hk', 'ah', '_renderAIBadge', 'addMsg', 'sendAIFeedback', 'showTyp', 'rmTyp'];

test('chat.js 는 briefing.js 바로 뒤, 본체보다 먼저 부르는 일반 스크립트다', () => {
  const tag = '<script src="/js/chat.js"></script>';
  assert.equal(html.split(tag).length - 1, 1);
  assert.ok(html.indexOf('<script src="/js/briefing.js"></script>') < html.indexOf(tag));
  assert.ok(html.indexOf(tag) < html.indexOf('<script src="/js/swap-checklist.js"></script>'));
  assert.ok(!/<script[^>]*(type=["']module["']|defer|async)[^>]*chat\.js/.test(html));
  assert.ok(html.indexOf(tag) < html.indexOf('let chatH=[], chatLd=false;'), '본체 스크립트보다 앞');
});

test('옮긴 함수는 chat.js 에 한 번씩만 있고 본체에는 정의가 없다', () => {
  for (const n of MOVED) {
    assert.equal(js.split(new RegExp(`^(async\\s+)?function ${n}\\(`, 'm')).length > 1, true, `${n} 가 chat.js 에 있어야 한다`);
    assert.equal((js.match(new RegExp(`^(?:async\\s+)?function ${n}\\(`, 'gm')) || []).length, 1, `${n} 는 chat.js 에 한 번`);
    assert.ok(!new RegExp(`^(async\\s+)?function ${n}\\(`, 'm').test(html), `${n} 정의가 본체에 남아 있다`);
  }
});

test('실행 순간 도는 줄과 공용 함수는 본체에 남는다(파일을 못 받아도 본체가 멈추지 않게)', () => {
  assert.ok(html.includes('let _chatSessionId = null;'), '본체의 7752줄 근처 검색 초기화가 이 값을 읽는다');
  assert.ok(html.includes("window.MHL.auth.onChange?.((session) => {"), '로그인 변화 등록');
  assert.ok(/^function _toggleChatHistoryButtons\(/m.test(html));
  assert.ok(/^function gt\(/m.test(html), 'gt 는 첫 화면 시각 표시도 쓴다');
  assert.ok(/^function toast\(/m.test(html));
  assert.ok(!/^let _chatSessionId/m.test(js) && !/^let chatH/m.test(js), 'chat.js 는 최상위 변수를 만들지 않는다');
});

test('chat.js 는 실행되는 순간 화면 요소나 본체 값을 읽지 않는다(빈 환경에서 실행)', () => {
  const sb = {};
  vm.runInNewContext(js + `\nthis.f={${MOVED.join(',')}};`, sb, { filename: 'chat.js' });
  for (const n of MOVED) assert.equal(typeof sb.f[n], 'function', n);
  // 최상위 문장은 함수 선언과 주석뿐이다(블록 주석 없음)
  assert.ok(!js.includes('/*'), '블록 주석이 없다(반만 옮긴 주석이 본체에 남을 일이 없다)');
});

test('파일을 못 받으면 화면 전환과 도우미 열기에서 한 번 알린다', () => {
  const guard = "if(typeof sM!=='function'&&!window._chatMissSent){window._chatMissSent=true;try{toast('화면 일부를 불러오지 못했어요. 새로 고침해 주세요');if(window.Sentry)window.Sentry.captureMessage('chat.js not loaded');}catch(_){}}";
  assert.equal(html.split(guard).length - 1, 2, 'sv 와 toggleRpOverlay 에 한 줄씩');
  const sv = html.indexOf('function sv(');
  const tro = html.indexOf('function toggleRpOverlay(');
  assert.ok(sv > 0 && tro > 0);
  const first = html.indexOf(guard), second = html.indexOf(guard, first + 1);
  assert.ok([first, second].some((p) => p > tro && p < html.indexOf('function _closeAiPanel(')), 'toggleRpOverlay 안');
});

test('옮긴 말풍선은 여전히 글을 먼저 이스케이프한다(XSS)', () => {
  const add = js.slice(js.indexOf('function addMsg('), js.indexOf('async function sendAIFeedback('));
  assert.match(add, /const safe=_escHtml\(text\)/);
  assert.ok(add.indexOf('_escHtml(text)') < add.indexOf('d.innerHTML='));
});
