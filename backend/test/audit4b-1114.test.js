/**
 * AUDIT4B-1114: 보안 점검 run-4 의 남은 검증 필요 단서 중 코드로 묶은 것의 회귀 검사.
 *   지도 범위 조회 서버 기억, 위조 토큰의 외부 인증 호출 묶기, 건축물대장 동별 키, 사용자 표와 대화 저장 총량.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('in-bounds: 서버도 소수 셋째 자리 바깥쪽 반올림을 하고 같은 영역 결과를 5분 기억한다', () => {
  const s = rd('routes/search.js');
  const i = s.indexOf("router.get('/in-bounds'");
  const head = s.slice(i, i + 1400);
  assert.match(head, /const south = _ibQuant\(parseFloat\(req\.query\.south\), false\);/);
  assert.match(head, /const north = _ibQuant\(parseFloat\(req\.query\.north\), true\);/);
  assert.match(head, /const _ibHit = _ibMemo\.get\(_ibKey\);/);
  assert.match(s, /const _IB_MAX = 300;/);
  // 반올림 함수(실제 소스): 더 많은 소수 자리를 붙여도 같은 키가 된다
  const q = new Function(`${s.match(/function _ibQuant\(v, up\) \{[^\n]*\}/)[0]}; return _ibQuant;`)();
  assert.equal(q(37.5123, false), q(37.51239999, false));
  assert.equal(q(127.0011, true), q(127.00101, true));
});

test('인증: exp 없는 토큰은 외부에 묻지 않고, 같은 IP 의 실패가 1분 20번을 넘으면 더 묻지 않는다', async () => {
  const auth = require('../middleware/auth');
  // exp 가 없는 JWT 모양 토큰
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const noExp = `${b64({ alg: 'HS256' })}.${b64({ sub: 'x' })}.signatureXX`;
  const r = await auth.verifyToken(noExp);
  assert.equal(r.user, null);
  // 실패 계수: Supabase 가 무효(401)라고 답하는 가짜 클라이언트로 바꿔 같은 IP 에서 25번 부르면, 20번까지만 외부에 묻는다
  const clientPath = require.resolve('../db/client');
  const authPath = require.resolve('../middleware/auth');
  const savedClient = require.cache[clientPath];
  const real = require('../db/client');
  let calls = 0;
  require.cache[clientPath] = { ...savedClient, exports: { ...real, getSupabasePublic: () => ({ auth: { getUser: async () => { calls++; return { data: null, error: { status: 401 } }; } } }) } };
  delete require.cache[authPath];
  try {
    const a2 = require('../middleware/auth');
    const mk = (i) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 3600, n: i })}.signatureXX`;
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => a2.optionalAuth({ ip: '203.0.113.7', headers: { authorization: `Bearer ${mk(i)}` } }, {}, resolve));
    }
    assert.equal(calls, a2.AUTH_FAIL_MAX, `외부 인증 호출이 ${a2.AUTH_FAIL_MAX}번에서 멈춰야 한다(실제 ${calls})`);
    // 만료 토큰은 외부에 묻지 않으므로 다른 IP 의 실패 계수를 올리지 않는다
    const expired = `${b64({ alg: 'HS256' })}.${b64({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 3600 })}.signatureXX`;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => a2.optionalAuth({ ip: '198.51.100.9', headers: { authorization: `Bearer ${expired}` } }, {}, resolve));
    }
    assert.ok(![...a2._authFail.keys()].some((k) => k.includes('198.51.100')), '만료 토큰이 실패 계수에 들어갔다');
  } finally {
    require.cache[clientPath] = savedClient;
    delete require.cache[authPath];
  }
});

test('in-bounds 반올림은 이미 격자 위의 값을 바꾸지 않는다(프런트가 보낸 값과 같은 키)', () => {
  // 서버 소스의 _ibQuant 를 그대로 꺼내 쓴다(복사한 식이 아니라 실제 코드를 검사)
  const src = rd('routes/search.js');
  const fn = src.match(/function _ibQuant\(v, up\) \{[^\n]*\}/);
  assert.ok(fn, '_ibQuant 를 찾지 못했다');
  const q = new Function(`${fn[0]}; return _ibQuant;`)();
  let changed = 0;
  for (let i = 33000; i < 39000; i++) { const v = parseFloat((i / 1000).toString()); if (q(v, false) !== v || q(v, true) !== v) changed++; }
  for (let i = 124000; i < 132000; i++) { const v = parseFloat((i / 1000).toString()); if (q(v, false) !== v || q(v, true) !== v) changed++; }
  assert.equal(changed, 0);
});

test('건축물대장: 요청 동의 지번이 저장 행과 다르면 동을 붙인 키를 쓰고, 없음 기억도 동별이다', () => {
  const s = rd('services/buildingRegisterService.js');
  assert.match(s, /select\('title, bun, ji'\)\.eq\('apt_key', nameKey\)/);
  assert.match(s, /cacheKey = `\$\{nameKey\}\|\$\{umdNm\}`;/);
  assert.match(s, /String\(row\.bun\) === pU\.bun && String\(row\.ji\) === pU\.ji/);
  assert.match(s, /const key = aptKey \|\| `name:\$\{aptName\}\|\$\{lawdCd\}\|\$\{args\.umdNm \|\| ''\}`;/);
});

test('북마크: 사용자당 500개, PATCH 와 migrate 도 POST 와 같은 길이 제한과 개인정보 검사', () => {
  const s = rd('routes/bookmarks.js');
  assert.match(s, /const BOOKMARK_MAX = 500;/);
  const post = s.slice(s.indexOf("router.post('/'"), s.indexOf("router.patch('/:id'"));
  assert.match(post, /_bookmarkCount\(sb\)\) >= BOOKMARK_MAX/);
  const patch = s.slice(s.indexOf("router.patch('/:id'"), s.indexOf("router.delete('/:id'"));
  assert.match(patch, /_detectPII\(memo\) \|\| _detectPII\(address\)/);
  assert.match(patch, /patch\.memo = _clipMemo\(memo\)/);
  const mig = s.slice(s.indexOf("router.post('/migrate'"));
  assert.match(mig, /_bookmarkCount\(sb\)\) \+ dedupedRows\.length > BOOKMARK_MAX/);
  assert.match(mig, /memo: _detectPII\(it\.memo\) \? null : _clipMemo\(it\.memo\)/);
});

test('현장 메모: 사용자당 300개, 이름 100자, checks 50개', () => {
  const s = rd('routes/fieldNotes.js');
  assert.match(s, /const FIELD_NOTE_MAX = 300;/);
  assert.match(s, /aptName\.length > 100\) return res\.status\(400\)/);
  assert.match(s, /checks\.slice\(0, 50\)/);
});

test('검색 기록: 저장 뒤 최근 500건만 남긴다', () => {
  const s = rd('routes/search.js');
  assert.match(s, /const SEARCH_HISTORY_KEEP = 500;/);
  assert.match(s, /\.range\(SEARCH_HISTORY_KEEP, SEARCH_HISTORY_KEEP \+ 199\)/);
});

test('search_popular_apts 실행 권한 회수가 마이그레이션 기록에 있다(운영은 이미 회수)', () => {
  const dir = path.join(__dirname, '../../supabase/migrations');
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(all, /revoke execute on function public\.search_popular_apts\(integer\) from public, anon, authenticated;/);
});

test('대화 저장: 사용자 전체 1000건, 하루 200건', () => {
  const s = rd('routes/chatSessions.js');
  assert.match(s, /const MAX_MESSAGES_PER_USER = 1000;/);
  assert.match(s, /const MAX_MESSAGES_PER_USER_DAY = 200;/);
  assert.match(s, /\(allCount \|\| 0\) >= MAX_MESSAGES_PER_USER/);
  assert.match(s, /dl:chatmsg:\$\{todayKey\(\)\}:\$\{req\.user\.id\}/);
});
