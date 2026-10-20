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

test('프런트: Presence 는 호스트별 채널 · 탭마다 난수 키 · 숨김 1분 뒤 빠짐 · 임계값 미만이면 줄을 숨긴다', () => {
  assert.match(html, /const ch = c\.channel\(`site-presence:\$\{location\.hostname\}`, \{ config: \{ presence: \{ key \} \} \}\);/);
  assert.match(html, /hideT = setTimeout\(untrack, 60000\)/);
  assert.match(html, /const LIVE_SHOW_MIN = 2, VISIT_SHOW_MIN = 10;/);
  assert.match(html, /<p class="hp-live" id="hpLive" role="status" aria-live="polite" hidden><\/p>/);
  // 실행 값: 임계값 판정
  const fn = html.match(/function _renderLive\(\)\{[\s\S]*?\n\}/)[0];
  const el = { hidden: true, textContent: '', innerHTML: '', title: '' };
  const run = (n, v) => {
    const f = new Function('document', 'window', '_escHtml', `const LIVE_SHOW_MIN = 2, VISIT_SHOW_MIN = 10; ${fn}; _renderLive();`);
    f({ getElementById: () => el }, { _liveN: n, _visitsToday: v }, (s) => String(s));
    return { hidden: el.hidden, html: el.innerHTML };
  };
  assert.equal(run(1, 4).hidden, true);
  assert.deepEqual(run(3, 4), { hidden: false, html: '<span class="dot" aria-hidden="true"></span>지금 3명이 보고 있어요' });
  assert.deepEqual(run(1, 12), { hidden: false, html: '오늘 방문 12명' });
  assert.equal(run(null, null).hidden, true);
});

test('데이터 상태 창: 방문 현황 행은 임계값과 무관하게 항상', () => {
  assert.match(html, /row\('방문 현황','오늘 방문은 브라우저 기준 · 지금 보는 사람은 열린 탭 기준',/);
});
