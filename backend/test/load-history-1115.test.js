/**
 * backend/test/load-history-1115.test.js
 *
 * 2026-11-15 인계 문서 6절의 남은 일 가운데 두 가지.
 *   REGION-DEADLINE  구별 순위 즉석 계산에 시간 상한(20초)과 실패 뒤 쉬는 시간(5분)
 *   VIEW-HISTORY     화면 전환을 방문 기록과 주소(?view=)에 남겨 뒤로 가기가 앞 화면으로 돌아옴(전면 감사 3번)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');

// ── REGION-DEADLINE ──────────────────────────────────────────────
function _loadRegionPopular(delayMs, lawdCount, pageRows = 0) {
  const paths = ['../db/client', '../services/transactionService', '../services/priceRecordsService', '../services/snapshotStore', '../services/regionPopularService']
    .map((p) => require.resolve(p));
  const saved = paths.map((p) => require.cache[p]);
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  let queries = 0;
  const builder = () => {
    const b = {};
    for (const m of ['select', 'eq', 'gte', 'order', 'range', 'in']) b[m] = () => b;
    b.then = (ok, bad) => { queries += 1; return new Promise((r) => setTimeout(() => r({ data: Array.from({ length: pageRows }, (_, k) => ({ apt_name: '가' + (k % 3), umd_nm: '동', deal_date: '2026-11-01', deal_amount: 1 })), error: null }), delayMs)).then(ok, bad); };
    return b;
  };
  const codes = {};
  for (let i = 0; i < lawdCount; i++) codes[`구${i}`] = String(11000 + i * 10);
  stub(paths[0], { getSupabaseAdmin: () => ({ from: builder }) });
  stub(paths[1], { LAWD_CODES: codes, RETIRED_LAWD_CODES: new Set(), getAliasCanonicalMap: async () => new Map(), aliasCanon: () => null });
  stub(paths[2], { regionLabel: (c) => `지역 ${c}` });
  stub(paths[3], { getSnapshot: async () => null, putSnapshot: async () => {} });
  delete require.cache[paths[4]];
  const rp = require('../services/regionPopularService');
  return {
    rp, queries: () => queries,
    restore() { paths.forEach((p, i) => { if (saved[i]) require.cache[p] = saved[i]; else delete require.cache[p]; }); },
  };
}

test('구별 순위 즉석 계산: 시간 상한을 주면 남은 시군구를 시작하지 않고 끝난 것만 돌려준다', async () => {
  const { rp, queries, restore } = _loadRegionPopular(40, 12);
  try {
    const t0 = Date.now();
    const p = await rp.computeSido('11', { concurrency: 2, deadlineMs: 60 });
    const took = Date.now() - t0;
    assert.ok(p.groups.length >= 2 && p.groups.length < 12, `일부만 끝나야 한다(끝난 수 ${p.groups.length})`);
    assert.equal(p.timedOut, 12 - p.groups.length - p.failed, '못 한 시군구 수를 알려 준다');
    assert.equal(queries(), p.groups.length, '시작하지 않은 시군구는 조회도 보내지 않는다');
    assert.ok(took < 400, `상한을 크게 넘기지 않는다(${took}ms)`);
  } finally { restore(); }
});

test('구별 순위 즉석 계산: 이미 시작한 시군구도 쪽을 넘기다 시간 상한을 넘으면 멈추고, 실패가 아니라 못 한 곳으로 센다', async () => {
  // 쪽마다 1,000행이 꽉 차 20쪽까지 읽게 되는 가짜 DB(쪽당 30ms). 상한이 없으면 한 곳에 600ms 가 걸린다.
  const { rp, queries, restore } = _loadRegionPopular(30, 2, 1000);
  try {
    const t0 = Date.now();
    const p = await rp.computeSido('11', { concurrency: 2, deadlineMs: 50 });
    const took = Date.now() - t0;
    assert.equal(p.groups.length, 0);
    assert.equal(p.failed, 0);
    assert.equal(p.timedOut, 2);
    assert.ok(queries() <= 8, '20쪽씩 읽지 않는다(조회 ' + queries() + '번)');
    assert.ok(took < 350, '한 곳을 끝까지 읽는 600ms 보다 훨씬 일찍 끝난다(' + took + 'ms)');
  } finally { restore(); }
});

test('구별 순위 계산: 시간 상한을 주지 않으면(예약 작업) 전부 계산하고 timedOut 이 없다', async () => {
  const { rp, restore } = _loadRegionPopular(1, 12);
  try {
    const p = await rp.computeSido('11', { concurrency: 6 });
    assert.equal(p.groups.length, 12);
    assert.equal('timedOut' in p, false);
  } finally { restore(); }
});

test('구별 순위 경로: 즉석 계산은 20초 상한, 실패나 빈 결과 뒤 5분은 다시 계산하지 않고, 덜 끝난 결과는 스냅샷으로 남기지 않는다', () => {
  const s = read('../routes/search.js');
  const src = s.slice(s.indexOf("router.get('/popular-region'"), s.indexOf("router.get('/popular',"));
  assert.match(s, /const REGION_POP_DEADLINE_MS = 20000;/);
  assert.match(s, /const REGION_POP_COOLDOWN_MS = 5 \* 60 \* 1000;/);
  assert.match(src, /if \(Date\.now\(\) - \(_regionPopFailAt\.get\(sido\) \|\| 0\) < REGION_POP_COOLDOWN_MS\) \{\r?\n\s*res\.set\('Cache-Control', 'no-store'\); return res\.json\(\{ sido, groups: \[\] \}\);/, '쉬는 시간 안이면 계산 없이 빈 응답');
  assert.match(html, /if\(j && Array\.isArray\(j\.groups\) && j\.groups\.length && !j\.timedOut\) st\.data\[sido\] = j;/, '화면은 덜 끝난 응답을 기억하지 않는다');
  const iCool = src.indexOf('_regionPopFailAt.get(sido)');
  const iCompute = src.indexOf('rp.computeSido(sido, { deadlineMs: REGION_POP_DEADLINE_MS })');
  assert.ok(iCool > 0 && iCompute > iCool, '쉬는 시간 확인이 계산보다 먼저다');
  assert.ok(src.indexOf('rp.readSido(sido)') < iCool, '스냅샷이 있으면 쉬는 시간과 상관없이 스냅샷을 준다');
  assert.match(src, /if \(!r\.timedOut && r\.groups\.length >= Math\.ceil\(rp\.lawdsOfSido\(sido\)\.length \/ 2\)\)/);
  assert.equal((src.match(/_regionPopFailAt\.set\(sido, Date\.now\(\)\)/g) || []).length, 2, '빈 결과와 예외 두 곳에서 기록');
  assert.match(src, /cache\.set\(ck, p, p\.timedOut \? 300 : 1800\);/);
});

// ── VIEW-HISTORY ─────────────────────────────────────────────────
function _historyEnv(visibleView, href) {
  const a = html.indexOf('let _svCur=null,_svPop=false,_svUser=false;');
  const b = html.indexOf('// IA-2026-07-12 (Sprint QQQQ)', a);
  assert.ok(a > 0 && b > a, '화면 기록 코드를 찾지 못했다');
  const listeners = {};
  const env = {
    pushed: [], replaced: [], svCalls: [],
    location: { href },
    window: { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } },
    VIEW_DISPLAY: { map: {}, calc: {}, report: {}, news: {}, landing: {} },
    document: { getElementById: (id) => ({ id }) },
    getComputedStyle: (e) => ({ display: e.id === 'view-' + visibleView ? 'flex' : 'none' }),
    fire: (t, ev) => (listeners[t] || []).forEach((f) => f(ev || {})),
  };
  env.history = {
    state: null,
    pushState(st, _t, url) { env.pushed.push({ st, url }); this.state = st; if (url) env.location.href = 'https://x.test' + url; },
    replaceState(st, _t, url) { env.replaced.push({ st, url }); this.state = st; },
  };
  const api = new Function('env', `with(env){ ${html.slice(a, b)}
    function sv(v){ svCalls.push(v); _svSeed(); _svHist(v); }
    return { sv, cur: () => _svCur }; }`)(env);
  return Object.assign(env, api);
}

test('화면 기록: 코드가 스스로 부른 첫 전환은 기록을 쌓지 않고 주소도 건드리지 않는다(바로가기 주소 보존)', () => {
  const e = _historyEnv('map', 'https://x.test/?view=report');
  e.sv('report');
  assert.equal(e.pushed.length, 0);
  assert.deepEqual(e.replaced.map((r) => r.url), [undefined, undefined], '주소 인자 없이 표시만');
  assert.deepEqual(e.replaced[0].st, { mhlView: 'map' }, '전환 직전에 보이던 화면을 먼저 표시');
  assert.deepEqual(e.history.state, { mhlView: 'report' });
  assert.equal(e.location.href, 'https://x.test/?view=report');
});

test('화면 기록: 사람이 누른 뒤의 전환은 기록을 하나 쌓고 주소에 ?view= 를 맞춘다. 지도는 기본이라 뺀다. 같은 화면은 쌓지 않는다', () => {
  const e = _historyEnv('map', 'https://x.test/?region=%EC%84%9C%EC%9A%B8');
  e.fire('pointerdown');
  e.sv('calc');
  assert.equal(e.pushed.length, 1);
  assert.equal(e.pushed[0].url, '/?region=%EC%84%9C%EC%9A%B8&view=calc', '다른 주소 값은 그대로');
  assert.deepEqual(e.pushed[0].st, { mhlView: 'calc' });
  e.sv('calc');
  assert.equal(e.pushed.length, 1);
  e.sv('map');
  assert.equal(e.pushed[1].url, '/?region=%EC%84%9C%EC%9A%B8');
});

test('화면 기록: 뒤로 가기는 기록에 표시된 화면을 다시 열고 새 기록을 쌓지 않는다. 표시가 없거나 모르는 화면이면 아무것도 하지 않는다', () => {
  const e = _historyEnv('map', 'https://x.test/');
  e.fire('keydown');
  e.sv('news');
  e.fire('popstate', { state: { mhlView: 'map' } });
  assert.deepEqual(e.svCalls, ['news', 'map']);
  assert.equal(e.cur(), 'map');
  assert.equal(e.pushed.length, 1, '뒤로 가기로 연 화면은 쌓지 않는다');
  e.fire('popstate', { state: null });
  e.fire('popstate', { state: { mhlView: '없는화면' } });
  e.fire('popstate', { state: { mhlView: 'map' } });
  assert.deepEqual(e.svCalls, ['news', 'map'], '표시 없음, 모르는 화면, 이미 보이는 화면은 무시');
});

test('화면 기록: sv 가 표시 함수를 부르고, 다른 주소 갱신은 기록의 화면 표시를 지우지 않는다', () => {
  const src = html.slice(html.indexOf('function sv(v,btn){'), html.indexOf('let _svCur=null'));
  assert.match(src, /^function sv\(v,btn\)\{\r?\n\s*try\{ _svSeed\(\); \}catch\(_\)\{\}/);
  const iToggle = src.indexOf("if(el)el.style.display=id===v?meta.display:'none';");
  const iHist = src.indexOf('try{ _svHist(v); }catch(_){}');
  assert.ok(iToggle > 0 && iHist > iToggle && iHist - iToggle < 80, '화면을 바꾼 바로 뒤에 기록한다(뒤의 그리기 함수가 예외를 내도 어긋나지 않게)');
  assert.ok(src.indexOf('cDM()') < iHist, '상세를 닫아 주소의 apt 를 지운 뒤에 기록한다');
  assert.equal((src.match(/_svHist\(v\)/g) || []).length, 1);
  assert.equal((html.match(/replaceState\(null/g) || []).length, 0, 'replaceState(null, ...) 은 화면 표시를 지운다');
  assert.equal((html.match(/replaceState\(history\.state/g) || []).length, 5);
});

test('화면 기록: 새로고침으로 옛 표시가 남아 있어도 지금 보이는 화면으로 다시 적는다', () => {
  const e = _historyEnv('map', 'https://x.test/');
  e.history.state = { mhlView: 'landing', other: 1 };
  e.fire('pointerdown');
  e.sv('calc');
  assert.deepEqual(e.replaced[0].st, { mhlView: 'map', other: 1 }, '옛 표시 landing 을 map 으로 고치고 다른 값은 둔다');
  assert.equal(e.pushed.length, 1);
});

// ── FALLBACK-MARKERS ─────────────────────────────────────────────
test('대체 지도: 네이버 지도 인증이 실패하면 인기 마커 표시를 풀고 다시 그린다', () => {
  const a = html.indexOf('window.navermap_authFailure = function(){');
  const src = html.slice(a, html.indexOf('const sc = document.createElement', a));
  assert.ok(a > 0);
  const iClear = src.indexOf("el.innerHTML = ''");
  const iReset = src.indexOf('mapObj = null; window._popMarkers = []; _popularMarkersLoaded = false;');
  const iLoad = src.indexOf('loadLeaflet();');
  assert.ok(iClear > 0 && iReset > iClear && iLoad > iReset, '지도를 비운 뒤 표시를 풀고, 그다음 대체 지도를 부른다');
  assert.match(src, /window\._popMarkersRetry = 0; window\._declutterHooked = false;/);
  assert.match(src, /setTimeout\(\(\) => \{ try \{ loadPopularMarkers\(\); \} catch \(_\) \{\} \}, 0\);/);
  // loadPopularMarkers 는 지도가 아직 없으면 0.1초 간격으로 다시 시도한다(이 동작에 기대고 있다)
  assert.match(html, /if \(window\._popMarkersRetry < 50\) \{\r?\n\s*window\._popMarkersRetry\+\+;\r?\n\s*setTimeout\(loadPopularMarkers, 100\);/);
});
