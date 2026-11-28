/**
 * plans/215 (감사 3차 남은 화면 항목, 운영자 승인 2026-11-27): 본문 바로가기(8), 다크 기본값(9), 대출 입력 안내와 연소득 상한(10),
 *  특약 초안 오류 때 이전 초안 숨김(11), 관심 단지 가격 기준 문구(12), 임장노트 저장 직후 기록 삭제 단추(14).
 * 실행: cd backend && TZ=UTC node --test test/ux-215-1128.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

const html = readIndexHtml();
const FRONT = path.join(__dirname, '../../frontend');
function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error(`${name} 의 끝을 찾지 못했다`);
}

// ── 9 다크 기본값 ──
const THEME_RE = /\(function\(\)\{try\{var t=localStorage\.getItem\('mhl_theme'\);[^\n]*?\}\)\(\);/;
function runTheme(src, { stored, sysDark, hasMM = true }) {
  const attrs = {}; let meta = '#173A63';
  const ctx = {
    localStorage: { getItem: () => stored },
    window: hasMM ? { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' && sysDark }) } : {},
    document: {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
      querySelector: () => ({ setAttribute: (_k, v) => { meta = v; } }),
    },
  };
  vm.runInNewContext(src, ctx);
  return { dark: attrs['data-theme'] === 'dark', meta };
}

test('다크 기본값: 저장값이 없을 때만 시스템 다크를 따르고, 주소창 색도 맞춘다(다섯 페이지 같은 줄)', () => {
  for (const f of ['index.html', 'billing.html', 'privacy.html', 'refund.html', 'terms.html']) {
    const s = fs.readFileSync(path.join(FRONT, f), 'utf8');
    const m = s.match(THEME_RE);
    assert.ok(m, `${f} 첫 스크립트`);
    const src = m[0];
    assert.deepEqual(runTheme(src, { stored: null, sysDark: true }), { dark: true, meta: '#0F131A' }, f);
    assert.deepEqual(runTheme(src, { stored: null, sysDark: false }), { dark: false, meta: '#173A63' }, f);
    assert.deepEqual(runTheme(src, { stored: 'light', sysDark: true }), { dark: false, meta: '#173A63' }, `${f}: 단추로 고른 밝게는 유지`);
    assert.deepEqual(runTheme(src, { stored: 'dark', sysDark: false }), { dark: true, meta: '#0F131A' }, f);
    assert.deepEqual(runTheme(src, { stored: null, sysDark: true, hasMM: false }), { dark: false, meta: '#173A63' }, `${f}: matchMedia 없는 브라우저`);
    assert.ok(!s.includes("(function(){try{if(localStorage.getItem('mhl_theme')==='dark')"), `${f}: 옛 줄이 남지 않았다`);
  }
});

// ── 8 본문 바로가기 ──
test('본문 바로가기: 헤더보다 앞의 링크가 본문 틀(id appMain, tabindex -1)을 가리키고 평소에는 화면 밖에 있다', () => {
  const iLink = html.indexOf('<a class="skip-link" href="#appMain" onclick="return _skipToMain(event)">본문으로 건너뛰기</a>');
  assert.ok(iLink > 0);
  // 주소에 #appMain 을 남기지 않는다(첫 화면 코드는 해시가 있으면 소개 화면을 건너뛴다). 보이는 화면으로 초점을 옮긴다.
  let prevented = false; let focused = null;
  const mk = (id, display) => ({ id, display, attrs: {}, hasAttribute(k) { return k in this.attrs; }, setAttribute(k, v) { this.attrs[k] = v; }, focus() { focused = this.id; } });
  const views = [mk('view-map', 'none'), mk('view-landing', 'block')];
  const app = mk('appMain', 'flex');
  new Function('env', `with(env){ ${fnSrc('_skipToMain')}; _skipToMain({preventDefault(){ env.prevented(); }}); }`)({
    prevented: () => { prevented = true; },
    document: { querySelectorAll: () => views, getElementById: () => app },
    getComputedStyle: (el) => ({ display: el.display }),
  });
  assert.equal(prevented, true, '기본 이동(주소 해시)을 막는다');
  assert.equal(focused, 'view-landing', '보이는 화면으로 초점');
  assert.equal(views[1].attrs.tabindex, '-1');
  assert.ok(iLink < html.indexOf('<header>'), '첫 Tab 에 닿게 헤더보다 앞');
  assert.equal(html.split('id="appMain"').length - 1, 1);
  assert.ok(html.includes('<div class="app" id="appMain" tabindex="-1">'));
  assert.match(html, /\.skip-link\{position:absolute;left:8px;top:-60px;/);
  assert.match(html, /\.skip-link:focus\{top:8px;/);
});

// ── 10 대출 입력 ──
test('연소득 상한: 100억 원(1,000,000만 원)까지 받고 넘으면 문구를 돌려준다', () => {
  const sb = {};
  vm.runInNewContext(readFrontendJs('calc.js') + '\nthis.f=calcInputProblem;', sb);
  const base = { buy: 10, ratePct: 4, yrs: 30, ex: 0, cash: 3, cl: 0, jl: 0 };
  assert.equal(sb.f({ ...base, inc: 1000000 }), '');
  assert.equal(sb.f({ ...base, inc: 1000001 }), '연소득을 다시 확인해 주세요(100억 원까지 넣을 수 있어요)');
  assert.equal(sb.f({ ...base, inc: 8000 }), '');
  assert.equal(sb.f({ ...base, inc: NaN }), '', '빈 칸은 종전처럼 통과');
});

test('금리와 기간 0: 계산은 종전 기본값 그대로, 결과 위 안내 줄(c_note)에 알린다', () => {
  const dc = fnSrc('dc');
  assert.ok(html.includes('<div id="c_note" role="status"'));
  assert.ok(html.indexOf('id="c_note"') < html.indexOf('<div id="co"'), '결과보다 위');
  assert.match(dc, /if\(_num\('c_r'\)===0\)_notes\.push\(`금리가 0이라 시중 평균 \$\{window\._ecosMortgageRate\|\|4\}% 로 계산했어요`\)/);
  assert.match(dc, /if\(parseInt\(document\.getElementById\('c_y'\)\?\.value\)===0\)_notes\.push\('기간이 0년이라 30년으로 계산했어요'\)/);
  // 계산 줄(기본값 대체)은 그대로다
  assert.match(dc, /rate=\(parseFloat\(document\.getElementById\('c_r'\)\?\.value\)\|\|window\._ecosMortgageRate\|\|4\)\/100,yrs=parseInt\(document\.getElementById\('c_y'\)\?\.value\)\|\|30/);
  // 안내는 입력 검사를 통과한 뒤에만 보인다(오류면 안내 없음)
  assert.ok(dc.indexOf('if(_prob){') < dc.indexOf("_notes.push(`금리가 0"));
});

// ── 11 특약 초안 ──
test('특약 초안: 입력 오류면 이전 초안을 숨기고 단추 아래 오류 줄에 같은 문구를 보인다', () => {
  const g = fnSrc('genClause');
  assert.ok(html.includes('<div id="cl_err" role="alert"'));
  const iProb = g.indexOf('if(_clProb){');
  assert.ok(iProb > 0);
  const block = g.slice(iProb, g.indexOf('toast(_clProb);return;', iProb));
  assert.match(block, /_clRes\.style\.display='none'/);
  assert.match(block, /_clErr\.textContent=_clProb;_clErr\.style\.display='block'/);
  assert.ok(g.indexOf("_clErr.style.display='none'") < iProb, '다시 만들 때는 오류 줄을 먼저 지운다');
  // 반증 검토 지적 B: 단지명을 비운 경우도 이전 초안을 숨긴다(실제 실행)
  const els = { cl_apt: { value: '  ' }, cl_result: { style: { display: 'block' } }, cl_err: { style: { display: 'none' }, textContent: '' } };
  let toasted = '';
  new Function('env', `with(env){ (${g.replace(/^async /, 'async ')})(); }`)({
    document: { getElementById: (id) => els[id] || null }, toast: (m) => { toasted = m; },
  });
  assert.equal(els.cl_result.style.display, 'none');
  assert.equal(els.cl_err.style.display, 'block');
  assert.equal(els.cl_err.textContent, '단지명을 입력해 주세요');
  assert.equal(toasted, '단지명을 입력해 주세요');
  // 반증 검토 지적 A: 이력을 불러올 때 오류 줄을 지운다
  const lh = fnSrc('loadClauseHistory');
  assert.ok(lh.indexOf("_e.style.display='none'") > 0 && lh.indexOf("_e.style.display='none'") < lh.indexOf("getElementById('cl_result').style.display='block'"));
});

// ── 12 관심 단지 기준 문구 ──
test('관심 단지: 담을 때 기준 문구를 저장하고, 로그인 합치기에서 이 기기 가격과 함께 옮기고, 목록과 팝오버가 이스케이프해 보인다', () => {
  assert.match(fnSrc('toggleBookmark'), /priceBasis: \(p\.avgPrice>0 && p\._priceBasis\) \? String\(p\._priceBasis\) : undefined,/);
  assert.match(html, /priceBasis: \(lb\?\.avgPrice > 0 && lb\?\.priceBasis\) \? lb\.priceBasis : undefined,/);
  const rb = fnSrc('renderBookmarks');
  assert.match(rb, /priceNow\.toFixed\(2\)\+'억'/);
  assert.match(rb, /\$\{_escHtml\(b\.priceBasis\)\}/);
  assert.ok(!/priceNow\.toFixed\(1\)/.test(rb), '목록도 소수 둘째 자리');
  assert.match(fnSrc('toggleBmPop'), /\$\{_escHtml\(b\.priceBasis\)\}/);
});

// ── 14 임장노트 기록 삭제 단추 ──
test('임장노트: 처음 저장한 직후 기록 삭제 단추 자리를 채우고, 빈 기록이면 채우지 않는다', () => {
  const run = (memo) => {
    const slot = { innerHTML: '' };
    const store = {};
    const env = {
      getNoteForApt: () => ({}), saveNoteForApt: (_a, v) => { store.v = v; },
      document: { getElementById: (id) => (id === 'fn-del-x' ? slot : id === 'fn-memo-x' ? { value: memo } : id === 'fn-date-x' ? { value: '' } : null) },
      toast: () => {}, renderBookmarks: () => {}, _syncFieldNote: () => {},
      _escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    };
    new Function('env', `with(env){ ${fnSrc('_fnDelBtnHtml')}; ${fnSrc('saveFieldNote')}; saveFieldNote('상계주공7단지','x'); }`)(env);
    return slot.innerHTML;
  };
  const filled = run('남향, 놀이터 가까움');
  assert.match(filled, /clearFieldNote\(&quot;상계주공7단지&quot;\)/);
  assert.match(filled, />기록 삭제<\/button>/);
  assert.equal(run(''), '', '빈 기록은 단추 없음');
  assert.ok(html.includes('<span id="fn-del-${safeId}">${hasNote?_fnDelBtnHtml(nJs):\'\'}</span>'), '칸을 그릴 때도 같은 단추');
});
