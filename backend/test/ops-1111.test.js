/**
 * 2026-11-11 운영 자원 관리(plans/190)의 회귀 검사.
 *  - 값이 같은 갱신을 건너뛰는 트리거가 스키마 기록과 마이그레이션에 있다(DB 인덱스 불어남 차단)
 *  - robots.txt 에서 막은 수집기는 vercel.json 첫 route 가 함수 실행 전에 막는다(검색엔진과 일반 브라우저는 통과)
 *  - 가동 감시의 HEAD /api/health 는 본문 계산 없이 끝난다
 *  - 전월세 실시간 조회 기록은 같은 내용을 10분에 한 번만 남긴다
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('원본 거래 표에 같은 값 갱신을 건너뛰는 트리거가 기록돼 있다', () => {
  const stmt = /create trigger zz_skip_same before update on public\.molit_transactions\s+for each row execute function suppress_redundant_updates_trigger\(\);/;
  assert.match(read('supabase/schema.sql'), stmt);
  assert.match(read('supabase/migrations/20261111_molit_skip_same_update.sql'), stmt);
});

test('robots.txt 에서 전체를 막은 수집기는 vercel.json 첫 route 가 막고, 검색엔진과 브라우저는 지나간다', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const first = vercel.routes[0];
  assert.deepEqual(first.mitigate, { action: 'deny' }, '차단 route 는 맨 앞이어야 한다(뒤에 두면 함수가 먼저 뜬다)');
  assert.equal(first.dest, undefined);
  const has = first.has[0];
  assert.equal(has.type, 'header');
  assert.equal(has.key, 'user-agent');
  const ua = new RegExp(`^${has.value}$`);
  const src = new RegExp(`^${first.src}$`);

  // robots.txt 에서 "Disallow: /" 인 수집기 이름을 읽는다. Google-Extended 는 요청 헤더에 나오지 않는 토큰이라 뺀다.
  const robots = read('frontend/robots.txt');
  const blocked = [];
  let agents = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(user-agent|disallow|allow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'user-agent') { if (inRules) { agents = []; inRules = false; } agents.push(m[2]); }
    else { inRules = true; if (m[1].toLowerCase() === 'disallow' && m[2] === '/') blocked.push(...agents); }
  }
  const names = [...new Set(blocked)].filter((n) => n !== '*' && n !== 'Google-Extended');
  assert.ok(names.length >= 8, `읽은 수집기 수가 예상보다 적다: ${names.join(', ')}`);
  for (const n of names) assert.ok(ua.test(`Mozilla/5.0 (compatible; ${n}/1.0; +https://example.com/bot)`), `${n} 가 차단 목록에 없다`);

  const pass = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html?faqId=28966)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'vercel-cron/1.0',
  ];
  for (const u of pass) assert.ok(!ua.test(u), `지나가야 하는 요청이 막힌다: ${u}`);

  // robots.txt 자체는 막힌 수집기도 읽을 수 있어야 한다(못 읽으면 규칙을 모르는 상태가 된다).
  assert.ok(!src.test('/robots.txt'));
  for (const p of ['/', '/apt/11350-23', '/region/41290', '/api/health', '/robots.txt.bak', '/sitemap.xml']) assert.ok(src.test(p), `${p} 가 차단 범위에서 빠졌다`);
});

test('HEAD /api/health 는 GET 처리부보다 먼저 등록돼 본문 계산 없이 200 으로 끝난다', async () => {
  const src = read('backend/server.js');
  const head = src.indexOf("app.head('/api/health'");
  const get = src.indexOf("app.get('/api/health', optionalAuth");
  assert.ok(head > 0 && get > 0 && head < get, 'HEAD 처리부가 GET 처리부 앞에 있어야 한다');
  // 등록 순서가 실제로 그렇게 동작하는지 같은 모양의 작은 앱으로 확인한다.
  const express = require('express');
  const http = require('node:http');
  const app = express();
  let bodyBuilt = 0;
  app.head('/api/health', (req, res) => { res.set('Cache-Control', 'no-store'); res.status(200).end(); });
  app.get('/api/health', (req, res) => { bodyBuilt++; res.json({ status: 'ok' }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const call = (method) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/health', method }, (rs) => { rs.resume(); rs.on('end', () => resolve(rs.statusCode)); });
    rq.on('error', reject); rq.end();
  });
  try {
    assert.equal(await call('HEAD'), 200);
    assert.equal(bodyBuilt, 0, 'HEAD 가 GET 처리부까지 갔다');
    assert.equal(await call('GET'), 200);
    assert.equal(bodyBuilt, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test('전월세 실시간 조회 기록은 같은 내용을 10분에 한 번만 남기고, 사유가 바뀌면 바로 남긴다', () => {
  const cronStats = require('../services/cronStats');
  const rent = require('../services/rentService');
  const orig = cronStats.recordCronRun;
  const calls = [];
  cronStats.recordCronRun = async (name, summary) => { calls.push([name, summary]); };
  rent._rentLiveLast.clear();
  try {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 14; i++) rent._recordRentLive({ ok: 1 }, t0 + i * 400);
    assert.equal(calls.length, 1, '5초 동안 14번 기록했다');
    assert.equal(rent._recordRentLive({ ok: false, error: 'HTTP 429' }, t0 + 6000), true, '실패는 성공 기록과 따로 센다');
    assert.equal(rent._recordRentLive({ ok: false, error: 'HTTP 429' }, t0 + 7000), false);
    assert.equal(rent._recordRentLive({ ok: false, error: 'timeout' }, t0 + 8000), true, '사유가 바뀌면 바로 남긴다');
    assert.equal(rent._recordRentLive({ ok: 1 }, t0 + 10 * 60 * 1000 + 1), true, '10분이 지나면 다시 남긴다');
    assert.deepEqual(calls.map((c) => c[0]), ['rent-live', 'rent-live', 'rent-live', 'rent-live']);
  } finally { cronStats.recordCronRun = orig; rent._rentLiveLast.clear(); }
});

test('알림 공개 키 응답은 키가 있을 때만 CDN 에 저장된다', () => {
  const src = read('backend/routes/push.js');
  assert.match(src, /router\.get\('\/key'[\s\S]{0,500}res\.set\('Cache-Control', VAPID_PUBLIC_KEY \? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' : 'no-store'\);/);
});

test('Sentry 가동 감시 봇은 첫 화면 대신 2바이트 응답을 받는다(감시는 200 유지, 전송량만 줄인다)', () => {
  // 2026-11-11 Vercel 방화벽 화면: SentryUptimeBot 하루 약 1,500건이 첫 화면(1.28MB)을 받아 갔다. 팀 전송량 67GB 중 내집로그 58.7GB.
  const vercel = JSON.parse(read('vercel.json'));
  const r = vercel.routes[1];
  assert.equal(r.dest, '/frontend/up.txt');
  assert.equal(r.status, undefined, '상태 코드를 바꾸면 감시가 장애로 본다');
  const ua = new RegExp(`^${r.has[0].value}$`);
  const src = new RegExp(`^${r.src}$`);
  assert.ok(ua.test('SentryUptimeBot/1.0 (+http://docs.sentry.io/product/alerts/uptime-monitoring/)'));
  assert.ok(!ua.test('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'));
  assert.ok(src.test('/') && src.test('/index.html') && !src.test('/api/health') && !src.test('/apt/1'));
  assert.ok(fs.statSync(path.join(ROOT, 'frontend/up.txt')).size < 16);
});

test('BG-QUEUE: 방문 기록 전송은 첫 상태 확인 뒤에 한 번에 하나씩 나간다(동시 호출로 서버가 여러 개 뜨지 않게)', async () => {
  const html = read('frontend/index.html');
  const i = html.indexOf('// BG-QUEUE-2026-11-12'), j = html.indexOf('const HEALTH_TTL_MS = 20000;');
  assert.ok(i > 0 && j > i);
  // 줄 세우기 코드만 떼어 실행해 순서를 확인한다
  const code = html.slice(i, j).replace("try{ window.addEventListener('pagehide', function(){ _bgGateOpen(); }); }catch(_){}", '');
  const api = new Function(`${code}; return { _bgApi, open: () => _bgGateOpen() };`)();
  const log = []; let running = 0, maxRunning = 0;
  const task = (name, ms) => () => new Promise((r) => { running++; maxRunning = Math.max(maxRunning, running); log.push('start ' + name); setTimeout(() => { running--; log.push('end ' + name); r(); }, ms); });
  api._bgApi(task('a', 30)); api._bgApi(task('b', 10)); api._bgApi(() => { throw new Error('x'); }); const last = api._bgApi(task('c', 5));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log, [], '상태 확인이 끝나기 전에는 나가지 않는다');
  api.open();
  await last;
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(maxRunning, 1, '동시에 둘 이상 나갔다');
  assert.ok(html.includes("if (typeof _bgApi === 'function') _bgApi(_send); else _send();"));
  assert.ok(html.includes('_bgGateOpen(); }); // BG-QUEUE'));
  assert.ok(html.includes("window.addEventListener('pagehide', function(){ _bgGateOpen(); });"));
});
