/**
 * backend/test/sentry-scrub.test.js
 *
 * Plan 128 (2026-09-28) — Sentry 로 나가는 이벤트의 개인정보·비밀값 스크러빙.
 *
 * 실측으로 확인된 누출(같은 SDK 10.75.3·같은 옵션, plans/128 §1):
 *   - 오류 이벤트: 요청 본문(request.data)·쿠키(request.cookies)·위치 헤더(x-vercel-ip-*)·
 *     x-vercel-oidc-token 원문.
 *   - 성능 이벤트(transaction): beforeSend 를 거치지 않아 Authorization·Cookie 헤더 원문,
 *     클라이언트 IP(http.client_ip) 까지.
 *   - ECOS 인증키는 URL 경로에 들어가 SDK 의 쿼리 필터를 통과한다.
 *   - Supabase 조회 스팬 URL 에 로그인 사용자 ID(user_id=eq.<UUID>)가 실린다.
 *
 * E2E 앞의 테스트들은 scrubEvent 를 이벤트 모양으로 직접 검사하고, 마지막 E2E 는 **실제 SDK** 를
 * 자식 프로세스로 띄워 가짜 수집 서버가 받은 envelope 전문에서 표지 문자열을 찾는다 —
 * SDK 가 올라가(예: 11) 이벤트 모양이 바뀌면 여기서 잡히게 하려는 것이다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SENTRY_JS = path.join(__dirname, '..', 'sentry.js');
const { _scrubEvent: scrubEvent, _collectSecretValues: collectSecretValues } = require(SENTRY_JS);

test('오류 이벤트 — 본문·쿠키 삭제, 헤더는 허용목록만(인증·쿠키는 존재만), 쿼리 비밀값 마스킹', () => {
  const event = {
    user: { ip_address: '203.0.113.9' },
    request: {
      url: 'https://myhomelog.vercel.app/api/x?serviceKey=abcdefghij&x=1',
      query_string: 'serviceKey=abcdefghij&x=1',
      cookies: { 'sb-session': 'COOKIEVALUE' },
      data: '{"name":"홍길동","phone":"010-1234-5678"}',
      headers: {
        host: 'myhomelog.vercel.app',
        'user-agent': 'UA',
        'content-type': 'application/json',
        authorization: 'Bearer TOKENVALUE',
        cookie: 'sb-session=COOKIEVALUE',
        'x-vercel-oidc-token': 'OIDCVALUE',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-vercel-ip-city': 'Seoul',
        'x-vercel-ip-latitude': '37.5',
        referer: 'https://myhomelog.vercel.app/?region=x',
        'X-Api-Key': 'APIKEYVALUE',
      },
    },
  };
  scrubEvent(event, []);
  assert.equal(event.user.ip_address, undefined);
  assert.equal(event.request.cookies, undefined, 'request.cookies 가 남아 있다');
  assert.equal(event.request.data, undefined, 'request.data(요청 본문)가 남아 있다');
  assert.deepEqual(Object.keys(event.request.headers).sort(),
    ['authorization', 'content-type', 'cookie', 'host', 'user-agent']);
  assert.equal(event.request.headers.authorization, '[Filtered]');
  assert.equal(event.request.headers.cookie, '[Filtered]');
  assert.equal(event.request.query_string, 'serviceKey=[Filtered]&x=1');
});

test('성능 이벤트 — 클라이언트 주소 속성 삭제, 헤더 속성은 요청 헤더와 같은 규칙, 경로의 비밀값 치환', () => {
  const ECOS_VAL = 'ecos-xxxxxxxxxxxxxxxx';
  const event = {
    type: 'transaction',
    transaction: 'POST /boom',
    request: { headers: { authorization: 'Bearer T', 'user-agent': 'UA', 'x-vercel-ip-city': 'Seoul' }, data: 'BODY' },
    contexts: {
      trace: {
        data: {
          'http.client_ip': '203.0.113.9',
          'client.address': '203.0.113.9',
          'net.peer.ip': '203.0.113.9',
          'http.request.header.authorization': '[Filtered]',
          'http.request.header.x_vercel_oidc_token': '[Filtered]',
          'http.request.header.x_vercel_ip_city': 'Seoul',
          'http.request.header.cookie.sb_session': '[Filtered]',
          'http.request.header.user_agent': 'UA',
          'url.path': '/boom',
        },
      },
    },
    spans: [{
      op: 'http.client',
      description: `GET https://ecos.bok.or.kr/api/KeyStatisticList/${ECOS_VAL}/json/kr/1/100`,
      data: {
        'url.full': `https://ecos.bok.or.kr/api/KeyStatisticList/${ECOS_VAL}/json/kr/1/100`,
        'network.peer.address': '1.2.3.4',
      },
    }],
    breadcrumbs: [{ category: 'http', data: { url: `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_VAL}/json` } }],
  };
  scrubEvent(event, [ECOS_VAL]);
  const data = event.contexts.trace.data;
  for (const k of ['http.client_ip', 'client.address', 'net.peer.ip']) assert.equal(data[k], undefined, `${k} 가 남아 있다`);
  assert.equal(data['http.request.header.authorization'], '[Filtered]');
  assert.equal(data['http.request.header.user_agent'], 'UA');
  for (const k of ['http.request.header.x_vercel_oidc_token', 'http.request.header.x_vercel_ip_city', 'http.request.header.cookie.sb_session']) {
    assert.equal(data[k], undefined, `${k} 가 남아 있다`);
  }
  assert.equal(data['url.path'], '/boom');
  assert.equal(event.request.data, undefined);
  assert.deepEqual(Object.keys(event.request.headers).sort(), ['authorization', 'user-agent']);
  assert.equal(event.spans[0].data['network.peer.address'], undefined);
  const text = JSON.stringify(event);
  assert.ok(!text.includes(ECOS_VAL), '경로에 든 비밀값이 남아 있다');
  assert.ok(text.includes('KeyStatisticList/[Filtered]/json'), '비밀값 자리가 [Filtered] 로 바뀌지 않았다');
});

test('사용자 식별값 — PostgREST 필터 값과 UUID 를 가리고, 필터가 아닌 파라미터는 남긴다', () => {
  const UID = '0b7e2c1a-1111-4222-8333-944455556666';
  const event = {
    type: 'transaction',
    request: { url: `https://myhomelog.vercel.app/api/chat-sessions/${UID}/messages` },
    spans: [{
      op: 'http.client',
      description: `GET https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.${UID}&order=created_at.desc`,
      data: {
        'url.full': `https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.${UID}&facility-%3E_empty=not.is.null&order=created_at.desc&limit=20`,
        'http.query': `select=id&endpoint=eq.https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fabc`,
        'url.query': `?lawd_cd=eq.11350&apt_name=in.(a,b)`,
      },
    }],
  };
  scrubEvent(event, []);
  const text = JSON.stringify(event);
  assert.ok(!text.includes(UID), 'UUID 가 남아 있다');
  assert.ok(!text.includes('fcm.googleapis.com'), '푸시 구독 endpoint 필터 값이 남아 있다');
  const d = event.spans[0].data;
  assert.equal(d['url.full'],
    'https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.[Filtered]&facility-%3E_empty=not.is.[Filtered]&order=created_at.desc&limit=20');
  assert.equal(d['http.query'], 'select=id&endpoint=eq.[Filtered]');
  assert.equal(d['url.query'], '?lawd_cd=eq.[Filtered]&apt_name=in.[Filtered]');
  assert.equal(event.request.url, 'https://myhomelog.vercel.app/api/chat-sessions/[Filtered]/messages');
});

test('SDK 내부 객체(sdkProcessingMetadata·클래스 인스턴스)는 순회·수정하지 않는다', () => {
  const UID = '0b7e2c1a-1111-4222-8333-944455556666';
  class FakeScope { constructor() { this.note = `scope ${UID}`; } }
  const scope = new FakeScope();
  const meta = { normalizedRequest: { url: `https://x/api/${UID}` }, capturedSpanScope: scope };
  const event = { sdkProcessingMetadata: meta, extra: { scope, plain: `id ${UID}` } };
  scrubEvent(event, []);
  assert.equal(scope.note, `scope ${UID}`, '클래스 인스턴스 내부 문자열이 바뀌었다');
  assert.equal(meta.normalizedRequest.url, `https://x/api/${UID}`, 'sdkProcessingMetadata 가 순회됐다');
  assert.equal(event.extra.plain, 'id [Filtered]', '일반 객체 문자열은 치환돼야 한다');
});

test('collectSecretValues — 이름 규칙·최소 길이·URL 인코딩형·긴 값 우선', () => {
  const values = collectSecretValues({
    MOLIT_API_KEY: 'xxxx/xxxx+xxxx=xxxx0000',
    ECOS_API_KEY: 'ecos-xxxxxxxxxxxxxxxx',
    service_role: 'role-xxxxxxxxxxxxxxxx',
    UPSTASH_REDIS_REST_TOKEN: 'short',
    CACHE_MAX_KEYS: '2000',
    SUPABASE_URL: 'https://example.supabase.co/0123456789',
    NODE_ENV: 'production-environment-name',
  });
  assert.ok(values.includes('xxxx/xxxx+xxxx=xxxx0000'));
  assert.ok(values.includes(encodeURIComponent('xxxx/xxxx+xxxx=xxxx0000')), 'URL 인코딩형이 없다');
  assert.ok(values.includes('ecos-xxxxxxxxxxxxxxxx'));
  assert.ok(values.includes('role-xxxxxxxxxxxxxxxx'), '소문자 service_role 이 빠졌다');
  assert.ok(!values.includes('short'), '최소 길이 미만이 포함됐다');
  assert.ok(!values.includes('2000'));
  assert.ok(!values.some((v) => v.includes('example.supabase.co')), '비밀이 아닌 이름(SUPABASE_URL)이 포함됐다');
  assert.ok(!values.includes('production-environment-name'));
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1].length >= values[i].length, '긴 값부터 정렬돼야 한다');
});

test('기존 규칙 유지 — message·exception 안의 serviceKey= 패턴 마스킹', () => {
  const event = {
    message: 'failed serviceKey=xxxxxxxxxxxxxxxx more',
    exception: { values: [{ value: 'axios serviceKey=xxxxxxxxxxxxxxxx' }] },
  };
  scrubEvent(event, []);
  assert.ok(!event.message.includes('xxxxxxxxxxxxxxxx'));
  assert.ok(!event.exception.values[0].value.includes('xxxxxxxxxxxxxxxx'));
});

// ── 실제 SDK 경유 E2E ────────────────────────────────────────────────────────
// 자식 프로세스가 backend/sentry.js 를 **먼저** require 하고(자동 계측 순서), 최소 express 앱에서
// 외부 호출(경로에 ECOS 키, 쿼리에 MOLIT 키) 뒤 예외를 던진다. SENTRY_DSN 은 이 테스트의 가짜 수집
// 서버를 가리키고 표본율 1 이라 오류·성능 이벤트가 모두 온다. 요청은 계측되지 않는 raw 소켓으로
// 보낸다(계측된 클라이언트는 비표본 sentry-trace 를 전파해 성능 이벤트가 사라질 수 있다).
// sentry.js 경로·표지는 명령행 인자로 넘긴다 — 환경변수로 넘기면 scripts/check-env-example.js 게이트가
// 테스트 전용 이름을 미선언 환경변수로 잡는다(backend/**/*.js 의 process.env 참조를 .env.example 과 대조).
// 표지 값은 일부러 `…-xxxx` 형식이다 — CI gitleaks 의 generic-api-key 는 이름에 key·token·secret 이 든
// 할당의 값 엔트로피로 잡는데(이 저장소 2회 재발), `.gitleaks.toml` 전역 allowlist 의 `xxx+` 가 이 형식을 통과시킨다.
// 읽기 좋은 값으로 바꾸지 말 것. 서로의 부분 문자열이 되지 않게 접두어를 다르게 둔다.
const M = {
  queryToken: 'qtoken-xxxxxxxxxxxx',
  cookie: 'cookie-xxxxxxxxxxxx',
  bearer: 'bearer-xxxxxxxxxxxx',
  oidc: 'oidc-xxxxxxxxxxxx',
  ip: '203.0.113.77',
  city: 'city-xxxxxxxxxxxx',
  lat: '37.123456',
  name: 'name-xxxxxxxxxxxx',
  phone: '010-9999-8888',
  ecos: 'ecos-e2e-xxxxxxxxxxxxxxxx',
  molit: 'molit/xxxx+xxxx==xxxxxxxx',
  userId: '0b7e2c1a-1111-4222-8333-944455556666',
};

const CHILD = `
const [sentryJsPath, markersJson] = process.argv.slice(1);
const Sentry = require(sentryJsPath);
const express = require('express');
const axios = require('axios');
const net = require('net');
const app = express();
app.use(express.json());
app.get('/api/:svc/:key/json', (req, res) => res.json({ ok: true }));
app.get('/rest/v1/:table', (req, res) => res.json([]));
const M = JSON.parse(markersJson);
app.post('/boom', async (req, res) => {
  const port = req.socket.localPort;
  await axios.get('http://127.0.0.1:' + port + '/api/KeyStatisticList/' + process.env.ECOS_API_KEY + '/json',
    { params: { serviceKey: process.env.MOLIT_API_KEY, LAWD_CD: '11350' } });
  await axios.get('http://127.0.0.1:' + port + '/rest/v1/bookmarks',
    { params: { select: '*', user_id: 'eq.' + M.userId } });
  throw new Error('scrub-e2e boom');
});
Sentry.setupExpressErrorHandler(app);
app.use((err, req, res, next) => { res.status(500).json({ ok: false }); });
const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const body = Buffer.from(JSON.stringify({ name: M.name, phone: M.phone }));
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write([
      'POST /boom?token=' + M.queryToken + '&x=1 HTTP/1.1', 'Host: 127.0.0.1:' + port,
      'Content-Type: application/json', 'Content-Length: ' + body.length,
      'Cookie: sb-e2e=' + M.cookie, 'Authorization: Bearer ' + M.bearer, 'X-Vercel-OIDC-Token: ' + M.oidc,
      'X-Forwarded-For: ' + M.ip, 'X-Real-IP: ' + M.ip, 'X-Vercel-Forwarded-For: ' + M.ip,
      'X-Vercel-IP-City: ' + M.city, 'X-Vercel-IP-Latitude: ' + M.lat,
      'User-Agent: scrub-e2e-agent', 'Connection: close', '', '',
    ].join('\\r\\n'));
    sock.write(body);
  });
  sock.on('data', () => {});
  sock.on('close', async () => {
    await new Promise((r) => setTimeout(r, 300));
    await Sentry.flush(5000);
    server.close();
    process.exit(0);
  });
});
`;

function parseEnvelope(text) {
  const lines = text.split('\n').filter((l) => l.length);
  const items = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    let header = {};
    let payload = null;
    try { header = JSON.parse(lines[i]); } catch (_) { /* 비 JSON 줄은 건너뛴다 */ }
    try { payload = JSON.parse(lines[i + 1]); } catch (_) { payload = lines[i + 1]; }
    items.push({ type: header.type, payload });
  }
  return items;
}

test('실제 SDK 경유 E2E — 오류·성능 envelope 어디에도 본문·쿠키·토큰·IP·위치·비밀값이 없다', { timeout: 60000 }, async () => {
  const received = [];
  const ingest = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      received.push(buf.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const ingestPort = ingest.address().port;

  const env = {
    ...process.env,
    SENTRY_DSN: `http://e2epublickey@127.0.0.1:${ingestPort}/1`,
    SENTRY_TRACES_SAMPLE_RATE: '1',
    VERCEL_ENV: 'test',
    ECOS_API_KEY: M.ecos,
    MOLIT_API_KEY: M.molit,
  };
  delete env.NODE_TEST_CONTEXT;
  let stderr = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, SENTRY_JS, JSON.stringify(M)], { cwd: path.join(__dirname, '..'), env });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('close', resolve);
  });
  await new Promise((resolve) => ingest.close(resolve));
  assert.equal(code, 0, `자식 프로세스 실패(exit ${code}): ${stderr.slice(0, 2000)}`);

  const all = received.join('\n');
  const items = received.flatMap(parseEnvelope);
  const event = items.find((i) => i.type === 'event'
    && ((i.payload && i.payload.exception && i.payload.exception.values) || []).some((v) => v.value === 'scrub-e2e boom'));
  const tx = items.find((i) => i.type === 'transaction' && /\/boom/.test((i.payload && i.payload.transaction) || ''));
  assert.ok(event, `오류 이벤트가 수집 서버에 도착하지 않았다 — 받은 항목: ${items.map((i) => i.type).join(',')}`);
  // @sentry/node 11.0.0 은 성능 데이터를 transaction 이 아니라 span 항목으로 보내고, 그 항목은
  // beforeSendTransaction 을 거치지 않는다(2026-09-28 실측 — IP·본문·경로 비밀값이 그대로 나감).
  // 여기서 실패하면 SDK 메이저를 올린 것이다: span 항목 스크러빙을 먼저 넣고 이 단언을 고칠 것(plans/128 §6).
  assert.ok(tx, `POST /boom 성능 이벤트(transaction)가 도착하지 않았다 — 받은 항목: ${items.map((i) => i.type).join(',')}. ` +
    'span 항목만 왔다면 SDK 메이저 변경으로 성능 데이터 형식이 바뀐 것이다(plans/128 §6)');

  for (const [label, marker] of Object.entries(M)) {
    assert.ok(!all.includes(marker), `envelope 에 ${label} 표지가 남아 있다`);
  }
  assert.ok(!all.includes(encodeURIComponent(M.molit)), 'envelope 에 MOLIT 키 URL 인코딩형이 남아 있다');
  // 과잉 삭제·공허한 통과 방지: 허용 헤더는 남고, 인증 헤더는 존재만, 경로 비밀값 자리는 [Filtered].
  assert.ok(all.includes('scrub-e2e-agent'), 'user-agent 까지 지워졌다(허용목록 헤더는 남아야 한다)');
  assert.equal(event.payload.request.headers.authorization, '[Filtered]');
  assert.equal(tx.payload.request && tx.payload.request.headers && tx.payload.request.headers.authorization, '[Filtered]');
  assert.ok(all.includes('KeyStatisticList/[Filtered]/json'), 'ECOS 경로 호출 기록이 없거나 비밀값 자리가 치환되지 않았다');
  assert.ok(all.includes('user_id=eq.[Filtered]'), 'Supabase 조회 기록이 없거나 사용자 ID 자리가 치환되지 않았다');
});
