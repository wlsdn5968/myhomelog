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
  assert.ok(h.includes('<span class="hp-ct"><span class="hp-ctl">거래 </span>60건</span>'));
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
  assert.ok(apply.includes("window.innerWidth > 700"), '데스크톱·모바일 분기는 700px(CSS min-width:701px 와 같은 경계)');
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

test('Plan 151b: 모바일 목록 시트 — 시안 값(위 모서리 16·그림자·손잡이 36×4·행 최소 60)과 지도 줄임', () => {
  const i = html.indexOf('HOME-SHEET-2026-10-18 (Plan 151b');
  assert.ok(i > 0);
  const css = html.slice(i, html.indexOf('</style>', i));
  assert.ok(css.includes('border-radius:16px 16px 0 0;box-shadow:0 -4px 20px rgba(20,30,45,.1)'));
  assert.ok(css.includes('width:36px;height:4px'));
  assert.ok(css.includes('min-height:60px'));
  // 시트가 지도를 덮지 않고 지도를 줄인다 — 지도 출처 표기·로고·이 지역 단지 보기 버튼이 가려지지 않게
  assert.ok(css.includes('body.hp-on #mapEl{margin-bottom:var(--hps-pad,0px);'));
  for (const sel of ['#mMapCap', '#mhint', '.fab-ai', '.fab-bm', '.bm-pop']) assert.ok(css.includes(`body.hp-on ${sel}{bottom:calc(var(--hps-pad,0px)`), `${sel} 가 시트 위로 오르지 않는다`);
  assert.ok(css.includes('.app:has(#MSHEET.on) .hp,body.ms-open .hp{visibility:hidden}'), '마커 시트가 열리면 목록 시트를 내린다');
  // 시안에 없는 지역 칩·표 머리는 모바일에서 숨김, "거래 N건" 앞말은 모바일에서만
  assert.ok(css.includes('.hp-s,.hp-chips,.hp-th,.hp-rep p,.hp-ft-l{display:none!important}'));
  assert.ok(css.includes('.hp-ctl{display:inline}'));
  const { els } = runRender(SAMPLE);
  assert.ok(els.hpList.innerHTML.includes('<span class="hp-ct"><span class="hp-ctl">거래 </span>60건</span>'));
});

test('Plan 151b: 멈춤 3단계 — 기본은 지도 영역 52% 지점(시트 48%), 펼침은 위 8px, 접힘은 제목 줄 · 펼쳐도 지도는 다시 줄이지 않는다', () => {
  const props = {}; const cls = new Set(); const grab = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const ctx = {
    document: {
      body: { style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } }, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), remove: (c) => cls.delete(c) } },
      querySelector: (s) => (s === '.app' ? { clientHeight: 700 } : null),
      getElementById: (id) => (id === 'hpHd' ? { offsetTop: 0, offsetHeight: 56 } : id === 'hpGrab' ? grab : null),
    },
    setTimeout: () => 0, window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(['let _hpsState = \'base\', _hpsPad = -1, _hpsDragged = false;', ...['_hpsMetrics', '_hpMapResize', '_hpsSet', '_hpsTap'].map(n => extractFn(html, n)),
    'globalThis.S = _hpsSet; globalThis.T = _hpsTap; globalThis.st = () => _hpsState;'].join('\n'), ctx);
  ctx.S('base');
  assert.equal(props['--hps-h'], '336px'); assert.equal(props['--hps-pad'], '336px'); // 700 × 0.48
  ctx.T();
  assert.equal(ctx.st(), 'full'); assert.equal(props['--hps-h'], '692px'); assert.equal(props['--hps-pad'], '336px', '펼침은 지도 크기를 바꾸지 않는다');
  assert.ok(cls.has('hps-full')); assert.equal(grab.attrs['aria-expanded'], 'true');
  ctx.T(); assert.equal(ctx.st(), 'base');
  ctx.S('min'); assert.equal(props['--hps-h'], '56px'); assert.equal(props['--hps-pad'], '56px');
  ctx.T(); assert.equal(ctx.st(), 'base', '접힘에서 누르면 기본으로');
});

test('Plan 151b: _hpApply — 모바일 지도 화면이면 시트, 그 밖이면 시트 값을 걷는다', () => {
  const apply = extractFn(html, '_hpApply');
  assert.ok(apply.includes('if(on && !desk){ _hpsSet(_hpsState); _hpLoad(); }'));
  assert.ok(apply.includes('else _hpsClear();'));
  assert.ok(apply.includes('_hpSearchPlace(on && desk);'), '검색창은 데스크톱에서만 띠로');
});

test('Plan 151b: 끌기는 window 에서 이동·놓기를 받고 포인터 캡처를 쓰지 않는다 — 캡처하면 손잡이 click 이 죽고, hd 에만 걸면 마우스 첫 이동을 놓쳤다(375 실측)', () => {
  const i = html.indexOf("let y0 = 0, h0 = 0, id = null, moved = false, hp = null;");
  assert.ok(i > 0);
  const blk = html.slice(i, html.indexOf('})();', i));
  assert.ok(!blk.includes('setPointerCapture('), '포인터 캡처 금지');
  assert.ok(blk.includes("window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);"));
  assert.ok(blk.includes("window.removeEventListener('pointermove', move);"), '끝나면 window 리스너를 걷는다');
  assert.ok(blk.includes("if(e.pointerType === 'mouse' && e.buttons === 0){ end(e); return; }"), '놓기를 놓친 마우스는 끌기를 끝낸다');
});

test('Plan 151b 리뷰: 접힘이면 가려진 본문 숨김 · 홈 바 여백 · 마커 시트 :has 대체 · 지도 줄임 전환 · 손잡이 이름 고정', () => {
  const i = html.indexOf('HOME-SHEET-2026-10-18 (Plan 151b');
  const css = html.slice(i, html.indexOf('</style>', i));
  assert.ok(css.includes('body.hps-min .hp-note,body.hps-min .hp-list,body.hps-min .hp-rep,body.hps-min .hp-ft{visibility:hidden}'));
  assert.ok(css.includes('body.hp-on .hp{padding-bottom:max(0px,calc(env(safe-area-inset-bottom,0px) - 7px))}'));
  assert.ok(css.includes('.app:has(#MSHEET.on) .hp,body.ms-open .hp{visibility:hidden}'));
  assert.ok(css.includes('transition:margin-bottom .2s ease'));
  assert.ok(extractFn(html, '_mapSheetTry').includes("document.body.classList.add('ms-open')"));
  assert.ok(extractFn(html, 'closeMapSheet').includes("document.body.classList.remove('ms-open')"));
  assert.ok(html.includes('id="hpGrab" aria-label="목록 크기 조절" aria-expanded="false"'));
  assert.ok(html.includes('<span class="hp-sm">최근 60일</span>'), '"최근 60일" 은 스크린리더에도 읽힌다');
  assert.ok(extractFn(html, '_hpsSet').includes("b.classList.toggle('hps-min', state === 'min');"));
  // 낮은 화면에서 목록이 0 이 되지 않게 기본 높이 하한
  assert.ok(extractFn(html, '_hpsMetrics').includes('const floor = min + (rep ? rep.offsetHeight : 0) + (ft ? ft.offsetHeight : 0) + 60;'));
});

test('Plan 151b 보정: 지도 영역 크기 변화를 감시해 지도 SDK 에 알린다 — 고정 220ms 타이머는 전환(.2s)과 경쟁해 네이버 지도가 옛 크기를 유지했다(운영 실측)', () => {
  const i = html.indexOf("const me = document.getElementById('mapEl'); if(!me) return;");
  assert.ok(i > 0);
  const blk = html.slice(i, i + 300);
  assert.ok(blk.includes('new ResizeObserver(') && blk.includes('setTimeout(_hpMapResize, 60)') && blk.includes('.observe(me)'));
  assert.ok(!extractFn(html, '_hpsSet').includes('setTimeout(_hpMapResize, 220)'));
});
