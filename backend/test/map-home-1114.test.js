/**
 * MAP-HOME-1114: 첫 화면 지도 위치. 운영자 지적 "처음 열면 지도가 이상한 곳에 포커싱".
 *   예전에는 그날 거래 많은 단지 12곳에 맞춰 지도를 다시 잡아, 서울 단지가 없던 날 중심이 화성 서쪽으로 갔다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

function body(name) {
  const i = html.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} 가 없다`);
  let depth = 0; let j = html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(i, j + 1);
}
const consts = html.match(/const MAP_HOME = \{[^}]+\};\s*const MAP_VIEW_KEY = '[^']+';/);
assert.ok(consts, 'MAP_HOME 상수가 없다');
// 실제 소스의 함수를 가짜 localStorage 와 함께 실행한다
function load(store) {
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  return new Function('localStorage', 'window', 'mapObj',
    `${consts[0]} ${body('_mapViewValid')} ${body('_mapStartView')} ${body('_mapSaveView')} ${body('_mapHomeLat')}
     return { MAP_HOME, MAP_VIEW_KEY, _mapViewValid, _mapStartView, _mapHomeLat, save: (w, m) => { window = w; mapObj = m; _mapSaveView(); } };`)(ls, {}, null);
}
// 서울 경계(frontend/geo/sgg-11.json 에서 계산)
const geo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'geo', 'sgg-11.json'), 'utf8'));
let S = 90, N = -90, W = 180, E = -180;
const walk = (c) => { if (typeof c[0] === 'number') { S = Math.min(S, c[1]); N = Math.max(N, c[1]); W = Math.min(W, c[0]); E = Math.max(E, c[0]); } else c.forEach(walk); };
geo.features.forEach((ft) => walk(ft.geometry.coordinates));

test('처음 온 사람은 서울을 가운데 둔 수도권 화면에서 시작한다', () => {
  const m = load({});
  const v = m._mapStartView();
  assert.deepEqual(v, { lat: m.MAP_HOME.lat, lng: m.MAP_HOME.lng, zoom: m.MAP_HOME.zoom, saved: false });
  assert.equal(m.MAP_HOME.zoom, 10);
  // 시작 경도는 서울 동서 범위 한가운데 근처
  assert.ok(Math.abs(m.MAP_HOME.lng - (W + E) / 2) < 0.05);
});

test('지도 높이가 달라도 서울 25개 구가 위아래로 잘리지 않는다', () => {
  const m = load({});
  const degPerPx = (360 / (256 * 2 ** m.MAP_HOME.zoom)) * Math.cos(37.5 * Math.PI / 180);
  for (const h of [300, 363, 420, 506, 581, 700, 900]) {
    const c = m._mapHomeLat(h);
    const top = c + (h / 2) * degPerPx; const bottom = c - (h / 2) * degPerPx;
    assert.ok(top >= N, `높이 ${h}: 서울 북쪽이 잘린다(위 ${top.toFixed(3)}, 서울 북단 ${N.toFixed(3)})`);
    assert.ok(bottom <= S, `높이 ${h}: 서울 남쪽이 잘린다(아래 ${bottom.toFixed(3)}, 서울 남단 ${S.toFixed(3)})`);
  }
  // 미리보기 실측과 같은 값: 데스크톱 581px 는 기본 위도, 모바일 363px 는 위로 옮긴 위도
  assert.equal(m._mapHomeLat(581), m.MAP_HOME.lat);
  assert.ok(Math.abs(m._mapHomeLat(363) - 37.5462) < 0.002);
  // 서울이 다 들어갈 수 없을 만큼 낮으면 서울 한가운데
  assert.equal(m._mapHomeLat(200), 37.565);
});

test('가로 폭 375px 에서도 서울 동서가 들어온다', () => {
  const m = load({});
  const lngPerPx = 360 / (256 * 2 ** m.MAP_HOME.zoom);
  assert.ok(m.MAP_HOME.lng - (375 / 2) * lngPerPx <= W);
  assert.ok(m.MAP_HOME.lng + (375 / 2) * lngPerPx >= E);
});

test('다시 온 사람은 마지막으로 보던 위치에서 시작하고, 이상한 저장값은 무시한다', () => {
  const key = load({}).MAP_VIEW_KEY;
  assert.deepEqual(load({ [key]: JSON.stringify({ lat: 35.16, lng: 129.06, zoom: 12 }) })._mapStartView(), { lat: 35.16, lng: 129.06, zoom: 12, saved: true });
  for (const bad of ['', 'x', '{}', '{"lat":0,"lng":0,"zoom":10}', '{"lat":35,"lng":129,"zoom":99}', '{"lat":"35","lng":129,"zoom":10}', '{"lat":52,"lng":13,"zoom":10}', 'null']) {
    assert.equal(load({ [key]: bad })._mapStartView().saved, false, `저장값 ${bad} 를 받아들인다`);
  }
});

test('위치 저장은 사용자가 지도를 직접 만진 뒤에만 한다', () => {
  const store = {}; const m = load(store);
  const nav = { getCenter: () => ({ lat: () => 35.16, lng: () => 129.06 }), getZoom: () => 12 };   // 네이버 지도 모양
  const lf = { getCenter: () => ({ lat: 36.35, lng: 127.38 }), getZoom: () => 11 };               // 대체 지도 모양
  m.save({ _mapUserMoved: false }, nav);
  assert.equal(store[m.MAP_VIEW_KEY], undefined, '자동 이동만 있었는데 저장했다');
  m.save({ _mapUserMoved: true }, nav);
  assert.deepEqual(JSON.parse(store[m.MAP_VIEW_KEY]), { lat: 35.16, lng: 129.06, zoom: 12 });
  m.save({ _mapUserMoved: true }, lf);
  assert.deepEqual(JSON.parse(store[m.MAP_VIEW_KEY]), { lat: 36.35, lng: 127.38, zoom: 11 });
});

test('지도 초기화가 시작 위치 함수를 쓰고, 거래 많은 단지에 맞춰 다시 잡지 않는다', () => {
  assert.doesNotMatch(html, /center:new naver\.maps\.LatLng\(37\.565,127\.02\),\s*zoom:12/);
  assert.match(html, /const _sv0=_mapStartView\(\);[^\n]*\n\s*mapObj=new naver\.maps\.Map\('mapEl',\{\s*center:new naver\.maps\.LatLng\(_sv0\.lat,_sv0\.lng\),\s*zoom:_sv0\.zoom,/);
  assert.match(html, /mapObj=L\.map\('mapEl',\{center:\[_sv0\.lat,_sv0\.lng\],zoom:_sv0\.zoom\}\);/);
  assert.match(html, /window\._fitPopularMetro = function\(\)\{ _mapApplyHome\(\); \};/);
  const i = html.indexOf('window._fitPopularMetro = function(){');
  assert.doesNotMatch(html.slice(i, i + 400), /fitBounds/);
  // 시작 화면 맞춤은 사용자가 움직였거나 저장된 위치가 있거나 확대 단계가 다르면 손대지 않는다
  const ap = body('_mapApplyHome');
  assert.match(ap, /window\._mapUserMoved \|\| window\._mapHomeLocked\) return;/);
  assert.match(ap, /if \(_mapStartView\(\)\.saved\) return;/);
  assert.match(ap, /if \(mapObj\.getZoom\(\) !== MAP_HOME\.zoom\) return;/);
  assert.doesNotMatch(ap, /_mapHomeUntil/, '시간 제한에 기대지 않는다');
  // 다른 코드가 지도를 옮겼으면(경도가 달라졌거나 위도가 크게 달라졌으면) 되돌리지 않는다
  assert.ok(ap.includes('if (Math.abs(_cLng - MAP_HOME.lng) > 0.01 || Math.abs(_cLat - MAP_HOME.lat) > 0.25) return;'));
  // 사용자 이동 감지와 시작 화면 맞춤은 지도 초기화 직후에 건다(인기 단지 API 가 실패해도 동작)
  assert.equal(html.split('_mapHookUserMove(); _mapApplyHome();').length - 1, 2, '네이버와 대체 지도 초기화 두 곳');
  assert.equal(html.split('window._fitPopularMetro = function').length - 1, 1, '진입점 정의는 한 곳');
});
