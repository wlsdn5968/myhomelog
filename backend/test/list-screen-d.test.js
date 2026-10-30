/**
 * backend/test/list-screen-d.test.js
 *
 * Plan 163 — 목록 화면 결과 영역(시안 화면 D).
 * 지키는 것: 점수는 숫자+막대 한 가지(점수 기준 "거래활발" 배지 없음) · 표본 건수는 있을 때만 ·
 *   평형 3칸 · 비교 버튼은 카드 클릭과 분리 · 검색 전 문구 · 소스 고정(다크 결함, 사이드바 숨김, 모달 가두기).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

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

// renderListGrid / _renderListCard 를 가짜 DOM 으로 실제 실행한다.
function run({ props, searchMeta = null, cmp = [], flt = 'all' }) {
  const view = { innerHTML: '', classList: { add() {} } };
  const ctx = {
    props,
    searchMeta,
    cmpSel: new Set(cmp),
    window: { _lstFlt: flt },
    console,
    document: {
      getElementById: (id) => (id === 'view-list' ? view : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    _isRegProp: () => false,
    _regLtvLabel: () => '70%',
    _dispAptName: (n) => n,
  };
  vm.createContext(ctx);
  const code = [
    ...['_escHtml', '_fmtSgg', '_fmtEok', '_cardMaxLoan', '_renderListCard', 'renderListGrid'].map((n) => extractFn(html, n)),
    'globalThis.__render = renderListGrid;',
  ].join('\n');
  vm.runInContext(code, ctx);
  ctx.__render();
  return view.innerHTML;
}

const APT = (over) => ({
  aptName: '테스트단지', area: '강남구 역삼동', buildYear: 2005, avgPrice: 12.345, score: 78,
  ltv: '70%', maxLoan: '5.0억', lawdCd: '11680', pros: '역세권', tags: ['역세권', { t: '대단지', c: 'gn' }],
  currentPriceByPyeong: [{ pyeong: 25, recentAvg: 11.2 }, { pyeong: 33, recentAvg: 13.5 }, { pyeong: 40, recentAvg: 16 }],
  priceSampleN: 12, ...over,
});
const META = { regions: ['강남구'], totalAptsInRegion: 1234, inBudget: 56, totalTx: 300 };

// 카드 하나의 마크업만 잘라 본다
function cardHtml(over) {
  const out = run({ props: [APT(over)], searchMeta: META });
  const a = out.indexOf('<div class="ld-card"');
  assert.ok(a >= 0, '카드가 그려지지 않았다');
  return out.slice(a, out.indexOf('<div class="ld-foot">'));
}

test('Plan 163 (a): 결과 머리·점수 안내·면책 한 줄이 있고 거래량 배지·빨간 면책 상자는 없다', () => {
  const out = run({ props: [APT(), APT({ aptName: '둘째단지', score: 40 })], searchMeta: META });
  assert.ok(out.includes('예산 안에 드는 단지'));
  assert.ok(out.includes('56건'));
  assert.ok(out.includes('점수는 과거 실거래 통계로'));
  assert.ok(out.includes('매수·매도 추천이 아니에요'));
  for (const bad of ['거래활발', '거래보통', '거래적음', '아래 점수와 신호는']) {
    assert.ok(!out.includes(bad), `"${bad}" 가 남아 있다`);
  }
});

test('Plan 163 (b): 점수 막대 채움 폭 = 점수%, 점수 없으면 분석 대기에 막대 없음', () => {
  assert.ok(cardHtml({ score: 78 }).includes('width:78%'));
  const none = cardHtml({ score: null });
  assert.ok(none.includes('분석 대기'));
  assert.ok(!none.includes('ld-bar'));
});

test('Plan 163 (c): 표본 건수는 priceSampleN 이 있을 때만', () => {
  assert.ok(cardHtml({ priceSampleN: 12 }).includes('표본 12건'));
  assert.ok(!cardHtml({ priceSampleN: undefined }).includes('표본'));
  assert.ok(!cardHtml({ priceSampleN: 0 }).includes('표본'));
});

test('Plan 163 (d): 평형이 1개뿐이면 나머지 2칸은 —', () => {
  const c = cardHtml({ currentPriceByPyeong: [{ pyeong: 25, recentAvg: 11.2 }] });
  const pyg = c.slice(c.indexOf('<div class="ld-pyg">'), c.indexOf('<div class="ld-c-loan">'));
  assert.ok(pyg.includes('25평') && pyg.includes('11.20억'));
  assert.equal((pyg.match(/<b>—<\/b>/g) || []).length, 2);
});

test('Plan 163 (e): 비교 버튼은 aria-pressed · 카드 클릭과 분리 · 담긴 카드는 true', () => {
  const off = cardHtml({});
  assert.match(off, /<button type="button" class="ld-cmp" aria-pressed="false"/);
  assert.ok(off.includes('event.stopPropagation()'));
  assert.ok(off.includes('toggleCmp('));
  const on = run({ props: [APT()], searchMeta: META, cmp: [0] });
  assert.ok(on.includes('aria-pressed="true"') && on.includes('담았어요'));
});

test('Plan 163 (f): 결과가 없으면 검색 전 문구와 면책', () => {
  const out = run({ props: [] });
  assert.ok(out.includes('단지 찾기를 눌러 주세요'));
  assert.ok(out.includes('매수·매도 추천이 아니에요'));
});

test('Plan 163 (g): 소스 고정 — 다크 결함 제거 · 사이드바 결과 숨김 · 모달 가두기', () => {
  assert.ok(!extractFn(html, 'setLstFilter').includes('#fff'));
  assert.match(html, /@media\(min-width:701px\)\{\s*#s3\{display:none!important\}\s*\}/);
  const m = html.match(/const MODAL_SEL='([^']*)'/);
  assert.ok(m && m[1].includes('#toolsSheet'));
  // 사이드바 결과 노드는 지우지 않는다
  assert.equal((html.match(/id="pList"/g) || []).length, 1);
  // 새 CSS 블록에 hex 색 직접 지정이 없다
  const a = html.indexOf('/* LIST-D-2026-10-18 (Plan 163): 시안 화면 D 결과 영역');
  const b = html.indexOf('.lc-top{', a);
  assert.ok(a >= 0 && b > a);
  assert.ok(!/:[^;{}]*#[0-9a-fA-F]{3,8}\b/.test(html.slice(a, b)), '새 CSS 에 hex 색이 있다');
});

test('검색 — 지도 표시가 실패해도 목록은 그린다(옛 마커 정리 실패 삼킴) (MARKER-SAFE)', () => {
  assert.ok(html.includes("renderPList();try{ renderMarkers(props); }catch(e){ console.warn('지도 표시 실패 — 목록은 계속', e); }renderListGrid();"));
  assert.equal(html.split("(window._popMarkers||[]).forEach(o=>{ try{ if(o._isNaver)o.setMap&&o.setMap(null); else o.remove&&o.remove(); }catch(_){} });").length - 1, 2);
});
