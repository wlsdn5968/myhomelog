/**
 * Plan 171 (2026-10-30, 운영자 지적 — 상계주공7단지 실거래 차트): ① 평형마다 색이 다른 선·선 끝 평형 이름표·범례
 *  ② 이웃 거래와 동떨어진 거래(26.01.29 7층 3.60억)가 '3년 최저'로 나오던 문제 — 점은 빈 원으로 남기고 최고·최저·선에서 뺀다.
 * 거래 값은 운영 DB 실측(2026-10-30, apt_seq 11350-41 상계주공7(고층) 45.55·45.77·45.90㎡).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

function load() {
  const a = html.indexOf('const _PC_PERIODS');
  const b = html.indexOf('function _setPcPeriod(k)');
  assert.ok(a > 0 && b > a, '차트 함수 구간을 찾지 못했다 — 테스트를 갱신할 것');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', `${html.slice(a, b)}\nreturn { _pcModel, _pcOutliers, _pcPy, _pcGroups, _pcHtml };`)(
    { _curTrendApt: [], innerWidth: 700 }, { getElementById: () => null, querySelector: () => null });
}

// 14평 2025-11~2026-04 실측 일부 + 2026-07~09 오름 구간
const D14 = [
  ['2025-11-21', 52500, 45.77], ['2025-12-05', 51500, 45.9], ['2025-12-11', 54500, 45.9], ['2025-12-11', 53000, 45.55],
  ['2025-12-16', 51300, 45.55], ['2026-01-07', 50000, 45.9], ['2026-01-15', 52200, 45.9], ['2026-01-26', 54800, 45.55],
  ['2026-01-28', 51900, 45.9], ['2026-01-29', 36000, 45.55], ['2026-01-31', 50000, 45.77], ['2026-01-31', 54000, 45.55],
  ['2026-02-12', 56000, 45.9], ['2026-02-19', 53000, 45.77], ['2026-02-20', 54000, 45.55], ['2026-03-10', 58750, 45.55],
  ['2026-07-27', 63000, 45.9], ['2026-07-28', 60700, 45.9], ['2026-07-31', 62000, 45.9], ['2026-08-04', 62000, 45.9],
  ['2026-08-06', 65000, 45.9], ['2026-08-24', 66000, 45.9], ['2026-09-05', 64000, 45.9], ['2026-09-19', 70000, 45.9],
  ['2026-09-29', 58000, 45.9],
].map(([d, a, ar]) => ({ d, a, ar }));

test('동떨어진 거래: 26.01.29 3.60억만 걸리고, 오르는 흐름 끝의 최고가(26.09.19 7.00억)는 걸리지 않는다', () => {
  const { _pcOutliers } = load();
  const o = [..._pcOutliers(D14)].map(x => `${x.d} ${x.a}`);
  assert.deepEqual(o, ['2026-01-29 36000']);
});

test('이웃이 드물면 180일까지 넓혀 본다(공릉 동부 85㎡ 26.09.10 4.20억 실측)', () => {
  const { _pcOutliers } = load();
  const rows = [['2026-04-23', 65000], ['2026-05-16', 68000], ['2026-05-19', 72500], ['2026-06-11', 68000], ['2026-08-19', 70000], ['2026-09-10', 42000]]
    .map(([d, a]) => ({ d, a, ar: 84.79 }));
  assert.deepEqual([..._pcOutliers(rows)].map(x => x.a), [42000]);
});

test('_pcModel: 동떨어진 거래는 점(rows)에는 남고 최고·최저·선에서 빠진다', () => {
  const { _pcModel, _pcOutliers } = load();
  const o = _pcOutliers(D14);
  const m = _pcModel(D14.map(x => Object.assign({}, x, { o: o.has(x) })), 'all');
  assert.equal(m.rows.length, D14.length, '점은 그대로 다 그린다');
  assert.equal(m.lo.a, 50000, '최저가 3.60억이 아니다');
  assert.equal(m.hi.a, 70000, '최고는 7.00억 그대로');
  assert.deepEqual(m.out.map(x => x.a), [36000]);
  const jan = m.line.find(p => p && new Date(p.t * 864e5).toISOString().startsWith('2026-01'));
  assert.ok(jan.v > 50000, '1월 중앙값 선이 3.60억에 끌려 내려가면 안 된다');
});

test('평형 묶음: 평 반올림 · 색은 평 오름차순 고정 · 고른 평형이 7번째여도 들어간다', () => {
  const { _pcGroups, _pcPy } = load();
  assert.equal(_pcPy(45.55), 14); assert.equal(_pcPy(58.01), 18); assert.equal(_pcPy(59.39), 18); assert.equal(_pcPy(41.3), 12);
  const src = [];
  [[41.3, 9], [45.9, 9], [49.94, 9], [58.01, 9], [79.07, 9], [84.9, 9], [114.9, 2]].forEach(([ar, n]) => { for (let i = 0; i < n; i++) src.push({ ar }); });
  const G = _pcGroups(src, 0);
  assert.deepEqual(G.shown.map(g => [g.py, g.color]), [[12, 'var(--pc-1)'], [14, 'var(--pc-2)'], [15, 'var(--pc-3)'], [18, 'var(--pc-4)'], [24, 'var(--pc-5)'], [26, 'var(--pc-6)']]);
  assert.equal(G.hidden, 1);
  const G2 = _pcGroups(src, 35);
  assert.ok(G2.shown.some(g => g.py === 35), '고른 평형은 거래가 적어도 선을 그린다');
});

test('차트 화면: 평형마다 선, 선 끝 평형 이름표, 범례 버튼, 빈 원 안내, 기준 문구', () => {
  const { _pcHtml } = load();
  const src = D14.concat([['2026-01-10', 52000, 41.3], ['2026-02-10', 53000, 41.3], ['2026-03-10', 54000, 41.3], ['2026-09-10', 60000, 41.3]].map(([d, a, ar]) => ({ d, a, ar })));
  // window 는 load() 안에서 고정 — _pcHtml 이 쓰는 window._curTrendLong 을 직접 넣는다
  const a = html.indexOf('const _PC_PERIODS'), b = html.indexOf('function _setPcPeriod(k)');
  const win = { _curTrendLong: { state: 'ok', deals: src }, _curTrendApt: [], _pcPeriod: 'all', innerWidth: 700 };
  // eslint-disable-next-line no-new-func
  const f = new Function('window', 'document', `${html.slice(a, b)}\nreturn _pcHtml;`)(win, { getElementById: () => null, querySelector: () => null });
  const out = f(46);
  assert.match(out, /46㎡\(14평\)가 최근 5\.80억에 거래됐어요/);
  assert.match(out, /stroke:var\(--pc-1\)/); assert.match(out, /stroke:var\(--pc-2\)/);
  assert.match(out, />12평<\/text>/); assert.match(out, />14평<\/text>/);
  assert.match(out, /onclick="_pcPickPy\(12,41\)"/);
  assert.match(out, /빈 원 1건은[^<]*26\.01\.29 3\.60억/); // 테스트 거래에는 층이 없다
  assert.match(out, /최저 5\.00억/, '최저가 3.60억이 아니다');
  assert.match(out, /같은 평형\(전용면적을 평으로 반올림\)/);
  assert.doesNotMatch(out, /±2㎡/);
  assert.ok(_pcHtml, 'load() 경로도 살아 있다');
});

test('색 토큰: 밝은·어두운 화면 모두 --pc-1~7 정의(dataviz 검증 팔레트)', () => {
  assert.match(html, /--pc-1:#2a78d6; --pc-2:#eb6834; --pc-3:#1baf7a; --pc-4:#eda100; --pc-5:#e87ba4; --pc-6:#008300; --pc-7:#6250d6;/);
  assert.match(html, /--pc-1:#3987e5; --pc-2:#d95926; --pc-3:#199e70; --pc-4:#c98500; --pc-5:#d55181; --pc-6:#008300; --pc-7:#9085e9;/);
});

test('범례는 평을 직접 고른다 — 83.6㎡(25평)·84.4㎡(26평)가 둘 다 84㎡ 로 반올림돼도 26평을 고를 수 있다(교차 검토 결함)', () => {
  const a = html.indexOf('const _PC_PERIODS'), b = html.indexOf('function _setPcPeriod(k)');
  const deals = [];
  ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'].forEach((d, k) => { deals.push({ d, a: 80000 + k * 500, ar: 83.6 }); deals.push({ d, a: 90000 + k * 500, ar: 84.4 }); });
  const win = { _curTrendLong: { state: 'ok', deals }, _curTrendApt: [], _pcPeriod: 'all', innerWidth: 700, _curTrendArea: 84, _pcSelPy: 26 };
  // eslint-disable-next-line no-new-func
  const f = new Function('window', 'document', `${html.slice(a, b)}\nreturn _pcHtml;`)(win, { getElementById: () => null, querySelector: () => null });
  assert.match(f(84), /84㎡\(26평\)가 최근 9\.15억/);
  assert.match(f(84), /onclick="_pcPickPy\(25,84\)"/);
  win._pcSelPy = 0;
  assert.match(f(84), /84㎡\(25평\)가 최근/, '칩(㎡)으로 고르면 거래가 많은(동률이면 먼저) 평');
  assert.match(html, /function _selectTrendArea\(sqm, btn, py\) \{\n  window\._curTrendArea = sqm;\n  window\._pcSelPy = py \|\| 0;/);
});
