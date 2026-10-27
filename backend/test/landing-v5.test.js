/**
 * backend/test/landing-v5.test.js — LANDING-V5-2026-10-21: 첫 방문 화면 포인트 수정(claude.ai/design 시안 "첫 방문 화면 수정안 v2").
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const fn = (name) => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} 없음`); return m[0];
};
const lvStart = html.indexOf('<div id="view-landing"');
const lv = html.slice(lvStart, html.indexOf('<!-- 모바일 하단 탭 -->', lvStart));
const cssStart = html.indexOf('<!-- ════ LANDING-V5-2026-10-21');
const css = html.slice(cssStart, html.indexOf('</style>', cssStart));

test('금액 표기: 만원 → "5억 8,800만" · "6억" · "6,700만", 값이 없으면 빈칸', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(`${fn('_lvAmt')}; globalThis.f = _lvAmt;`, ctx);
  assert.equal(ctx.f(58800), '5억 8,800만');
  assert.equal(ctx.f(60000), '6억');
  assert.equal(ctx.f(6700), '6,700만');
  assert.equal(ctx.f(null), ''); assert.equal(ctx.f(0), ''); assert.equal(ctx.f('x'), '');
});

function renderCtx() {
  const els = { lvRecList: { innerHTML: '' }, lvTabHi: { a: {}, setAttribute(k, v) { this.a[k] = v; } }, lvTabLo: { a: {}, setAttribute(k, v) { this.a[k] = v; } } };
  const ctx = { document: { getElementById: (id) => els[id] || null } };
  vm.createContext(ctx);
  vm.runInContext([
    ...['_escHtml', '_jsonAttr', '_isUnnamedApt', '_dispAptName', '_lvAmt', '_lvRecRender', '_lvRecTab'].map(fn),
    'let _lvRec = null, _lvRecMode = "high";',
    'globalThis.set = (r) => { _lvRec = r; }; globalThis.tab = _lvRecTab; globalThis.render = _lvRecRender;',
  ].join('\n'), ctx);
  return { ctx, els };
}

test('경신 목록: 최고가·최저가 탭 전환, 직전 값 문구가 탭을 따른다, 3줄까지, 이름은 이스케이프', () => {
  const { ctx, els } = renderCtx();
  const row = (n, amt, prevMax, prevMin) => ({ aptName: n, region: '수원시 영통구', umdNm: '매탄동', excluUseAr: 84.45, dealAmount: amt, prevMax, prevMin, dealDate: '2026-10-19', lawdCd: '41117', sigungu: '수원시영통구', buildYear: 2002 });
  ctx.set({ high: [row('주공그린빌1', 58800, 54500, 36000), row('B', 1, 1, 1), row('C', 1, 1, 1), row('D', 1, 1, 1)], low: [row('<b>x</b>', 6700, 12000, 7000)] });
  ctx.render();
  let h = els.lvRecList.innerHTML;
  assert.equal((h.match(/class="lv-row"/g) || []).length, 3, '3줄까지');
  assert.ok(h.includes('주공그린빌1') && h.includes('5억 8,800만') && h.includes('직전 최고 5억 4,500만 · 10.19') && h.includes('수원시 영통구 매탄동 · 84.45㎡'));
  ctx.tab('low');
  h = els.lvRecList.innerHTML;
  assert.equal(els.lvTabLo.a['aria-selected'], 'true'); assert.equal(els.lvTabHi.a['aria-selected'], 'false');
  assert.ok(h.includes('직전 최저 7,000만'), '최저가 탭은 직전 최저와 비교');
  assert.ok(!h.includes('<b>x</b>') && h.includes('&lt;b&gt;'), '이름 이스케이프');
  ctx.set({ high: [], low: [] }); ctx.render();
  assert.ok(els.lvRecList.innerHTML.includes('이번 주에는 새 최저가 거래가 없어요'));
});

test('원칙: 최고가만 싣지 않는다(두 건수 탭 늘 함께) · 빨강·파랑·그라데이션·고정폭·Sora 없음 · 한글 로고', () => {
  assert.match(lv, /최고가 <span id="lv-recHigh">—<\/span>/);
  assert.match(lv, /최저가 <span id="lv-recLow">—<\/span>/);
  assert.doesNotMatch(css, /gradient|--font-mono|--font-display|#(?:E5|EF|DC|D9|C0|B9)[0-9A-F]{4}|--negative|--positive|red|blue/i);
  assert.match(lv, /aria-label="내집로그 지도로 가기"><span class="lmark"[^>]*>[\s\S]*?<\/span>내집로그<\/button>/);
  assert.doesNotMatch(lv, /myhomelog|01 · |02 · |03 · /);
  assert.match(lv, /<h1 class="lv-h1">우리 아파트, 최근 얼마에<br>거래됐을까요\?<\/h1>/);
  assert.match(lv, /매수·매도 추천이 아니에요\. 출처 국토교통부 실거래가/);
});

test('검색: 두 글자 미만은 막고, 넘기면 소개를 닫고 기존 헤더 검색 흐름(_rerunSearch)을 탄다', () => {
  const s = fn('_landingSearch');
  assert.match(s, /if \(q\.length < 2\)/);
  assert.match(s, /_landingDismiss\('search'\);/);
  assert.match(s, /_rerunSearch\(q\)/);
  assert.match(lv, /<form class="lv-search" role="search" onsubmit="return _landingSearch\(event\)">/);
  // 구 행 → 지도 화면의 그 구(구 경계 색 구역 보기)
  assert.match(fn('_lvRegion'), /_hpPick\('서울'\); _hpReg = String\(lawd\); _hpRegShow\(\);/);
});

// QA-2026-10-27: 전 기능 점검에서 찾은 표시 결함 — 데이터는 맞았고 표기가 틀렸던 것들
test('QA 10-27: 브리핑 동기화 날짜는 한국 날짜 · 목록 개수는 "N곳 중 상위 M곳" · 가중 평균 표기 · 특약 "전세 낀 집" 인식', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(`${fn('_kstMD')}; globalThis.f = _kstMD;`, ctx);
  assert.equal(ctx.f('2026-10-20T17:45:11.648+00:00'), '10.21', '10.21 02:45 KST 적재가 10.20 으로 보였다');
  assert.equal(ctx.f(''), '');
  assert.doesNotMatch(html, /String\(dc\.lastIngestedAt\)\.slice\(5,10\)/);
  assert.match(html, /곳 중 점수 상위 \$\{props\.length\}곳/);
  assert.match(html, />6개월 가중 평균<\/span>/);
  assert.doesNotMatch(html, /<span class="ld-m">6개월 평균<\/span>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8'), /건 거래 · 가중 평균 \$\{avgAuk\}억/);
  assert.match(html, /if \(\/전세\|세입자\|임차\/\.test\(issues\)\)/);
});

test('QA 10-27: 지역 페이지는 정식 단지명 · 서버 페이지 라벨 한글 · 지도 팝업은 사실(180일 건수·평균)', () => {
  const rp = fs.readFileSync(path.join(__dirname, '../routes/regionPage.js'), 'utf8');
  assert.match(rp, /getAliasCanonicalMap\(\[region\.lawdCd\]\)/);
  assert.match(rp, /esc\(showName\(it\.aptName, it\.umdNm\)\)/);
  assert.match(rp, /esc\(showName\(a\.apt_name, a\.umd_nm\)\)/);
  for (const f of ['aptPage', 'regionPage', 'briefing', 'dataSources']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, `../routes/${f}.js`), 'utf8'), /MYHOMELOG [A-Z]+/, `${f} 영문 라벨`);
  }
  assert.doesNotMatch(html, /데이터 분석 대기<br>/);
  assert.match(html, /최근 180일 실거래 <b/);
  assert.doesNotMatch(html, /HOUSING DATA TERMINAL<\/span>/);
  assert.doesNotMatch(html, /30초 만에 만드는 맞춤 보고서|30초 입력으로 받는/);
});

test('GU-RANK·POPUP-RECENT 10-27: 구 순위는 TOP10 에 있을 때만(단지 번호 또는 이름+동) · 팝업 최근 거래는 같은 조회 경로·실패 시 줄 제거', () => {
  const gr = fn('_fillGuRank');
  assert.match(gr, /if\(i < 0 \|\| document\.getElementById\('t0GuRank'\) !== el\) return;/, '없으면 아무것도 쓰지 않는다');
  assert.match(gr, /\(p\.aptSeq && x\.aptSeq && x\.aptSeq === p\.aptSeq\)/);
  assert.match(gr, /nm\(x\.aptName\) === nm\(p\.aptName\) && \(!x\.umdNm \|\| !p\.umdNm \|\| x\.umdNm === p\.umdNm\)/);
  assert.match(html, /setTimeout\(\(\) => \{ try \{ _fillGuRank\(p\); \} catch\(_\)\{\} \}, 0\);/);
  const rc = fn('_niwRecentFill');
  assert.match(rc, /fetchRecentTx\(String\(p\.lawdCd\), p\.aptName, umd\)/);
  assert.match(rc, /if\(!rows\.length\)\{ el\.remove\(\); return; \}/);
  assert.match(html, /\$\{_niwRecentSlot\(p\)\}/);
});

test('POPUP-RECENT 보정: 팝업 내용은 마커 생성 때 미리 만들어지므로, 여는 두 곳에서 채우기를 시작한다', () => {
  assert.equal((html.match(/iw\.open\(mapObj, ?ov\); _niwKick\(\);/g) || []).length, 2);
  assert.match(fn('_niwRecentSlot'), /_niwPending\.set\(id, p\);/);
  assert.doesNotMatch(fn('_niwRecentSlot'), /setTimeout\(\(\) => _niwRecentFill/, '생성 시점에 채우면 팝업이 아직 없다');
});
