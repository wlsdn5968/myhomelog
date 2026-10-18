/**
 * backend/test/header-v2.test.js
 *
 * Plan 152 — 헤더 v2(시안 화면 B 헤더). 지키는 것:
 *   ① 헤더 전용 토큰(--hd-*)이 v2 토큰에 연결된다(골드 테마 제거, 다크는 v2 토큰이 맡는다).
 *   ② 데스크톱 시안 값: 높이 64·좌우 24, 로고 20/700, 내비 36·좌우 12·선택 prit, 다크/알림 40×40, 로그인 보조 40.
 *   ③ 다른 상시 경로가 없는 기능(알림 벨·데이터 상태·로그인·다크 모드·헤더 검색)은 남는다.
 *   ④ 탭 DOM 순서·개수는 그대로(htabOrder·querySelectorAll('.htab')[N] 인덱스 코드가 의존).
 *   ⑤ 헤더 높이에 맞춘 절대 배치 뷰 오프셋(64 + 동기화 띠 실측 32.2 → 96).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const i0 = html.indexOf('HEADER-V2-2026-10-18 (Plan 152');
const i1 = html.indexOf('/* Sprint PPPPP: 보고서 입력 위저드', i0);
assert.ok(i0 > 0 && i1 > i0, 'HEADER-V2 블록 경계 표식을 찾지 못했다');
const css = html.slice(i0, i1);

test('Plan 152 ①: 헤더 토큰을 v2 토큰에 연결 — 골드 값이 블록 안에 없다', () => {
  assert.ok(i0 > 0, 'HEADER-V2 블록이 없다');
  assert.ok(css.includes('header:not(.lv-top),html[data-theme="dark"] header:not(.lv-top){'), '라이트·다크를 한 규칙으로, 소개 화면 헤더(.lv-top) 제외');
  for (const kv of ['--hd-navy:var(--acc-bg)', '--hd-tab:var(--t2)', '--hd-tab-act:var(--acc)', '--hd-tab-act-bg:var(--accent-tint)', '--hd-bd:var(--bd)', '--hd-menu-bg:var(--bg-base)', '--hd-logo-ink:var(--acc-ink)', 'background:var(--bg-base);border-bottom:1px solid var(--bd)']) {
    assert.ok(css.includes(kv), kv);
  }
  assert.ok(!/#C98A00|#FFC93C/i.test(css), '골드 값이 남아 있다');
  // 이 블록이 앞선 골드 블록보다 뒤에 있어야 이긴다(같은 선택자)
  assert.ok(i0 > html.indexOf('--hd-navy:#C98A00'), 'v2 블록이 골드 블록보다 앞에 있다');
});

test('Plan 152 ②: 데스크톱 시안 값', () => {
  const m = css.slice(css.indexOf('@media(min-width:701px){'));
  // 데스크톱 값은 ≥701px 미디어 블록 안에 있어야 한다(모바일 헤더 폭 예산으로 새지 않게)
  const mq = css.indexOf('@media(min-width:701px){'), hdr = css.indexOf('header:not(.lv-top){height:64px;padding:0 24px}');
  assert.ok(mq > 0 && hdr > mq && css.slice(mq, hdr).split('{').length - css.slice(mq, hdr).split('}').length === 1, '높이 64 규칙이 ≥701px 블록 안에 있지 않다');
  assert.ok(m.includes('width:40px;height:40px;padding:0!important'), '인라인 padding 을 이기는 !important');
  assert.ok(m.includes('header .hml > .hbtn{flex-shrink:0}'));
  assert.ok(css.includes('@media(min-width:701px) and (max-width:900px){ header:not(.lv-top){padding:0 16px;gap:10px}'));
  assert.ok(css.includes('html:not([data-theme="dark"]) header .acct-sw .knob{background:var(--t1)}'), '라이트 스위치 손잡이 대비');
  assert.ok(m.includes('header .ltxt{font-size:20px;font-weight:700;'));
  assert.ok(m.includes('height:36px;padding:0 12px;border-radius:6px;font-size:14px'));
  assert.ok(css.includes('header .htab.on,header .htab-tool.on{background:var(--accent-tint);color:var(--acc);'));
  assert.ok(css.includes('header .htabs > .htab.on::before,header .htab-tool.on::before{content:none}'), '골드 점 제거');
  assert.ok(m.includes('#themeToggle,#ntcBell{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;'));
  assert.ok(m.includes('#loginBtn{height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--bd2);background:var(--bg-base);color:var(--t1);font-size:14px;font-weight:600}'));
  assert.ok(css.includes('.lsub{display:none}'), '"HOUSING DATA TERMINAL" 부제는 시안에 없다');
});

test('Plan 152 ③: 다른 상시 경로가 없는 기능은 헤더에 남는다', () => {
  const h = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  for (const id of ['ntcBell', 'dataStatusBtn', 'loginBtn', 'themeToggle', 'hSearchInput', 'hUsage', 'acctDd']) {
    assert.ok(h.includes(`id="${id}"`), `#${id} 가 헤더에서 빠졌다`);
  }
});

test('Plan 152 ④: 탭 순서·개수 그대로', () => {
  assert.match(html, /const htabOrder=\['news','map','list','report','clause','subs','calc'\];/);
  const h = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  const order = [...h.matchAll(/<button class="htab[^"]*" onclick="sv\('([a-z]+)',this\)"/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 7), ['news', 'map', 'list', 'report', 'clause', 'subs', 'calc']);
});

test('Plan 152 ⑤ → VIEW-TOP: 절대 배치 뷰 위쪽 = 헤더·동기화 띠의 실제 아래 끝(고정값 대신 측정)', () => {
  assert.ok(html.includes('.clause-view{position:absolute;top:var(--biz-top,84px);'));
  assert.ok(html.includes('.biz-view{position:absolute;top:var(--biz-top,84px);'));
  assert.ok(html.includes('@media(min-width:701px){ .clause-view,.biz-view{top:var(--biz-top,96px)} }'));
  assert.ok(!/\.clause-view,\.biz-view\{top:\d+px\}/.test(html), '고정 px 값이 남아 있다');
  const i = html.indexOf('function _bizTop(){');
  const fn = html.slice(i, html.indexOf('\n}\n', i));
  assert.ok(fn.includes("document.querySelector('header:not(.lv-top)')"));
  assert.ok(fn.includes("getComputedStyle(sb).display !== 'none'"), '띠가 숨으면(모바일) 헤더 아래 끝까지만');
  assert.ok(fn.includes('offsetTop + h.offsetHeight') && fn.includes('offsetTop + sb.offsetHeight'), '스크롤과 무관한 offset 기준');
  assert.ok(html.includes("const ro = new ResizeObserver(_bizTop);"), '띠가 켜지고 꺼질 때 다시 잰다');
});
