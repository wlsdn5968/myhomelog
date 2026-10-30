/**
 * backend/test/feature-links.test.js
 *
 * Plan 148 — 기능 사이 길 잇기. 운영자 지적 "기능은 많은데 적재적소에 못 쓴다".
 * frontend-contracts.test.js / region-deeplink.test.js 와 같은 방식(fs.readFileSync + 소스 검사)으로 배선을 고정하고,
 * 순수에 가까운 함수(_carrySidebarToCalc)는 가짜 DOM 으로 실제 실행해 동작을 확인한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

// 중괄호 균형으로 함수 본문 전체를 잘라 낸다.
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

// ── 1) 지역 서버 페이지 → 앱: ?region 진입이면 자동 검색 ─────────────────────────────────────
test('index.html — ?region 으로 복원된 진입은 지도 화면에서 doSearch() 를 자동 실행하고 해요체 토스트를 띄운다 (Plan 148)', () => {
  assert.ok(html.includes('REGION-AUTOSEARCH-2026-10-14'), 'REGION-AUTOSEARCH 주석 태그가 없다');
  const m = html.match(/const _autoRegion=\(restored==='url'\) && new URLSearchParams\(location\.search\)\.has\('region'\);[\s\S]*?\} else\s*\n\s*if\(restored==='url'\)\{/);
  assert.ok(m, '_autoRegion 분기(region 파라미터 + restored==="url")를 찾지 못했다');
  const block = m[0];
  assert.match(block, /sv\('map'/, '자동 검색 전에 지도 화면으로 전환하지 않는다');
  assert.match(block, /doSearch\(\)/, 'doSearch() 자동 호출이 없다');
  assert.ok(block.includes('링크의 조건으로 단지를 찾고 있어요'), '해요체 토스트 문구가 없다');
  assert.match(block, /sessionStorage\.getItem\(_akey\)/, '새로고침 반복 검색을 막는 sessionStorage 가드가 없다');
  // region 이 없는 공유 링크는 기존 안내 토스트를 그대로 쓴다.
  assert.ok(html.includes('공유받은 조건을 불러왔어요. 조건에 맞는 단지 찾기 버튼을 눌러 주세요'), '기존 공유 링크 토스트가 사라졌다');
});

// ── 2) 서버 페이지 CTA 약속과 도착지 ─────────────────────────────────────────────────────────
test('briefing.js — 브리핑 CTA 라벨이 실제 도착지(앱 브리핑 화면)와 맞는다 (Plan 148)', () => {
  const src = read('../routes/briefing.js');
  assert.ok(src.includes('<a class="cta" href="/?briefing=${esc(day)}">앱에서 브리핑 보기 →</a>'), '브리핑 CTA 라벨이 도착지에 맞게 바뀌지 않았다');
  assert.ok(!src.includes('지도·계산기와 함께 보기'), '지켜지지 않는 약속(지도·계산기) 문구가 남아 있다');
});

test('aptPage.js + index.html — 단지 CTA 는 &calc=1 을 달고, 앱은 상세에 평균가가 채워진 뒤에만 goCalcFromDetail 을 부른다 (Plan 148)', () => {
  const apt = read('../routes/aptPage.js');
  assert.match(apt, /&area=\$\{encodeURIComponent\(region\)\}&calc=1">\$\{esc\(displayName\)\} 대출 한도·비용 계산 →<\/a>/, '단지 CTA 에 &calc=1 이 없다');
  const fn = extractFn(html, 'handleShareUrl');
  assert.ok(fn.includes("sp.get('calc')==='1'"), "handleShareUrl 이 calc=1 을 읽지 않는다");
  // 두 경로(props 에서 찾은 경우 / 실거래 조회로 만든 aptEnriched) 모두 avgPrice>0 일 때만 계산기로 보낸다.
  assert.ok(fn.includes('wantCalc&&found.avgPrice>0)goCalcFromDetail(found.avgPrice)'), 'found 경로의 계산기 연결이 없다');
  assert.ok(fn.includes('wantCalc&&aptEnriched.avgPrice>0)goCalcFromDetail(aptEnriched.avgPrice)'), '실거래 조회 경로의 계산기 연결이 없다');
  // 평균가를 못 구하는 stub(avgPrice:0) 경로에는 calc 호출이 없어야 한다 — 0원으로 계산기를 채우지 않는다.
  assert.equal((fn.match(/goCalcFromDetail\(/g) || []).length, 2, 'goCalcFromDetail 호출은 정확히 2곳이어야 한다');
});

test('regionPage.js — 지역 CTA 라벨에서 지켜지지 않는 "대출 계산" 약속을 뺐다 (Plan 148)', () => {
  const src = read('../routes/regionPage.js');
  assert.ok(src.includes('${esc(label)} 단지 찾아보기 →'), '지역 CTA 라벨이 바뀌지 않았다');
  assert.ok(!src.includes('단지 검색·대출 계산'), '옛 CTA 라벨이 남아 있다');
});

// ── 3) 값 이어 주기 ──────────────────────────────────────────────────────────────────────────
test('index.html — 사이드바와 계산기의 단위가 같다는 전제(억/억·억/억·만원/만원)를 라벨로 고정한다 (Plan 148)', () => {
  const lbl = (id) => { const m = html.match(new RegExp(`<label class="lbl" for="${id}">([^<]*(?:<span[^>]*>[^<]*</span>)?[^<]*)</label>`)); assert.ok(m, `${id} 라벨 없음`); return m[1]; };
  assert.match(lbl('bp'), /\(억\)/); assert.match(lbl('c_b'), /\(억\)/);
  assert.match(lbl('mc'), /\(억\)/); assert.match(lbl('c_c'), /\(억\)/);
  assert.match(lbl('inc'), /만원/); assert.match(lbl('c_i'), /\(만\)/);
});

test('_carrySidebarToCalc — 계산기 칸이 비어 있을 때만 사이드바 값을 복사한다 (Plan 148)', () => {
  const calls = [];
  const els = {
    bp: { value: '9' }, mc: { value: '3.5' }, inc: { value: '7000' },
    c_b: { value: '' }, c_c: { value: '' }, c_i: { value: '' },
  };
  const ctx = { document: { getElementById: (id) => els[id] || null }, dc: () => calls.push('dc'), parseFloat };
  vm.createContext(ctx);
  vm.runInContext(extractFn(html, '_carrySidebarToCalc'), ctx);

  ctx._carrySidebarToCalc(false); // 상세 모달 경로: 매수가는 건드리지 않는다
  assert.equal(els.c_b.value, '');
  assert.equal(els.c_c.value, '3.5');
  assert.equal(els.c_i.value, '7000');

  els.c_c.value = '1.2'; els.c_i.value = ''; els.inc.value = '';
  ctx._carrySidebarToCalc(true); // 시뮬레이터 링크 경로: 매수가 포함
  assert.equal(els.c_b.value, '9');
  assert.equal(els.c_c.value, '1.2', '이미 입력한 계산기 값을 덮어썼다');
  assert.equal(els.c_i.value, '', '사이드바가 비었는데 값을 만들어 넣었다');
  assert.ok(calls.length >= 2, '복사 뒤 dc() 재계산을 부르지 않는다');
});

test('index.html — goCalcFromDetail·시뮬레이터 링크가 복사를 하고, searchWithBudget 이 연소득을 사이드바로 돌려준다 (Plan 148)', () => {
  assert.ok(extractFn(html, 'goCalcFromDetail').includes('_carrySidebarToCalc(false)'), 'goCalcFromDetail 에 복사가 없다');
  assert.ok(extractFn(html, 'openCalcFromSidebar').includes('_carrySidebarToCalc(true)'), '시뮬레이터 링크 함수에 복사가 없다');
  assert.ok(html.includes('onclick="openCalcFromSidebar()" style="color:var(--acc);font-weight:700;text-decoration:none">대출 계산 열기 →'), '시뮬레이터 링크가 새 함수를 쓰지 않는다');
  const sb = extractFn(html, 'searchWithBudget');
  assert.match(sb, /getElementById\('c_i'\)/);
  assert.match(sb, /_incEl\.value=_ci/);
});

// ── 4) 찾기 어려운 기능 노출 ─────────────────────────────────────────────────────────────────
test('index.html — 도구▾ 메뉴와 모바일 도구 시트에 복비 계산·사용법이 있고, 하이라이트 목록에 포함된다 (Plan 148)', () => {
  const calcIdx = html.indexOf(`<button class="htab" onclick="sv('calc',this)">`);
  const bizIdx = html.indexOf(`<button class="htab" onclick="sv('biz',this)">`);
  const guideIdx = html.indexOf(`<button class="htab" onclick="sv('guide',this)">`);
  const regIdx = html.indexOf(`<button class="htab" onclick="closeToolMenu();openRegSummary()"`);
  assert.ok(calcIdx > 0 && bizIdx > calcIdx && guideIdx > bizIdx && regIdx > guideIdx,
    '복비 계산·사용법 항목이 calc 뒤, 규제 요약(항상 마지막 — htabOrder 인덱스 밖) 앞에 있어야 한다');
  assert.match(html, /data-tool="biz"[^>]*onclick="closeToolsSheet\(\);sv\('biz',this\)"/);
  assert.match(html, /data-tool="guide"[^>]*onclick="closeToolsSheet\(\);sv\('guide',this\)"/);
  // Plan 154: 거래 체크리스트(deal)도 도구 뷰
  assert.equal((html.match(/\['clause','subs','calc','biz','deal','swap','guide'\]\.includes\(v\)/g) || []).length, 2, '데스크톱 도구 버튼·모바일 도구 탭 하이라이트 목록 둘 다 biz·deal·guide 를 포함해야 한다');
  // htabOrder 는 7개 — 새 .htab 두 개는 인덱스 밖이라 항상 off 다.
  assert.match(html, /const htabOrder=\['news','map','list','report','clause','subs','calc'\];/);
});

test('index.html — 모바일 드로어 유틸에 지역별 실거래·브리핑 기록 링크가 있다 (Plan 148)', () => {
  const fn = extractFn(html, 'renderDrawerUtil');
  assert.ok(fn.includes('<a href="/region">지역별 실거래</a>'));
  assert.ok(fn.includes('<a href="/briefing">브리핑 기록</a>'));
});

test('index.html — 지역 시장 요약 모달 맨 아래에 5자리 코드일 때만 지역 서버 페이지 링크를 단다 (Plan 148)', () => {
  const fn = extractFn(html, '_renderRegionSummary');
  assert.ok(fn.includes('/^\\d{5}$/.test(_rgCode)'), '5자리 코드 검사가 없다');
  assert.ok(fn.includes('href="/region/${_rgCode}"'), '/region/<lawdCd> 링크가 없다');
  assert.ok(fn.includes("''` : ''") || fn.includes(": '';"), '코드가 아니면 링크를 숨기는 분기가 없다');
  // 서버 라우트가 받는 형식과 같다는 근거 고정
  assert.ok(read('../routes/regionPage.js').includes('/^\\d{5}$/.test(code)'), 'regionPage.js 의 코드 형식이 바뀌었다 — 모달 링크 조건을 다시 확인');
});

// ── 5) 죽은 호출 ────────────────────────────────────────────────────────────────────────────
test('index.html — 서버에서 삭제된 /legal/search 호출이 없다 (Plan 148)', () => {
  assert.ok(!html.includes('/legal/search'), '삭제된 엔드포인트 호출이 남아 있다');
  assert.ok(read('../server.js').includes('DEAD-ENDPOINT-REMOVED-2026-09-05'), '서버 쪽 삭제 근거 주석이 사라졌다 — 이 테스트의 전제를 다시 확인');
});
