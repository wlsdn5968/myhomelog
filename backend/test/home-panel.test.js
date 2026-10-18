/**
 * backend/test/home-panel.test.js
 *
 * Plan 151 — 첫 화면(지도 화면) 왼쪽 패널 "최근 거래가 많은 단지" (시안 화면 B).
 * 지키는 것:
 *   ① 인기 API 에는 가장 최근 단건 거래가가 없다 — 가격 칸은 "60일 평균가"(avgDealAmount) 로만 표기한다.
 *   ② 지역 칩은 받은 데이터에 있는 시도만 — 없는 지역(예: 서울 0건)의 칩을 만들어 빈 목록을 보이지 않는다.
 *   ③ 사이드바 노드는 지우지 않는다 — doSearch·renderPList·cl·renderBookmarks 가 널 가드 없이 읽는다.
 *   ④ 지도 화면만 패널, 목록 화면은 사이드바 유지.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const regionJs = fs.readFileSync(path.join(__dirname, '../routes/region.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾지 못했다`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 닫는 중괄호를 찾지 못했다`);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`));
  assert.ok(m, `${name} 상수를 찾지 못했다`);
  return m[0];
}

// 가짜 DOM 으로 _hpRender 를 실제 실행한다.
function runRender(data, sido) {
  const els = { hpList: { innerHTML: '' }, hpChips: { innerHTML: '' }, hpSub: { title: '' } };
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    console,
  };
  vm.createContext(ctx);
  const code = [
    extractConst(html, '_HP_SIDO'),
    `let _hpData = null, _hpSido = '전국';`,
    'const UNNAMED_RE = /^\\(?\\s*\\d+(?:-\\d+)?\\s*\\)?$/;',
    'const JIBUN_SUFFIX_RE = /\\s*\\(\\s*(\\d+(?:-\\d+)?)\\s*\\)\\s*$/;',
    ...['_hpSidoOf', '_hpRender', '_escHtml', '_jsonAttr', '_fmtSgg', '_isUnnamedApt', '_dispAptName'].map(n => extractFn(html, n)),
    'globalThis.__set = (d, s) => { _hpData = d; _hpSido = s; };',
    'globalThis.__render = _hpRender;',
    'globalThis.__sido = () => _hpSido;',
  ].join('\n');
  vm.runInContext(code, ctx);
  ctx.__set(data, sido || '전국');
  ctx.__render();
  return { els, sido: ctx.__sido() };
}

const SAMPLE = {
  results: [
    { aptName: '벽적골우성', displayName: '벽적골우성', aptSeq: '41117-37', lawdCd: '41117', sigungu: '수원시영통구', umdNm: '영통동', buildYear: 1998, dealCount60d: 60, avgDealAmount: 51571, recentDealDate: '2026-10-16', lat: 37.2, lng: 127.0 },
    { aptName: '대연롯데캐슬', lawdCd: '26290', sigungu: '남구', umdNm: '대연동', dealCount60d: 30, avgDealAmount: 80000, recentDealDate: '2026-10-10', lat: 35.1, lng: 129.1 },
    { aptName: '부평아이파크', lawdCd: '28237', sigungu: '부평구', umdNm: '부평동', dealCount60d: 25, avgDealAmount: 0, recentDealDate: '2026-10-09', lat: 37.5, lng: 126.7 },
  ],
  window: { days: 60, since: '2026-08-18', until: '2026-10-17' },
};

test('Plan 151 ①: 패널 마크업 — 가격 칸은 "60일 평균가", "최근 거래가" 칸 이름을 쓰지 않는다', () => {
  const aside = html.match(/<aside class="hp" id="homePanel"[\s\S]*?<\/aside>/);
  assert.ok(aside, '#homePanel 이 없다');
  assert.ok(aside[0].includes('<span class="c2">60일 평균가</span>'));
  assert.ok(!/최근 거래가<\/span>/.test(aside[0]), '단건 가격 필드가 없는데 "최근 거래가" 칸 이름이 있다');
  assert.ok(aside[0].includes('최근 60일 국토교통부 실거래 신고 기준이에요'));
  assert.ok(aside[0].includes('매수·매도 추천이 아니에요'), '면책 문구');
  assert.ok(aside[0].includes(`onclick="sv('report')">내 조건으로 맞춤 보고서 받기</button>`));
  // 위치: .app 안, 사이드바(.lp) 뒤·지도 화면 앞 (flex 가로 배치)
  const iApp = html.indexOf('<div class="app">'), iLp = html.indexOf('<div class="lp">'), iHp = html.indexOf('id="homePanel"'), iMap = html.indexOf('id="view-map"');
  assert.ok(iApp < iLp && iLp < iHp && iHp < iMap, '패널 위치가 .lp 와 #view-map 사이가 아니다');
});

test('Plan 151 ①: 행 가격은 avgDealAmount(만원) → 억, 값이 없으면 빈칸(지어내지 않는다)', () => {
  const { els } = runRender(SAMPLE);
  const h = els.hpList.innerHTML;
  assert.ok(h.includes('<span class="hp-pr">5.16억</span>'), h.slice(0, 400));
  assert.ok(h.includes('<span class="hp-ct">60건</span>'));
  assert.ok(h.includes('<span class="hp-pr"></span>'), '평균가 0 인 행은 빈칸이어야 한다');
  assert.ok(h.includes('경기 수원시 영통구 영통동'), '지역 = 시도 + 시군구 + 동');
  assert.ok(h.includes('부산 남구 대연동'), '같은 이름의 구(남구)는 시도로 구별');
  assert.ok(h.includes('goSearchResult('), '행은 단지 상세(goSearchResult)로');
  assert.ok(!/최근 거래가/.test(h));
  assert.ok(els.hpSub.title.includes('2026.08.18부터 2026.10.17까지'), '집계 기간은 서버 window 값');
  assert.ok(els.hpSub.title.includes('자리가 남으면 넘는 단지도 채워요'), '선정 기준은 지도 범례와 같은 문장(시군구 2곳 캡의 예외 포함)');
  assert.ok(runRender({ results: SAMPLE.results }).els.hpSub.title.startsWith('최근 21일'), 'window 가 없어도 선정 기준 문장은 남는다');
});

test('Plan 151 ②: 지역 칩은 데이터에 있는 시도만 — 서울 0건이면 서울 칩이 없다', () => {
  const { els } = runRender(SAMPLE);
  const c = els.hpChips.innerHTML;
  for (const s of ['전국', '경기', '부산', '인천']) assert.ok(c.includes(`>${s}</button>`), `${s} 칩이 없다`);
  assert.ok(!c.includes('>서울</button>'), '데이터에 없는 서울 칩이 생겼다');
  assert.ok(c.includes('aria-pressed="true"'));
  // 칩 필터
  const busan = runRender(SAMPLE, '부산').els.hpList.innerHTML;
  assert.ok(busan.includes('대연롯데캐슬') && !busan.includes('벽적골우성'));
  // 사라진 지역이 선택돼 있으면 전국으로 되돌린다
  assert.equal(runRender(SAMPLE, '서울').sido, '전국');
  // 시도가 하나뿐이면 칩 줄 자체를 만들지 않는다
  const one = runRender({ results: [SAMPLE.results[0]] });
  assert.equal(one.els.hpChips.innerHTML, '');
});

test('Plan 151: 대체 경로(degraded) 응답이면 평균가·건수 칸을 비운다 — 그 값은 최근 1건 가격·2주 표본 건수', () => {
  const h = runRender({ ...SAMPLE, degraded: true }).els.hpList.innerHTML;
  assert.ok(h.includes('평균가와 건수는 잠시 비워 둬요'));
  assert.ok(!h.includes('5.16억') && !h.includes('60건'));
  assert.ok(h.includes('벽적골우성'), '단지 목록 자체는 보인다');
  const search = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(search, /const payload = \{ results: out, window: popularWindow\(\) \};[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(usedFallback\) payload\.degraded = true;/);
});

test('Plan 151: 목록 화면에서 시작한 검색은 끝나도 지도로 옮기지 않는다 · 단지 없이 안내만 오면 목록 화면으로', () => {
  const ds = extractFn(html, 'doSearch');
  assert.ok(ds.includes("window._searchStartV = (typeof _hpView === 'string') ? _hpView : null;"));
  assert.match(ds, /if \(_nowTab === window\._searchStartView && window\._searchStartV !== 'list'\) \{\s*if \(!_realN && window\.innerWidth > 700\) sv\('list'\);\s*else sv\('map',document\.querySelector\('\.htab'\)\);/);
  // '지방' 세부 미선택 안내: 로딩 카드 되돌림 + 데스크톱 지도 화면이면 목록 화면(세부 칩이 보이는 곳)으로
  const i = ds.indexOf("if(getRegionForSearch()==='지방'){");
  const blk = ds.slice(i, ds.indexOf('return;', i));
  assert.ok(blk.includes('renderListGrid()') && blk.includes("sv('list')"));
});

test('Plan 151: 검색 띠는 패널이 켜진 지도 화면에서만(저장소 예외로 hp-on 이 없으면 빈 띠가 보이지 않게)', () => {
  assert.ok(html.includes('body.hp-on #hpBand{display:block;'));
  assert.ok(!/\n\s*#hpBand\{display:block/.test(html), '조건 없는 #hpBand 표시 규칙이 남아 있다');
});

test('Plan 151: 빈 응답·stale 응답 안내', () => {
  assert.ok(runRender({ results: [] }).els.hpList.innerHTML.includes('지금 보여 드릴 단지가 없어요'));
  assert.ok(runRender({ ...SAMPLE, stale: true }).els.hpList.innerHTML.includes('집계가 잠시 늦어져'));
});

test('Plan 151: 시도 표는 서버 SIDO_BY_PREFIX 와 같다', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(extractConst(html, '_HP_SIDO') + ';globalThis.F=_HP_SIDO;', ctx);
  const m = regionJs.match(/const SIDO_BY_PREFIX = (\{[\s\S]*?\});/);
  assert.ok(m, 'region.js SIDO_BY_PREFIX 를 찾지 못했다');
  const back = vm.runInNewContext('(' + m[1] + ')');
  const norm = o => JSON.stringify(Object.keys(o).map(String).sort().map(k => [k, o[k]]));
  assert.equal(norm(ctx.F), norm(back));
});

test('Plan 151 ④: 지도 화면만 사이드바를 숨기고 목록 화면은 유지 · sv 가 _hpApply 를 부른다', () => {
  assert.match(html, /map:\s*\{display:'flex', lp:false, rp:true\}/);
  assert.match(html, /list:\s*\{display:'grid', lp:true,\s*rp:false\}/);
  assert.ok(extractFn(html, 'sv').includes('_hpApply(v);'));
  assert.match(html, /@media\(min-width:701px\)\{\s*\n\s*body\.hp-on \.lp\{display:none!important\}/);
  const apply = extractFn(html, '_hpApply');
  assert.ok(apply.includes("window.innerWidth > 700"), '모바일(≤700px)에는 패널을 켜지 않는다(151b 전까지)');
  assert.ok(extractFn(html, 'renderMarkers').includes('_hpNote(fl)'), '안내 개수는 필터 적용 뒤 목록 기준');
  assert.ok(extractFn(html, 'showPop').includes('_hpNote(null)'));
});

test('Plan 151 ③: 사이드바 노드는 그대로 있다(숨김만 — 삭제하면 널 오류)', () => {
  for (const id of ['srchBtn', 'srchSp', 'srchTx', 'pList', 'pCnt', 'bkList', 'bkCnt', 'lr', 'lA', 'bp', 'mc', 'inc', 'wp', 'wizHome', 'wizCore', 'dealTracker']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} 가 정확히 1개가 아니다`);
  }
});

test('Plan 151: 검색창은 노드 하나를 옮긴다(이중 입력칸 없음)', () => {
  assert.equal((html.match(/id="hSearchInput"/g) || []).length, 1);
  assert.equal((html.match(/id="hpSearchSlot"/g) || []).length, 1);
  const place = extractFn(html, '_hpSearchPlace');
  assert.ok(place.includes('slot.appendChild(hs)') && place.includes('insertBefore(hs, _hpSearchPh)'));
});
