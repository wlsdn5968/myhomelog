/**
 * backend/test/auth.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _authFn, _mkJwtPayload } = require('../testSupport/_helpers');



test('_jwtExpMs — 실제 JWT 인코딩(base64url·무패딩)에서 exp 를 읽어야 만료 우회가 막힌다', () => {
  const _jwtExpMs = _authFn('_jwtExpMs');
  const expSec = 1893456000; // 고정값 (2030-01-01 근처) — 현재 시각에 의존하지 않는다

  // 길이(패딩) 변주 — 기본 동작 확인
  for (const pad of ['a', 'ab', 'abc', 'abcd']) {
    const t = _mkJwtPayload({ exp: expSec, sub: pad, iss: 'https://example.supabase.co/auth/v1' });
    assert.equal(_jwtExpMs(t), expSec * 1000, `디코드 실패(길이 케이스 '${pad}')`);
  }

  // base64url 특수문자(-, _)가 실제로 들어간 토큰에서도 exp 를 읽는지 확인한다.
  let urlSafeToken = null;
  for (let i = 0; i < 500 && !urlSafeToken; i++) {
    const t = _mkJwtPayload({ exp: expSec, sub: 'u' + i, n: 'ÿþ~?' + i });
    if (/[-_]/.test(t.split('.')[1])) urlSafeToken = t;
  }
  assert.ok(urlSafeToken, 'base64url 특수문자(-,_)가 포함된 payload 를 만들지 못했다');
  assert.equal(_jwtExpMs(urlSafeToken), expSec * 1000, 'base64url 토큰에서 exp 를 읽지 못했다');

  // ⚠ 정직한 한계 (2026-08-16 실측): `_jwtExpMs` 안의 base64url 복원 두 줄
  //   — `.replace(/-/g,'+').replace(/_/g,'/')` 와 `.padEnd(..., '=')` — 은
  //   **Node 에서 no-op** 이다. `Buffer.from(s,'base64')` 가 base64url 도, 무패딩도 그대로 디코드한다.
  //   실제로 두 줄을 각각 제거해도 이 테스트는 전부 통과했다(회귀 주입 확인).
  //   즉 **어떤 테스트로도 그 두 줄은 고정할 수 없다** — 다른 런타임(예: 브라우저 atob) 대비
  //   방어 코드로 보고 남겨 두되, "테스트가 지켜준다"고 오해하지 말 것.
  //   이 테스트가 실제로 고정하는 것은 아래 셋이다:
  //     (a) 정상 JWT 에서 exp*1000 을 돌려준다   (b) exp 없음/숫자 아님 → null (NaN 오염 차단)
  //     (c) 손상 입력에 예외를 던지지 않는다(던지면 인증 요청이 500 으로 죽는다)

  // exp 없음 → null (verifyToken 이 micro-cache TTL 로 폴백하는 기존 동작)
  assert.equal(_jwtExpMs(_mkJwtPayload({ sub: 'u1' })), null);
  // exp 가 숫자가 아니면 null — 문자열 exp 를 곱해 NaN/이상값이 되는 것을 막는다
  assert.equal(_jwtExpMs(_mkJwtPayload({ exp: '1893456000' })), null);
  // 손상 입력 — 전부 null 이어야 하고 예외를 던지면 안 된다(요청이 500 으로 죽는다)
  assert.equal(_jwtExpMs('not-a-jwt'), null);
  assert.equal(_jwtExpMs('hdr..sig'), null);
  assert.equal(_jwtExpMs('hdr.###.sig'), null);
  assert.equal(_jwtExpMs(''), null);
});



test('isDeletionAllowed — 삭제 유예 중 허용 경로는 화이트리스트로만 열린다', () => {
  // DELETION_ALLOWED_PATHS 는 모듈 스코프 상수라 주입한다(값은 auth.js 정의와 동일).
  const PATHS = new Set(['/api/account/restore', '/api/account/deletion-status']);
  const isDeletionAllowed = _authFn('isDeletionAllowed', ['DELETION_ALLOWED_PATHS'], [PATHS]);

  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore' }), true);
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/deletion-status' }), true);
  // 쿼리스트링이 붙어도 판정은 경로 기준
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore?from=email' }), true);
  // ★ 화이트리스트 밖은 전부 차단 — 삭제 유예 중 일반 API 가 열리면 안 된다
  assert.equal(isDeletionAllowed({ originalUrl: '/api/report/generate' }), false);
  assert.equal(isDeletionAllowed({ originalUrl: '/api/billing/checkout' }), false);
  // 접두만 같은 경로도 차단(Set 정확일치)
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore/all' }), false);
  // originalUrl 이 없으면 url 로 폴백, 둘 다 없으면 차단
  assert.equal(isDeletionAllowed({ url: '/api/account/restore' }), true);
  assert.equal(isDeletionAllowed({}), false);
});



// OAUTH-STATE-2026-08-17 (Sprint MMMMMMM-15): 이 세 함수는 **3개월간 테스트가 0** 이었고,
//   그 사이 매달린 참조로 통째로 죽어 있었는데 아무도 몰랐다. 형태(선언 존재)만 고정하면
//   같은 사고의 다른 형태(예: 키가 undefined 로 계산되어 서명이 항상 같아짐)를 못 잡는다.
//   → 실제로 **실행해서** 서명·검증 왕복과 위조 거부를 확인한다.
test('카카오 OAuth state — 서명·검증 왕복과 위조·만료 거부가 실제로 동작한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/kakao.js'), 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `kakao.js 에서 ${name} 을 찾지 못했다 (형태가 바뀌면 이 테스트도 갱신할 것)`);
    return m[0];
  };
  const build = (serviceKey) => new Function('crypto', 'SERVICE_KEY',
    `${pick('stateHmacKey')}\n${pick('signState')}\n${pick('verifyState')}\n` +
    'return { stateHmacKey, signState, verifyState };'
  )(require('node:crypto'), serviceKey);

  const k = build('test-service-key-xxxxxxxx');

  // ① 정상 왕복 — 서명한 payload 가 그대로 돌아온다.
  const payload = { n: 'nonce-1', exp: Date.now() + 60000 };
  const signed = k.signState(payload);
  assert.match(signed, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'state 형식이 data.sig 가 아니다');
  const back = k.verifyState(signed);
  assert.equal(back && back.n, 'nonce-1', '서명한 state 가 검증을 통과하지 못한다 — OAuth 가 죽는다');

  // ② 위조 거부 — 서명부를 바꾸면 통과하면 안 된다(CSRF 방어의 본체).
  const [d, s] = signed.split('.');
  assert.equal(k.verifyState(`${d}.${s.slice(0, -1)}X`), null, '변조된 서명이 통과한다');
  assert.equal(k.verifyState('garbage'), null, '형식이 깨진 값이 통과한다');
  assert.equal(k.verifyState(''), null, '빈 값이 통과한다');

  // ③ 만료 거부.
  assert.equal(k.verifyState(k.signState({ n: 'x', exp: Date.now() - 1 })), null, '만료된 state 가 통과한다');

  // ④ **키가 다르면 검증이 실패해야 한다** — 이게 깨지면 파생 키가 실제로 안 쓰이는 것이다.
  //    (SERVICE_KEY 가 undefined 로 조용히 'no-key' 폴백만 타는 회귀를 여기서 잡는다.)
  const other = build('another-service-key-yyyyyyyy');
  assert.equal(other.verifyState(signed), null,
    '다른 키로 서명한 state 가 통과한다 — 파생 키가 서명에 반영되지 않는다');
});



// ── ADMIN-VERIFIED-2026-09-05 (감사 H-LOW: admin 은 확인된 이메일만) ─────────────────────────────
//   [행위 테스트] ADMIN_EMAILS 를 세우고 planService 를 다시 로드해 isAdminUser 를 실제 실행한다.
test('admin 판정 — 이메일이 맞아도 확인되지 않은 이메일(emailVerified=false)은 admin 이 아니다', () => {
  const p = require.resolve('../services/planService');
  const saved = { mod: require.cache[p], env: process.env.ADMIN_EMAILS };
  try {
    process.env.ADMIN_EMAILS = 'ops@example.test';
    delete require.cache[p];
    const { isAdminUser, isAdminEmail } = require('../services/planService');
    assert.equal(isAdminUser({ email: 'ops@example.test', emailVerified: true }), true);
    assert.equal(isAdminUser({ email: 'OPS@example.test', emailVerified: true }), true, '대소문자 무시(종전 규칙 유지)');
    assert.equal(isAdminUser({ email: 'ops@example.test', emailVerified: false }), false, '미확인 이메일이 admin 이 됐다');
    assert.equal(isAdminUser({ email: 'ops@example.test' }), true, '필드가 없으면(옛 캐시·다른 경로) 운영자를 잠그지 않는다 — 명시적 false 만 거부');
    assert.equal(isAdminUser({ email: 'someone@example.test', emailVerified: true }), false);
    assert.equal(isAdminUser(null), false);
    assert.equal(isAdminEmail('ops@example.test'), true, '문자열 판정은 남는다(다른 소비자 호환)');
  } finally {
    if (saved.env === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = saved.env;
    if (saved.mod) require.cache[p] = saved.mod; else delete require.cache[p];
  }
  // 배선: 토큰 검증이 emailVerified 를 싣고, 무제한 판정 5곳이 사용자 객체로 부른다
  const fs = require('node:fs'), path = require('node:path');
  const auth = fs.readFileSync(path.join(__dirname, '../middleware/auth.js'), 'utf8');
  assert.match(auth, /emailVerified: Boolean\(data\.user\.email_confirmed_at\)/, 'auth 미들웨어가 검증 상태를 싣지 않는다');
  for (const f of ['../middleware/dailyLimit.js', '../middleware/rateLimit.js', '../routes/clause.js', '../server.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.equal(src.includes('isAdminEmail(req.user?.email)'), false, f + ' 가 문자열 판정으로 되돌아갔다');
    assert.ok(src.includes('isAdminUser(req.user)'), f + ' 가 isAdminUser 를 쓰지 않는다');
  }
  const plan = fs.readFileSync(path.join(__dirname, '../services/planService.js'), 'utf8');
  assert.match(plan, /ADMIN_EMAILS\.includes\(email\) && _verified/, 'getActivePlan 의 admin 분기가 확인 여부를 보지 않는다');
});
