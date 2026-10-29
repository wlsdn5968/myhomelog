/**
 * PRICE-SAME-BASIS-2026-10-30 — 10-18 전수 점검 '같은 단지 가격이 화면마다 다름' 후속(운영 실측 공릉풍림아이원 11350-183).
 *  ① 신고가 경신 추이가 최근 30건·전 면적을 섞어 115㎡ 거래를 60㎡ 차트 위 '신고가'로 보였다 → 차트와 같은 거래·같은 대표 평형
 *  ② 서버 단지 페이지 첫 요약이 31~115㎡ 를 섞은 평균(8.67억) → 앱과 같은 대표 평형 규칙
 * 실행: cd backend && TZ=UTC node --test test/price-same-basis.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

function loadPeak(win) {
  const a = html.indexOf('function _pcRepArea(src)');
  const repSrc = html.slice(a, html.indexOf('\n', a));
  const r = html.indexOf('function _pcRecentDeals(){');
  const recentSrc = html.slice(r, html.indexOf('\n}', r) + 2);
  const p = html.indexOf('  function _peakTrendHtml(area) {');
  const peakSrc = html.slice(p, html.indexOf('\n  window._peakTrendHtml = _peakTrendHtml;', p));
  assert.ok(a > 0 && r > 0 && p > 0, '함수를 찾지 못했다 — 테스트를 갱신할 것');
  // eslint-disable-next-line no-new-func
  return new Function('window', `${repSrc}\n${recentSrc}\n${peakSrc}\nreturn _peakTrendHtml;`)(win);
}

// 공릉풍림 모양: 60㎡ 가 가장 많고, 115㎡ 가 더 비싸다
const LONG = [
  { d: '2021-01-10', a: 70000, ar: 59.94, f: 3 },
  { d: '2021-06-10', a: 80000, ar: 59.94, f: 5 },
  { d: '2022-03-10', a: 88000, ar: 59.94, f: 8 },
  { d: '2023-01-10', a: 60000, ar: 59.94, f: 2 },
  { d: '2024-05-10', a: 104800, ar: 114.78, f: 3 },
  { d: '2026-05-21', a: 90000, ar: 84.99, f: 9 },
  { d: '2026-06-19', a: 109500, ar: 114.78, f: 15 },
  { d: '2026-09-10', a: 85000, ar: 59.94, f: 8 },
];

test('신고가 추이: 평형 "전체"면 차트와 같은 대표 평형(거래 최다)만으로 센다 — 다른 면적이 끼지 않는다', () => {
  const peak = loadPeak({ _curTrendLong: { state: 'ok', deals: LONG }, _curTrendApt: [] });
  const out = peak(0);
  assert.match(out, /60㎡\(18평\) 신고가 경신 3회/);
  assert.match(out, /처음 7\.00억에서 최근 8\.80억으로/);
  assert.doesNotMatch(out, /10\.95억|10\.48억|9\.00억/, '다른 면적 거래가 신고가로 끼었다');
  assert.match(out, /2021\.01부터 거래 5건 기준/);
  assert.doesNotMatch(out, /그 전의 모든 거래/, '사실과 다른 옛 안내가 남았다');
});

test('신고가 추이: 평형을 고르면 그 평형(±2㎡)만', () => {
  const peak = loadPeak({ _curTrendLong: { state: 'ok', deals: LONG }, _curTrendApt: [] });
  const out = peak(115);
  assert.match(out, /115㎡\(35평\) 신고가 경신 2회/);
  assert.match(out, /10\.95억/);
});

test('신고가 추이: 장기 이력이 없으면 불러온 최근 거래만이라고 밝힌다', () => {
  const recent = [
    { dealYear: 2026, dealMonth: 1, dealDay: 5, excluUseAr: 59.94, dealAmount: 80000, floor: 3 },
    { dealYear: 2026, dealMonth: 3, dealDay: 5, excluUseAr: 59.94, dealAmount: 82000, floor: 4 },
  ];
  const peak = loadPeak({ _curTrendLong: { state: 'loading' }, _curTrendApt: recent });
  assert.match(peak(0), /불러온 최근 거래 2건 기준/);
});

test('장기 이력이 도착하면 신고가 추이도 다시 그린다', () => {
  const i = html.indexOf('async function _pcLoad(){');
  const body = html.slice(i, html.indexOf('\n}', i));
  assert.match(body, /peakTrendBox[\s\S]*_peakTrendHtml\(window\._curTrendArea\|\|0\)/);
});

test('가격 차트도 같은 대표 평형 함수를 쓴다', () => {
  const i = html.indexOf('function _pcHtml(area){');
  assert.match(html.slice(i, i + 600), /if\(!area\) area=_pcRepArea\(src\);/);
});

test('세금 카드 매매가는 소수 2자리(같은 화면의 평균가와 같은 자릿수)', () => {
  assert.match(html, /매매가 \$\{market\.toFixed\(2\)\}억 \/ 공시가격 추정 \$\{official\.toFixed\(2\)\}억/);
});

test('서버 단지 페이지: 대표 평형 = 거래 최다(동률이면 최근), 그 평형만으로 평균·중앙값·범위', () => {
  const { _repAreaSummary } = require('../routes/aptPage');
  const t = (y, m, d, ar, amt) => ({ dealYear: y, dealMonth: m, dealDay: d, excluUseAr: ar, dealAmount: amt });
  const r = _repAreaSummary([
    t(2026, 1, 1, 59.94, 80000), t(2026, 2, 1, 59.94, 82000), t(2026, 3, 1, 59.94, 84000),
    t(2026, 4, 1, 114.78, 110000), t(2026, 5, 1, 31.2, 30000),
  ]);
  assert.equal(r.sqm, 60); assert.equal(r.py, 18); assert.equal(r.n, 3);
  assert.equal(r.avg, 82000); assert.equal(r.median, 82000); assert.equal(r.min, 80000); assert.equal(r.max, 84000);
  // 동률이면 가장 최근 거래의 평형
  const tie = _repAreaSummary([t(2025, 1, 1, 59.94, 80000), t(2026, 6, 1, 84.99, 90000)]);
  assert.equal(tie.sqm, 85);
  assert.equal(_repAreaSummary([]), null);
});

test('서버 단지 페이지: 첫 요약은 평형을 적고, 섞은 평균(시간 가중)을 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/aptPage.js'), 'utf8');
  assert.doesNotMatch(src, /평균가\(시간 가중\)/);
  assert.match(src, /\$\{rep\.sqm\}㎡\(\$\{rep\.py\}평\) 평균/);
  assert.match(src, /거래 건수\(전 평형\)/);
});

test('링크(?apt=)로 연 상세도 검색 경로와 같은 대표 평형·최근 30건·같은 라벨로 평균을 낸다', () => {
  const i = html.indexOf('async function handleShareUrl(){');
  const body = html.slice(i, html.indexOf('\n}', i));
  assert.match(body, /const _rep=_repAreaOf\(_recent\);/);
  assert.match(body, /Math\.round\(Number\(t\.excluUseAr\)\|\|0\)===_rep\.sqm/);
  assert.match(body, /_priceBasis:_rep \? `\$\{_rep\.sqm\}㎡\(\$\{_rep\.py\}평\) 최근 \$\{_rep\.n\}건 평균`/);
  assert.match(body, /\.sort\(\(a,b\)=>_dn\(b\)-_dn\(a\)\)\.slice\(0,30\)/);
  // 검색 경로 라벨과 문자열이 같다
  assert.match(html, /`\$\{_repArea\.sqm\}㎡\(\$\{_repArea\.py\}평\) 최근 \$\{_repArea\.n\}건 평균`/);
});

test('관심 단지 가격 갱신도 대표 평형 평균(목표가 알림 판정에 쓰이므로 면적을 섞지 않는다)', () => {
  const i = html.indexOf('async function refreshBookmarkPrices(){');
  const body = html.slice(i, html.indexOf('\n}', i));
  assert.match(body, /const _rep=_repAreaOf\(_recent\);/);
  assert.match(body, /Math\.round\(Number\(t\.excluUseAr\)\|\|0\)===_rep\.sqm/);
  assert.match(body, /b\.priceBasis=_rep \?/);
  assert.doesNotMatch(body, /const prices=items\.map\(t=>t\.dealAmount\/10000\);/, '섞은 평균이 남았다');
  assert.match(html, /_priceBasis:b\.priceBasis\|\|undefined/);
});
