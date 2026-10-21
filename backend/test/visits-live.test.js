/**
 * backend/test/visits-live.test.js — VISITS-2026-10-20: 지금 보는 사람(Realtime Presence) · 오늘 방문(daily_visit).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');

test('kstDayStart: KST 날짜와 그날 0시(UTC) — 자정 경계', () => {
  const { _kstDayStart } = require('../routes/visits');
  assert.deepEqual(_kstDayStart(Date.parse('2026-10-19T14:59:59Z')), { day: '2026-10-19', startIso: '2026-10-18T15:00:00.000Z' });
  assert.deepEqual(_kstDayStart(Date.parse('2026-10-19T15:00:00Z')), { day: '2026-10-20', startIso: '2026-10-19T15:00:00.000Z' });
});

function handler() {
  delete require.cache[require.resolve('../routes/visits')];
  const router = require('../routes/visits');
  const layer = router.stack.find((l) => l.route && l.route.path === '/today');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const mockRes = () => ({ headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } });

test('GET /api/visits/today: daily_visit 을 오늘 0시(KST) 이후로 head count · 캐시 헤더 · 실패면 today:null + no-store', async () => {
  const dbc = require('../db/client');
  const cache = require('../cache');
  const orig = dbc.getSupabaseAdmin;
  const calls = [];
  try {
    cache.del('visits:today:v1');
    dbc.getSupabaseAdmin = () => ({ from(t) { calls.push(['from', t]); const q = {
      select(c, o) { calls.push(['select', c, o]); return q; },
      eq(k, v) { calls.push(['eq', k, v]); return q; },
      gte(k, v) { calls.push(['gte', k, v]); return Promise.resolve({ count: 17, error: null }); } }; return q; } });
    let res = mockRes(); await handler()({}, res);
    assert.equal(res.body.today, 17); assert.match(res.body.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(res.headers['Cache-Control'], 'public, max-age=30, s-maxage=60');
    assert.deepEqual(calls.slice(0, 3), [['from', 'visit_attribution'], ['select', 'id', { count: 'exact', head: true }], ['eq', 'event', 'daily_visit']]);
    assert.equal(calls[3][0], 'gte'); assert.equal(calls[3][1], 'created_at');
    // 두 번째 호출은 메모리 캐시(DB 안 감)
    const before = calls.length; res = mockRes(); await handler()({}, res);
    // handler() 가 모듈을 다시 읽어도 캐시는 공용 모듈이라 적중해야 한다
    assert.equal(calls.length, before); assert.equal(res.body.today, 17);

    cache.del('visits:today:v1');
    dbc.getSupabaseAdmin = () => ({ from() { const q = { select() { return q; }, eq() { return q; }, gte() { return Promise.resolve({ count: null, error: { message: 'boom' } }); } }; return q; } });
    res = mockRes(); await handler()({}, res);
    assert.equal(res.body.today, null); assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { dbc.getSupabaseAdmin = orig; cache.del('visits:today:v1'); }
});

test('배선: attribution 화이트리스트에 daily_visit · /api/visits 마운트', () => {
  assert.match(read('../routes/attribution.js'), /const EVENTS = new Set\(\['first_load', 'signup', 'search', 'report', 'daily_visit'\]\);/);
  assert.match(read('../server.js'), /app\.use\('\/api\/visits', dataLimiter, require\('\.\/routes\/visits'\)\);/);
});

test('프런트: daily_visit 은 운영 도메인에서만 브라우저당 하루 1회(날짜만 저장)', () => {
  assert.match(html, /if \(location\.hostname === 'myhomelog\.vercel\.app'\) \{\r?\n\s*var _vd = new Date\(Date\.now\(\) \+ 9 \* 3600e3\)\.toISOString\(\)\.slice\(0, 10\);\r?\n\s*if \(localStorage\.getItem\('mhl_visit_day'\) !== _vd\) \{\r?\n\s*localStorage\.setItem\('mhl_visit_day', _vd\);\r?\n\s*window\._attr\.send\('daily_visit'\);/);
});

test('프런트: Presence 는 호스트별 채널 · 탭마다 난수 키 · 숨김 1분 뒤 빠짐 · 홈 하단 배지 2곳(패널 맨 아래·하단 띠) · 임계값 없음', () => {
  assert.match(html, /const ch = c\.channel\(`site-presence:\$\{location\.hostname\}`, \{ config: \{ presence: \{ key \} \} \}\);/);
  assert.match(html, /hideT = setTimeout\(untrack, 60000\)/);
  assert.doesNotMatch(html, /LIVE_SHOW_MIN|VISIT_SHOW_MIN/, 'SITE-LIVE-2026-10-21: 임계값으로 숨기지 않는다(운영자 지적)');
  assert.doesNotMatch(html, /id="hpLive"/);
  const bars = html.match(/<div class="site-livebar" hidden><span class="site-live" data-site-live role="status" aria-live="polite"><\/span><\/div>/g) || [];
  assert.equal(bars.length, 2, '홈 패널 맨 아래와 하단 고지 띠');
  assert.match(html, /<div class="site-livebar" hidden>[^\n]*<\/div>\r?\n\s*<div class="hp-ft">/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\.site-live \.dot::after\{animation:none;opacity:0\}\}/);
  // 실행 값
  const fn = html.match(/function _siteLiveHtml\(n, v\)\{[\s\S]*?\n\}/)[0];
  const f = new Function(`${fn}; return _siteLiveHtml;`)();
  assert.equal(f(1, 3), '<span class="dot" aria-hidden="true"></span><span><b>1</b>명 보는 중</span><span class="sep" aria-hidden="true">·</span><span>오늘 <b>3</b>명</span>');
  assert.equal(f(null, 5), '<span>오늘 <b>5</b>명</span>', '실시간을 모르면 그 부분만 뺀다');
  assert.equal(f(2, null), '<span class="dot" aria-hidden="true"></span><span><b>2</b>명 보는 중</span>');
  assert.equal(f(null, null), '');
  assert.equal(f(1, 0), '<span class="dot" aria-hidden="true"></span><span><b>1</b>명 보는 중</span><span class="sep" aria-hidden="true">·</span><span>오늘 <b>0</b>명</span>', '0 은 아는 값 — 그대로');
});

test('데이터 상태 창: 방문 현황 행은 임계값과 무관하게 항상', () => {
  assert.match(html, /row\('방문 현황','오늘 방문은 브라우저 기준 · 지금 보는 사람은 열린 탭 기준',/);
});
