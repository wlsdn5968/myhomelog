/**
 * ALIAS-REFRESH-2026-09-06 (Plan 067) — molit_aliases 자동 갱신 cron 편승.
 *
 * [배경] apt_master.molit_aliases 는 2026-09-06 1회 backfill 로 1 → 10,505행이 됐다(Plan 053).
 *   그런데 aptMasterSync(주 1회 cron)가 새 단지를 upsert 할 때 molit_aliases 는 그 upsert 의
 *   컬럼이 아니라 빈 채로 들어온다(backend/jobs/aptMasterSync.js:17,174 주석) — 시간이 갈수록
 *   챗 도달률·단지정보 커버리지가 조용히 떨어진다. 이 계획은 그 upsert 직후 DB 함수
 *   `public.refresh_molit_aliases()`(SECURITY DEFINER, service_role 전용, integer 반환 — 리뷰어가
 *   운영자 승인 하에 생성)를 호출해 다시 채운다.
 *
 * [원칙] 실패해도 sync 결과는 ok(기존 검색 MV 갱신과 동일 규약) — "모름"을 0 으로 지어내지 않는다:
 *   RPC 가 실패하면 aliasRefreshed 필드 자체를 생략한다(0 건과 구별 불가능해지는 것을 방지).
 *
 * [파일 분리 이유] backend/test/characterization.test.js 는 동시에 다른 실행자가 분할 중이라
 *   건드리지 않는다 — 이 신규 파일에 최소 헬퍼를 자체적으로 둔다(다른 파일에서 import 하지 않음).
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Helper A: aptMasterSync.js 를 실제로 실행 — RPC 성공/실패에 따른 필드 구성을 확인한다.
//   외부 의존(db/client·dataGoKrClient·transactionService)은 require.cache 스텁으로 끊는다
//   (이 저장소 관례 — characterization.test.js 의 getSupabaseAdmin 스텁과 같은 방식만 따른다).
//   dataGoKrClient 는 빈 응답을 즉시 돌려줘 syncOneSgg 가 admin.from(...) 을 전혀 타지 않게 한다
//   (all.length===0 조기 반환) — 이 테스트의 관심사는 upsert 자체가 아니라 그 "직후" 호출뿐이다.
function _stubAptMasterDeps({ rpcData, rpcError, rpcThrow } = {}) {
  const dbPath = require.resolve('../db/client');
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const txPath = require.resolve('../services/transactionService');
  const jobPath = require.resolve('../jobs/aptMasterSync');
  const saved = {
    db: require.cache[dbPath], dgk: require.cache[dgkPath],
    tx: require.cache[txPath], job: require.cache[jobPath],
    key: process.env.APT_INFO_API_KEY,
  };
  const rpcCalls = [];
  const admin = {
    rpc(name) {
      rpcCalls.push(name);
      return {
        abortSignal: () => (rpcThrow
          ? Promise.reject(rpcThrow)
          : Promise.resolve({ data: rpcData, error: rpcError || null })),
      };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    requireSupabaseAdmin: () => admin,
  } };
  require.cache[dgkPath] = { id: dgkPath, filename: dgkPath, loaded: true, exports: {
    get: async () => ({ data: { response: { header: { resultCode: '00' }, body: { items: [] } } } }),
  } };
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: {
    LAWD_CODES: { 테스트구: '99999' }, LAWD_CODE_TO_NAME: { '99999': '테스트구' },
  } };
  // APT_INFO_KEY 는 모듈 로드 시 상수라 env 를 먼저 세우고 다시 require 해야 한다(dummy — gitleaks 허용 패턴).
  process.env.APT_INFO_API_KEY = 'xxxxxxxx-test-only';
  delete require.cache[jobPath];
  const { runAptMasterSync } = require('../jobs/aptMasterSync');
  return {
    runAptMasterSync, rpcCalls,
    restore() {
      if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
      if (saved.dgk) require.cache[dgkPath] = saved.dgk; else delete require.cache[dgkPath];
      if (saved.tx) require.cache[txPath] = saved.tx; else delete require.cache[txPath];
      if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
      if (saved.key === undefined) delete process.env.APT_INFO_API_KEY; else process.env.APT_INFO_API_KEY = saved.key;
    },
  };
}

test('molit_aliases 자동 갱신 — RPC 성공 시 aliasRefreshed 가 숫자로 기록된다', async () => {
  const { runAptMasterSync, rpcCalls, restore } = _stubAptMasterDeps({ rpcData: 137 });
  try {
    const summary = await runAptMasterSync();
    assert.ok(rpcCalls.includes('refresh_molit_aliases'), 'upsert 직후 refresh_molit_aliases RPC 가 호출되지 않았다');
    assert.equal(typeof summary.aliasRefreshed, 'number', 'aliasRefreshed 가 숫자로 기록되지 않았다');
    assert.equal(summary.aliasRefreshed, 137);
    assert.equal('aliasRefreshError' in summary, false, '성공인데 실패 사유 필드가 남아있다');
  } finally { restore(); }
});

test('molit_aliases 자동 갱신 — RPC 가 error 를 돌려줘도 sync 는 예외 없이 끝나고 aliasRefreshed 는 생략된다', async () => {
  const { runAptMasterSync, restore } = _stubAptMasterDeps({ rpcError: { message: 'statement timeout' } });
  try {
    const summary = await runAptMasterSync(); // 예외 없이 완료 — 실패해도 sync 결과는 ok(요구사항 1)
    assert.equal('aliasRefreshed' in summary, false,
      'RPC 실패인데 aliasRefreshed 가 채워졌다 — "모름"을 0 등의 값으로 지어내면 안 된다');
    assert.equal(summary.aliasRefreshError, 'statement timeout');
    // 별칭 갱신 실패가 sync 본체(다른 필드)를 망가뜨리지 않는지도 함께 확인한다.
    assert.equal(typeof summary.sggs, 'number', 'RPC 실패가 sync 본체 결과까지 지워버렸다');
  } finally { restore(); }
});

test('molit_aliases 자동 갱신 — RPC 호출 자체가 reject 해도(네트워크 예외) 같은 규약을 따른다', async () => {
  const { runAptMasterSync, restore } = _stubAptMasterDeps({ rpcThrow: new Error('fetch failed') });
  try {
    const summary = await runAptMasterSync();
    assert.equal('aliasRefreshed' in summary, false);
    assert.equal(summary.aliasRefreshError, 'fetch failed');
  } finally { restore(); }
});

// ── Helper B: cron.js 의 /apt-master-sync 핸들러만 떼어내 경보 로직을 확인한다.
//   job(aptMasterSync) 자체는 통제된 summary 를 돌려주는 스텁으로 대체 — characterization.test.js 의
//   _requireCronMolitHandler(MV 경보 테스트, Plan 058)와 같은 기법이다(그 파일은 건드리지 않고
//   방식만 따른다). authorizeCron 은 router.use 미들웨어라 라우트 핸들러를 직접 뽑으면 우회된다
//   (인증 자체는 이 저장소의 기존 계약 테스트가 별도로 고정한다).
function _requireCronAptMasterHandler(summary) {
  const jobPath = require.resolve('../jobs/aptMasterSync');
  const sentryPath = require.resolve('@sentry/node');
  const statsPath = require.resolve('../services/cronStats');
  const cronPath = require.resolve('../routes/cron');
  const saved = {
    job: require.cache[jobPath], sentry: require.cache[sentryPath],
    stats: require.cache[statsPath], cron: require.cache[cronPath],
  };
  const sentryCalls = [];
  const statsCalls = [];
  require.cache[sentryPath] = { id: sentryPath, filename: sentryPath, loaded: true, exports: {
    captureMessage: (msg, opts) => sentryCalls.push({ msg, opts }),
    captureException: () => {},
  } };
  require.cache[jobPath] = { id: jobPath, filename: jobPath, loaded: true, exports: {
    runAptMasterSync: async () => summary,
  } };
  require.cache[statsPath] = { id: statsPath, filename: statsPath, loaded: true, exports: {
    recordCronRun: (name, s) => { statsCalls.push({ name, summary: s }); return Promise.resolve(); },
  } };
  delete require.cache[cronPath];
  const cronRouter = require('../routes/cron');
  const layer = cronRouter.stack.find(l => l.route && l.route.path === '/apt-master-sync' && l.route.methods.get);
  if (!layer) throw new Error('GET /apt-master-sync 라우트를 못 찾았다 — cron.js 구조가 바뀌었다');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return {
    handle, sentryCalls, statsCalls,
    restore() {
      if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
      if (saved.sentry) require.cache[sentryPath] = saved.sentry; else delete require.cache[sentryPath];
      if (saved.stats) require.cache[statsPath] = saved.stats; else delete require.cache[statsPath];
      if (saved.cron) require.cache[cronPath] = saved.cron; else delete require.cache[cronPath];
    },
  };
}
function _mkRes() {
  const r = { code: 200, body: null };
  r.json = (b) => { r.body = b; return r; };
  r.status = (c) => { r.code = c; return r; };
  return r;
}

test('molit_aliases 자동 갱신 실패 — Sentry 경보가 고정 메시지 + extra 로 나가고(가변값 없음), 응답은 여전히 ok', async () => {
  const { handle, sentryCalls, statsCalls, restore } = _requireCronAptMasterHandler({
    sggs: 82, fetched: 0, inserted: 0, aliasRefreshError: 'statement timeout',
  });
  try {
    const res = _mkRes();
    await handle({ query: {} }, res);
    assert.equal(sentryCalls.length, 1, 'aliasRefreshError 가 있는데 경보가 나가지 않았다');
    const call = sentryCalls[0];
    assert.equal(typeof call.msg, 'string', 'Sentry 메시지가 문자열이 아니다');
    assert.equal(/\$\{|`|statement timeout/.test(call.msg), false,
      '경보 메시지에 가변값(실패 사유)이 섞여 있다 — 매번 새 이슈로 잡혀 그룹핑이 깨진다');
    assert.equal(call.opts.level, 'warning');
    assert.equal(call.opts.tags.route, 'cron.apt-master-sync');
    assert.equal(call.opts.extra.aliasRefreshError, 'statement timeout', '가변값은 extra 에만 실려야 한다');
    // 별칭 갱신이 실패해도 cron 응답 자체는 ok(요구사항 1의 "실패해도 sync 결과는 ok" 규약).
    assert.equal(res.body && res.body.ok, true, 'aliasRefreshError 가 있어도 cron 응답은 ok 여야 한다');
    const rec = statsCalls.find(c => c.name === 'apt-master-sync');
    assert.ok(rec, 'apt-master-sync 실행 기록이 recordCronRun 으로 남지 않았다');
    assert.equal(rec.summary.aliasRefreshError, 'statement timeout', 'recordCronRun 에 실패 사유가 전달되지 않았다');
  } finally { restore(); }
});

test('molit_aliases 자동 갱신 성공 — aliasRefreshError 가 없으면 경보가 나가지 않는다(오탐 방지)', async () => {
  const { handle, sentryCalls, restore } = _requireCronAptMasterHandler({
    sggs: 82, fetched: 10, inserted: 10, aliasRefreshed: 3,
  });
  try {
    const res = _mkRes();
    await handle({ query: {} }, res);
    assert.equal(sentryCalls.length, 0, '성공(aliasRefreshError 없음)인데 경보가 나갔다');
    assert.equal(res.body && res.body.ok, true);
  } finally { restore(); }
});

// ── cronStats._pick 화이트리스트 — health 로 실제로 노출되는지 확인한다(058 이 같은 이유로 추가한 선례).
test('cronStats._pick — aliasRefreshed(숫자)·aliasRefreshError(문자열, 길이제한)가 화이트리스트를 통과한다', () => {
  const { _pick } = require('../services/cronStats');
  assert.equal(_pick({ aliasRefreshed: 137 }).aliasRefreshed, 137);
  assert.equal(_pick({ aliasRefreshed: 0 }).aliasRefreshed, 0, '0건(진짜 갱신 0건)도 유효한 값이라 통과해야 한다');
  assert.equal('aliasRefreshed' in _pick({ aliasRefreshed: undefined }), false,
    '미상(undefined)이 통과해 0 으로 오독될 값을 남기면 안 된다');
  assert.equal('aliasRefreshed' in _pick({}), false);
  assert.equal(_pick({ aliasRefreshError: 'x'.repeat(300) }).aliasRefreshError.length, 120, '길이 제한이 없다');
  assert.equal('aliasRefreshError' in _pick({ aliasRefreshError: '  ' }), false, '공백뿐인 사유가 통과했다');
});
