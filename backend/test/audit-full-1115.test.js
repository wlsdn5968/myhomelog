/**
 * AUDIT-FULL-1115: 전면 감사(AUDIT_REPORT.md, 2026-11-15)에서 운영 화면으로 재현한 것의 회귀 검사.
 *   1번 단지 상세 요청 수와 요청 제한, 2번 검색 순위, 6번과 7번 복비와 특약 입력 범위.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = require('../testSupport/readFrontend').readFrontend(); // SPLIT-1116: index.html 과 frontend/js 를 함께 읽는다
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function body(name) {
  let i = html.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} 가 없다`);
  let depth = 0; let j = html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(i, j + 1);
}

test('검색 순위: 끝의 "아파트"를 떼고 비교해 이름이 같은 단지는 같은 등급이 된다', () => {
  const src = rd('routes/search.js');
  const { stripAptSuffix } = require('../utils/aptNameMatch');
  const m = src.match(/const _rankKey = \(v\) => [^\n]+;/);
  assert.ok(m, '_rankKey 가 없다');
  const key = new Function('stripAptSuffix', `${m[0]} return _rankKey;`)(stripAptSuffix);
  const rank = (q, n) => { const a = key(q); const s = key(n); return s === a ? 0 : (s.startsWith(a) ? 1 : 2); };
  // 운영에서 재현한 경우: 거래 0건 "헬리오시티"(부천)와 거래 213건 "헬리오시티아파트"(송파)가 같은 등급이어야 건수로 갈린다
  assert.equal(rank('헬리오시티', '헬리오시티'), 0);
  assert.equal(rank('헬리오시티', '헬리오시티아파트'), 0);
  assert.equal(rank('헬리오시티아파트', '헬리오시티'), 0);
  assert.equal(rank('잠실 엘스', '잠실엘스아파트'), 0);
  // 기존 규칙은 그대로: 정확 일치가 포함 일치보다 앞
  assert.equal(rank('은마', '은마'), 0);
  assert.equal(rank('은마', '시범다은마을월드반도'), 2);
  assert.equal(rank('래미안', '래미안퍼스티지'), 1);
  // 순위 함수가 이 키를 쓰고, 두 정렬(묶음, 최종)이 같은 함수를 쓴다
  assert.match(src, /const _qn = _rankKey\(q\);/);
  assert.match(src, /const s = _rankKey\(n\);/);
  assert.match(src, /const _rank = \(g\) => Math\.min\(_qRank\(g\.baseName\)/);
  assert.match(src, /const _rankOut = \(o\) => Math\.min\(_qRank\(o\.aptName\)/);
});

test('단지 상세: 좌표 변환은 같은 단지에 한 번만 부르고, 실패는 기억하지 않는다', async () => {
  const calls = [];
  let answer = { lat: 37.5, lng: 127.0 };
  const fakeFetch = (url, opt) => { calls.push(JSON.parse(opt.body)); return Promise.resolve({ json: () => Promise.resolve(answer) }); };
  const consts = html.match(/const _geoMemo = new Map\(\);/);
  assert.ok(consts);
  const fn = new Function('fetch', 'CFG', 'AbortSignal', `${consts[0]} ${body('_geocodeOnce')} return _geocodeOnce;`)(fakeFetch, { api: '/api' }, { timeout: () => undefined });
  const a = await fn({ aptName: '은마', area: '강남구 대치동', sigungu: '강남구', umdNm: '대치동' });
  const b = await fn({ aptName: '은마', area: '다른 문자열', sigungu: '강남구', umdNm: '대치동' }); // 검색 경로와 상세 경로는 area 글자가 다르다
  assert.equal(calls.length, 1, '같은 단지에 좌표 변환을 두 번 불렀다');
  assert.deepEqual(a, b);
  await fn({ aptName: '은마', area: '', sigungu: '북구', umdNm: '' });
  assert.equal(calls.length, 2, '다른 구의 같은 이름 단지를 같은 것으로 봤다');
  // 실패(좌표 없음, 요청 제한 응답)는 기억하지 않아 다음에 다시 묻는다
  answer = { error: '요청이 많아요' };
  await fn({ aptName: '없는단지', sigungu: '강남구', umdNm: '대치동' });
  await fn({ aptName: '없는단지', sigungu: '강남구', umdNm: '대치동' });
  assert.equal(calls.length, 4);
  // 두 호출처가 모두 이 함수를 쓴다
  assert.equal(html.split('_geocodeOnce({').length - 1, 2);
  assert.equal(html.split('fetch(`${CFG.api}/geocode`').length - 1, 1, '좌표 변환을 직접 부르는 곳이 남았다');
});

test('단지 상세: 주변 시설은 상자가 화면에 들어올 때 부르고, 다른 단지를 열었으면 부르지 않는다', () => {
  assert.match(html, /loadAnalysis\(p\);_lazyAmenities\(p\);loadFacility\(p\);/);
  const lz = body('_lazyAmenities');
  assert.match(lz, /if \(!box \|\| !window\.IntersectionObserver\) \{ loadAmenities\(p\); return; \}/, '관찰 기능이 없는 브라우저에서는 바로 불러야 한다');
  assert.match(lz, /io\.disconnect\(\);/);
  assert.match(lz, /if \(!currentDetail \|\| currentDetail\.aptName === p\.aptName\) loadAmenities\(p\);/);
  assert.match(lz, /if \(window\._amenIO\) window\._amenIO\.disconnect\(\);/, '앞 단지의 관찰을 끊지 않는다');
});

test('요청 제한 안내: 429 는 한 번 안내하고, 하루 한도 초과는 건드리지 않는다', () => {
  const toasts = [];
  const fn = new Function('toast', 'Date', `let _last429 = 0; ${body('_notify429')} return _notify429;`);
  let now = 1000000;
  const notify = fn((t) => toasts.push(t), { now: () => now });
  notify('/api/analysis?aptName=x');
  notify('/api/properties/nearby?lat=1');
  assert.equal(toasts.length, 1, '15초 안에 두 번 안내했다');
  now += 16000;
  notify('https://myhomelog.vercel.app/api/search/facility?x=1');
  assert.equal(toasts.length, 2);
  now += 16000;
  notify('/api/chat');       // 도우미와 보고서는 각자 안내가 있다
  notify('/api/report/generate');
  notify('/api/feedback/data-error');
  assert.equal(toasts.length, 2);
  assert.doesNotMatch(toasts[0], /[—–·]/);
  assert.ok(html.includes("if (!j || j.error !== 'DAILY_LIMIT_EXCEEDED') _notify429(url);"));
});

test('요청 제한 묶음: 내 데이터 경로는 조회 경로와 다른 묶음을 쓰고 Redis 호출 수는 그대로다', () => {
  const s = rd('server.js');
  const def = s.match(/const meLimiter = makeRateLimiter\(\{[^}]+\}\);/);
  assert.ok(def, 'meLimiter 정의가 없다');
  assert.match(def[0], /scope: 'data'/, 'scope 가 바뀌면 Redis 장애 시 동작과 호출 수 집계가 달라진다');
  assert.match(def[0], /keySuffix: ':me'/);
  assert.match(def[0], /limit: 30/);
  for (const p of ['account', 'account/automated-decision', 'field-notes', 'bookmarks', 'chat/sessions', 'push', 'kakao']) {
    assert.ok(new RegExp(`app\\.use\\('/api/${p}', meLimiter,`).test(s), `/api/${p} 가 내 데이터 묶음이 아니다`);
  }
  for (const p of ['transactions', 'search', 'analysis', 'region', 'subscription', 'visits']) {
    assert.ok(new RegExp(`app\\.use\\('/api/${p}', (optionalAuth, )?dataLimiter`).test(s), `/api/${p} 가 조회 묶음이 아니다`);
  }
  // 한 경로에 두 묶음을 함께 걸지 않는다
  assert.doesNotMatch(s, /dataLimiter, meLimiter|meLimiter, dataLimiter/);
});

test('복비와 특약: 범위를 벗어난 입력은 계산 전에 걸러진다', () => {
  const biz = new Function(`${body('bizInputProblem')} return bizInputProblem;`)();
  assert.equal(biz(6), '');
  assert.equal(biz(0), '');
  assert.equal(biz(1000), '');
  assert.match(biz(-3), /0보다 작은/);          // 운영에서 "-270만원" 이 나왔던 입력
  assert.match(biz(999999), /1,000억 이하/);
  const cl = new Function('Date', `${body('clauseInputProblem')} return clauseInputProblem;`)(Date);
  const ok = { aptName: '래미안 대치팰리스', price: 10.5, excluUseAr: 84.9, buildYear: 2010 };
  assert.equal(cl(ok), '');
  assert.equal(cl({ ...ok, price: 0, excluUseAr: 0, buildYear: 0 }), '', '빈 칸(0)은 문제로 보지 않는다');
  assert.match(cl({ ...ok, price: -5 }), /0보다 작은/);
  assert.match(cl({ ...ok, excluUseAr: -1 }), /0보다 작은/);
  assert.match(cl({ ...ok, buildYear: 99999 }), /준공연도/);
  assert.match(cl({ ...ok, buildYear: 1800 }), /준공연도/);
  assert.match(cl({ ...ok, aptName: '가'.repeat(61) }), /60자 이하/);
  assert.match(cl({ ...ok, price: 5000 }), /1,000억 이하/);
  // 호출처: 계산과 생성보다 먼저 확인한다
  const cc = body('calcComm');
  assert.ok(cc.indexOf('bizInputProblem(price)') > 0 && cc.indexOf('bizInputProblem(price)') < cc.indexOf('priceW'));
  const gc = html.slice(html.indexOf('async function genClause('), html.indexOf('async function genClause(') + 1400);
  assert.ok(gc.indexOf('clauseInputProblem(body)') > 0);
  assert.match(html, /<div id="biz_err" role="alert"/);
  assert.match(html, /id="cl_apt" maxlength="60"/);
});

test('요청 제한 안내: fetch 감싸기가 인자와 응답을 그대로 넘기고 429 일 때만 안내한다', async () => {
  const i = html.indexOf('if (window._fetch429Hooked || typeof window.fetch !== ');
  assert.ok(i > 0, 'fetch 감싸기가 없다');
  const start = html.lastIndexOf('(function(){', i);
  const end = html.indexOf('})();', i) + '})();'.length;
  const block = html.slice(start, end);
  const seen = []; const notified = [];
  const mk = (status, bodyObj) => ({ status, clone() { return { json: () => Promise.resolve(bodyObj) }; }, marker: status });
  let next = mk(200, {});
  const win = { fetch(...args) { seen.push({ self: this === win, args }); return Promise.resolve(next); } };
  new Function('window', '_notify429', block)(win, (u) => notified.push(String(u)));
  assert.equal(win._fetch429Hooked, true);
  const opt = { method: 'POST' };
  const r1 = await win.fetch('/api/analysis?x=1', opt);
  assert.equal(r1.marker, 200, '응답을 그대로 돌려주지 않는다');
  assert.equal(seen[0].self, true, 'this 를 넘기지 않는다');
  assert.deepEqual(seen[0].args, ['/api/analysis?x=1', opt], '인자를 그대로 넘기지 않는다');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(notified.length, 0, '정상 응답에 안내했다');
  next = mk(429, { error: '데이터 조회 한도를 넘었어요' });
  await win.fetch({ url: 'https://x.test/api/search/facility?a=1' });   // Request 모양
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(notified, ['https://x.test/api/search/facility?a=1']);
  next = mk(429, { error: 'DAILY_LIMIT_EXCEEDED' });
  await win.fetch('/api/properties/recommend');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(notified.length, 1, '하루 한도 초과에 안내했다');
  // 두 번 감싸지 않는다
  const wrapped = win.fetch;
  new Function('window', '_notify429', block)(win, () => {});
  assert.equal(win.fetch, wrapped);
});

test('요청 제한 묶음: 내 데이터 묶음으로 건 경로도 공용 제한 건너뛰기 목록과 맞는다', () => {
  const s = rd('server.js');
  const re = s.match(/const GENERAL_SKIP_RE = (\/.+\/);/);
  assert.ok(re, 'GENERAL_SKIP_RE 를 못 찾았다');
  const skip = new Function(`return ${re[1]}`)();
  for (const m of s.matchAll(/app\.use\('\/api\/([a-z-]+)[^']*',[^\n]*\bmeLimiter\b/g)) {
    if (m[1] === 'kakao') continue; // 연결 해제 웹훅이 앞에 있어 공용 제한을 그대로 탄다(기존과 같음)
    assert.ok(skip.test('/' + m[1]), `/api/${m[1]} 는 meLimiter 가 있는데 건너뛰기 목록에 없어 Redis 를 두 번 쓴다`);
  }
});

test('검색창: 2글자 미만이거나 한글 조합 중이면 요청을 보내지 않는다', () => {
  const skip = new Function(`${body('_searchSkipQuery')} return _searchSkipQuery;`)();
  for (const q of ['', '은', 'ㅈ', '잠ㅅ', '잠실ㅇ', 'ㅏ', '헬리오ㅅ']) assert.equal(skip(q), true, `${q} 에 요청을 보낸다`);
  for (const q of ['은마', '잠실', '잠실엘스', '공덕동', 'e편한세상', 'SK뷰', '래미안 대치']) assert.equal(skip(q), false, `${q} 를 막는다`);
  const fn = html.slice(html.indexOf('async function onHeaderSearchInput('), html.indexOf('async function onHeaderSearchInput(') + 3000);
  assert.ok(fn.indexOf('_searchSkipQuery(q)') > 0 && fn.indexOf('_searchSkipQuery(q)') < fn.indexOf('fetch('), '요청보다 뒤에서 확인한다');
  // 서버도 2글자 미만은 빈 결과를 돌려준다(화면 규칙과 같은 기준)
  assert.match(rd('routes/search.js'), /if \(q\.length < 2\) return res\.json\(\{ results: \[\] \}\);/);
});

test('작은 항목: 상단 띠는 테마 변수로 칠하고, 한도 창과 갈아타기 버튼이 안내를 준다', () => {
  assert.ok(html.includes("syncBanner.style.background = 'var(--ambL)';"));
  assert.ok(!html.includes("syncBanner.style.background = '#FFF6E3';"));
  // 한도 창과 한도 안내에는 '플랜'이라는 말을 쓰지 않는다(계정 메뉴의 '무료 플랜 · 로그인됨' 표시는 승인된 시안이라 그대로)
  assert.ok(html.includes("tit.textContent = '오늘 사용량';"));
  assert.ok(!html.includes('무료 플랜 사용량') && !html.includes('무료 플랜 한도'));
  assert.ok(html.includes('id="qmLoginHint"'));
  assert.match(body('_swpFillAvg'), /toast\('먼저 단지를 골라 주세요/);
  // 미리보기에서 확인: disabled 버튼은 눌러도 함수가 불리지 않아 안내가 뜨지 않았다. aria-disabled 로 흐리게만 한다.
  assert.ok(html.includes("fb.setAttribute('aria-disabled'"));
  assert.ok(!html.includes('fb.disabled='));
});
