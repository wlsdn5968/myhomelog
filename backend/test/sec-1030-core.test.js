/**
 * SEC-1030 C1·C2·C10·C12 — 보안 감사(2026-10-30) 결함 회귀 고정.
 * 실행: cd backend && TZ=UTC node --test test/sec-1030-core.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const clientPath = require.resolve('../db/client');
const authPath = require.resolve('../middleware/auth');
const analysisSvcPath = require.resolve('../services/analysisService');

const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
function fresh(rel) { const p = require.resolve(rel); delete require.cache[p]; return require(p); }
function findHandler(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mkRes() {
  return { body: null, code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}

// ── C1: 관리자·이메일 확인 판정은 email_confirmed_at 만 ──
test('C1: auth·planService 가 user_metadata.email_verified 를 확인 근거로 쓰지 않는다', () => {
  for (const f of ['../middleware/auth.js', '../services/planService.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
      .split(/\r?\n/).filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n'); // 주석 제외
    assert.doesNotMatch(src, /user_metadata\s*\??\.\s*email_verified/, f);
    assert.match(src, /Boolean\(\s*data\??\.(user\??\.)?email_confirmed_at|Boolean\(\s*data\?\.user\?\.email_confirmed_at/, f);
  }
});

// ── C10: 비교 API 지역 코드 허용 목록 ──
function loadAnalysis(calls) {
  stub(analysisSvcPath, {
    analyzeApt: async () => ({}), getLawdCdFromArea: () => null,
    compareBatch: async (apts) => { calls.push(apts); return { ok: true }; },
  });
  return fresh('../routes/analysis');
}

test('C10: 모르는 지역 코드·잘못된 단지 정보는 400, 외부 호출 없음', async () => {
  const calls = [];
  const h = findHandler(loadAnalysis(calls), 'post', '/compare');
  const cases = [
    [{ aptName: 'A', lawdCd: '99999' }, { aptName: 'B', lawdCd: '11350' }],
    [{ aptName: 'A', lawdCd: '11350' }, { aptName: 'x'.repeat(101), lawdCd: '11350' }],
    [{ aptName: 'A', lawdCd: '11350' }, null],
    [{ aptName: 'A', lawdCd: '11350' }, { aptName: '   ' }],
  ];
  for (const apts of cases) {
    const res = mkRes();
    await h({ body: { apts } }, res);
    assert.equal(res.code, 400, JSON.stringify(apts).slice(0, 80));
  }
  assert.equal(calls.length, 0);
});

test('C10: 알려진 지역 코드(또는 코드 생략)는 그대로 비교한다', async () => {
  const calls = [];
  const h = findHandler(loadAnalysis(calls), 'post', '/compare');
  const res = mkRes();
  await h({ body: { apts: [{ aptName: '공릉풍림아이원', lawdCd: '11350' }, { aptName: 'B', sigungu: '노원구' }] } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 1);
});

// ── C12: 시설 조회 입력 검사 ──
test('C12: /facility — 모르는 지역 코드·과도한 길이는 400, 정상 입력은 검사를 통과한다', async () => {
  const router = fresh('../routes/search');
  const h = findHandler(router, 'get', '/facility');
  const bad = [
    { aptName: 'A', lawdCd: '00000' },
    { aptName: 'x'.repeat(101) },
    { aptName: 'A', sigungu: 'x'.repeat(41) },
    { aptName: 'A', umdNm: 'x'.repeat(41) },
    { aptName: 'A', aptSeq: 'x'.repeat(41) },
  ];
  for (const q of bad) {
    const res = mkRes();
    await h({ query: q }, res);
    assert.equal(res.code, 400, JSON.stringify(q).slice(0, 60));
  }
  // 정상 입력은 검사를 지나 다음 단계(관리자 DB 연결)로 간다 — 테스트 환경엔 DB 가 없어 503 또는 그 뒤 단계.
  const ok = mkRes();
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try { await h({ query: { aptName: '공릉풍림아이원', sigungu: '노원구', umdNm: '공릉동', lawdCd: '11350', mode: 'basic' } }, ok); }
  catch (_) { /* DB 단계 예외는 검사 통과를 뜻한다 */ }
  finally { if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev; }
  assert.notEqual(ok.code, 400);
});

test('C12: 시군구·단지 코드 없는 카카오 결과는 apt_geocache·apt_schools 에 저장하지 않는다(코드 고정)', () => {
  const geo = fs.readFileSync(path.join(__dirname, '../services/geocodeCacheService.js'), 'utf8');
  assert.match(geo, /if \(!apt\.sigungu && !apt\.kaptCode\) \{\s*cache\.set\(`geo-db:\$\{key\}`, fromKakao, 3600\);\s*return fromKakao;\s*\}\s*await saveToDb/);
  const sch = fs.readFileSync(path.join(__dirname, '../services/schoolService.js'), 'utf8');
  assert.match(sch, /if \(!apt\.sigungu && !apt\.kaptCode\) cache\.set\(`schools:\$\{key\}`, schools, 3600\);\s*else saveToDb\(key, apt, schools\);/);
});

// ── C2: 채팅 저장 상한 ──
function fakeSb({ sessionCount = 0, messageCount = 0, inserts }) {
  return {
    from(table) {
      const q = {
        _head: false,
        select(_c, opts) { this._head = !!(opts && opts.head); return this; },
        eq() { return this; },
        order() { return this; }, limit() { return this; },
        maybeSingle: async () => ({ data: null }),
        insert(row) { inserts.push([table, row]); return { select: () => ({ single: async () => ({ data: { id: 'n1', created_at: 'T', title: row.title }, error: null }) }) }; },
        update() { return { eq: () => ({ then: (f) => f({ error: null }) }) }; },
        then(resolve) { resolve(this._head ? { count: table === 'chat_sessions' ? sessionCount : messageCount, error: null } : { data: [], error: null }); },
      };
      return q;
    },
  };
}
function loadChat(sb) {
  const real = require(clientPath);
  stub(clientPath, { ...real, getUserScopedClient: () => sb });
  stub(authPath, { requireAuth: (_q, _s, n) => n(), optionalAuth: (_q, _s, n) => n() });
  return fresh('../routes/chatSessions');
}
const req = (body, extra = {}) => ({ body, params: { id: '11111111-1111-4111-8111-111111111111' }, user: { id: 'u1' }, accessToken: 't', ...extra });

test('C2: meta 는 일반 객체·2KB 이하만', async () => {
  const inserts = [];
  const h = findHandler(loadChat(fakeSb({ inserts })), 'post', '/:id/messages');
  for (const meta of [[1, 2], 'str', { big: 'x'.repeat(2100) }]) {
    const res = mkRes();
    await h(req({ role: 'user', content: 'hi', meta }), res, e => { throw e; });
    assert.equal(res.code, 400);
  }
  assert.equal(inserts.length, 0);
  const ok = mkRes();
  await h(req({ role: 'user', content: 'hi', meta: { a: 1 } }), ok, e => { throw e; });
  assert.equal(ok.code, 201);
  assert.equal(inserts.length, 1);
});

test('C2: 세션당 메시지 상한·사용자당 세션 상한에 닿으면 429, 저장 안 함', async () => {
  const router0 = loadChat(fakeSb({ inserts: [] }));
  const { MAX_SESSIONS_PER_USER, MAX_MESSAGES_PER_SESSION } = router0._limits;

  const ins1 = [];
  const hm = findHandler(loadChat(fakeSb({ messageCount: MAX_MESSAGES_PER_SESSION, inserts: ins1 })), 'post', '/:id/messages');
  const r1 = mkRes();
  await hm(req({ role: 'user', content: 'hi' }), r1, e => { throw e; });
  assert.equal(r1.code, 429);
  assert.equal(ins1.length, 0);

  const ins2 = [];
  const hs = findHandler(loadChat(fakeSb({ sessionCount: MAX_SESSIONS_PER_USER, inserts: ins2 })), 'post', '/');
  const r2 = mkRes();
  await hs(req({ title: 't' }), r2, e => { throw e; });
  assert.equal(r2.code, 429);
  assert.equal(ins2.length, 0);

  const ins3 = [];
  const hs2 = findHandler(loadChat(fakeSb({ sessionCount: MAX_SESSIONS_PER_USER - 1, inserts: ins3 })), 'post', '/');
  const r3 = mkRes();
  await hs2(req({ title: 't' }), r3, e => { throw e; });
  assert.equal(r3.code, 201);
  assert.equal(ins3.length, 1);
});

test('C2: DB 길이 CHECK 기록 파일이 API 상한과 맞는다', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261030_chat_size_checks.sql'), 'utf8');
  assert.match(sql, /char_length\(content\) <= 8000/);
  assert.match(sql, /octet_length\(meta::text\) <= 4096/);
  assert.match(sql, /char_length\(title\) <= 60/);
  const route = fs.readFileSync(path.join(__dirname, '../routes/chatSessions.js'), 'utf8');
  assert.match(route, /MAX_CONTENT_LEN = 8000/);
  assert.match(route, /MAX_TITLE_LEN = 60/);
});

// ── 적대 리뷰 2026-10-30 후속 ──
test('특약: price·score 도 정리하고(구분자 깨기 차단), 캐시 키에 프롬프트 입력을 모두 넣는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/clause.js'), 'utf8');
  assert.match(src, /price {8}= _safeStr\(price, 10\);/);
  assert.match(src, /score {8}= _safeStr\(score, 5\);/);
  assert.match(src, /isFirstBuyer = isFirstBuyer === true;/);
  // 정리 줄이 프롬프트 조립보다 앞
  assert.ok(src.indexOf('price        = _safeStr') < src.indexOf('<data>${price}억원</data>'));
  const key = src.match(/const cacheKey = `([^`]+)`/)[1];
  for (const v of ['aptName', 'area', 'price', 'ltv', 'houseStatus', 'isFirstBuyer', 'buildYear', 'score', 'issues']) assert.ok(key.includes(v), v);
});

test('백업: 카카오 토큰 열은 백업 파일에 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../scripts/backup-db.js'), 'utf8');
  assert.match(src, /kakao_notify_tokens: \['access_token', 'refresh_token'\]/);
  assert.match(src, /JSON\.stringify\(_omitSecrets\(table, row\)\)/);
  const fnSrc = src.slice(src.indexOf('const SECRET_COLUMNS'), src.indexOf('async function dumpTable'));
  const omit = new Function(`${fnSrc}; return _omitSecrets;`)();
  assert.deepEqual(omit('kakao_notify_tokens', { user_id: 'u', access_token: 'a', refresh_token: 'r', linked_at: 't' }), { user_id: 'u', linked_at: 't' });
  assert.deepEqual(omit('bookmarks', { id: 1 }), { id: 1 });
});

test('AI 전역 사용량: Redis 증분이 실패하면 메모리에 대신 더한다', async () => {
  const redisPath = require.resolve('../redis');
  const savedRedis = require.cache[redisPath];
  stub(redisPath, { getRedis: () => ({ incrby: async () => { throw new Error('down'); }, expire: async () => {} }) });
  const cache = require('../cache');
  try {
    const g = fresh('../services/globalAiBudget');
    const keys = cache.keys ? cache.keys().filter(k => /^gai:/.test(k)) : [];
    for (const k of keys) cache.del(k);
    await g.recordGlobalAiUsage({ input_tokens: 100000, output_tokens: 100000 });
    const vals = (cache.keys ? cache.keys() : []).filter(k => /^gai:(day|mon):/.test(k)).map(k => cache.get(k));
    assert.equal(vals.length, 2);
    assert.ok(vals.every(v => v > 0));
  } finally {
    if (savedRedis) require.cache[redisPath] = savedRedis; else delete require.cache[redisPath];
    delete require.cache[require.resolve('../services/globalAiBudget')];
  }
});

// ── U14 (2026-10-30): 외부 API 오류 로그에 키 원문이 남지 않는다 ──
test('로거: axios 오류를 err 로 넣어도 serviceKey·Authorization·apikey 원문이 로그에 없다', async () => {
  const http = require('http');
  const axios = require('axios');
  const { Writable } = require('stream');
  const pino = require('pino');
  const lp = require.resolve('../logger');
  delete require.cache[lp];
  // 같은 설정을 쓰되 출력만 메모리로 받는다
  let out = '';
  const realPino = require.cache[require.resolve('pino')].exports;
  const sink = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const wrapped = Object.assign((opts) => realPino(opts, sink), realPino);
  require.cache[require.resolve('pino')].exports = wrapped;
  let logger;
  try { logger = require('../logger'); } finally { require.cache[require.resolve('pino')].exports = realPino; delete require.cache[lp]; }
  const srv = http.createServer((_q, r) => { r.statusCode = 500; r.end('x'); });
  await new Promise(r => srv.listen(0, r));
  try {
    await axios.get(`http://127.0.0.1:${srv.address().port}/x`, {
      params: { serviceKey: 'FAKEKEY123456789ABCDEF' },
      headers: { Authorization: 'Bearer FAKEJWTSECRETVALUE', apikey: 'FAKEJWTSECRETVALUE' },
    });
  } catch (e) { logger.error({ err: e }, 'x'); }
  finally { srv.close(); }
  await new Promise(r => setTimeout(r, 0));
  assert.ok(out.length > 0, '로그 출력이 없다');
  assert.equal(out.includes('FAKEKEY123456789ABCDEF'), false);
  assert.equal(out.includes('FAKEJWTSECRETVALUE'), false);
  const line = JSON.parse(out.trim().split('\n')[0]);
  assert.equal(line.err.status, 500);
  assert.equal(line.err.type, 'AxiosError');
  void pino;
});
