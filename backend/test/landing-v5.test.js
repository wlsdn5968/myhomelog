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
  const els = { lvRecList: { innerHTML: '' } };
  const ctx = { document: { getElementById: (id) => els[id] || null } };
  vm.createContext(ctx);
  vm.runInContext([
    ...['_escHtml', '_jsonAttr', '_isUnnamedApt', '_dispAptName', '_lvAmt', '_lvDiff', '_lvRecCard', '_lvRecRender'].map(fn),
    'let _lvRec = null, _lvRecN = { high: null, low: null }, _lvRecFull = null, _lvRecOpen = { high: false, low: false }, _lvRecFullState = "";',
    'globalThis.set = (r, n) => { _lvRec = r; _lvRecN = n || { high: null, low: null }; }; globalThis.render = _lvRecRender; globalThis.diff = _lvDiff;',
  ].join('\n'), ctx);
  return { ctx, els };
}

test('경신 목록(시안 F): 높았던·낮았던 거래를 늘 함께, 한 문장·직전 대비 차이·계약일·층, 묶음당 3건, 이름 이스케이프', () => {
  const { ctx, els } = renderCtx();
  const row = (n, amt, prevMax, prevMin, extra) => ({ aptName: n, region: '수원시 영통구', umdNm: '매탄동', excluUseAr: 84.45, dealAmount: amt, prevMax, prevMin, dealDate: '2026-10-19', floor: 7, priorCount: 265, lawdCd: '41117', sigungu: '수원시영통구', buildYear: 2002, ...(extra || {}) });
  ctx.set({ high: [row('주공그린빌1', 58800, 54500, 36000), row('B', 1, 1, 1), row('C', 1, 1, 1), row('D', 1, 1, 1)], low: [row('<b>x</b>', 6700, 12000, 7000)] }, { high: 168, low: 68 });
  ctx.render();
  const h = els.lvRecList.innerHTML;
  assert.equal((h.match(/class="lv-card"/g) || []).length, 4, '높았던 3건 + 낮았던 1건 — 두 묶음을 함께 그린다');
  assert.ok(h.includes('같은 면적 이전 거래보다 높았어요<small>168건 중 3건</small>') && h.includes('같은 면적 이전 거래보다 낮았어요<small>68건 중 1건</small>'));
  assert.equal((h.match(/onclick="_lvRecMore\('(high|low)'\)"/g) || []).length, 2, '두 묶음 모두 "모두 보기"');
  assert.ok(h.includes('84.45㎡가 5억 8,800만에 거래돼 같은 면적 이전 거래 265건보다 높았어요'));
  assert.ok(h.includes('<span class="lv-chip">+4,300만</span><span>직전 최고 5억 4,500만</span>'));
  assert.ok(h.includes('주공그린빌1 · 수원시 영통구 매탄동 · 10.19 · 7층'));
  assert.ok(h.includes('6,700만에 거래돼 같은 면적 이전 거래 265건보다 낮았어요') && h.includes('<span class="lv-chip">−300만</span><span>직전 최저 7,000만</span>'), '낮았던 거래는 직전 최저와 비교');
  assert.ok(!h.includes('<b>x</b>') && h.includes('&lt;b&gt;'), '이름 이스케이프');
  assert.ok(!/역대|신고가/.test(h), '자극 단어 없음');
  assert.equal(ctx.diff(119900, 119500), '+400만'); assert.equal(ctx.diff(37000, 39000), '−2,000만'); assert.equal(ctx.diff(1, 1), ''); assert.equal(ctx.diff(null, 1), '');
  ctx.set({ high: [], low: [] }); ctx.render();
  assert.ok(els.lvRecList.innerHTML.includes('이번 주에는 이전 거래보다 높았던 거래가 없어요') && els.lvRecList.innerHTML.includes('이번 주에는 이전 거래보다 낮았던 거래가 없어요'));
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

test('모두 보기(시안 F): 펼치면 전체 목록(단지당 1건)과 "N건 중 단지 M곳", 접기 · 서버는 ?full=1 을 별도 캐시로', () => {
  const { ctx, els } = renderCtx();
  const row = (n) => ({ aptName: n, region: '화성시 동탄구', umdNm: '영천동', excluUseAr: 59.98, dealAmount: 119900, prevMax: 119500, prevMin: 56000, dealDate: '2026-10-27', floor: 18, priorCount: 265, lawdCd: '41597', sigungu: '화성시동탄구' });
  vm.runInContext('globalThis.openAll = (f) => { _lvRecFull = f; _lvRecOpen = { high: true, low: false }; };', ctx);
  ctx.set({ high: [row('A'), row('B'), row('C'), row('D')], low: [] }, { high: 168, low: 0 });
  ctx.openAll({ high: Array.from({ length: 160 }, (_, i) => row('H' + i)), low: [] });
  ctx.render();
  const h = els.lvRecList.innerHTML;
  assert.equal((h.match(/class="lv-card"/g) || []).length, 160);
  assert.ok(h.includes('168건 중 단지 160곳 · 같은 단지는 가장 최근 1건') && h.includes('>접기</button>'));
  const fs = require('fs'), path = require('path');
  const svc = fs.readFileSync(path.join(__dirname, '../services/priceRecordsService.js'), 'utf8');
  assert.ok(svc.includes("const CK_FULL = 'records:price:full:v1';") && svc.includes('p_limit: FULL_LIMIT'));
  const route = fs.readFileSync(path.join(__dirname, '../routes/transactions.js'), 'utf8');
  assert.ok(route.includes("if (String(req.query.full || '') === '1') {") && route.includes('svc.canonRecords({ ...full'));
  const cron = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  assert.equal((cron.match(/getPriceRecordsFull\(\{ force: true \}\)/g) || []).length, 2, '두 cron 경로 모두 전체 목록을 데운다');
});
