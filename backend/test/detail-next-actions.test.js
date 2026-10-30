/**
 * backend/test/detail-next-actions.test.js
 *
 * Plan 150 — 단지 상세 "다음에 할 일"(디자인 규칙 v2 화면 A). feature-links.test.js 와 같은 방식:
 * index.html 소스를 읽어 배선을 고정하고, 순수에 가까운 함수는 가짜 DOM 으로 실제 실행한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

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

// 새 영역 JS 블록 전체(상수 + 함수) — 표식 주석부터 다음 기존 함수 앞까지.
const JS_START = html.indexOf('// ════ NEXT-ACTIONS-2026-10-15 (Plan 150)');
const JS_END = html.indexOf('// 특약 생성 완료 → 관심단지 저장', JS_START);
assert.ok(JS_START > 0 && JS_END > JS_START, 'Plan 150 JS 블록을 찾지 못했다');
const NXT_JS = html.slice(JS_START, JS_END);

// 가짜 DOM + 기존 함수 실물(_escHtml·_fmtSgg·toggleCmp)로 블록을 실행한다.
function makeCtx(opts = {}) {
  const log = { toasts: [], calls: [], bodyClass: new Set() };
  const sidoNames = opts.chips || ['', '서울', '경기', '인천', '부산', '대구', '대전'];
  const chips = sidoNames.map((n) => {
    const c = { dataset: { sido: n }, cls: new Set(n === '' ? ['chip', 'on'] : ['chip']) };
    c.classList = { add: (x) => c.cls.add(x), remove: (x) => c.cls.delete(x), contains: (x) => c.cls.has(x), toggle: () => {} };
    c.parentElement = { querySelectorAll: () => chips };
    return c;
  });
  const subsList = { dataset: opts.subsLoaded ? { loaded: '1' } : {} };
  const document = {
    querySelectorAll: (sel) => {
      if (sel === '#subs-sido .chip[data-sido]') return chips;
      if (sel === '.htab') return [{}, {}, {}, {}, {}, { htab5: true }, {}];
      if (sel.startsWith('.cmp-chk-input')) return [];
      return [];
    },
    querySelector: () => null,
    getElementById: (id) => (id === 'subsList' ? subsList : null),
    body: { classList: { add: (x) => log.bodyClass.add(x), remove: (x) => log.bodyClass.delete(x) } },
  };
  const ctx = {
    document, props: opts.props || [], cmpSel: new Set(), _cmpExtra: {}, CMP_MAX: 6, currentDetail: null,
    toast: (m) => log.toasts.push(m),
    getBookmarks: () => opts.bookmarks || [],
    _aptKey: (p) => (p.aptSeq ? String(p.aptSeq) : `composite:${p.aptName}`),
    _ensureCmpStyles: () => {}, renderCmpBar: () => {},
    sv: (v) => log.calls.push(['sv', v, chips.filter((c) => c.cls.has('on')).map((c) => c.dataset.sido)]),
    loadSubs: () => log.calls.push(['loadSubs', chips.filter((c) => c.cls.has('on')).map((c) => c.dataset.sido)]),
    openRegionSummary: (...a) => log.calls.push(['openRegionSummary', ...a]),
    console,
  };
  vm.createContext(ctx);
  // `let`/`const` 최상위 선언은 ctx 프로퍼티로 안 보이므로, 함수와 함께 한 스크립트로 실행한 뒤 전역에 노출한다.
  vm.runInContext(
    extractFn(html, '_escHtml') + '\n' + extractFn(html, '_fmtSgg') + '\n' + extractFn(html, 'toggleCmp') + '\n' + extractFn(html, '_bkIndex') + '\n' + NXT_JS +
    '\nthis._NXT_SIDO=_NXT_SIDO;', ctx);
  return { ctx, log, chips, subsList };
}

const FULL = () => ({
  aptName: '은마', sigungu: '강남구', umdNm: '대치동', area: '강남구 대치동', lawdCd: '11680', aptSeq: '11680-218',
  avgPrice: 34.15, _priceBasis: '전 평형 최근 12건 평균', recentDealDate: '2026-10-02',
});

// ── 1) 구조: 새 영역이 있고, 옛 하단 버튼 3개는 새 영역으로 대체됐으며, 헤더 버튼은 남아 있다 ──────────
test('showDetail — 종합의견 하단이 _nxtHtml(p) 새 영역이고 옛 하단 버튼 3개는 사라졌다, 모달 헤더 버튼은 그대로다 (Plan 150)', () => {
  const sd = extractFn(html, 'showDetail');
  assert.ok(sd.includes('${_nxtHtml(p)}'), 'showDetail 의 종합의견 템플릿이 _nxtHtml(p) 를 쓰지 않는다');
  assert.ok(!sd.includes('onclick="goCalcFromDetail(${p.avgPrice||0})"'), '옛 "대출 계산" 하단 버튼이 남아 있다');
  assert.ok(!sd.includes('onclick="goClauseFromCurrentDetail()"'), '옛 "특약 초안 만들기" 하단 버튼이 남아 있다');
  assert.ok(!sd.includes('>도우미에게 시세 묻기<'), '옛 "도우미에게 시세 묻기" 하단 버튼이 남아 있다');
  assert.ok(sd.includes('_nxtRenderMobile(p)'), '모바일 하단 바 렌더 호출이 없다');
  // 헤더(카드·공유·관심 추가)는 유지
  assert.match(html, /<button class="bk-btn" id="cardBtn" onclick="openShareCard\(\)"/);
  assert.match(html, /<button class="bk-btn" id="shareBtn" onclick="shareCurrent\(\)"/);
  assert.match(html, /<button class="bk-btn" id="bkToggle" onclick="toggleBookmark\(\)">관심 추가<\/button>/);
  // 상단 "OO구 시장 요약" 버튼(.rg-open)도 그대로
  assert.ok(sd.includes("openRegionSummary(_lc, _nm)"), '상단 시장 요약 버튼이 사라졌다');
});

test('_nxtHtml — 제목·주 행동 띠·보조 4·텍스트 5·푸터가 사양 순서대로 나온다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  const out = ctx._nxtHtml(FULL());
  assert.ok(out.includes('<h3 class="nxt-t" id="nxtT">다음에 할 일</h3>'));
  assert.ok(out.includes('이 단지 평균가로 대출 한도를 계산해요'));
  assert.ok(out.includes('<span>대출 계산</span>'), '데스크톱 주 버튼 문구는 "대출 계산"(사양)');
  const labels = [...out.matchAll(/<span class="nx-l">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    '비교에 담기', '관심 추가', '특약 초안 만들기', '서울 청약 일정 보기',
    '강남구 시장 요약', '지금 집으로 갈아타기 계산', '데이터 도우미에게 시세 묻기', '공유', '실거래 카드 저장', '단지 페이지 열기',
  ]);
  // 보조 4(.nx-b) 와 텍스트 5(.nx-t) 의 구분
  assert.equal((out.match(/class="nx-b[ "]/g) || []).length, 4);
  assert.equal((out.match(/class="nx-t[ "]/g) || []).length, 6); // Plan 155: 지금 집으로 갈아타기 계산
  assert.ok(out.includes('매수·매도 추천이 아니에요. 출처 국토교통부 실거래가'));
  assert.ok(out.includes('최근 거래 2026.10.02'));
  assert.ok(out.includes('<span class="nx-n">새 탭</span>'));
});

// ── 2) 각 버튼이 올바른 기존 함수를 부른다 ───────────────────────────────────────────────
test('_nxtHtml — 각 버튼이 기존 동작 함수에 연결된다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  const out = ctx._nxtHtml(FULL());
  const oc = (key) => { const m = out.match(new RegExp(`data-nxt="${key}"[^>]*onclick="([^"]*)"`)); assert.ok(m, `${key} 버튼 없음`); return m[1]; };
  assert.equal(oc('calc'), 'goCalcFromDetail(34.15)', '주 버튼은 p.avgPrice 를 goCalcFromDetail 에 넘긴다');
  assert.equal(oc('bk'), 'toggleBookmark()');
  assert.equal(oc('clause'), 'goClauseFromCurrentDetail()');
  assert.equal(oc('cmp'), 'nxtToggleCmp()');
  assert.equal(oc('subs'), 'nxtOpenSubs()');
  assert.equal(oc('region'), 'nxtOpenRegion()');
  assert.equal(oc('share'), 'shareCurrent()');
  assert.equal(oc('card'), 'openShareCard()');
  assert.match(oc('ask'), /^askP\('%EC%9D%80%EB%A7%88','34\.15','[^']*'\);cDM\(\)$/, '도우미 묻기는 askP(이름,평균가,지역);cDM() 옛 호출과 같다');
  const page = out.match(/<a class="nx-t" data-nxt="page" href="([^"]*)" target="_blank" rel="noopener">/);
  assert.ok(page, '단지 페이지 링크는 새 탭(target=_blank rel=noopener)이어야 한다');
  assert.equal(page[1], '/apt/11680-218');
  // 래퍼 함수는 기존 함수를 그대로 부른다
  assert.ok(extractFn(html, 'nxtOpenRegion').includes('openRegionSummary(lc,'));
  assert.ok(extractFn(html, 'nxtToggleCmp').includes('toggleCmp(k, true)') && extractFn(html, 'nxtToggleCmp').includes('toggleCmp(k, false)'));
});

// ── 3) 조건부 숨김 ──────────────────────────────────────────────────────────────────────
test('숨김 1 — lawdCd 가 없으면 시장 요약과 청약 일정 버튼이 없다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  const p = FULL(); p.lawdCd = '';
  const out = ctx._nxtHtml(p);
  assert.ok(!out.includes('data-nxt="region"') && !out.includes('시장 요약'));
  assert.ok(!out.includes('data-nxt="subs"'));
  assert.ok(out.includes('data-nxt="share"'), '다른 버튼은 남는다');
});

test('숨김 2 — 청약 화면 시도 칩에 없는 시도거나 칩이 아예 없으면 청약 버튼이 없다 (Plan 150)', () => {
  const sejong = makeCtx();
  const p = FULL(); p.lawdCd = '36110'; // 세종 — 칩 목록(서울·경기·인천·부산·대구·대전)에 없다
  assert.ok(!sejong.ctx._nxtHtml(p).includes('data-nxt="subs"'));
  assert.equal(sejong.ctx._nxtSido(p), '');
  const noChip = makeCtx({ chips: ['', '경기'] }); // 서울 칩이 사라진 가정 — DOM 이 근거다
  assert.equal(noChip.ctx._nxtSido(FULL()), '');
  assert.ok(!noChip.ctx._nxtHtml(FULL()).includes('data-nxt="subs"'));
  const gg = FULL(); gg.lawdCd = '41135';
  assert.equal(makeCtx().ctx._nxtSido(gg), '경기');
});

test('숨김 3 — aptSeq 가 없거나 /apt/:aptSeq 형식(^\\d{5}-\\d+$)이 아니면 단지 페이지 링크가 없다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  for (const bad of [null, '', 'abc', '11680', '1168-218', '11680-', '11680-2x', '../x', '11680-218/../x']) {
    const p = FULL(); p.aptSeq = bad;
    assert.ok(!ctx._nxtHtml(p).includes('data-nxt="page"'), `aptSeq=${bad} 인데 링크가 있다`);
  }
  assert.ok(ctx._nxtHtml(FULL()).includes('href="/apt/11680-218"'));
  // 서버 라우트가 받는 형식과 같다는 근거
  assert.ok(read('../routes/aptPage.js').includes('/^\\d{5}-\\d+$/.test(seq)'), 'aptPage.js 의 aptSeq 형식이 바뀌었다 — _nxtAptSeq 도 다시 확인');
  assert.ok(extractFn(html, '_nxtAptSeq').includes('/^\\d{5}-\\d+$/'));
});

test('숨김 4 — avgPrice 가 없으면 주 행동 띠를 숨기고, 모바일 주 버튼도 없다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  const p = FULL(); p.avgPrice = 0;
  const out = ctx._nxtHtml(p);
  assert.ok(!out.includes('nxt-band') && !out.includes('goCalcFromDetail'));
  assert.ok(out.includes('다음에 할 일'), '나머지 영역은 남는다');
});

// ── 4) 주 행동 띠 설명: 기간은 실제 라벨만 ─────────────────────────────────────────────────
test('주 행동 띠 설명 — p._priceBasis 라벨을 그대로 쓰고, 없으면 기간을 지어내지 않는다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  let p = FULL();
  assert.ok(ctx._nxtHtml(p).includes('전 평형 최근 12건 평균 34.15억을 매수가로 넣어 계산 화면을 열어요'));
  p = FULL(); p._priceBasis = '내 평형대 · 6개월 가중평균(최근 거래 가중)';
  assert.ok(ctx._nxtHtml(p).includes('내 평형대 · 6개월 가중평균(최근 거래 가중) 34.15억을 매수가로 넣어 계산 화면을 열어요'));
  p = FULL(); p._priceBasis = null;
  const out = ctx._nxtHtml(p);
  assert.ok(out.includes('이 단지 평균가 34.15억을 매수가로 넣어 계산 화면을 열어요'));
  assert.ok(!/최근 \d+개월/.test(out), '근거 없는 "최근 N개월" 단정이 있다');
  // 라벨은 이스케이프된다
  p = FULL(); p._priceBasis = '<b>x</b>';
  assert.ok(!ctx._nxtHtml(p).includes('<b>x</b>'));
});

// ── 5) 비교 담기 ────────────────────────────────────────────────────────────────────────
test('nxtToggleCmp — 담기·빼기 라벨, 검색 결과에 있으면 같은 인덱스, 최대 개수 초과는 기존 안내 (Plan 150)', () => {
  const p = FULL();
  const { ctx, log } = makeCtx({ props: [{ aptName: '다른', sigungu: '강남구', umdNm: '대치동' }, { aptName: '은마', sigungu: '강남구', umdNm: '대치동' }] });
  ctx.currentDetail = p;
  assert.equal(ctx._nxtCmpKey(p), 1, 'props 에 같은 단지가 있으면 그 인덱스를 쓴다(목록 체크박스와 한 항목)');
  ctx.nxtToggleCmp();
  assert.ok(ctx.cmpSel.has(1));
  assert.equal(log.toasts.at(-1), '비교에 담았어요 (1/6)');
  assert.ok(ctx._nxtHtml(p).includes('비교에서 빼기'), '담긴 단지는 "비교에서 빼기" 로 보인다');
  ctx.nxtToggleCmp();
  assert.ok(!ctx.cmpSel.has(1));
  assert.equal(log.toasts.at(-1), '비교에서 뺐어요');
  assert.ok(ctx._nxtHtml(p).includes('비교에 담기'));
});

test('nxtToggleCmp — 검색 결과에 없는 단지는 문자열 키로 담고 최대 6개를 넘기면 기존 안내만 띄운다 (Plan 150)', () => {
  const p = FULL();
  const { ctx, log } = makeCtx({ props: [] });
  ctx.currentDetail = p;
  const k = ctx._nxtCmpKey(p);
  assert.equal(typeof k, 'string');
  ctx.nxtToggleCmp();
  assert.ok(ctx.cmpSel.has(k));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._cmpExtra[k])), { aptName: '은마', sigungu: '강남구', umdNm: '대치동', lawdCd: '11680' });
  ctx.nxtToggleCmp();
  assert.ok(!ctx.cmpSel.has(k) && !(k in ctx._cmpExtra), '뺄 때 보조 저장소도 비운다');
  for (let i = 0; i < 6; i++) ctx.cmpSel.add(i);
  ctx.nxtToggleCmp();
  assert.ok(!ctx.cmpSel.has(k), '최대 개수 초과인데 담겼다');
  assert.ok(!(k in ctx._cmpExtra), '담기지 않았는데 보조 저장소가 남았다');
  assert.equal(log.toasts.at(-1), '비교는 최대 6개까지 담을 수 있어요', '기존 toggleCmp 안내와 같은 문구여야 한다');
  assert.ok(!log.toasts.includes('비교에 담았어요 (7/6)'));
});

test('openCompare — 문자열 키(상세에서 담은 단지)도 비교 입력으로 변환한다 (Plan 150)', () => {
  const fn = extractFn(html, 'openCompare');
  assert.ok(fn.includes("typeof i==='string'?_cmpExtra[i]:props[i]"), 'openCompare 가 보조 저장소를 읽지 않는다');
  assert.ok(extractFn(html, 'clearCmp').includes('delete _cmpExtra[k]'), 'clearCmp 가 보조 저장소를 비우지 않는다');
  assert.ok(extractFn(html, 'renderCmpBar').includes('_nxtRefresh()'), '비교 상태가 바뀔 때 상세 라벨을 갱신하지 않는다');
  assert.ok(extractFn(html, 'renderBookmarks').includes('_nxtRefresh()'), '관심 상태가 바뀔 때 상세 라벨을 갱신하지 않는다');
});

// ── 6) 청약 일정 보기 ────────────────────────────────────────────────────────────────────
test('nxtOpenSubs — 시도 칩을 먼저 고른 뒤 청약 화면을 열고, 이미 불러온 적이 있을 때만 loadSubs 를 다시 부른다 (Plan 150)', () => {
  // 처음 진입: sv('subs') 가 스스로 loadSubs 를 부르므로(index.html sv 안) 여기서 또 부르면 요청이 엇갈린다.
  const first = makeCtx({ subsLoaded: false });
  first.ctx.currentDetail = FULL();
  first.ctx.nxtOpenSubs();
  assert.deepEqual(first.log.calls, [['sv', 'subs', ['서울']]], '칩이 sv 호출 전에 서울로 바뀌어 있어야 하고, 처음엔 loadSubs 를 직접 부르지 않는다');
  // 재진입: 이미 불러온 목록이면 sv 가 loadSubs 를 안 부르므로 직접 부른다.
  const again = makeCtx({ subsLoaded: true });
  again.ctx.currentDetail = FULL();
  again.ctx.nxtOpenSubs();
  assert.deepEqual(again.log.calls, [['sv', 'subs', ['서울']], ['loadSubs', ['서울']]]);
  assert.ok(again.chips.filter((c) => c.cls.has('on')).length === 1, '칩 선택은 하나여야 한다');
  // 근거: sv 안에서 처음 진입일 때만 loadSubs
  assert.ok(html.includes("if(v==='subs' && !document.getElementById('subsList').dataset.loaded){loadSubs();}"));
  // 시도 코드표는 서버 region.js 의 SIDO_BY_PREFIX 와 같은 값
  const region = read('../routes/region.js');
  for (const [pfx, name] of Object.entries(first.ctx._NXT_SIDO)) {
    assert.ok(new RegExp(`\\b${pfx}: '${name}'`).test(region), `${pfx} → ${name} 가 region.js 와 다르다`);
  }
  // 청약 화면의 시도 칩이 실제로 이 6개를 갖는다
  for (const name of Object.values(first.ctx._NXT_SIDO)) assert.ok(html.includes(`data-sido="${name}" onclick="cpSubs(this,'sido')"`), `${name} 칩이 청약 화면에 없다`);
});

test('nxtOpenRegion — lawdCd 로만 openRegionSummary 를 부른다 (Plan 150)', () => {
  const { ctx, log } = makeCtx();
  ctx.currentDetail = FULL();
  ctx.nxtOpenRegion();
  assert.deepEqual(log.calls, [['openRegionSummary', '11680', '강남구']]);
  const none = makeCtx();
  const p = FULL(); p.lawdCd = '';
  none.ctx.currentDetail = p;
  none.ctx.nxtOpenRegion();
  assert.deepEqual(none.log.calls, []);
});

// ── 7) 관심 라벨 ────────────────────────────────────────────────────────────────────────
test('관심 버튼 — 이미 관심이면 "관심 해제" 로 보인다 (Plan 150)', () => {
  const { ctx } = makeCtx({ bookmarks: [{ aptName: '은마', aptKey: '11680-218' }] });
  assert.ok(ctx._nxtHtml(FULL()).includes('관심 해제'));
  const none = makeCtx();
  assert.ok(none.ctx._nxtHtml(FULL()).includes('관심 추가'));
});

test('관심 판정 — 같은 이름이라도 저장 항목의 aptKey 가 다르면 "관심 추가" 로 보인다 (Plan 157)', () => {
  const { ctx } = makeCtx({ bookmarks: [{ aptName: '은마', aptKey: '99999-1' }] });
  const h = ctx._nxtHtml(FULL());
  assert.ok(h.includes('관심 추가'));
  assert.ok(!h.includes('관심 해제'));
});

test('관심 판정 — 키 없는 옛 항목은 이름으로 맞춰 "관심 해제" 로 보인다 (Plan 157)', () => {
  const { ctx } = makeCtx({ bookmarks: [{ aptName: '은마' }] });
  assert.ok(ctx._nxtHtml(FULL()).includes('관심 해제'));
});

test('관심 판정 — 토글·다음 할 일·상세 헤더가 모두 _bkIndex 를 쓴다 (Plan 157)', () => {
  assert.ok(extractFn(html, 'toggleBookmark').includes('_bkIndex('));
  assert.ok(extractFn(html, '_nxtIsBk').includes('_bkIndex('));
  const m = html.match(/const isBk=[^\n]*/);
  assert.ok(m && m[0].includes('_bkIndex('));
});

// ── 8) 모바일: 하단 고정 바 + 더보기 시트 ──────────────────────────────────────────────────
test('모바일 — 더보기 시트의 행 순서가 사양과 같고, 하단 바에는 주 버튼과 aria-label "더보기" 가 있다 (Plan 150)', () => {
  const els = {};
  const mk = (id) => (els[id] = { id, innerHTML: '', textContent: id === 'dmT' ? '은마' : '', _cls: new Set(), classList: { add(c) { els[id]._cls.add(c); }, remove(c) { els[id]._cls.delete(c); }, contains: (c) => els[id]._cls.has(c) }, setAttribute() {}, focus() {} });
  ['dmNxtBar', 'dmNxtRows', 'dmNxtSheetT', 'dmNxtSheetF', 'dmT', 'dmNxtSheet', 'dmNxtDim'].forEach(mk);
  const { ctx } = makeCtx();
  ctx.document.getElementById = (id) => els[id] || null;
  ctx.currentDetail = FULL();
  ctx._nxtRenderMobile(FULL());
  assert.ok(els.dmNxtBar.innerHTML.includes('aria-label="더보기"'));
  assert.ok(els.dmNxtBar.innerHTML.includes('aria-label="평균가로 대출 계산"') && els.dmNxtBar.innerHTML.includes('onclick="goCalcFromDetail(34.15)"'));
  assert.ok(els.dmNxtBar._cls.has('on'));
  assert.equal(els.dmNxtSheetT.textContent, '은마에서 할 수 있는 일');
  const labels = [...els.dmNxtRows.innerHTML.matchAll(/<span class="nx-l">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    '비교에 담기', '관심 추가', '특약 초안 만들기', '서울 청약 일정 보기', '강남구 시장 요약',
    '지금 집으로 갈아타기 계산', '데이터 도우미에게 시세 묻기', '공유', '실거래 카드 저장', '단지 페이지 열기',
  ], '더보기 시트 순서가 사양과 다르다');
  assert.ok(els.dmNxtRows.innerHTML.includes('onclick="closeDmNxtSheet(true);nxtToggleCmp()"'), '행을 누르면 시트를 닫고 동작을 부른다');
  assert.ok(els.dmNxtSheetF.innerHTML.includes('평균가로 대출 계산') && els.dmNxtSheetF.innerHTML.includes('매수·매도 추천이 아니에요'));
  // 평균가가 없으면 주 버튼이 없다(더보기는 남는다)
  const p0 = FULL(); p0.avgPrice = 0;
  ctx._nxtRenderMobile(p0);
  assert.ok(!els.dmNxtBar.innerHTML.includes('평균가로 대출 계산') && els.dmNxtBar.innerHTML.includes('더보기'));
});

test('모바일 — 분기 폭은 상세 모달이 전체 화면이 되는 기존 600px 이고, 시트는 ESC·포커스 가둠에 등록돼 있다 (Plan 150)', () => {
  // 새 CSS 의 모바일 분기는 기존 .dm 전체 화면 규칙과 같은 폭
  assert.match(html, /@media\(max-width:600px\)\{[^@]*?\.dmbg\{padding:var\(--biz-top,54px\) 0 0!important;align-items:stretch!important\}\s*\n\s*\.dm\{max-width:100%!important/, '기존 상세 모달 전체 화면 분기가 600px 가 아니다');
  assert.match(html, /@media\(max-width:600px\)\{\r?\n  \.nxt-band\{display:none\}/, '새 영역 모바일 분기가 600px 가 아니다');
  // 데스크톱에서는 하단 바·시트가 기본 숨김(.nxb,.nxs,.nxs-dim{display:none}) 이고 모바일 분기에서만 켜진다
  assert.ok(html.includes('.nxb,.nxs,.nxs-dim{display:none}'));
  assert.ok(html.includes('.nxb.on{display:flex}') && html.includes('.nxs.open{display:flex}'));
  // ESC: 공유 closers 레지스트리 맨 앞에 등록
  assert.match(html, /const closers = \[\s*\n\s*\{ id: 'dmNxtSheet', fn: 'closeDmNxtSheet' \}/);
  // 포커스 가둠: 시트가 열려 있고 포커스가 안이면 시트 안에서만 Tab 순환
  assert.ok(html.includes("if(_sh&&_sh.classList.contains('open')&&_sh.contains(document.activeElement)) return _sh;"));
  // 시트 마크업: 대화상자 + 이름 연결, 닫기 44x44 + aria-label
  assert.match(html, /<div class="nxs" id="dmNxtSheet" role="dialog" aria-modal="true" aria-labelledby="dmNxtSheetT">/);
  assert.match(html, /<button type="button" class="nxs-x" aria-label="닫기" onclick="closeDmNxtSheet\(\)">/);
  // 시트 열림 시 첫 행으로 포커스, 닫힘 시 더보기 버튼으로 복귀
  assert.ok(extractFn(html, 'openDmNxtSheet').includes("sh.querySelector('.nxs-r')") && extractFn(html, 'openDmNxtSheet').includes('first.focus()'));
  assert.ok(extractFn(html, 'closeDmNxtSheet').includes('mb.focus()'));
  // 모달을 닫으면 바·시트도 정리
  assert.ok(extractFn(html, 'cDM').includes('_nxtClear()'));
});

// ── 9) 토큰만 쓴다 ──────────────────────────────────────────────────────────────────────
test('새 영역 CSS — 직접 색은 시안의 시트 딤 rgba(14,21,32,.48) 하나뿐이다 (Plan 150)', () => {
  const s = html.indexOf('/* NEXT-ACTIONS-2026-10-15 (Plan 150, 디자인 규칙 v2 화면 A)');
  const e = html.indexOf('body.dm-nxs-open .cmp-bar{display:none}', s);
  assert.ok(s > 0 && e > s);
  const css = html.slice(s, e).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '새 영역 CSS 에 16진 색이 있다');
  const rgbs = css.match(/rgba?\([^)]*\)/g) || [];
  assert.deepEqual(rgbs, ['rgba(14,21,32,.48)']);
  assert.ok(!/font-size:(?!12px|14px|16px|20px)\d+px/.test(css), '글자 크기가 12·14·16·20 밖이다');
});

test('새 영역 마크업 — 이모지·화살표·줄표 나열 없이 Lucide 인라인 SVG 만 쓴다 (Plan 150)', () => {
  const { ctx } = makeCtx();
  const out = ctx._nxtHtml(FULL());
  assert.ok(!/[→←↗↘▶▲▼✓✕]|—|–|\p{Extended_Pictographic}/u.test(out.replace(/<svg[\s\S]*?<\/svg>/g, '')), '화살표·줄표·이모지가 있다');
  assert.equal((out.match(/<svg class="nx-ic"[^>]*aria-hidden="true"/g) || []).length, 11, '버튼 10개와 주 버튼의 아이콘이 모두 장식(aria-hidden)이어야 한다');
});
