/**
 * backend/test/header-more-menu.test.js
 *
 * Plan 153 — 헤더 더보기 메뉴(시안 화면 C, plans/design-spec-v2-screen-C-header-2026-10-18.md). 지키는 것:
 *   ① 데스크톱에서 벨·데이터 상태 버튼을 빼도 기능 길이 끊기지 않는다 — 로그아웃은 더보기, 로그인은 아바타 메뉴가
 *      알림 설정·데이터 상태·서비스 정보와 사용량·사용법을 모두 연다(로그아웃 상태 서비스 정보 창 경로도 새로 생김).
 *   ② 시안 순서·값(메뉴 280·항목 44·두 줄 56·빨간 점 8)과 다크 대체 토큰.
 *   ③ 빨간 점은 기존 알림 구독 조건(_ntcSubscribed) 하나로 움직인다.
 *   ④ 로그인하면 더보기를 숨기고, 메뉴는 바깥 클릭·ESC 로 닫힌다.
 *   ⑤ 모바일(≤700px)은 그대로 — 벨·데이터 상태 숨김 규칙은 데스크톱 미디어 안에만.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));

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

test('Plan 153 ①: 더보기 메뉴(로그아웃) — 시안 C1 순서, 각 항목이 실제 창을 연다', () => {
  const m = header.slice(header.indexOf('id="moreMenu"'), header.indexOf('</div>\n    </div>', header.indexOf('id="moreMenu"')));
  const order = [...m.matchAll(/onclick="closeMoreMenu\(\);([^"]+)"/g)].map(x => x[1]);
  assert.deepEqual(order, ['openNtc()', 'openDataStatus()', 'openSettings()', "sv('guide')"]);
  assert.ok(m.includes('알림 설정') && m.includes('데이터 상태') && m.includes('서비스 정보와 사용량') && m.includes('사용법'));
  assert.ok(header.includes('id="moreBtn" onclick="toggleMoreMenu(event)" aria-haspopup="true" aria-expanded="false" aria-label="더보기"'));
});

test('Plan 153 ①: 아바타 메뉴(로그인) — 시안 C2 순서, 다크 모드 항목 없음(헤더 아이콘에 있음)', () => {
  const a = header.slice(header.indexOf('id="acctMenu"')); // 계정 메뉴는 헤더 오른쪽 맨 끝(153 리뷰 M2 재배치)
  const order = [...a.matchAll(/onclick="closeAcctMenu\(\);([a-zA-Z]+)\(/g)].map(x => x[1]);
  assert.deepEqual(order, ['openUserMenu', 'openNtc', 'openDataStatus', 'openSettings', 'sv', 'logout']);
  assert.ok(!a.includes('toggleTheme()'), '계정 메뉴에 다크 모드 항목이 남아 있다');
  assert.ok(!a.includes('acct-sw'), '스위치 마크업이 남아 있다');
  assert.ok(a.includes('id="acctDqSub"'), '관리자 데이터 품질 줄(updateDataQuality)은 유지');
});

test('Plan 153 ②: 시안 값 — 메뉴·항목·점·칩', () => {
  const i = html.indexOf('HEADER-MORE-2026-10-18 (Plan 153, 시안 C — plans/design-spec-v2-screen-C-header');
  const css = html.slice(i, html.indexOf('/* Sprint PPPPP: 보고서 입력 위저드', i));
  assert.ok(i > 0);
  for (const v of ['width:280px;padding:6px 0;background:var(--bg-base);border:1px solid var(--bd);border-radius:8px;box-shadow:0 8px 24px rgba(20,30,45,.12)',
    'min-height:44px;padding:0 16px', 'min-height:56px!important', '.hd-mi svg,header .acct-it svg{width:18px;height:18px',
    'width:8px;height:8px;border-radius:50%;background:#B4473C;box-shadow:0 0 0 2px var(--bg-base)',
    '#hUsage{height:32px;padding:0 12px;border:1px solid var(--bd2);border-radius:6px',
    '#apiSt{height:32px;padding:0 12px;align-items:center;gap:8px;border:1px solid #B4473C;border-radius:6px;background:#F7E7E5;color:#8E3128',
    'html[data-theme="dark"] #apiSt{border-color:var(--danger-bd);background:var(--redL);color:var(--red)}',
    'html[data-theme="dark"] .hd-dot,html[data-theme="dark"] .hd-st::before{background:var(--red)}']) {
    assert.ok(css.includes(v), v);
  }
  // 오른쪽 순서(시안 C3): 장애 칩 · 남은 검색 · 다크 · 더보기 · 로그인/아바타 — CSS order 가 아니라 마크업 순서로(키보드 Tab 순서 = 화면 순서)
  const pos = ['apiSt', 'hUsage', 'themeToggle', 'moreDd', 'loginBtn', 'acctDd'].map(id => header.indexOf(`id="${id}"`));
  assert.ok(pos.every(x => x > 0) && pos.every((x, k) => k === 0 || x > pos[k - 1]), '마크업 순서가 화면 순서와 다르다: ' + pos);
  assert.ok(!/#apiSt\{order:|#loginBtn\{order:/.test(css), 'order 속성으로 순서를 바꾸면 Tab 순서가 어긋난다');
});

test('Plan 153 ③: 빨간 점은 기존 구독 조건 하나로', () => {
  const fn = extractFn(html, '_updateNtcDot');
  assert.ok(fn.includes("document.body.classList.toggle('ntc-unsub', !_ntcSubscribed());"));
  assert.ok(fn.includes("b.classList.toggle('unsub', !_ntcSubscribed());"), '모바일 벨 점도 그대로');
  assert.ok(html.includes('body.ntc-unsub .hd-dot{display:block}') && html.includes('body.ntc-unsub .hd-st{display:inline-flex}'));
});

test('Plan 153 ④: 로그인하면 더보기 숨김 · 바깥 클릭·ESC 로 닫힘 · 장애 칩은 데이터 상태를 연다', () => {
  const au = extractFn(html, '_updateAuthUi');
  assert.ok(au.includes("if(_md){ _md.style.display='none';"), '로그인 시 숨김');
  assert.ok(au.includes("if(_md) _md.style.display='';"), '로그아웃 시 CSS 에 맡김');
  assert.ok(/if\(md&&md\.classList\.contains\('open'\)&&!md\.contains\(e\.target\)\)closeMoreMenu\(\);/.test(html));
  const i = html.indexOf('const closers = [');
  const list = html.slice(i, html.indexOf('];', i));
  assert.ok(list.includes("{ id: 'moreDd', fn: 'closeMoreMenu' }") && list.includes("{ id: 'acctDd', fn: 'closeAcctMenu' }"));
  assert.ok(header.includes('id="apiSt" style="display:none" onclick="openDataStatus()"'));
  const chk = extractFn(html, 'chkAPI');
  assert.ok(chk.includes("el.textContent='서버에 연결되지 않아요'"));
  assert.ok(!chk.includes("el.style.background='var(--redL)'"), '인라인 색이 CSS(시안·다크 토큰)를 덮는다');
});

test('Plan 153 ⑤: 벨·데이터 상태 숨김은 데스크톱 미디어 안에서만(모바일 헤더 그대로)', () => {
  const k = html.indexOf('#ntcBell,#dataStatusBtn{display:none!important}');
  assert.ok(k > 0);
  const before = html.slice(html.lastIndexOf('@media', k), k);
  assert.ok(before.startsWith('@media(min-width:701px){'), '숨김 규칙이 ≥701px 미디어 안이 아니다');
  assert.ok(header.includes('id="ntcBell"') && header.includes('id="dataStatusBtn"'), '모바일용 노드는 남는다');
});

test('Plan 153 보정: 1120~1279px 에서 장애·남은 검색 칩이 함께면 장애 칩 우선(넘침 방지)', () => {
  assert.ok(html.includes('@media(min-width:1120px) and (max-width:1279px){ body.api-off #hUsage{display:none!important} }'));
  const chk = extractFn(html, 'chkAPI');
  assert.ok(chk.includes("document.body.classList.add('api-off')") && chk.includes("document.body.classList.remove('api-off')"));
});

test('Plan 153 리뷰 M1: 데이터 상태 둘째 줄 — 사라지는 #syncTime 대신 health 값, 모르면 지어내지 않는다', () => {
  const vm = require('node:vm');
  const run = (state) => {
    const els = [{ textContent: '', hidden: false }, { textContent: '', hidden: false }];
    const ctx = { window: state.window, document: { body: { classList: { contains: c => c === 'api-off' && !!state.off } }, querySelectorAll: () => els } };
    vm.createContext(ctx);
    vm.runInContext(extractFn(html, '_hdSyncLine') + ';_hdSyncLine();', ctx);
    return els[0];
  };
  assert.equal(run({ window: { _syncData: { kst: '10. 18. 02:45' }, _healthData: {} } }).textContent, '마지막 데이터 동기화 10. 18. 02:45 KST');
  const noTime = run({ window: { _syncData: { kst: null }, _healthData: {} } });
  assert.equal(noTime.textContent, ''); assert.equal(noTime.hidden, true, '응답은 왔는데 시각이 없으면 줄을 숨긴다');
  assert.equal(run({ window: {} }).textContent, '마지막 동기화 시각을 확인하는 중이에요', '응답 전');
  assert.equal(run({ window: { _syncData: { kst: '10. 18. 02:45' }, _healthData: {} }, off: true }).textContent, '서버에 연결되지 않아요', '장애 중');
  assert.ok(!extractFn(html, '_hdSyncLine').includes("getElementById('syncTime')"));
  assert.ok(html.includes('.hd-sub[hidden]{display:none}'), 'display:block 이 hidden 을 덮지 않게');
  assert.ok(extractFn(html, 'chkAPI').includes('_hdSyncLine();'), '메뉴를 연 채 health 가 와도 갱신');
});

test('Plan 153 리뷰 M3·L2: 헤더 메뉴는 하나만 열린다 · 도구 메뉴도 ESC · 버튼 이름에 알림 상태', () => {
  assert.ok(extractFn(html, 'toggleMoreMenu').includes('closeToolMenu(); closeAcctMenu();'));
  assert.ok(extractFn(html, 'toggleAcctMenu').includes('closeToolMenu(); closeMoreMenu();'));
  assert.ok(extractFn(html, 'toggleToolMenu').includes('closeMoreMenu(); closeAcctMenu();'));
  const i = html.indexOf('const closers = [');
  assert.ok(html.slice(i, html.indexOf('];', i)).includes("{ id: 'htabToolDd', fn: 'closeToolMenu' }"));
  assert.ok(header.includes('id="userBtn" onclick="toggleAcctMenu(event)" aria-haspopup="true" aria-expanded="false" aria-label="계정 메뉴"'));
  const dot = extractFn(html, '_updateNtcDot');
  assert.ok(dot.includes("'더보기 (알림이 꺼져 있어요)'") && dot.includes("'계정 메뉴 (알림이 꺼져 있어요)'"));
  assert.ok(html.includes('@media(min-width:701px) and (max-width:1119px){ #apiSt{font-size:0;gap:0} }'), '좁은 폭 장애 칩은 점만');
});
