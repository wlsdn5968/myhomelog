/**
 * backend/test/home-seoul-1115.test.js
 *
 * 2026-11-15 운영 크롬 시나리오 점검에서 나온 것(운영자 "지도 첫 화면이 서울 권역이면 좋겠어", "무슨 의미인지 알 수 있으면 좋겠어").
 *   HOME-SEOUL          처음 뜨는 지역은 서울 구별 보기. 지난번에 보던 지도 위치는 덮어쓰지 않음
 *   GU-LABEL            구 이름표는 구역 한가운데, 먼저 구 이름만으로 모두 놓고 자리가 남는 곳만 단지 이름까지
 *   MAP-NOTE            지역 보기 동안 지도 위 안내
 *   SEARCH-DROP-CLOSE   고른 뒤 포커스가 돌아와도 목록을 다시 띄우지 않고, 바깥을 누르거나 Esc 로 닫힘
 *   WP-CLEAR            직장 위치 때문에 좁혀진 결과에서 단추 하나로 비우고 다시 찾기
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

// 함수 본문을 중괄호 짝으로 잘라 온다
function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error(`${name} 의 끝을 찾지 못했다`);
}

test('첫 화면: 처음 뜨는 지역은 서울이고, 구별 자료가 없으면 부르고 있으면 바로 그린다', () => {
  assert.match(html, /let _hpData = null, _hpReq = null, _hpSido = '서울', _hpDataAt = 0, _hpAuto = true;/);
  const calls = [];
  const env = { _HP_REG_SIDO: { 서울: '11' }, _hpSido: '서울', _hpRegData: {}, _hpRegReq: {}, _hpRegLoad: (c) => calls.push('load:' + c), _hpRegShow: () => calls.push('show') };
  const run = new Function('env', `with(env){ ${fnSrc('_hpRegEnsure')}; return _hpRegEnsure; }`)(env);
  run(); assert.deepEqual(calls, ['load:11'], '자료가 없으면 부른다');
  env._hpRegReq['11'] = {}; run(); assert.deepEqual(calls, ['load:11', 'show'], '받는 중이면 다시 부르지 않는다');
  env._hpRegReq['11'] = null; env._hpRegData['11'] = { groups: [] }; run(); assert.equal(calls[2], 'show');
  env._hpSido = '전국'; run(); assert.equal(calls.length, 3, '지역 보기가 아니면 아무것도 하지 않는다');
  // 패널 그리기와 지도 마커 그리기 두 곳이 이 함수를 거친다
  assert.match(fnSrc('_hpRender'), /if\(_HP_REG_SIDO\[_hpSido\]\) \{[\s\S]{0,200}_hpRegEnsure\(\);\s*return;/);
  assert.match(html, /try \{ if \(_HP_REG_SIDO\[_hpSido\]\) \{ _hpRegEnsure\(\); return; \} \} catch\(_\) \{\}/);
});

test('첫 화면: 사람이 지역을 고르기 전이고 지난번 위치가 저장돼 있으면 지도를 옮기지 않는다. 고르면 그때부터 옮긴다', () => {
  const src = fnSrc('_hpRegMarkers');
  assert.match(src, /let _keep = false; try\{ _keep = _hpAuto && !!_mapStartView\(\)\.saved; \}catch\(_\)\{\}/);
  assert.match(src, /if\(!_keep\)\{ window\._regFitBB = bb; window\._regFitAt = Date\.now\(\); _hpRegFit\(bb\); \}/);
  assert.match(fnSrc('_hpPick'), /^function _hpPick\(s\)\{\r?\n\s*_hpAuto = false;/);
  assert.match(fnSrc('_hpRegPick'), /^function _hpRegPick\(code\)\{\r?\n\s*_hpAuto = false;/);
});

test('첫 화면: 지도가 숨겨져 크기가 0 일 때는 범위 맞춤을 미루고, 지도가 보일 때 한다', () => {
  const calls = [];
  const env = {
    window: {}, rect: { width: 0, height: 0 },
    document: { getElementById: () => ({ getBoundingClientRect: () => env.rect }) },
    mapObj: { fitBounds: (b) => calls.push(b) }, L: { latLngBounds: (b) => b },
  };
  env.window.L = env.L;
  const fit = new Function('env', `with(env){ ${fnSrc('_hpRegFit')}; return _hpRegFit; }`)(env);
  const bb = [[37.4, 126.7], [37.7, 127.2]];
  fit(bb);
  assert.equal(calls.length, 0); assert.equal(env.window._regFitPending, bb);
  env.rect = { width: 1020, height: 512 };
  fit(bb);
  assert.equal(calls.length, 1); assert.equal(env.window._regFitPending, null);
  assert.match(fnSrc('sv'), /if \(window\._regFitPending\) setTimeout\(\(\) => \{ try \{ _hpRegFit\(window\._regFitPending\); scheduleDeclutter\(\); \} catch\(_\) \{\} \}, 80\);/);
});

test('구 이름표: 놓는 자리는 구역 가장 큰 조각의 무게중심이고, 경계가 없으면 null', () => {
  const sq = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
  const env = { _hpGeo: { '11': { features: [
    { properties: { c: '11110' }, geometry: { type: 'Polygon', coordinates: sq(127, 37.5, 0.2) } },
    { properties: { c: '11140' }, geometry: { type: 'MultiPolygon', coordinates: [sq(126, 37, 0.01), sq(126.5, 37.2, 0.4)] } },
  ] } } };
  const center = new Function('env', `with(env){ ${fnSrc('_hpGuCenter')}; return _hpGuCenter; }`)(env);
  const a = center('11', '11110');
  assert.ok(Math.abs(a[0] - 37.6) < 1e-9 && Math.abs(a[1] - 127.1) < 1e-9, '[위도, 경도] 순서의 한가운데');
  const b = center('11', '11140');
  assert.ok(Math.abs(b[0] - 37.4) < 1e-9 && Math.abs(b[1] - 126.7) < 1e-9, '여러 조각이면 가장 큰 조각');
  assert.equal(center('11', '99999'), null);
  assert.equal(center('41', '41110'), null);
  // 시도 전체 보기에서만 이 자리를 쓰고, 누르면 여는 단지의 좌표는 그대로 둔다
  assert.match(fnSrc('_hpRegShow'), /markers\.forEach\(m => \{ const c = _hpGuCenter\(sido, m\.lawdCd\); if\(c\) m\._at = c; \}\);/);
  const mk = fnSrc('_hpRegMarkers');
  assert.match(mk, /const at = p\._at \|\| \[Number\(p\.lat\), Number\(p\.lng\)\];/);
  assert.match(mk, /const arg = \{ aptName:p\.aptName, sigungu:p\.sigungu, umdNm:p\.umdNm, lawdCd:p\.lawdCd, buildYear:p\.buildYear, recentDealDate:p\.recentDealDate, aptSeq:p\.aptSeq \|\| null, lat:p\.lat, lng:p\.lng \};/);
});

test('구 이름표 겹침 정리: 먼저 모두 구 이름만으로 놓고, 자리가 남는 곳만 단지 이름까지 편다', () => {
  // 가짜 이름표: 줄이면 폭 40, 펴면 폭 120. 가로로 60 간격이라 줄이면 모두 들어가고, 펴면 이웃과 겹친다.
  const mk = (x) => {
    const cls = new Set(['pop-marker', 'pop-guhead']); const attrs = {};
    return {
      classList: { add: (...c) => c.forEach((k) => cls.add(k)), remove: (...c) => c.forEach((k) => cls.delete(k)), contains: (k) => cls.has(k) },
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
      querySelector: () => null, attrs, cls,
      getBoundingClientRect: () => { const w = cls.has('pm-mini') ? 40 : 120; return { left: x, right: x + w, top: 0, bottom: 20, width: w }; },
    };
  };
  const els = [mk(0), mk(60), mk(120), mk(400)];
  const env = { document: { querySelectorAll: () => els } };
  new Function('env', `with(env){ ${fnSrc('declutterPopMarkers')}; declutterPopMarkers(); }`)(env);
  assert.equal(els.filter((e) => e.cls.has('pm-hidden')).length, 0, '줄이면 다 들어가므로 숨는 구가 없다');
  assert.deepEqual(els.map((e) => e.cls.has('pm-mini')), [true, true, false, false], '뒤에 이웃이 없는 곳만 단지 이름까지 편다');
});

test('구 이름표 겹침 정리: 줄여도 겹치는 구만 숨기고 가린 쪽에 개수를 적는다', () => {
  const mk = (x) => {
    const cls = new Set(['pop-marker', 'pop-guhead']); const attrs = {};
    return {
      classList: { add: (...c) => c.forEach((k) => cls.add(k)), remove: (...c) => c.forEach((k) => cls.delete(k)), contains: (k) => cls.has(k) },
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
      querySelector: () => null, attrs, cls,
      getBoundingClientRect: () => { const w = cls.has('pm-mini') ? 40 : 120; return { left: x, right: x + w, top: 0, bottom: 20, width: w }; },
    };
  };
  const els = [mk(0), mk(10), mk(300)];
  new Function('env', `with(env){ ${fnSrc('declutterPopMarkers')}; declutterPopMarkers(); }`)({ document: { querySelectorAll: () => els } });
  assert.equal(els[1].cls.has('pm-hidden'), true);
  assert.equal(els[0].attrs['data-more'], '1');
  assert.equal(els[2].cls.has('pm-mini'), false);
});

test('이름표 정리 연결: 지역 이름표를 그릴 때도 지도 이동과 확대에 다시 정리하도록 건다', () => {
  assert.match(fnSrc('_hpRegMarkers'), /try\{ _declutterHook\(\); \}catch\(_\)\{\}/);
  const src = fnSrc('_declutterHook');
  assert.match(src, /if \(!window\._declutterHooked\) \{/);
  assert.match(src, /if \(!window\._declutterWinHooked\) \{/, '창 크기 감시는 지도가 바뀌어도 한 번만');
});

test('지도 안내: 지역 보기 동안 뜻을 적고, 좁은 화면이나 지역 보기를 벗어나면 치운다', () => {
  let el = null; const host = { appendChild: (e) => { el = e; } };
  const env = {
    window: { innerWidth: 1440 },
    document: {
      getElementById: (id) => (id === 'mapEl' ? host : id === 'regMapNote' ? el : null),
      createElement: () => ({ style: {}, setAttribute() {}, remove() { el = null; } }),
    },
  };
  const note = new Function('env', `with(env){ ${fnSrc('_hpRegNote')}; return _hpRegNote; }`)(env);
  note({ sido: '11', sel: 'all', unit: '구' });
  assert.equal(el.textContent, '색칠된 구역이 구예요. 이름표는 그 구에서 최근 60일 동안 거래가 가장 많았던 단지예요. 구역을 누르면 그 구의 순위 10곳을 볼 수 있어요.');
  note({ sido: '11', sel: '11350', unit: '구', label: '노원구' });
  assert.equal(el.textContent, '노원구에서 최근 60일 동안 거래가 많았던 단지예요. 숫자는 순위예요. 이름표를 누르면 단지 정보를 볼 수 있어요.');
  note(null); assert.equal(el, null, '지역 보기를 벗어나면 치운다');
  env.window.innerWidth = 375; note({ sido: '11', sel: 'all' }); assert.equal(el, null, '좁은 화면에는 넣지 않는다');
  assert.match(fnSrc('_hpRegLegend'), /if\(text === null\)\{[^\n]*_hpRegNote\(null\)/);
  assert.doesNotMatch(fnSrc('_hpRegNote'), /[—–→]/, '문구에 긴 줄표와 화살표를 쓰지 않는다');
});

test('검색 목록: 고른 이름 그대로 포커스가 돌아오면 다시 묻지 않고, 글자를 고치면 묻는다', () => {
  const asked = [];
  const env = { window: {}, onHeaderSearchInput: (v) => asked.push(v) };
  const refocus = new Function('env', `with(env){ ${fnSrc('_hSearchRefocus')}; return _hSearchRefocus; }`)(env);
  env.window._hSearchChosen = '은마';
  refocus({ value: '은마' }); assert.deepEqual(asked, []);
  refocus({ value: '은마아파트' }); assert.deepEqual(asked, ['은마아파트']);
  refocus({ value: '' }); assert.equal(asked.length, 1);
  assert.match(html, /onfocus="_hSearchRefocus\(this\)"/);
  assert.match(fnSrc('goSearchResult'), /window\._hSearchChosen = r\.aptName;/);
});

test('검색 목록: 바깥을 누르거나 Esc 를 누르면 어디서든 닫히고, 목록 안과 검색창을 누르면 그대로다', () => {
  const a = html.indexOf("document.addEventListener('pointerdown', (e) => {\n  const d = document.getElementById('hSearchDrop')");
  const a2 = a > 0 ? a : html.indexOf("document.addEventListener('pointerdown', (e) => {\r\n  const d = document.getElementById('hSearchDrop')");
  const b = html.indexOf('function onHeaderSearchKey(e) {');
  assert.ok(a2 > 0 && b > a2);
  const handlers = {}; const drop = { style: { display: 'block' } };
  const env = { document: { addEventListener: (t, f) => { handlers[t] = f; }, getElementById: () => drop } };
  new Function('env', `with(env){ ${html.slice(a2, b)} }`)(env);
  handlers.pointerdown({ target: { id: 'x', closest: () => null } }); assert.equal(drop.style.display, 'none', '바깥');
  drop.style.display = 'block';
  handlers.pointerdown({ target: { id: 'y', closest: (s) => (s === '#hSearchDrop' ? {} : null) } }); assert.equal(drop.style.display, 'block', '목록 안');
  handlers.pointerdown({ target: { id: 'hSearchInput', closest: () => null } }); assert.equal(drop.style.display, 'block', '검색창');
  handlers.keydown({ key: 'a' }); assert.equal(drop.style.display, 'block');
  handlers.keydown({ key: 'Escape' }); assert.equal(drop.style.display, 'none');
});

test('목록: 직장 위치 때문에 좁혀진 안내 옆에 비우고 다시 찾는 단추가 있고, 누르면 칸과 저장값을 비운 뒤 다시 찾는다', () => {
  assert.match(html, /직장 위치를 비워 주세요 <button type="button" class="ld-wpbtn" onclick="_wpClearSearch\(\)"/);
  const log = []; const wp = { value: '강남구', dispatchEvent: () => log.push('input') };
  const env = {
    document: { getElementById: (id) => (id === 'wp' ? wp : null) }, window: { Event: function Event() {} },
    localStorage: { removeItem: (k) => log.push('rm:' + k) }, doSearch: () => log.push('search:' + wp.value),
  };
  new Function('env', `with(env){ ${fnSrc('_wpClearSearch')}; _wpClearSearch(); }`)(env);
  assert.deepEqual(log, ['input', 'rm:mhl_search_wp', 'search:']);
});
