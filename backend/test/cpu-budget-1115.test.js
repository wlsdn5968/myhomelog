/**
 * backend/test/cpu-budget-1115.test.js
 *
 * CPU-BUDGET-1115: Vercel Hobby 팀 Active CPU 30일 한도(4시간) 초과로 2026-11-08 팀 전체가 정지됐다.
 *   하루 CPU 를 서비스가 세고(5분에 한 번 Redis INCRBY), 기준을 넘으면 알리고 검색 로봇의 서버 렌더 요청을 미룬다.
 *   예약 작업은 실행 기록에 cpuMs 를 남긴다(함수 기록은 1시간만 남아 밤 작업의 CPU 를 볼 수 없었다).
 *   미리보기 대리 서버는 운영 응답을 잠시 기억해 같은 주소로 운영 함수를 다시 부르지 않는다.
 */
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cb = require('../services/cpuBudget');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

function fakeRedis() {
  const m = new Map(); const calls = [];
  return {
    calls, m,
    async incrby(k, n) { calls.push(['incrby', k, n]); m.set(k, (m.get(k) || 0) + n); return m.get(k); },
    async expire(k, s) { calls.push(['expire', k, s]); return 1; },
    async get(k) { calls.push(['get', k]); return m.has(k) ? m.get(k) : null; },
  };
}
const NOW = Date.parse('2026-11-15T05:00:00Z');
beforeEach(() => { Object.assign(cb._st, { flushedUs: 0, lastFlushAt: 0, flushing: false, day: null, totalMs: null }); });

test('기록: 지난 기록 뒤로 쓴 CPU 만 더하고, 그날 첫 기록에만 만료를 건다', async () => {
  const r = fakeRedis(); let us = 700_000;
  const deps = { getRedis: () => r, procUs: () => us, sentry: { captureMessage() {} } };
  assert.equal(await cb.flush(NOW, deps), 700);
  us = 950_000;
  assert.equal(await cb.flush(NOW + 1000, deps), 950);
  assert.deepEqual(r.calls.map((c) => c[0]), ['incrby', 'expire', 'incrby']);
  assert.equal(r.calls[0][1], 'cpu:day:20261115');
  assert.equal(r.calls[2][2], 250);
  assert.deepEqual(cb.snapshot(NOW), { day: '20261115', ms: 950 }, '공개 응답에 기준값을 싣지 않는다');
  // 날짜가 바뀌면 어제 합계를 오늘 값으로 보여 주지 않는다(모름은 null)
  assert.equal(cb.snapshot(NOW + 24 * 3600 * 1000).ms, null);
});

test('기록 실패: 더하지 못한 양은 다음 기록에 다시 들어간다. Redis 가 없으면 아무 일도 하지 않는다', async () => {
  let fail = true; const r = fakeRedis(); const orig = r.incrby.bind(r);
  r.incrby = async (k, n) => { if (fail) throw new Error('down'); return orig(k, n); };
  const deps = { getRedis: () => r, procUs: () => 400_000, sentry: { captureMessage() {} } };
  assert.equal(await cb.flush(NOW, deps), null);
  fail = false;
  assert.equal(await cb.flush(NOW + 1, deps), 400);
  assert.equal(await cb.flush(NOW + 2, { getRedis: () => null, procUs: () => 900_000 }), null);
  assert.equal(cb.shouldShed(NOW), false);
});

test('경보는 기준을 넘는 순간 한 번씩, 차단 기준을 넘으면 그날만 로봇을 돌려보낸다', async () => {
  const r = fakeRedis(); const msgs = []; let us = 0;
  const deps = { getRedis: () => r, procUs: () => us, sentry: { captureMessage: (m, o) => msgs.push([o.level, o.tags.monitor]) } };
  us = (cb.ALERT_MS - 1000) * 1000; await cb.flush(NOW, deps);
  assert.equal(msgs.length, 0);
  us += 2000 * 1000; await cb.flush(NOW + 1, deps);
  assert.deepEqual(msgs, [['warning', 'cpu-budget']]);
  us += 1000 * 1000; await cb.flush(NOW + 2, deps);
  assert.equal(msgs.length, 1, '이미 넘은 뒤에는 다시 보내지 않는다');
  assert.equal(cb.shouldShed(NOW), false);
  us = (cb.SHED_MS + 500) * 1000; await cb.flush(NOW + 3, deps);
  assert.deepEqual(msgs[1], ['error', 'cpu-budget']);
  assert.equal(cb.shouldShed(NOW), true);
  assert.equal(cb.shouldShed(NOW + 24 * 3600 * 1000), false, '다음 날은 다시 통과');
});

test('차단 미들웨어: 검색 로봇만 503 과 Retry-After, 사람과 링크 미리보기는 통과', () => {
  const server = read('../server.js');
  const m = server.match(/shedBots\(\(ua\) => (\/.+?\/i)\.test\(ua\)\)/);
  assert.ok(m, 'server.js 의 로봇 판정식');
  const re = new RegExp(m[1].slice(1, -2), 'i');
  const mw = cb.shedBots((ua) => re.test(ua));
  const run = (ua) => {
    const out = { status: 200, headers: {}, passed: false };
    const res = { set: (k, v) => { out.headers[k] = v; }, status: (s) => { out.status = s; return res; }, type: () => res, send: () => res };
    mw({ get: () => ua }, res, () => { out.passed = true; });
    return out;
  };
  Object.assign(cb._st, { day: cb.dayOf(Date.now()), totalMs: cb.SHED_MS + 1 });
  const yeti = run('Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)');
  assert.equal(yeti.status, 503); assert.equal(yeti.headers['Retry-After'], '3600'); assert.equal(yeti.passed, false);
  assert.equal(run('Mozilla/5.0 AppleWebKit/537.36; compatible; OAI-SearchBot/1.3').status, 503);
  assert.equal(run('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0 Safari/537.36').passed, true);
  assert.equal(run('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').status, 503);
  // 독립 검토에서 나온 구멍: 'bot' 이 든 이름을 전부 잡으면 링크 미리보기와 일부 휴대폰이 막힌다
  for (const ua of ['facebookexternalhit/1.1; kakaotalk-scrap/1.0', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'TelegramBot (like TwitterBot)', 'LinkedInBot/1.0',
    'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1)',
    'Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36', 'WhatsApp/2.23']) {
    assert.equal(run(ua).passed, true, ua);
  }
  Object.assign(cb._st, { totalMs: cb.SHED_MS - 1 });
  assert.equal(run('Yeti/1.1').passed, true, '기준 아래에서는 로봇도 통과');
  // 서버 렌더 세 경로에만 걸고, 그 경로들보다 앞에 둔다
  assert.match(server, /app\.use\(\['\/briefing', '\/region', '\/apt'\], _shedCrawlers\);\r?\napp\.use\('\/briefing', ssrMemLimiter/);
  assert.match(server, /cpuMeter\(require\('\.\/logger'\)\)\);\r?\napp\.use\(require\('\.\/services\/cpuBudget'\)\.gate\(\)\);/);
  assert.match(server, /cpuDay: require\('\.\/services\/cpuBudget'\)\.snapshot\(\),/);
});

test('기록 미들웨어: 5분 안에는 Redis 를 부르지 않고 바로 넘긴다', () => {
  cb._st.lastFlushAt = Date.now();
  let passed = false;
  cb.gate()({}, {}, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(cb.FLUSH_GAP_MS, 5 * 60 * 1000);
});

test('예약 작업: 시작 표시와 끝 기록 사이의 CPU 가 실행 기록에 붙고, 하루 합계에도 바로 더한다', async () => {
  const cs = require('../services/cronStats');
  cs.markCronStart('unit-cron');
  const t0 = Date.now(); while (Date.now() - t0 < 300) { Math.sqrt(Math.random()); } // Windows 는 CPU 시간 눈금이 약 16ms 라 넉넉히 돈다
  const cost = cs._takeCronCost('unit-cron');
  assert.ok(cost.cpuMs >= 50 && cost.wallMs >= 300, JSON.stringify(cost));
  assert.deepEqual(cs._takeCronCost('unit-cron'), {}, '한 번 꺼내면 지워진다');
  assert.deepEqual(cs._takeCronCost('never-started'), {});
  const src = read('../services/cronStats.js');
  assert.match(src, /\.\.\._pick\(summary\), \.\.\._takeCronCost\(_nm\) \};/);
  assert.equal(cs._pick({ cpuYesterdayMs: 181234 }).cpuYesterdayMs, 181234);
  const cron = read('../routes/cron.js');
  assert.match(cron, /router\.use\(authorizeCron\);[\s\S]{0,400}markCronStart\(String\(req\.path \|\| ''\)\.split\('\/'\)\.filter\(Boolean\)\[0\]\)/);
  assert.equal((cron.match(/summary\.cpuYesterdayMs = _y;/g) || []).length, 2, 'retention POST 와 GET 둘 다');
});

test('예약 작업 응답: 보내기 직전에 한 번 기록하고, Redis 가 답하지 않아도 응답은 나간다', async () => {
  const cron = read('../routes/cron.js');
  assert.match(cron, /router\.use\(require\('\.\.\/services\/cpuBudget'\)\.flushBeforeJson\(\)\);/);
  const sentBodies = [];
  const res = { json: (b) => { sentBodies.push(b); return res; } };
  cb.flushBeforeJson()({}, res, () => {});
  res.json({ ok: true });
  assert.equal(sentBodies.length, 0, '기록을 기다리는 동안은 아직 보내지 않는다');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sentBodies, [{ ok: true }], 'Redis 가 없는 환경에서도 응답이 한 번 나간다');
  // 답하지 않는 Redis: 상한(1.5초) 뒤에 null 로 돌아온다
  const hang = { incrby: () => new Promise(() => {}) };
  const t0 = Date.now();
  const v = await cb.flushBounded(NOW, { getRedis: () => hang, procUs: () => 5_000_000, sentry: { captureMessage() {} } });
  assert.equal(v, null);
  assert.ok(Date.now() - t0 >= 1400 && Date.now() - t0 < 3000);
  cb._st.flushing = false;
});

test('어제 합계 읽기: 값이 없으면 null(0 으로 만들지 않는다)', async () => {
  const r = fakeRedis(); r.m.set('cpu:day:20261114', 186000);
  assert.equal(await cb.readDay('20261114', { getRedis: () => r }), 186000);
  assert.equal(await cb.readDay('20261113', { getRedis: () => r }), null);
  assert.equal(await cb.readDay('20261114', { getRedis: () => null }), null);
  assert.equal(cb.yesterdayOf(NOW), '20261114');
});

test('미리보기 대리 서버: 200 응답만 정해진 시간 동안 기억한다', () => {
  const px = require('../../scripts/dev-preview-proxy.cjs');
  px.cache.clear();
  px.cachePut('GET /api/rates', 200, { 'content-type': 'application/json' }, Buffer.from('{}'));
  px.cachePut('GET /api/x', 429, {}, Buffer.from('no'));
  assert.equal(px.cacheGet('GET /api/rates').body.toString(), '{}');
  assert.equal(px.cacheGet('GET /api/x'), null);
  px.cache.get('GET /api/rates').at = Date.now() - px.CACHE_MS - 1;
  assert.equal(px.cacheGet('GET /api/rates'), null, '시간이 지나면 버린다');
  const src = read('../../scripts/dev-preview-proxy.cjs');
  assert.match(src, /if \(require\.main === module\) server\.listen\(/, '불러오기만 해서는 서버가 뜨지 않는다');
  assert.match(src, /u\.searchParams\.has\('_fresh'\)/);
});
