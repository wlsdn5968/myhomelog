/**
 * COMPARE-PLUS-2026-10-30 (Plan 156): 비교 창 생활 거리·가격 흐름.
 *  ① 월 목록(한국 시간 이번 달 포함) ② 월별 평당가 중앙값 — 거래 없는 달은 null(지어내지 않음)
 *  ③ 생활 거리 상태 구분: 역 ok/none/fail, 학교 ok/notfound/fail — 실패를 '없음'으로 쓰지 않는다
 *  ④ 화면 문구(직선거리만, 도보 시간 없음)·y축 눈금 규칙·차트 끊김 ⑤ 통근 추정값을 넣지 않는다
 * 실행: cd backend && TZ=UTC node --test test/compare-plus.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const fnSrc = (name) => {
  const i = html.indexOf(`\nfunction ${name}(`);
  assert.ok(i >= 0, `${name} 없음`);
  const rest = html.slice(i + 1);
  const m = rest.slice(1).search(/\n(?:function |const |let |\/\/ )/);
  return rest.slice(0, m + 1);
};
const { _internals: I } = require('../services/analysisService');

test('① 월 목록: 한국 시간 기준 이번 달까지 N개월, 연도 넘김', () => {
  // 2026-10-31 20:00 UTC = 한국 11-01 05:00 → 이번 달은 11월
  const ms = I.cmpMonths(12, Date.UTC(2026, 9, 31, 20, 0));
  assert.equal(ms.length, 12);
  assert.equal(ms[11], '2026-11');
  assert.equal(ms[0], '2025-12');
  assert.deepEqual(I.cmpMonths(3, Date.UTC(2026, 0, 15)), ['2025-11', '2025-12', '2026-01']);
});

test('② 월별 평당가: 같은 달 거래의 평당가(전용) 중앙값·건수, 거래 없는 달은 null', () => {
  const PY = 3.3058;
  const t = (y, m, amt, ar = 59.94) => ({ dealYear: y, dealMonth: m, dealAmount: amt, excluUseAr: ar });
  const s = I.cmpSeries([t(2026, 9, 60000), t(2026, 9, 66000), t(2026, 9, 63000), t(2026, 7, 50000)], ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(s.map((x) => x.n), [1, 0, 3]);
  assert.equal(s[1].v, null);
  assert.equal(s[2].v, Math.round(63000 / (59.94 / PY)));
  assert.equal(s[0].v, Math.round(50000 / (59.94 / PY)));
});

async function nearWith({ coord, station, schools }) {
  const set = (rel, exp) => {
    const p = require.resolve(rel);
    const saved = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
    return () => { if (saved) require.cache[p] = saved; else delete require.cache[p]; };
  };
  const undo = [
    set('../services/geocodeCacheService', { resolveCoord: async () => coord }),
    set('../services/kakaoService', { nearestSubway: async () => station }),
    set('../services/schoolService', { resolveSchools: async () => schools }),
  ];
  try { return await I.cmpNear({ aptName: '예시', sigungu: '노원구', umdNm: '공릉동' }); }
  finally { undo.forEach((u) => u()); }
}

test('③ 생활 거리 상태: 역 ok·none(3km 안 없음)·fail(조회 실패), 학교 ok·notfound·fail, 좌표 없으면 둘 다 fail', async () => {
  const c = { lat: 37.62, lng: 127.07 };
  const ok = await nearWith({ coord: c, station: { name: '공릉역', distance: 320.4 }, schools: [{ type: '중', name: '가중학교', distance_m: 100 }, { type: '초', name: '나초등학교', distance_m: 410 }, { type: '초', name: '다초등학교', distance_m: 700 }] });
  assert.deepEqual(ok, { station: { s: 'ok', name: '공릉역', m: 320 }, school: { s: 'ok', name: '나초등학교', m: 410 } });
  const none = await nearWith({ coord: c, station: null, schools: [{ type: '중', name: '가중학교', distance_m: 100 }] });
  assert.deepEqual(none, { station: { s: 'none' }, school: { s: 'notfound' } });
  const fail = await nearWith({ coord: c, station: undefined, schools: undefined });
  assert.deepEqual(fail, { station: { s: 'fail' }, school: { s: 'fail' } });
  const noCoord = await nearWith({ coord: null, station: { name: 'x', distance: 1 }, schools: [] });
  assert.deepEqual(noCoord, { station: { s: 'fail' }, school: { s: 'fail' } });
  // DB 캐시 적중이면 역 이름이 없다 → 이름 없이 거리만
  const noName = await nearWith({ coord: c, station: { name: null, distance: 1234 }, schools: [] });
  assert.deepEqual(noName.station, { s: 'ok', name: null, m: 1234 });
});

// eslint-disable-next-line no-new-func
const F = new Function(`${['_cmpDist', '_cmpNearText', '_cmpYTicks'].map(fnSrc).join('\n')}\nreturn {_cmpDist,_cmpNearText,_cmpYTicks};`)();

test('④ 화면 문구: 직선거리만(도보 시간 없음), 상태별 문구, y축 눈금(간격 100에서 6개 넘으면 2배)', () => {
  assert.deepEqual(F._cmpNearText({ s: 'ok', name: '공릉역', m: 320 }, 'station'), { ok: true, text: '공릉역 · 직선 320m' });
  assert.deepEqual(F._cmpNearText({ s: 'ok', name: null, m: 1234 }, 'station'), { ok: true, text: '직선 1.2km' });
  assert.equal(F._cmpNearText({ s: 'none' }, 'station').text, '3km 안에 없음');
  assert.equal(F._cmpNearText({ s: 'fail' }, 'station').text, '확인 못 함');
  assert.equal(F._cmpNearText(undefined, 'school').text, '확인 못 함');
  assert.equal(F._cmpNearText({ s: 'notfound' }, 'school').text, '1km 안에서 찾지 못함');
  assert.equal(F._cmpDist(999), '999m');
  assert.equal(F._cmpDist(1000), '1.0km');
  assert.doesNotMatch((fnSrc('_cmpNearText') + fnSrc('_cmpDist')).replace(/\/\/[^\n]*/g, ''), /\d\s*분|도보/, '도보 시간을 만들지 않는다');
  const y = F._cmpYTicks(3320, 3480);
  assert.deepEqual([y.lo, y.hi, y.step], [3200, 3600, 100]);
  const wide = F._cmpYTicks(2000, 4000);
  assert.ok(wide.ticks.length <= 6 && wide.step === 800, JSON.stringify(wide));
  // 차트: 거래 없는 달은 선을 끊는다(null 이면 flush), 지나간 거래라는 안내
  const ch = fnSrc('_cmpChartHtml');
  assert.match(ch, /if\(!p \|\| !Number\.isFinite\(p\.v\)\)\{ flush\(\); return; \}/);
  assert.match(ch, /지나간 거래를 정리한 것이고 앞으로의 가격을 뜻하지 않아요\./);
  assert.match(html, /직선거리라 걸어서 가는 길은 더 길어요\./);
  assert.match(html, /생활 거리\(직선거리, 카카오 지도 검색\)/);
});

test('④-2 단지 6개까지 선 모양(색·선·점)이 모두 다르고, 정렬해도 단지별 모양은 원래 담은 순서로 고정', () => {
  // eslint-disable-next-line no-new-func
  const S = new Function(`const _CMP_COL=['A','B','C'], _CMP_DASH=['','9 6','1 6'];\n${fnSrc('_cmpStyle')}\nreturn _cmpStyle;`)();
  const keys = [0, 1, 2, 3, 4, 5].map((k) => { const s = S(k); return `${s.c}|${s.d}`; });
  assert.equal(new Set(keys).size, 6, keys.join(' / '));
  assert.deepEqual([S(0), S(1), S(2)].map((s) => [s.c, s.d]), [['A', ''], ['B', '9 6'], ['C', '1 6']], '앞의 3개는 시안 그대로');
  assert.match(html, /:_cmpChartHtml\(oResults, oPerResult, sel, _order\)\}/);
});

test('⑥ 기간 선택(Plan 160): 12/24개월 세그먼트는 칩 위, 불러오는 동안 자리 표시·잠금, 실패하면 되돌림, 24개월 눈금', () => {
  const f = html.slice(html.indexOf('async function _cmpSetMonths('), html.indexOf('function _cmpPickBand('));
  assert.match(f, /body: JSON\.stringify\(\{ apts: _cmpApts\.slice\(0,CMP_MAX\), dealMonths: m \}\)/);
  assert.match(f, /_cmpMonths = prev; _cmpLoading = false;/, '실패 시 이전 기간으로');
  assert.match(f, /_cmpBand = \(keep!=null && _clusterBands\(data\.results\|\|\[\]\)\.some\(c=>c\.center===keep\)\) \? keep : null;/);
  // 세그먼트가 면적 칩보다 앞(위)
  const seg = html.indexOf('<div class="cmp-period" role="radiogroup" aria-label="비교 기간">');
  assert.ok(seg > 0 && seg < html.indexOf('<div class="cmp-chips">${chips ||'));
  assert.match(html, /role="radio" aria-checked="\$\{_cmpMonths===m\?'true':'false'\}"/);
  // 안내: 12개월 + 표본 부족 단지가 있을 때만, 불러오는 동안 숨김
  assert.match(html, /const _cmpShowHint = _CMP_PERIOD_ON && !_cmpLoading && _cmpMonths===12 && oPerResult\.some\(b=>b && !b\.reliable\);/);
  // 24개월: 원본 창 밖 달은 이력 테이블에서 읽는다(Plan 170, tx-hist-region.test.js) — 고친 뒤 다시 열었다
  assert.match(html, /const _CMP_PERIOD_ON = true;/);
  assert.match(html, /\$\{_CMP_PERIOD_ON\?`<div class="cmp-period"/);
  assert.match(html, /표본이 적은 단지는 24개월로 넓혀 볼 수 있어요\./);
  // 불러오는 동안: 표 aria-busy·셀 자리 표시·차트 자리 role=status·칩과 정렬 잠금
  assert.match(html, /<table class="cmp-tbl" aria-busy="\$\{_cmpLoading\?'true':'false'\}">/);
  assert.match(html, /<div class="cmp-chart-sk" role="status">불러오는 중이에요<\/div>/);
  assert.match(html, /function _cmpPickBand\(b\)\{\n\s*if\(_cmpLoading\) return;/);
  assert.match(html, /function _cmpToggleSort\(\)\{\n\s*if\(_cmpLoading\) return;/);
  // 24개월 눈금: 데스크톱 3개월·모바일 6개월(1월 기준), 모바일 24개월 점 0.75배·탭 영역 8
  assert.match(html, /const long=months\.length>12, step=long\?\(mob\?6:3\):\(mob\?2:1\);/);
  assert.match(html, /_cmpMarker\(st\.m,px,py,sm\?3:0\)/);
  assert.match(html, /r="\$\{sm\?8:12\}" class="cmp-hit"/);
});

test('⑤ 통근 추정값(자동차×1.6+5분)을 비교에 넣지 않는다, 면책에 카카오 지도 출처', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.doesNotMatch(svc, /getTransitMinutes|getCarMinutes/);
  assert.match(svc, /공동주택 기본정보\(K-apt\) · 카카오 지도\./);
  assert.match(html, /results\.forEach\(\(r,ri\)=> \(r\.bands\|\|\[\]\)\.forEach\(b=> all\.push\(\{[^}]*series:Array\.isArray\(b\.series\)\?b\.series:null, ri \}\)\)\);/);
});
