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
