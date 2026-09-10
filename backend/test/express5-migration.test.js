/**
 * Express 4.22.2 → 5.2.1 마이그레이션 회귀 테스트 — Plan 073 (2026-09-06)
 *
 * 이 파일은 신규다(헬퍼는 다른 테스트 파일에서 import 하지 않고 아래에 직접 정의한다 —
 * 실행자 지시). 프로덕션 코드는 이 계획서에서 이미 수정됐고, 여기서는 그 수정이 실제로
 * 동작하는지를 실행으로 확인한다(추측이 아니라 증거).
 *
 * 배경(실행 재현, 스크래치패드에 express@5.2.1 설치해 확인됨):
 *   A. Express 5부터 req.query 는 접근할 때마다 재파싱되는 getter다. 미들웨어가
 *      req.query.x = 정제값 으로 대입해도 다음 접근(소비자)에서는 URL 원문으로 되돌아간다.
 *      backend/middleware/validation.js:69 (validateTransactionQuery) 가 aptName 을
 *      sanitizeString 으로 정제해 req.query.aptName 에 넣었는데,
 *      backend/routes/transactions.js:31 소비 시점엔 '<script>' 원문 그대로였다 — XSS 방어 우회.
 *      수정: req.sanitized 에 정제값을 싣고 소비자가 그걸 읽는다.
 *   B. body-parser 2.x(Express 5 연쇄) 는 content-type 이 안 맞거나 본문이 없는 POST 에서
 *      req.body 를 undefined 로 둔다(v4 는 항상 {}). 가드 없는 구조분해는 400 검증 응답 대신
 *      TypeError → 500 을 낸다. 8곳에 `req.body || {}` 가드를 적용했다.
 *   D. 테스트가 `router.stack.find(...)` · `route.stack[n].handle` 로 프로덕션 핸들러를 직접
 *      꺼내 호출하는 기존 패턴(characterization.test.js)이 router@2.2.0(Express 5 연쇄)에서도
 *      그대로 동작하는지 확인한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── 공용 헬퍼 ────────────────────────────────────────────────────────────────
/** 라우터 핸들러 호출용 최소 mock res — characterization.test.js 의 _mockRes 패턴과 동일 형태
 *  (이 파일은 그 파일의 함수를 import 하지 않는다 — 실행자 지시로 자체 정의). */
function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set() { return this; },
    redirect(...args) {
      // res.redirect(code, url) 또는 res.redirect(url) 둘 다 수용
      if (args.length >= 2) { this.statusCode = args[0]; this.redirectUrl = args[1]; }
      else { this.redirectUrl = args[0]; }
      return this;
    },
  };
}

/** router.stack 에서 path(+method)로 라우트를 찾아 마지막 핸들러(next 없이 응답을 내는 실제
 *  핸들러)를 꺼낸다 — D: router@2.2.0 에서도 이 추출 패턴이 그대로 동작하는지 확인한다. */
function extractLastHandler(routerModule, path, method) {
  const layer = routerModule.stack.find(
    (l) => l.route && l.route.path === path && (!method || (l.route.methods && l.route.methods[method]))
  );
  assert.ok(layer, `${path}(${method || '*'}) 라우트를 router.stack 에서 찾지 못했다 — 배선 변경 시 이 테스트를 갱신할 것`);
  assert.ok(layer.route.stack.length > 0, `${path} 라우트에 핸들러가 없다`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** require.cache 를 직접 바꿔치기해 의존 서비스를 목으로 교체한다 — 기존 테스트 파일의
 *  require.cache 스텁 패턴(예: popularService 테스트)과 동일 기법. */
function stubModule(relPathFromThisFile, exportsObj) {
  const resolved = require.resolve(relPathFromThisFile);
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return function restore() {
    if (saved) require.cache[resolved] = saved; else delete require.cache[resolved];
  };
}

async function callHandler(handler, req) {
  const res = mkRes();
  let threw = null;
  try {
    await handler(req, res, () => {});
  } catch (e) {
    threw = e;
  }
  return { res, threw };
}

// ── A: req.query getter 재파싱 — 정제값이 실제 소비자에 도달한다 ──────────────────────

// 실행 재현(HTTP 레벨) — mock req 로는 Express 5 의 진짜 getter 가 없어 버그가 은폐된다.
// 실제 express() 인스턴스에 프로덕션 라우터를 그대로 마운트하고 진짜 HTTP 요청을 보내야
// 이 회귀를 재현·검증할 수 있다.
test('EXPRESS5-A(HTTP): GET /api/transactions?aptName=<script> — 정제값이 원문으로 되돌아가지 않는다 (Plan 073)', async () => {
  const seen = [];
  const restore = stubModule('../services/transactionService', {
    getTransactions: async () => [],
    getTransactionsByApt: async (lawdCd, aptName) => { seen.push(aptName); return []; },
    getTransactionsByAptInclAliases: async () => [],
    getAliasCanonicalMap: async () => ({}),
    analyzeTransactions: async () => ({}),
    getRegionRecentTransactions: async () => [],
    getTransactionsByAptSeq: async () => [],
    LAWD_CODES: {}, LAWD_CODE_TO_NAME: {}, RETIRED_LAWD_CODES: new Set(),
  });
  const transactionsPath = require.resolve('../routes/transactions');
  delete require.cache[transactionsPath];
  const express = require('express');
  const app = express();
  let srv;
  try {
    app.use('/api/transactions', require('../routes/transactions'));
    srv = app.listen(0);
    const port = srv.address().port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/transactions?lawdCd=11680&dealYm=202501&aptName=${encodeURIComponent('<script>')}`
    );
    assert.equal(res.status, 200, `기대치 않은 상태 코드: ${res.status}`);
    assert.equal(seen.length, 1, 'getTransactionsByApt 가 정확히 한 번 호출돼야 한다');
    // 회귀 시(req.query 재파싱) 이 값은 '<script>' 원문 그대로 나온다.
    assert.equal(seen[0], '&lt;script&gt;',
      `정제값이 소비자(routes/transactions.js)에 도달하지 못했다 — 실제로 받은 값: ${JSON.stringify(seen[0])}`);
  } finally {
    if (srv) srv.close();
    restore();
    delete require.cache[transactionsPath];
  }
});

test('EXPRESS5-A(단위): validateTransactionQuery — 정제값을 req.sanitized 에 싣는다(req.query 재대입 아님)', () => {
  const { validateTransactionQuery } = require('../middleware/validation');
  const req = { query: { lawdCd: '11680', dealYm: '202501', aptName: '<b>x</b>' } };
  let nextCalled = false;
  validateTransactionQuery(req, mkRes(), () => { nextCalled = true; });
  assert.ok(nextCalled, '정상 입력인데 next() 가 호출되지 않았다');
  assert.equal(req.sanitized && req.sanitized.aptName, '&lt;b&gt;x&lt;/b&gt;', 'req.sanitized.aptName 이 정제값이 아니다');
});

test('DEAD-GET-BRANCH (Plan 074): validatePropertySearch 는 method 와 무관하게 req.body 만 본다 — GET 에서 req.sanitized 를 만들지 않는다', () => {
  const { validatePropertySearch } = require('../middleware/validation');
  const req = { method: 'GET', query: { query: '<i>x</i>', region: '서울' } };
  let nextCalled = false;
  validatePropertySearch(req, mkRes(), () => { nextCalled = true; });
  assert.ok(nextCalled, 'body 없는 GET 도 next() 로 통과해야 한다(검증 대상이 없으므로)');
  assert.equal(req.sanitized, undefined, '죽은 GET 분기가 되살아났다 — req.sanitized 가 만들어졌다');
  assert.equal(req.query.query, '<i>x</i>', 'req.query 를 건드리면 안 된다');
});

test('EXPRESS5-A(회귀 없음): validatePropertySearch POST 분기 — req.body 직접 mutate 는 기존 그대로 안전하다', () => {
  // req.body 는 body-parser 가 만든 고정 객체라 Express 5 에서도 mutate 가 그대로 유지된다
  // (POST /api/properties/recommend 가 실제로 의존하는 경로 — 회귀가 없어야 한다).
  const { validatePropertySearch } = require('../middleware/validation');
  const req = { method: 'POST', body: { query: '<u>y</u>', region: '서울' } };
  let nextCalled = false;
  validatePropertySearch(req, mkRes(), () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(req.body.query, '&lt;u&gt;y&lt;/u&gt;', 'POST 분기에서 req.body.query 정제가 유지되지 않는다(회귀)');
  assert.equal(req.body.region, '서울');
});

// ── B: req.body undefined 가드 — content-type 없는 POST 가 500 대신 400 을 낸다 ─────────
// (body-parser 가 파싱 못 하면 req.body 는 undefined — 이 조건을 req 목으로 그대로 재현한다.)

test('EXPRESS5-B(단위): validateChatInput — req.body undefined 에도 500 대신 400', async () => {
  const { validateChatInput } = require('../middleware/validation');
  const { res, threw } = await callHandler(validateChatInput, { body: undefined });
  assert.equal(threw, null, `req.body undefined 에서 예외가 발생했다(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B(단위): validatePropertySearch POST 분기 — req.body undefined 에도 예외 없이 next() 로 진행한다', () => {
  const { validatePropertySearch } = require('../middleware/validation');
  const req = { method: 'POST', body: undefined };
  let nextCalled = false;
  assert.doesNotThrow(() => {
    validatePropertySearch(req, mkRes(), () => { nextCalled = true; });
  });
  assert.ok(nextCalled, 'req.body undefined 에서 next() 가 호출되지 않았다');
});

// D + B 결합: router.stack 에서 실제 프로덕션 핸들러를 꺼내(D) req.body undefined 로 직접
// 호출한다(B). 8곳 전부 — chat.js:71, clause.js:32, geocode.js:122·161, properties.js:18·84,
// billing.js:424, 그리고 배선 확인용 briefing.js:99.

test('EXPRESS5-B+D: POST /api/chat 핸들러(chat.js:71) — req.body undefined 에도 예외 없이 응답한다', async () => {
  const router = require('../routes/chat');
  const handler = extractLastHandler(router, '/', 'post'); // D: 추출 자체가 성공해야 한다
  const { res, threw } = await callHandler(handler, { body: undefined, user: undefined });
  // validateChatInput 을 우회해 직접 호출한 경우다(회귀 전 코드라면 req.body 구조분해에서 500).
  // 이 핸들러 자체는 항상 400 을 내는 계약이 아니라 대화 폴백 응답을 낼 수 있으므로,
  // 여기서 확인하는 계약은 "예외로 죽지 않는다"(500 로 새지 않는다) 이다.
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.notEqual(res.statusCode, 500, `500 로 응답했다 — req.body undefined 가드 회귀`);
});

test('EXPRESS5-B+D: POST /api/clause 핸들러(clause.js:32) — req.body undefined → 400', async () => {
  const router = require('../routes/clause');
  const handler = extractLastHandler(router, '/', 'post');
  const { res, threw } = await callHandler(handler, { body: undefined });
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B+D: POST /api/geocode 핸들러(geocode.js:122) — req.body undefined → 400', async () => {
  const router = require('../routes/geocode');
  const handler = extractLastHandler(router, '/', 'post');
  const { res, threw } = await callHandler(handler, { body: undefined });
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B+D: POST /api/geocode/batch 핸들러(geocode.js:161) — req.body undefined → 400', async () => {
  const router = require('../routes/geocode');
  const handler = extractLastHandler(router, '/batch', 'post');
  const { res, threw } = await callHandler(handler, { body: undefined });
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B+D: POST /api/properties/recommend 핸들러(properties.js:18) — req.body undefined → 400', async () => {
  const router = require('../routes/properties');
  const handler = extractLastHandler(router, '/recommend', 'post');
  const { res, threw } = await callHandler(handler, { body: undefined });
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B+D: POST /api/properties/transit 핸들러(properties.js:84) — req.body undefined → 400', async () => {
  const router = require('../routes/properties');
  const handler = extractLastHandler(router, '/transit', 'post');
  const { res, threw } = await callHandler(handler, { body: undefined });
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

test('EXPRESS5-B+D: POST /billing/webhook 핸들러(billing.js:424) — req.body undefined → 400(501/503 아님)', async () => {
  const router = require('../routes/billing');
  const handler = extractLastHandler(router, '/webhook', 'post');
  const req = { body: undefined, get: () => undefined, ip: '127.0.0.1' };
  const { res, threw } = await callHandler(handler, req);
  assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
  assert.equal(res.statusCode, 400, `500 대신 400 이어야 한다 — 실제: ${res.statusCode}`);
});

// ── briefing.js:99 — res.redirect(302, url) 의 url 이 undefined 가 될 수 있으면 가드 ──────

test('EXPRESS5-D: GET /briefing 핸들러(briefing.js:99) — 정상 경로는 오늘 날짜로 리다이렉트한다', async () => {
  const router = require('../routes/briefing');
  const handler = extractLastHandler(router, '/', 'get');
  const { res, threw } = await callHandler(handler, {});
  assert.equal(threw, null);
  assert.equal(res.statusCode, 302);
  assert.match(res.redirectUrl, /^\/briefing\/\d{4}-\d{2}-\d{2}$/, `리다이렉트 URL 형식이 다르다: ${res.redirectUrl}`);
});

test('EXPRESS5-D: GET /briefing 핸들러(briefing.js:99) — kstDayString() 이 빈 값이면 "/briefing/undefined" 로 새지 않는다', async () => {
  // briefingService.kstDayString 을 undefined 를 돌려주도록 바꿔치기 — 5.2.0 부터
  // res.redirect(302, undefined) 에 deprecation 경고가 있었던 경로를 직접 시뮬레이션한다.
  const restore = stubModule('../services/briefingService', {
    kstDayString: () => undefined,
    getOrCreateSnapshot: async () => null,
  });
  const briefingPath = require.resolve('../routes/briefing');
  delete require.cache[briefingPath];
  try {
    const router = require('../routes/briefing');
    const handler = extractLastHandler(router, '/', 'get');
    const { res, threw } = await callHandler(handler, {});
    assert.equal(threw, null, `예외 발생(가드 회귀): ${threw && threw.message}`);
    assert.notEqual(res.redirectUrl, '/briefing/undefined', 'kstDayString() 빈 값이 그대로 새어 깨진 경로로 리다이렉트됐다(가드 회귀)');
    assert.equal(res.redirectUrl, '/', `가드 경로(기본 "/")로 떨어져야 한다 — 실제: ${res.redirectUrl}`);
  } finally {
    restore();
    delete require.cache[briefingPath];
  }
});
