/**
 * backend/test/audit-1116.test.js
 *
 * 2026-11-16 전면 감사(AUDIT_REPORT.md 15절)에서 운영 화면으로 확인한 것을 고친 뒤의 회귀 검사.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const rd = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function fnSrc(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} 를 찾지 못했다`);
  let i = html.indexOf('{', html.indexOf(')', a)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(a, i + 1); }
  }
  throw new Error('끝을 찾지 못했다');
}

test('발견 2, 3: 안내 글과 타임라인이 8.13 대책까지 말하고, 근거 없는 숫자를 쓰지 않는다', () => {
  assert.ok(html.includes("{ date:'2026-08-13', title:'부동산 시장 안정을 위한 금융 종합대책'"), '타임라인에 8.13 항목');
  assert.ok(!html.includes('4조 1,000억'), '원문 대조에서 근거를 찾지 못한 숫자');
  assert.ok(!html.includes('1.7만 가구'));
  assert.ok(html.includes('2025.10.15 대책부터 2026.8.13 금융 종합대책까지 반영했어요'));
  assert.ok(!html.includes('2026.6.30 확대 내용을 반영했어요'));
  assert.ok(!html.includes('2026.6.30 확대 반영)</summary>'));
  assert.ok(rd('routes/news.js').includes('2025.10.15 안정화 대책부터 2026.8.13 금융 종합대책까지 적용 중'));
  assert.ok(rd('routes/report.js').includes('2026.8.13 금융 종합대책까지 반영'));
});

test('발견 4: 화면 이름 검사는 객체 기본 속성 이름(constructor 등)을 통과시키지 않는다', () => {
  assert.ok(!/[!&]\s?VIEW_DISPLAY\[v\]\s?(&&|\|\|)/.test(html), '주소와 기록에서 온 값은 Object.hasOwn 으로 본다');
  assert.equal((html.match(/Object\.hasOwn\(VIEW_DISPLAY, ?v\)/g) || []).length, 3);
  const calls = [];
  const VIEW_DISPLAY = { map: {}, list: {} };
  const history = { pushState: (...a) => calls.push(a), replaceState: (...a) => calls.push(a), state: null };
  const mk = new Function('VIEW_DISPLAY', 'history', '_svUrl', `let _svCur='map',_svPop=false,_svUser=true; ${fnSrc('_svHist')}; return _svHist;`);
  const svHist = mk(VIEW_DISPLAY, history, (v) => '/?view=' + v);
  svHist('constructor'); svHist('toString'); svHist('__proto__');
  assert.equal(calls.length, 0, '없는 화면 이름은 기록을 만들지 않는다');
  svHist('list');
  assert.equal(calls.length, 1);
});

test('발견 9: 목록 조건은 목록 화면 주소에만 남는다', () => {
  const mk = (href) => new Function('location', 'URL', `${fnSrc('_svUrl')}; return _svUrl;`)({ href }, URL);
  const base = 'https://x.test/?view=list&region=%EC%84%9C%EC%9A%B8&house=a&py=b&apt=1';
  assert.equal(mk(base)('news'), '/?view=news&apt=1');
  assert.equal(mk(base)('map'), '/?apt=1');
  assert.ok(mk(base)('list').includes('region='), '목록으로 갈 때는 그대로 둔다');
});

test('발견 5: 로그인한 사람에게 비로그인 한도와 "로그인하면" 문구를 보이지 않는다', () => {
  const src = fnSrc('updateQuota');
  assert.ok(src.includes("_uIn ? '매일 자정에 다시 채워져요.' : '매일 자정에 다시 채워지고, 로그인하면 하루 10회예요.'"));
  const run = (user, usage) => {
    const info = { textContent: '' };
    const document = { getElementById: (id) => (id === 'usageInfo' ? info : null) };
    const window = { MHL: { auth: { user } }, _quotaNear: {} };
    new Function('document', 'window', '_syncHUsage', `${src}; updateQuota(arguments[3]);`)(document, window, () => {}, usage);
    return info.textContent;
  };
  assert.ok(!run({ id: 'u' }, { used: 1, limit: 10, remaining: 9 }).includes('로그인하면'));
  assert.ok(run(null, { used: 1, limit: 5, remaining: 4 }).includes('로그인하면 하루 10회예요'));
  assert.equal(run({ id: 'u' }, { unlimited: true }), '검색 무제한 (운영자·관리자)');
  // 부팅 때 받은 비로그인 응답으로 로그인 사용자의 한도를 덮지 않는다
  assert.ok(/if\(window\.MHL && window\.MHL\.auth && window\.MHL\.auth\.session\)\{\s*try\{ refreshQuota\(\); \}catch\(_\)\{\}\s*\} else if\(d\.usage\)\{/.test(html));
  assert.ok(html.includes("if (A.session && typeof refreshQuota === 'function') setTimeout(refreshQuota, 300);"), '저장된 로그인이 복원되면 한도를 다시 받는다');
});

test('발견 1: 대체 지도의 배경 그림을 한 장도 못 받으면 안내와 다시 시도 단추를 띄운다', () => {
  assert.ok(html.includes("_tl.on('tileerror',()=>{_tErr++;if(_tOk===0&&_tErr===4)_mapFailNote();});"));
  assert.ok(html.includes("_tl.on('tileload',()=>{_tOk++;const n=document.getElementById('mapFailNote');if(n)n.remove();});"));
  const made = [];
  const el = (tag) => ({ tag, style: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(c) { this.children.push(c); } });
  const host = el('div');
  const document = {
    getElementById: (id) => (id === 'mapEl' ? host : (id === 'mapFailNote' ? (host.children[0] || null) : null)),
    createElement: (t) => { const e = el(t); made.push(e); return e; },
  };
  const run = new Function('document', 'window', 'location', `${fnSrc('_mapFailNote')}; return _mapFailNote;`)(document, {}, { reload() {} });
  run(); run();
  assert.equal(host.children.length, 1, '안내는 한 번만 붙는다');
  assert.equal(host.children[0].children[0].textContent, '지도 배경을 불러오지 못했어요. 순위 목록과 단지 검색은 그대로 쓸 수 있어요.');
  assert.equal(host.children[0].children[1].textContent, '다시 시도');
});

test('발견 10: 권하는 말투와 내부 용어를 쓰지 않는다', () => {
  assert.ok(!html.includes('이하 권장 (+VAT)'));
  assert.ok(html.includes('참고로 상한의 70%는'));
  assert.ok(!html.includes('네이버 지도 (NCP)'));
  assert.ok(!html.includes('카카오맵 Local API'));
});
