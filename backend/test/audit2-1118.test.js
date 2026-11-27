/**
 * backend/test/audit2-1118.test.js
 *
 * 2026-11-18 2차 전면 감사(docs/audit/AUDIT_REPORT_2026-11-18_19.md 16절, 2026-11-27 에 옮김)에서 고친 것을 고정한다.
 *   발견 3  내보내기의 활동 기록(EXPORT-ACT-1118)
 *   발견 4  소득이 비었을 때 적용 한도 표시(INCOME-NONE-1118)
 *   발견 5, 12  결제 링크와 사이트맵(BILLING-LINK-1118, SITEMAP-1118)
 *   발견 7  첫 방문 화면 건수 단위
 *   발견 8  매수가 하한(BUY-MIN-1118)
 *   발견 19, 20  좌표 조회 전용 캐시가 가득 차면 지우고 넣는다(GEO-EVICT-1118)
 *   발견 21  단지 목록 부분 결과를 기억하지 않는다(APTLIST-PARTIAL-1118)
 *   발견 22  지역 대시보드의 예외 칸을 6시간 굳히지 않는다(REGION-PARTIAL-1118)
 * 실행: cd backend && TZ=UTC node --test test/audit2-1118.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readIndexHtml, readFrontendJs } = require('../testSupport/readFrontend');

test('발견 3: 내보내기는 활동 기록을 서버 권한으로 본인 행만 읽는다(사용자 토큰으로 읽지 않는다)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/account.js'), 'utf8');
  assert.ok(!src.includes("pageAll('activity_counters'"), '사용자 토큰으로 읽으면 조회 정책이 없어 늘 빈 배열이다');
  const i = src.indexOf("adminClient().from('activity_counters')");
  assert.ok(i > 0, '서버 권한으로 읽어야 한다');
  assert.ok(src.slice(i, i + 200).includes(".eq('user_id', userId)"), '본인 행 조건이 있어야 한다');
});

test('발견 4: 소득이 비면 적용 한도 숫자 옆에 소득 반영 전이라고 적는다', () => {
  const html = readIndexHtml();
  assert.ok(html.includes("fin.toFixed(2)+'억'+(dsrState==='none'?' (소득 반영 전)':'')"));
});

test('발견 5, 12: 설정 창에 결제 링크가 없고, 사이트맵에 결제 페이지가 없으며 법적 문서 날짜가 본문 개정일과 같다', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('<a href="/billing"'), '무료 서비스라 결제 페이지로 보내지 않는다');
  const sm = fs.readFileSync(path.join(__dirname, '../routes/sitemap.js'), 'utf8');
  assert.ok(!/loc: '\/billing'/.test(sm));
  const fe = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');
  const lastmod = (loc) => (sm.match(new RegExp(`loc: '${loc.replace('.', '\\.')}', lastmod: '([0-9-]+)'`)) || [])[1];
  const revised = (f) => { const m = fe(f).match(/최종 개정일: (\d{4})년 (\d{1,2})월 (\d{1,2})일/); return m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; };
  for (const [loc, f] of [['/terms.html', 'terms.html'], ['/privacy.html', 'privacy.html'], ['/refund.html', 'refund.html']]) {
    assert.ok(revised(f), `${f} 에서 최종 개정일을 찾지 못했다`);
    assert.equal(lastmod(loc), revised(f), `${loc} 사이트맵 날짜가 본문 개정일과 다르다`);
  }
});

test('발견 7: 첫 방문 화면의 최고가, 최저가 숫자에 건 단위를 붙여 넣고, 못 받으면 — 만 남긴다', () => {
  const html = readIndexHtml();
  assert.ok(html.includes("if (e) e.textContent = Number(n).toLocaleString() + '건'; };"));
  assert.ok(html.includes('최고가 <span id="lv-recHigh">—</span> · 최저가 <span id="lv-recLow">—</span>'), '자리 표시는 — 그대로');
});

test('발견 8: 매수가 0.1억 미만은 입력 실수로 막고, 0.1억 이상과 빈 값(0)은 이 검사에서 막지 않는다', () => {
  const sb = {};
  vm.runInNewContext(readFrontendJs('calc.js') + '\nthis.f=calcInputProblem;', sb);
  const ok = { inc: 5000, ratePct: 4, yrs: 30, ex: 0, cash: 1, cl: 0, jl: 0 };
  assert.match(sb.f({ ...ok, buy: 0.0001 }), /0\.1억/);
  assert.match(sb.f({ ...ok, buy: 0.09 }), /0\.1억/);
  assert.equal(sb.f({ ...ok, buy: 0.1 }), '');
  assert.equal(sb.f({ ...ok, buy: 0 }), '', '빈 값은 다른 곳이 "매수가를 입력해 주세요"로 막는다');
  assert.equal(sb.f({ ...ok, buy: 7 }), '');
});

test('발견 19, 20: 좌표 조회 전용 캐시가 가득 차도 오래된 것을 지우고 새 값을 넣는다', () => {
  const p = require.resolve('../routes/geocode');
  delete require.cache[p];
  const { _geoCache } = require('../routes/geocode');
  const { set, mem } = _geoCache;
  mem.flushAll();
  try {
    const max = mem.options.maxKeys;
    assert.equal(max, 1000);
    for (let i = 0; i < max; i++) assert.notEqual(set(`geo:old${i}|a|b|`, { i }, 600), false);
    assert.equal(mem.keys().length, max);
    assert.equal(set('geo:new|a|b|', { n: 1 }, 600), true, '가득 찼을 때 새 값을 넣지 못했다');
    assert.deepEqual(mem.get('geo:new|a|b|'), { n: 1 });
    assert.equal(mem.get('geo:old0|a|b|'), undefined, '가장 먼저 넣은 것부터 지워야 한다');
    assert.ok(mem.keys().length <= max);
  } finally { mem.flushAll(); delete require.cache[p]; }
});

function fakeAdmin(resultFor) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const res = resultFor(table, calls.length);
      const chain = new Proxy({}, { get(_, prop) { if (prop === 'then') return (ok, ko) => Promise.resolve(res).then(ok, ko); return () => chain; } });
      return chain;
    },
  };
}

test('발견 21: 단지 목록을 둘째 쪽부터 못 읽으면 그 요청에는 모은 만큼 쓰되 기억하지 않는다', async () => {
  const row = (i) => ({ kapt_code: `A${i}`, apt_name: `단지${i}`, umd_nm: '상계동', kaptAddr: null, kaptUsedate: '19880101' });
  const full = Array.from({ length: 1000 }, (_, i) => row(i));
  const admin = fakeAdmin((t, n) => (n === 1 ? { data: full, error: null } : { data: null, error: { message: 'boom' } }));
  const clientPath = require.resolve('../db/client');
  const savedClient = require.cache[clientPath];
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseAdmin: () => admin, getSupabasePublic: () => null, hasAdminEnv: () => true } };
  const p = require.resolve('../services/aptFacilityService');
  delete require.cache[p];
  try {
    const mod = require('../services/aptFacilityService');
    const o1 = await mod.getAptListByLawdFromDb(['41131']);
    assert.equal(o1.length, 1000, '그 요청에는 첫 쪽을 쓴다');
    const n1 = admin.calls.length;
    await mod.getAptListByLawdFromDb(['41131']);
    assert.ok(admin.calls.length > n1, '일부만 받은 결과를 기억했다');
  } finally { delete require.cache[p]; if (savedClient) require.cache[clientPath] = savedClient; else delete require.cache[clientPath]; }
});

test('발견 22: 지역 대시보드는 예외가 난 칸 이름을 싣고, 그때는 5분만 기억하고 Redis 와 지역 페이지 CDN 에 굳히지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/region.js'), 'utf8');
  const s = src.indexOf('async function buildDashboard(region) {');
  const body = src.slice(s, src.indexOf('\n}\n', s));
  assert.ok(!body.includes('catch (_) { return null; }'), '예외를 기록 없이 null 로 바꾸는 곳이 남았다');
  for (const n of ['priceIndex', 'txTrend', 'unsold', 'netMigration', 'regulation']) assert.ok(body.includes(`_failed.push('${n}')`), n);
  assert.ok(body.includes('...(_failed.length ? { partial: _failed } : {})'));
  assert.match(body, /if \(_failed\.length\) \{\r?\n\s+cache\.set\(ck, payload, 300\);/);
  const page = fs.readFileSync(path.join(__dirname, '../routes/regionPage.js'), 'utf8');
  assert.ok(page.includes('!!(dash && Array.isArray(dash.partial) && dash.partial.length)'));
});
