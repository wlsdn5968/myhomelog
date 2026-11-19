/**
 * backend/test/policy-changes-1116.test.js
 *
 * POLICY-CHANGES-1116 (plans/203): 정책 변화 한 장 요약의 자료.
 * 원본은 backend/data/policy-changes.json 이고 화면용 frontend/js/policy-data.js 는 scripts/build-policy-data.js 가 만든다.
 * 자료 내용이 맞는지는 원문 대조로 확인한다(이 검사는 못 한다). 여기서는 모양과 규칙만 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '../..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/data/policy-changes.json'), 'utf8'));
const { validate, render, CATS, STATUSES, SRC_HOSTS } = require('../../scripts/build-policy-data');

test('자료: 모양 검사를 통과하고, 항목마다 공식 출처와 확인일이 있다', () => {
  assert.deepEqual(validate(data), []);
  assert.ok(data.items.length >= 30, '2025년부터 모은 항목');
  for (const it of data.items) {
    // POLICY-1119: 국토교통부 보도자료 원문(첨부까지 읽음)을 출처로 넣으면서, 검증 함수의 공식 출처 목록(SRC_HOSTS)과 같은 기준으로 본다.
    //   고치기 전에는 정책브리핑, 금융위, 국가법령정보센터 세 곳만 허용했다.
    assert.ok(it.src.every((u) => u.startsWith('https://') && SRC_HOSTS.includes(new URL(u).host)), `${it.title}: 출처는 정부 공식 누리집(SRC_HOSTS)이어야 한다`);
  }
  assert.ok(new Date(data.checked) <= new Date(), '확인일이 미래가 아니다');
});

test('자료: 다섯 분류와 네 가지 넘는 상태가 실제로 쓰이고, 정부안과 계획은 확정처럼 적지 않는다', () => {
  assert.deepEqual([...new Set(data.items.map((x) => x.cat))].sort(), [...CATS].sort());
  for (const s of new Set(data.items.map((x) => x.status))) assert.ok(STATUSES.includes(s));
  const plans = data.items.filter((x) => x.status === '안');
  // POLICY-1118b: 세컨드홈 특례와 1월 시행령 개정안이 법령 원문 확인으로 '시행'이 되어 정부안은 1장(세제개편안)이 남았다. 전엔 3장 이상이었다.
  assert.ok(plans.length >= 1);
  for (const it of plans) assert.ok(it.note && /(정부안|발표 내용|입법예고)/.test(it.note), `${it.title}: 확정 전이라는 덧붙임이 있어야 한다`);
});

test('모양 검사가 잘못된 자료를 잡는다', () => {
  const base = () => JSON.parse(JSON.stringify({ checked: data.checked, items: [data.items[0]] }));
  const bad = (fn) => { const d = base(); fn(d.items[0], d); return validate(d).length > 0; };
  assert.ok(bad((it) => { it.src = []; }), '출처 없음');
  assert.ok(bad((it) => { it.src = ['https://blog.example.com/a']; }), '공식 출처가 아닌 주소');
  assert.ok(bad((it) => { it.src = ['http://www.korea.kr/a']; }), 'https 가 아님');
  assert.ok(bad((it) => { it.status = '확정'; }), '모르는 상태');
  assert.ok(bad((it) => { it.cat = 'etc'; }), '모르는 분류');
  assert.ok(bad((it) => { it.after = ''; }), '바뀐 뒤 없음');
  assert.ok(bad((it) => { it.date = '2025.02.11'; }), '날짜 형식');
  assert.ok(bad((it) => { it.after = '지금 사세요'; }), '권유');
  assert.ok(bad((it) => { it.note = '집값이 오를 전망이에요'; }), '전망');
  assert.ok(bad((it, d) => { d.items.push(JSON.parse(JSON.stringify(it))); }), '같은 항목 두 번');
  assert.ok(bad((it, d) => { delete d.checked; }), '확인일 없음');
});

test('화면용 파일은 원본에서 만든 그대로이고, 실행하면 window.MHL_POLICY 가 생긴다', () => {
  const out = fs.readFileSync(path.join(ROOT, 'frontend/js/policy-data.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(out, render(data), '다르면 node scripts/build-policy-data.js 를 실행한다');
  const sb = { window: {} };
  vm.runInNewContext(out, sb, { filename: 'policy-data.js' });
  assert.equal(sb.window.MHL_POLICY.items.length, data.items.length);
  assert.equal(sb.window.MHL_POLICY.checked, data.checked);
  assert.ok(!('held' in sb.window.MHL_POLICY), '넣지 않은 후보 목록은 화면으로 보내지 않는다');
});

// ── 화면(frontend/js/policy.js)과 서버 페이지(/policy) ──
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');
const html = readIndexHtml();

function mountPolicy(policy) {
  const root = { innerHTML: '' };
  const sb = {
    window: { MHL_POLICY: policy }, URL,
    document: { getElementById: (id) => (id === 'polRoot' ? root : null) },
    location: { reload() {} },
  };
  vm.runInNewContext(readFrontendJs('policy.js') + '\n;this.api={_polRender,_polSetCat,_polSetState,_polReset,_polToggle,_polRecent,_polOpen};', sb, { filename: 'policy.js' });
  return { root, api: sb.api };
}
const count = (s, re) => (s.match(re) || []).length;

test('화면: 자료 전체를 최신순 카드로 그리고, 계획은 접어 둔다', () => {
  const { root, api } = mountPolicy({ checked: data.checked, items: data.items });
  api._polOpen();
  assert.equal(count(root.innerHTML, /<article class="pol-card/g), data.items.length);
  assert.equal(count(root.innerHTML, /pol-fold"/g), data.items.filter((x) => x.status === '계획').length, '계획 카드는 한 줄로 접힌다');
  assert.ok(root.innerHTML.includes('원문 확인 ' + data.checked.replace(/-/g, '.') + ' · ' + data.items.length + '건'));
  const dates = [...root.innerHTML.matchAll(/<span class="pol-date">([\d.]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(dates, [...dates].sort().reverse(), '최신이 위');
  assert.ok(root.innerHTML.includes('참고용 정리예요. 실제 적용은 원문과 담당 기관에서 꼭 확인하세요. 매수·매도 추천이 아니에요.'));
  assert.ok(!/undefined|NaN|\[object/.test(root.innerHTML));
});

test('화면: 분류와 상태를 고르면 그 조건만 보이고, 없으면 안내와 전체 보기가 나온다', () => {
  const { root, api } = mountPolicy({ checked: data.checked, items: data.items });
  api._polSetCat('tax'); api._polSetState('soon');
  const want = data.items.filter((x) => x.cat === 'tax' && (x.status === '안' || x.status === '예정')).length;
  assert.ok(want >= 1);
  assert.equal(count(root.innerHTML, /<article class="pol-card/g), want);
  assert.ok(root.innerHTML.includes('세금 · 예정·정부안 ' + want + '건'));
  assert.equal(count(root.innerHTML, /아직 확정되지 않았어요/g), data.items.filter((x) => x.cat === 'tax' && x.status === '안').length);
  api._polSetCat('rent'); api._polSetState('end');
  assert.equal(data.items.filter((x) => x.cat === 'rent' && x.status === '종료').length, 0, '이 조건의 자료가 생기면 다른 빈 조건으로 바꾼다');
  assert.ok(root.innerHTML.includes('고른 조건에 맞는 변화가 없어요'));
  api._polReset();
  assert.equal(count(root.innerHTML, /<article class="pol-card/g), data.items.length);
  api._polSetCat('없는분류'); api._polSetState('x');
  assert.equal(count(root.innerHTML, /<article class="pol-card/g), data.items.length, '모르는 값은 무시한다');
});

test('화면: 글은 이스케이프하고, 바뀌기 전이 없으면 바뀐 뒤만, 끝난 것은 흐리게, 계획은 펼칠 수 있다', () => {
  const items = [
    { date: '2026-01-02', effective: null, org: '기관<b>', cat: 'loan', status: '시행', title: '<img src=x onerror=1>', before: null, after: '뒤 "따옴표"', who: '누구', src: ['https://www.korea.kr/a?x=1&y=2'] },
    { date: '2026-01-01', effective: '2026-02-01', org: '기관', cat: 'supply', status: '계획', title: '계획 항목', before: '전', after: '후', who: '누구', src: ['https://www.korea.kr/a', 'https://www.fsc.go.kr/b'] },
    { date: '2025-12-01', effective: null, org: '기관', cat: 'zone', status: '종료', title: '끝난 항목', before: '전', after: '후', who: '누구', note: '덧붙임', src: ['https://www.korea.kr/c'] },
  ];
  const { root, api } = mountPolicy({ checked: '2026-01-03', items });
  api._polOpen();
  assert.ok(!root.innerHTML.includes('<img'), '자료의 글자가 태그가 되지 않는다');
  assert.ok(root.innerHTML.includes('&lt;img src=x onerror=1&gt;'));
  assert.ok(root.innerHTML.includes('href="https://www.korea.kr/a?x=1&amp;y=2"'));
  assert.equal(count(root.innerHTML, /pol-ba pol-one/g), 1);
  assert.equal(count(root.innerHTML, /pol-card pol-ended/g), 1);
  assert.ok(root.innerHTML.includes('>펼치기<') && !root.innerHTML.includes('>접기<'));
  api._polToggle(1);
  assert.ok(root.innerHTML.includes('>접기<'));
  assert.ok(root.innerHTML.includes('원문 보기 · 정책브리핑') && root.innerHTML.includes('원문 보기 · 금융위원회'), '원문이 둘이면 기관 이름을 붙인다');
  assert.deepEqual(JSON.parse(JSON.stringify(api._polRecent(3))), [{ date: '2026.01.02', title: '<img src=x onerror=1>' }, { date: '2025.12.01', title: '끝난 항목' }], '줄인 상자에는 계획을 빼고 최신순으로');
});

test('화면: 자료를 못 받으면 안내와 새로 고침 단추를 보이고, 줄인 상자는 빈 목록을 돌려준다', () => {
  const { root, api } = mountPolicy(undefined);
  api._polOpen();
  assert.ok(root.innerHTML.includes('정책 변화를 불러오지 못했어요. 새로 고침해 주세요'));
  assert.ok(root.innerHTML.includes('새로 고침</button>'));
  assert.deepEqual(JSON.parse(JSON.stringify(api._polRecent(3))), []);
});

test('본체 연결: 스크립트 순서, 화면 등록, 들어가는 길 세 곳, 주소로 열기', () => {
  const a = html.indexOf('<script src="/js/policy-data.js"></script>');
  const b = html.indexOf('<script src="/js/policy.js"></script>');
  const main = html.indexOf('// ── CONFIG & STATE');
  assert.ok(a > 0 && b > a && main > b, '자료, 화면 코드, 본체 순서');
  assert.ok(html.includes('<div class="biz-view" id="view-policy" style="display:none"><div id="polRoot"></div></div>'));
  assert.ok(html.includes("policy:{display:'flex', lp:false, rp:false},"));
  assert.ok(html.includes("if(v==='policy'){if(typeof _polOpen==='function'){try{_polOpen();}catch(_){}}else{"), '화면 코드를 못 받았으면 알린다');
  assert.ok(/<button class="htab" onclick="sv\('policy',this\)">[\s\S]{0,400}?정책 변화<\/button>\s*<!-- Sprint OOOOO: 규제 요약/.test(html), '위쪽 도구 메뉴에서 규제 요약 바로 위');
  assert.ok(html.includes('data-tool="policy" aria-current="false" onclick="closeToolsSheet();sv(\'policy\',this)"'), '모바일 도구 목록');
  assert.ok(html.includes("onclick=\"document.getElementById('regSummaryModal').remove();sv('policy')\">바뀐 내용 날짜순으로 보기</button>"), '규제 요약 창');
  assert.ok(html.includes("const rec=typeof _polRecent==='function'?_polRecent(3):[];"), '대출 계산 화면의 줄인 상자');
  assert.ok(html.includes('id="policyTimelineHead"') && html.includes('id="policyTimelineFoot"'));
});

test('서버 페이지 /policy: 같은 자료를 내보내고, 경로와 사이트맵에 연결돼 있다', () => {
  const pageHtml = require('../routes/policyPage')._page();
  assert.equal(count(pageHtml, /<article class="card/g), data.items.length);
  assert.ok(pageHtml.includes('<title>부동산 정책 변화 한눈에 보기 | 내집로그</title>'));
  assert.ok(pageHtml.includes('<link rel="canonical" href="https://myhomelog.vercel.app/policy">'));
  assert.ok(pageHtml.includes('매수·매도 추천이 아니에요.'));
  for (const k of ['loan', 'zone', 'tax', 'supply', 'rent']) assert.equal(count(pageHtml, new RegExp('id="c-' + k + '"', 'g')), 1, k + ' 분류로 바로 가는 닻');
  assert.ok(!/undefined|NaN|\[object/.test(pageHtml));
  for (const it of data.items) assert.ok(pageHtml.includes(it.src[0].replace(/&/g, '&amp;')), it.title + ': 원문 링크');
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const i = v.routes.findIndex((r) => r.src === '/policy');
  assert.ok(i > 1 && i < v.routes.findIndex((r) => r.src === '/(.*)') && v.routes[i].dest === '/api/index.js');
  assert.ok(fs.readFileSync(path.join(ROOT, 'backend/server.js'), 'utf8').includes("app.use('/policy', ssrMemLimiter, require('./routes/policyPage'));"));
  assert.ok(fs.readFileSync(path.join(ROOT, 'backend/routes/sitemap.js'), 'utf8').includes("{ loc: '/policy', lastmod: require('../data/policy-changes.json').checked,"));
  const src = fs.readFileSync(path.join(ROOT, 'backend/routes/policyPage.js'), 'utf8');
  assert.ok(!/getSupabase|axios|fetch\(/.test(src), 'DB 와 외부 API 를 부르지 않는다');
  assert.ok(src.includes("s-maxage=86400"), 'CDN 이 하루 기억한다');
});
