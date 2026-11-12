/**
 * backend/test/audit-caps-1111.test.js
 *
 * 보안 점검 후속 3건 회귀 고정(2026-11-11).
 *  1) facility-kakao-uncapped-quota-and-persistent-rows: /api/search/facility 의 Kakao 호출도 전역 일일 상한 관문을 거친다.
 *  2) geocode-global-cap-exhaustible-by-few-ips: IP 1개의 하루 Kakao 시도 수가 전역 상한의 작은 일부로 막힌다.
 *  3) anon-append-tables-unbounded-growth: ai_feedback·data_error_reports 총 행 수 상한 정리(visit_attribution 은 기존 180일 정리).
 */
'use strict';
process.env.KAKAO_REST_API_KEY = 'test-key-for-unit';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const geocode = require('../routes/geocode');

function stubAxios(fn) {
  const orig = axios.get;
  const calls = [];
  axios.get = async (url, cfg) => { calls.push({ url, cfg }); return fn ? fn(url, cfg) : { status: 200, data: { documents: [], meta: { total_count: 0 } } }; };
  return { calls, restore() { axios.get = orig; } };
}
function resetCaps() {
  geocode._memCap.day = ''; geocode._memCap.n = 0; geocode._resetCapHit();
  geocode._memIp.day = ''; geocode._memIp.m = new Map();
}

// ── 1번 ─────────────────────────────────────────────
test('1: 관문은 요청당 한 번만 계수기를 올리고 판정을 기억한다', async () => {
  resetCaps();
  const gate = geocode.createKakaoGate();
  assert.equal(await gate(), true);
  assert.equal(await gate(), true);
  assert.equal(await gate(), true);
  assert.equal(geocode._memCap.n, geocode.FACILITY_KAKAO_WEIGHT, '세 번 불러도 한 번만 센다');
});

test('1: 전역 상한에 닿으면 관문이 false 를 돌려주고 같은 날 이후엔 계수기를 더 올리지 않는다', async () => {
  resetCaps();
  await geocode._bumpGeoCap(geocode.GEOCODE_GLOBAL_DAILY_CAP); // 상한까지 채움
  assert.equal(await geocode.createKakaoGate()(), false);
  const n = geocode._memCap.n;
  assert.equal(await geocode.createKakaoGate()(), false);
  assert.equal(geocode._memCap.n, n, '상한 도달일엔 더 세지 않는다');
  resetCaps();
});

test('1: resolveCoord 는 관문이 false 면 Kakao 를 부르지 않고 null(좌표 없음)을 돌려준다', async () => {
  resetCaps();
  const { resolveCoord } = require('../services/geocodeCacheService');
  const s = stubAxios();
  try {
    const r = await resolveCoord({ aptName: '관문시험단지', sigungu: '시험구', umdNm: '시험동' }, undefined, { kakaoGate: async () => false });
    assert.equal(r, null);
    assert.equal(s.calls.length, 0);
    await resolveCoord({ aptName: '관문시험단지2', sigungu: '시험구', umdNm: '시험동' }, undefined, { kakaoGate: async () => true });
    assert.ok(s.calls.length > 0, '관문 통과 시엔 종전처럼 Kakao 를 부른다');
  } finally { s.restore(); }
});

test('1: resolveSchools·resolveAcademies 도 관문이 false 면 Kakao 를 부르지 않는다', async () => {
  const { resolveSchools } = require('../services/schoolService');
  const { resolveAcademies } = require('../services/academyService');
  const s = stubAxios();
  try {
    const sc = await resolveSchools({ aptName: '관문학교단지', sigungu: '시험구', lat: 37.5, lng: 127.0 }, { kakaoGate: async () => false });
    assert.deepEqual(sc, []);
    const ac = await resolveAcademies({ aptName: '관문학원단지', sigungu: '시험구', umdNm: '시험동', lat: 37.51, lng: 127.01, kakaoGate: async () => false });
    assert.equal(ac, null);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test('1: search.js facility 경로가 관문을 좌표·학교·학원 호출에 모두 넘긴다', () => {
  const src = read('../routes/search.js');
  assert.match(src, /createKakaoGate\(undefined, req\)/);
  assert.match(src, /undefined, \{ kakaoGate \}\)/);
  assert.match(src, /resolveSchools\([^\r\n]*\{ kakaoGate \}\)/);
  assert.match(src, /resolveAcademies\([^\r\n]*kakaoGate \}\)/);
});

// ── 2번 ─────────────────────────────────────────────
test('2: IP 일일 Kakao 시도 상한은 전역 상한의 10% 이하이고 배치 1회 최악(50x6=300)을 여러 번 덮는다', () => {
  assert.ok(geocode.GEOCODE_IP_DAILY_KAKAO_CAP <= geocode.GEOCODE_GLOBAL_DAILY_CAP * 0.1);
  assert.ok(geocode.GEOCODE_IP_DAILY_KAKAO_CAP >= 300 * 3);
});

test('2: IP 예산이 바닥나면 Kakao 를 더 부르지 않고 capped 로 끝난다(전역 계수기도 올리지 않는다)', async () => {
  resetCaps();
  const s = stubAxios();
  try {
    const req = { ip: '203.0.113.7', headers: {} };
    const b = geocode.createIpBudget(req, 8, 8); // 상한 8, 이 요청의 예약 8
    await geocode._kakaoGeocode('k', '가나다', '시험구 시험동', '시험구', '시험동', { ipBudget: b }); // 시도 6
    assert.equal(s.calls.length, 6);
    await geocode._kakaoGeocode('k', '라마바', '시험구 시험동', '시험구', '시험동', { ipBudget: b }); // 남은 2 에서 멈춤
    assert.equal(s.calls.length, 8);
    const globalBefore = geocode._memCap.n;
    const st3 = { ipBudget: b };
    const out = await geocode._kakaoGeocode('k', '사아자', '시험구 시험동', '시험구', '시험동', st3);
    assert.equal(out, null);
    assert.equal(st3.capped, true);
    assert.equal(s.calls.length, 8, '예산 소진 뒤엔 호출 0');
    assert.equal(geocode._memCap.n, globalBefore);
    // flush 가 쓴 만큼 저장하고 같은 IP 의 다음 요청 예산에 반영된다
    await b.flush();
    const b2 = geocode.createIpBudget(req, 8, 6);
    await b2.ensure();
    assert.equal(b2.left, 0);
    const other = geocode.createIpBudget({ ip: '203.0.113.8', headers: {} }, 8, 6);
    await other.ensure();
    assert.equal(other.left, 6, '다른 IP 는 영향 없음(예약분 6 만큼 쓸 수 있다)');
  } finally { s.restore(); resetCaps(); }
});

test('2: batch·단건 라우트가 요청 하나당 IP 예산 하나를 만들어 쓰고 flush 한다', () => {
  const src = read('../routes/geocode.js');
  assert.match(src, /const ipBudget = createIpBudget\(req, GEOCODE_IP_DAILY_KAKAO_CAP, Math\.max\(6, items\.length \* 6\)\)/);
  assert.match(src, /\{ ipBudget \}\)/);
  assert.match(src, /await ipBudget\.flush\(\)/);
  assert.match(src, /ipBudget: createIpBudget\(req, GEOCODE_IP_DAILY_KAKAO_CAP, 6\)/);
});

// ── 3번 ─────────────────────────────────────────────
function mockAdmin(tables) {
  const log = [];
  return {
    log,
    from(t) {
      const st = tables[t];
      return {
        select(cols, opts) {
          if (opts && opts.head) return Promise.resolve({ count: st.count, error: null });
          const c = {
            order() { return c; },
            range(a) { log.push(['range', t, a]); return Promise.resolve({ data: [{ id: st.edgeId }], error: null }); },
          };
          return c;
        },
        delete() { return { lt(col, v) { log.push(['delete', t, col, v]); return Promise.resolve({ count: st.count - 3, error: null }); } }; },
      };
    },
  };
}

test('3: 상한을 넘은 표만 오래된 행부터 지운다', async () => {
  const { runAnonTableCaps, ANON_TABLE_ROW_CAPS } = require('../jobs/retention');
  const admin = mockAdmin({
    ai_feedback: { count: ANON_TABLE_ROW_CAPS.ai_feedback + 3, edgeId: 777 },
    data_error_reports: { count: 10, edgeId: 1 },
  });
  const r = await runAnonTableCaps(admin);
  assert.equal(r.aiFeedbackTrimmed, ANON_TABLE_ROW_CAPS.ai_feedback);
  assert.equal(r.dataErrorTrimmed, 0);
  assert.equal(r.error, null);
  assert.deepEqual(admin.log.find((x) => x[0] === 'delete'), ['delete', 'ai_feedback', 'id', 777]);
  assert.deepEqual(admin.log.find((x) => x[0] === 'range'), ['range', 'ai_feedback', ANON_TABLE_ROW_CAPS.ai_feedback - 1]);
});

test('3: 한 표가 실패해도 다른 표 정리는 계속된다(독립 try)', async () => {
  const { runAnonTableCaps, ANON_TABLE_ROW_CAPS } = require('../jobs/retention');
  const base = mockAdmin({ ai_feedback: { count: 1, edgeId: 1 }, data_error_reports: { count: ANON_TABLE_ROW_CAPS.data_error_reports + 3, edgeId: 9 } });
  const admin = { log: base.log, from(t) { if (t === 'ai_feedback') throw new Error('boom'); return base.from(t); } };
  const r = await runAnonTableCaps(admin);
  assert.match(r.error, /ai_feedback: boom/);
  assert.equal(r.dataErrorTrimmed, ANON_TABLE_ROW_CAPS.data_error_reports);
});

test('3: 결과 숫자는 cron 결과 최상위 키로 평탄하게 있고 cronStats NUM 에 등록돼 있다', () => {
  const ret = read('../jobs/retention.js');
  assert.match(ret, /aiFeedbackTrimmed: anonCapResult\.aiFeedbackTrimmed/);
  assert.match(ret, /dataErrorTrimmed: anonCapResult\.dataErrorTrimmed/);
  assert.match(read('../services/cronStats.js'), /'aiFeedbackTrimmed', 'dataErrorTrimmed'/);
});

test('3: visit_attribution 은 기존 180일 정리를 그대로 둔다(daily_visit 제외)', () => {
  const ret = read('../jobs/retention.js');
  assert.match(ret, /ATTRIBUTION_RETENTION_DAYS = 180/);
  assert.match(ret, /\.neq\('event', 'daily_visit'\)/);
});

// ── 보안 점검 run-2 (2026-11-11) 후속 ─────────────────────────────────────────────
test('run-2: 같은 IP 의 동시 요청은 예약분을 서로 보므로 합계가 상한을 넘지 못한다', async () => {
  resetCaps();
  try {
    const req = { ip: '203.0.113.20', headers: {} };
    const bs = Array.from({ length: 5 }, () => geocode.createIpBudget(req, 10, 6));
    await Promise.all(bs.map((b) => b.ensure()));
    const total = bs.reduce((a, b) => a + b.left, 0);
    assert.ok(total <= 10, `동시 요청 5개가 받은 예산 합계 ${total} 가 상한 10 을 넘었다`);
    // 안 쓴 예약분은 돌려준다: 전부 0 을 쓰고 끝내면 다음 요청이 다시 6 을 받는다
    await Promise.all(bs.map((b) => b.flush()));
    const next = geocode.createIpBudget(req, 10, 6);
    await next.ensure();
    assert.equal(next.left, 6);
    await next.flush();
  } finally { resetCaps(); }
});

test('run-2: 관문은 req 를 받으면 IP 예산을 먼저 쓰고, 예산이 모자라면 전역 계수기를 올리지 않는다', async () => {
  resetCaps();
  try {
    const req = { ip: '203.0.113.30', headers: {} };
    const cap = geocode.GEOCODE_IP_DAILY_KAKAO_CAP;
    const fill = geocode.createIpBudget(req, cap, cap - 2); // 이 IP 의 예산을 2 만 남긴다
    await fill.ensure(); fill.used = cap - 2; await fill.flush();
    const before = geocode._memCap.n;
    assert.equal(await geocode.createKakaoGate(4, req)(), false);
    assert.equal(geocode._memCap.n, before, '예산이 모자란 IP 가 전역 계수기를 올렸다');
    assert.equal(await geocode.createKakaoGate(4, { ip: '203.0.113.31', headers: {} })(), true);
    assert.equal(geocode._memCap.n, before + 4);
  } finally { resetCaps(); }
});

test('run-2: 단지 비교와 시설 조회가 req 가 붙은 관문을 쓴다', () => {
  assert.match(read('../routes/analysis.js'), /createKakaoGate\(apts\.length \* 4, req\)/);
  assert.match(read('../routes/analysis.js'), /compareBatch\(apts, \{ dealMonths, kakaoGate \}\)/);
  const svc = read('../services/analysisService.js');
  assert.match(svc, /_compareOne\(a, dealMonths, opts\.kakaoGate\)/);
  assert.match(svc, /if \(kakaoGate && !\(await kakaoGate\(\)\)\) return fail;/);
});

test('run-2: 채팅 개인정보 검사는 공백이 수만 자여도 빨리 끝나고, 잡던 것은 그대로 잡는다', () => {
  const chat = require('../routes/chat');
  const detect = chat._pii.detectPII;
  assert.equal(typeof detect, 'function');
  const t0 = Date.now();
  assert.deepEqual(detect('123456' + ' '.repeat(49000) + 'x'), []);
  assert.ok(Date.now() - t0 < 200, `검사가 ${Date.now() - t0}ms 걸렸다`);
  assert.ok(detect('900101-1234567').includes('주민등록번호'));
  assert.ok(detect('900101      -      1234567').includes('주민등록번호'), '공백이 많아도 잡아야 한다');
  assert.ok(detect('010 1234 5678').includes('휴대전화번호'));
  assert.deepEqual(detect('2026-11-11 에 거래된 84.97 타입'), []);
});

test('run-2: 지역과 시도 허용 목록은 상속 키(constructor 등)를 통과시키지 않는다', () => {
  assert.match(read('../routes/region.js'), /Object\.hasOwn\(LAWD_CODE_TO_NAME, code\)/);
  assert.match(read('../routes/region.js'), /Object\.hasOwn\(LAWD_CODES, n\)/);
  assert.match(read('../routes/search.js'), /Object\.hasOwn\(rp\.SIDOS, sido\)/);
  assert.match(read('../services/regionPopularService.js'), /Object\.hasOwn\(SIDOS, sido\)/);
});

// ── 보안 점검 run-3 (2026-11-11) 후속 ─────────────────────────────────────────────
test('run-3: CPU 측정 미들웨어의 봇 이름 찾기는 긴 식별 문자열에서도 빨리 끝난다', () => {
  const { botName } = require('../middleware/cpuMeter');
  const t0 = process.hrtime.bigint();
  assert.equal(botName('Mozilla/5.0 ' + 'a'.repeat(15000)), null);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 20, `봇 이름 찾기가 ${ms.toFixed(1)}ms 걸렸다`);
  assert.equal(botName('Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)'), 'Yeti');
  assert.equal(botName('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot');
  assert.match(read('../middleware/cpuMeter.js'), /String\(req\.get\('user-agent'\) \|\| ''\)\.slice\(0, 256\)/);
});

test('run-3: 분석 조회는 100자가 넘는 단지 이름을 받지 않는다, 검색은 별표와 음수 limit 을 막는다', () => {
  assert.match(read('../routes/analysis.js'), /if \(typeof aptName !== 'string' \|\| aptName\.length > 100\) return res\.status\(400\)/);
  const s = read('../routes/search.js');
  assert.ok(s.includes(String.raw`replace(/[%_\\*]/g, '')`));
  assert.ok(s.includes('Math.max(1, Math.min(parseInt(req.query.limit) || 10, 30))'));
});

test('run-3: 채팅 이력에 null 항목이 있어도 500 이 아니다', () => {
  const { validateChatInput } = require('../middleware/validation');
  const req = { body: { message: '안녕하세요', context: { history: [null, 'x', { role: 'user', content: '질문' }] } } };
  let nexted = false; const res = { status: () => ({ json: () => {} }) };
  validateChatInput(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.deepEqual(req.body.context.history, [{ role: 'user', content: '질문' }]);
});

test('run-3: 알림 구독의 지역 코드는 적재하는 지역만 받는다', () => {
  assert.ok(read('../routes/push.js').includes("const items = sanitizeItems(req.body?.items).map((it) => (it.lawdCd && !isKnownLawdCd(it.lawdCd) ? { ...it, lawdCd: null } : it));"));
});

test('run-3 후속: 단지 검색어는 100자로 자르고, 채팅 제목 변환 정규식은 공백 뒤 첫 글자를 고정한다', () => {
  assert.ok(read('../routes/search.js').includes("String(req.query.q || '').slice(0, 100).replace("));
  const html = read('../../frontend/index.html');
  assert.ok(html.includes(String.raw`#{1,4}\s+(\S.*?)(?=<br>|$)/g`));
  // 같은 정규식으로 긴 공백 입력이 빨리 끝나는지 확인
  const re = /(?:^|<br>)#{1,4}\s+(\S.*?)(?=<br>|$)/g;
  const t0 = process.hrtime.bigint();
  ('#' + ' '.repeat(20000) + '\u2028').replace(re, '$1');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50);
  assert.equal('## 둘째 제목<br>본문'.replace(re, '[$1]'), '[둘째 제목]<br>본문');
});

// ── 보안 점검 run-3 남은 항목 (2026-11-12) ─────────────────────────────────────────────
function routeHandlers(router, method, p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  return layer.route.stack.map((s) => s.handle);
}
test('run-3: 방문 기록(daily_visit)은 IP 하나가 하루 30건까지만 쌓인다, 다른 이벤트는 그대로', async () => {
  const dbClient = require('../db/client');
  const orig = dbClient.getSupabaseAdmin;
  const inserted = [];
  dbClient.getSupabaseAdmin = () => ({ from: () => ({ insert: async (row) => { inserted.push(row.event); return { error: null }; } }) });
  delete require.cache[require.resolve('../routes/attribution')];
  try {
    const router = require('../routes/attribution');
    const handler = routeHandlers(router, 'post', '/').pop();
    const call = async (event, ip) => { const res = { status() { return this; }, end() {}, json() {} }; await handler({ body: { event }, ip, headers: {} }, res); };
    for (let i = 0; i < 35; i++) await call('daily_visit', '203.0.113.50');
    assert.equal(inserted.filter((e) => e === 'daily_visit').length, 30, `쌓인 daily_visit ${inserted.length}건`);
    await call('daily_visit', '203.0.113.51');
    assert.equal(inserted.filter((e) => e === 'daily_visit').length, 31, '다른 IP 는 영향 없음');
    for (let i = 0; i < 40; i++) await call('search', '203.0.113.50');
    assert.equal(inserted.filter((e) => e === 'search').length, 40, '다른 이벤트에는 상한을 걸지 않는다');
  } finally { dbClient.getSupabaseAdmin = orig; delete require.cache[require.resolve('../routes/attribution')]; }
});

test('run-3: 피드백과 오류 신고는 보내는 쪽마다 하루 30건으로 묶인다', async () => {
  const router = require('../routes/feedback');
  for (const p of ['/ai', '/data-error']) {
    const names = routeHandlers(router, 'post', p).map((h) => h.name);
    assert.ok(names.includes('feedbackCap'), `${p} 에 상한이 없다`);
    assert.ok(names.indexOf('feedbackCap') > names.indexOf('optionalAuth') || names.indexOf('optionalAuth') === -1, '로그인 확인 뒤에 세어야 사용자 단위로 묶인다');
  }
  const cap = routeHandlers(router, 'post', '/ai').find((h) => h.name === 'feedbackCap');
  let passed = 0, blocked = 0;
  for (let i = 0; i < 33; i++) {
    const res = { status(c) { this.c = c; return this; }, json() { blocked++; } };
    await cap({ ip: '203.0.113.60', headers: {} }, res, () => { passed++; });
  }
  assert.equal(passed, 30); assert.equal(blocked, 3);
});

test('run-3: 서버 렌더 경로 여섯 곳에 메모리 요청 제한이 걸려 있고, 실제로 분당 한도를 넘으면 429 다', async () => {
  const src = read('../server.js');
  for (const p of ['/briefing', '/region', '/apt', '/data-sources', '/sitemap.xml', '/sitemaps']) {
    assert.ok(src.includes(`app.use('${p}', ssrMemLimiter, require(`), `${p} 에 제한이 없다`);
  }
  assert.match(src, /const ssrMemLimiter = rateLimit\(\{\s+windowMs: 60 \* 1000,\s+limit: 120,/);
  // 같은 설정의 제한기가 한도를 넘는 요청을 막는지 작은 앱으로 확인(한도만 3 으로 줄여서)
  const express = require('express'); const rateLimit = require('express-rate-limit'); const http = require('node:http');
  const app = express();
  app.use('/apt', rateLimit({ windowMs: 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false, message: 'x' }), (req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const get = () => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: server.address().port, path: '/apt/1' }, (rs) => { rs.resume(); rs.on('end', () => resolve(rs.statusCode)); }).on('error', reject); });
  try {
    const codes = []; for (let i = 0; i < 5; i++) codes.push(await get());
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await new Promise((r) => server.close(r)); }
});

test('run-3: 알림 구독 등록은 IP 하나가 하루 20번까지', () => {
  const src = read('../routes/push.js');
  assert.ok(src.includes('const PUSH_SUB_IP_DAILY = 20;'));
  assert.ok(src.indexOf('dl:pushsub:') < src.indexOf('const sub = req.body?.subscription;'), '구독 내용을 읽기 전에 센다');
  assert.ok(src.includes('if (used > PUSH_SUB_IP_DAILY) return res.status(429)'));
});

test('run-3: 인증은 모양이 아니거나 만료된 토큰은 외부 호출 없이 거절하고, 무효 판정만 잠깐 기억한다', async () => {
  const client = require('../db/client');
  const origPub = client.getSupabasePublic, origAdmin = client.getSupabaseAdmin;
  let calls = 0; let mode = 'invalid';
  client.getSupabasePublic = () => ({ auth: { getUser: async () => {
    calls++;
    if (mode === 'invalid') return { data: null, error: { status: 401, message: 'invalid JWT' } };
    if (mode === 'network') return { data: null, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } };
    return { data: { user: { id: 'u1', email: 'a@b.c', email_confirmed_at: '2026-01-01' } }, error: null };
  } } });
  client.getSupabaseAdmin = () => null;
  const authPath = require.resolve('../middleware/auth');
  delete require.cache[authPath];
  try {
    const { verifyToken } = require('../middleware/auth');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (exp, tag) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x', exp, tag })}.${'s'.repeat(43)}`;
    const future = Math.floor(Date.now() / 1000) + 3600;
    // 1) 모양이 아님, 2) 이미 만료: 호출 0
    assert.equal((await verifyToken('not-a-jwt')).user, null);
    assert.equal((await verifyToken(jwt(Math.floor(Date.now() / 1000) - 3600, 'old'))).user, null);
    assert.equal(calls, 0, '모양이 아니거나 만료된 토큰에 외부 호출을 했다');
    // 3) 무효 판정은 5초 기억
    const bad = jwt(future, 'bad');
    await verifyToken(bad); await verifyToken(bad);
    assert.equal(calls, 1, '무효 토큰을 두 번 물었다');
    // 4) 일시 오류는 기억하지 않는다
    mode = 'network'; calls = 0;
    const flaky = jwt(future, 'flaky');
    await verifyToken(flaky); await verifyToken(flaky);
    assert.equal(calls, 2, '일시 오류를 무효로 기억했다(다음 요청도 막힌다)');
    // 5) 정상 토큰은 사용자를 돌려준다
    mode = 'ok'; calls = 0;
    const good = jwt(future, 'good');
    assert.equal((await verifyToken(good)).user.id, 'u1');
    assert.equal(calls, 1);
  } finally {
    client.getSupabasePublic = origPub; client.getSupabaseAdmin = origAdmin;
    delete require.cache[authPath];
  }
});

test('run-3: 단지 이름 없는 월별 실거래 조회는 최근 36개월 안의 달만 받는다', async () => {
  const router = require('../routes/transactions');
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (q) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await handler({ query: q, sanitized: undefined }, res); return res; };
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const ym = (back) => { const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - back, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const old = await call({ lawdCd: '11680', dealYm: ym(37) });
  assert.equal(old.code, 400, '37개월 전 달을 받았다');
  const veryOld = await call({ lawdCd: '11680', dealYm: '200801' });
  assert.equal(veryOld.code, 400);
  // 최근 달과 단지 이름이 있는 조회는 이 검사에 걸리지 않는다(서비스 호출까지 가므로 400 이 아닌 다른 결과)
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/transactions.js'), 'utf8');
  assert.ok(src.includes('if (!aptName) {') && src.includes('if (back > 36 || back < -1) return res.status(400)'));
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.ok(html.includes('const months=[prevYm(1), prevYm(2), prevYm(3)];'), '화면의 이름 없는 조회 범위가 바뀌었다면 상한도 다시 볼 것');
});

// SURGE-ALERT-2026-11-13: 방문이 한 시간 기준(40)을 넘는 순간 Sentry 경보를 한 번 보낸다(10배에서 한 번 더).
test('방문 급증 경보: 한 시간 방문 기록이 기준에 닿으면 Sentry 경보가 정확히 한 번 나간다', async () => {
  const sentryPath = require.resolve('../sentry');
  const dlPath = require.resolve('../middleware/dailyLimit');
  const dbPath = require.resolve('../db/client');
  const routePath = require.resolve('../routes/attribution');
  const saved = { s: require.cache[sentryPath], dl: require.cache[dlPath], db: require.cache[dbPath], r: require.cache[routePath] };
  const sent = [];
  const counts = new Map();
  const realDl = require('../middleware/dailyLimit');
  require.cache[sentryPath] = { id: sentryPath, filename: sentryPath, loaded: true, exports: { captureMessage: (m, o) => sent.push({ m, o }), captureException() {} } };
  require.cache[dlPath] = { id: dlPath, filename: dlPath, loaded: true, exports: { ...realDl,
    incrementUsage: async (k) => { const n = (counts.get(k) || 0) + 1; counts.set(k, n); return { used: n }; } } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => ({ from: () => ({ insert: async () => ({}) }) }) } };
  delete require.cache[routePath];
  try {
    const router = require('../routes/attribution');
    const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    for (let i = 0; i < 45; i++) {
      const req = { body: { event: 'daily_visit' }, headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${i % 250}`, 'x-vercel-ip-country': 'CN' }, ip: `10.0.0.${i}`, socket: {} };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, end() { return this; }, json() { return this; } };
      await handle(req, res);
    }
    const surge = sent.filter((x) => x.o && x.o.tags && x.o.tags.monitor === 'visit-surge');
    assert.equal(surge.length, 1, `경보 ${surge.length}건`);
    assert.match(surge[0].m, /방문 급증: 이번 시간\(UTC \d{10}\) 방문 기록 40건/);
    assert.equal(surge[0].o.level, 'warning');
  } finally {
    for (const [p, v] of [[sentryPath, saved.s], [dlPath, saved.dl], [dbPath, saved.db], [routePath, saved.r]]) { if (v) require.cache[p] = v; else delete require.cache[p]; }
  }
});
