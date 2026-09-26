/**
 * Plan 107b-1 — 원본(molit_transactions) 16개월 창 자르기(Plan 107c) **전에** 정비해야 하는
 * 소비자 4가지(B3·B4·B6·B7)를 고정한다. 배경은 plans/107b-107c-window-cut-design.md §0~§1 —
 * 원본을 창으로 자르면 "원본 전 기간을 전제한 독자"가 조용히 빈 결과를 낸다(107 부록 A·A-2).
 * 이 계획 자체는 **DB 변경 0**(코드만) — 창은 아직 자르지 않았으므로 오늘은 대부분 "동작 변화 0"
 * 이 정상이다(각 테스트 설명 참고).
 *
 * [스텁 방식] server.js 를 통째로 require 하는 부분(B4)은 backend/test/data-counts-sync.test.js
 * (Plan 113)와 동일하게 `process.env.VERCEL='1'`로 app.listen() 을 피하고, `../db/client`·
 * `../services/redisCache` 를 require.cache 로 끊는다. 서비스 단독 테스트(B6·B7)는 같은
 * `../db/client` 스텁 하나를 공유한다 — server.js·서비스 파일 전부 동일한 절대경로로
 * `../db/client`/`./db/client` 를 resolve 하므로 스텁 1개로 전부 커버된다.
 *
 * ⚠ 기존 테스트 파일은 건드리지 않는다(절대 규칙) — data-counts-sync.test.js 가 이미
 * `getDataCounts()`(인자 없이 호출)의 "admin.from() 정확히 3회·반환 객체 3키" 를 고정해 뒀다.
 * 그래서 server.js 의 getDataCounts 는 `opts.includeHist`를 **opt-in**(기본 false)으로 두었고,
 * 이 파일의 B4 테스트는 `{ includeHist: true }`를 명시로 넘겨서만 이력 합산 경로를 확인한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CK = 'meta:dataCounts:v2'; // getDataCounts 내부 캐시 키 — server.js 와 동일 리터럴이어야 한다.
const HIST_CK = 'meta:dataCounts:txHistCount:v1'; // 위와 동일 — B4 의 "직전 캐시값" 키.
const DB_CLIENT_PATH = require.resolve('../db/client');
const REDIS_CACHE_PATH = require.resolve('../services/redisCache');
const SERVER_PATH = require.resolve('../server');

// 여러 test() 가 하나의 프로세스(이 파일)를 공유한다 — data-counts-sync.test.js 와 같은 이유로
// 고정된 스텁 뒤에 가변 admin 을 하나 둔다.
const state = {
  admin: null,
  rget: async () => undefined,
  rset: async () => {},
};

/**
 * 임의 테이블 이름에 대해 canned response 를 돌려주는 thenable 체인 — Supabase-js 의 쿼리
 * 빌더는 어느 메서드에서 멈춰 await 하든(.limit()·.maybeSingle()·.select() 등) 같은 Promise 로
 * resolve 되므로, 실제 필터 인자를 검증하지 않는 이 파일의 테스트 범위에는 이 정도 충실도로 충분하다
 * (B4 의 정밀한 호출 인자 검증은 data-counts-sync.test.js 가 이미 담당 — 건드리지 않는다).
 * @param {Object<string,{data,error,count?}>} responses table → canned response
 * @param {string[]} calls 호출된 table 이름을 순서대로 기록(폴백 호출 여부 검증용)
 */
function makeAdmin(responses, calls) {
  return {
    from(table) {
      calls.push(table);
      const res = responses[table] || { data: null, error: null };
      const chain = {
        select(cols, opts) {
          if (opts && opts.count) return Promise.resolve(res); // head:true count 조회(B4)
          return chain;
        },
        eq() { return chain; },
        not() { return chain; },
        neq() { return chain; },
        gte() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() { return Promise.resolve(res); },
        then(resolve, reject) { return Promise.resolve(res).then(resolve, reject); },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
}

let app, aptDimService, aptFacilityService, geocodeCacheService, buildingRegisterService, transactionService;
let savedVercelEnv;

before(() => {
  savedVercelEnv = process.env.VERCEL;
  process.env.VERCEL = '1'; // server.js 의 app.listen() 가드 회피(data-counts-sync.test.js 와 동일)

  require.cache[DB_CLIENT_PATH] = {
    id: DB_CLIENT_PATH, filename: DB_CLIENT_PATH, loaded: true,
    exports: {
      getSupabaseAdmin: () => state.admin,
      getSupabasePublic: () => null,
      getSupabaseReadonly: () => null,
      getUserScopedClient: () => null,
      requireSupabaseAdmin: () => { throw new Error('stub: 이 테스트는 requireSupabaseAdmin 을 쓰지 않는다'); },
      hasAdminEnv: () => true, // geocodeCacheService.DB_ENABLED 가 모듈 로드 시점에 이 값을 굳힌다 — require 전에 스텁해야 한다.
      _pickReadonlyKey: () => null,
      schema: 'public',
    },
  };
  require.cache[REDIS_CACHE_PATH] = {
    id: REDIS_CACHE_PATH, filename: REDIS_CACHE_PATH, loaded: true,
    exports: {
      rget: (...a) => state.rget(...a),
      rset: (...a) => state.rset(...a),
    },
  };

  // ⚠ 스텁 등록 **이후**에 require 한다 — geocodeCacheService 의 DB_ENABLED = hasAdminEnv() 가
  //   모듈 로드 시점 1회 평가라 순서를 지키지 않으면 스텁이 반영되지 않는다.
  app = require(SERVER_PATH);
  aptDimService = require('../services/aptDimService');
  aptFacilityService = require('../services/aptFacilityService');
  geocodeCacheService = require('../services/geocodeCacheService');
  buildingRegisterService = require('../services/buildingRegisterService');
  transactionService = require('../services/transactionService');
});

after(() => {
  delete require.cache[DB_CLIENT_PATH];
  delete require.cache[REDIS_CACHE_PATH];
  delete require.cache[SERVER_PATH];
  if (savedVercelEnv === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercelEnv;
});

beforeEach(() => {
  app.cache.del(CK);
  app.cache.del(HIST_CK);
  state.admin = null;
  state.rget = async () => undefined;
  state.rset = async () => {};
});

// ── B4 — dataCounts.tx = 원본 + 이력 ────────────────────────────────────────────
test('B4: getDataCounts({includeHist:true}) — 이력 카운트 성공 시 tx = 원본+이력, txLive/txHist 분리', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { count: 476716, error: null },
    apt_master: { count: 14661, error: null },
    molit_ingest_runs: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
    molit_transactions_hist: { count: 1290112, error: null },
  }, calls);

  const out = await app._getDataCounts({ includeHist: true });

  assert.equal(out.txLive, 476716, 'txLive 는 원본 count 그대로여야 한다');
  assert.equal(out.txHist, 1290112, 'txHist 는 이력 count 그대로여야 한다');
  assert.equal(out.tx, 1766828, 'tx 는 원본+이력 합계여야 한다(476716+1290112)');
  assert.equal(out.txHistUnknown, undefined, '성공 시 txHistUnknown 필드가 있으면 안 된다');
  assert.ok(calls.includes('molit_transactions_hist'), 'molit_transactions_hist 가 조회돼야 한다');
});

test('B4: 이력 카운트 실패 + 직전 캐시 없음 → txHistUnknown:true 이고 tx === txLive(이력을 0으로 지어내지 않는다)', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { count: 476716, error: null },
    apt_master: { count: 14661, error: null },
    molit_ingest_runs: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
    molit_transactions_hist: { count: null, error: { message: 'canceling statement due to statement timeout' } },
  }, calls);

  const out = await app._getDataCounts({ includeHist: true });

  assert.equal(out.txHistUnknown, true, '실패 + 직전 캐시 없음이면 txHistUnknown 이 서야 한다');
  assert.equal(out.tx, out.txLive, 'txHistUnknown 일 때 tx 는 txLive 와 같아야 한다(이력을 더하지 않음)');
  assert.equal(out.tx, 476716);
  assert.equal(out.txHist, undefined, '실패 시 txHist 필드 자체가 없어야 한다(0 을 지어내지 않는다)');
});

test('B4: includeHist 를 안 넘기면(기존 호출부와 동일) tx·apt·lastIngestedAt 3키만 — data-counts-sync.test.js 계약 불변 확인', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { count: 476716, error: null },
    apt_master: { count: 14661, error: null },
    molit_ingest_runs: { data: { finished_at: '2026-09-25T17:45:12Z' }, error: null },
  }, calls);

  const out = await app._getDataCounts();

  assert.deepEqual(out, { tx: 476716, apt: 14661, lastIngestedAt: '2026-09-25T17:45:12Z' },
    'opts 없이 부르면 옛 3키 계약이 그대로여야 한다(다른 실행자·기존 테스트가 이 모양에 의존)');
  assert.ok(!calls.includes('molit_transactions_hist'), 'opts 없이 부르면 이력 테이블을 조회하면 안 된다');
});

// ── B6 — aptDimService.findByName 폴백(원본 우선) ───────────────────────────────
test('B6: molitIdentity — 원본이 비어 있으면 dim 값으로 폴백한다', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: [], error: null },
    molit_apt_dim: {
      data: [{ apt_seq: '11320-1', apt_name: '폴백단지A', lawd_cd: '11320', sigungu: '도봉구', umd_nm: '방학동', build_year: 1998, jibun: '530-1', last_deal_date: '2024-01-01' }],
      error: null,
    },
  }, calls);

  const identity = await aptFacilityService.molitIdentity('폴백단지A', '도봉구', '방학동');

  assert.deepEqual(identity, { buildYear: 1998, jibunBon: '530' });
  assert.ok(calls.includes('molit_apt_dim'), 'molit_apt_dim 이 조회돼야 한다');
});

test('B6: molitIdentity — 원본이 있으면 dim 을 부르지 않는다', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: [{ build_year: 2005, jibun: '100-1' }, { build_year: 2005, jibun: '100-1' }], error: null },
    molit_apt_dim: { data: [{ apt_seq: '99999-9', apt_name: '오염방지', build_year: 1, jibun: '1' }], error: null }, // 불려선 안 된다
  }, calls);

  const identity = await aptFacilityService.molitIdentity('원본단지A', '강남구', '역삼동');

  assert.deepEqual(identity, { buildYear: 2005, jibunBon: '100' });
  assert.ok(!calls.includes('molit_apt_dim'), '원본이 있으면 molit_apt_dim 을 조회하면 안 된다');
});

test('B6: molitJibunAddress — 원본이 비어 있으면 dim 지번으로 같은 형식 문자열을 조립한다', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: [], error: null },
    molit_apt_dim: {
      data: [{ apt_seq: '11320-2', apt_name: '폴백단지B', lawd_cd: '11320', sigungu: '도봉구', umd_nm: '방학동', build_year: 1999, jibun: '271-1' }],
      error: null,
    },
  }, calls);

  const addr = await geocodeCacheService.molitJibunAddress({ aptName: '폴백단지B', sigungu: '도봉구', umdNm: '방학동' });

  assert.equal(addr, '도봉구 방학동 271-1');
  assert.ok(calls.includes('molit_apt_dim'), 'molit_apt_dim 이 조회돼야 한다');
});

test('B6: molitJibunAddress — 원본이 있으면 dim 을 부르지 않는다', async () => {
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: [{ jibun: '200-3' }], error: null },
    molit_apt_dim: { data: [{ jibun: '오염' }], error: null },
  }, calls);

  const addr = await geocodeCacheService.molitJibunAddress({ aptName: '원본단지B', sigungu: '서초구', umdNm: '반포동' });

  assert.equal(addr, '서초구 반포동 200-3');
  assert.ok(!calls.includes('molit_apt_dim'), '원본이 있으면 molit_apt_dim 을 조회하면 안 된다');
});

test('B6: resolveJibun — 원본이 비어 있으면 dim 행으로 {jibun,sigungu,umdNm} 을 돌려준다(라이브 폴백 전)', async () => {
  const calls = [];
  const admin = makeAdmin({
    molit_transactions: { data: [], error: null },
    molit_apt_dim: {
      data: [{ apt_seq: '11320-3', apt_name: '폴백단지C', lawd_cd: '11320', sigungu: '도봉구', umd_nm: '방학동', build_year: 2000, jibun: '530-4' }],
      error: null,
    },
  }, calls);
  state.admin = admin; // aptDimService 는 db/client 스텁을 통해 이 admin 을 얻는다

  const savedKey = process.env.MOLIT_API_KEY;
  delete process.env.MOLIT_API_KEY; // 라이브 폴백까지 못 가게 막아 "dim 에서 멈췄는지" 를 분명히 한다
  try {
    const ji = await buildingRegisterService.resolveJibun(admin, '11320', '방학동', '폴백단지C');
    assert.deepEqual(ji, { jibun: '530-4', sigungu: '도봉구', umdNm: '방학동' });
  } finally {
    if (savedKey === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = savedKey;
  }
  assert.ok(calls.includes('molit_apt_dim'), 'molit_apt_dim 이 조회돼야 한다');
});

test('B6: resolveJibun — 원본이 있으면 dim 을 부르지 않는다', async () => {
  const calls = [];
  const admin = makeAdmin({
    molit_transactions: { data: [{ jibun: '300-1', sigungu: '강남구', umd_nm: '역삼동' }], error: null },
    molit_apt_dim: { data: [{ jibun: '오염' }], error: null },
  }, calls);
  state.admin = admin;

  const ji = await buildingRegisterService.resolveJibun(admin, '11680', '역삼동', '원본단지C');

  assert.deepEqual(ji, { jibun: '300-1', sigungu: '강남구', umdNm: '역삼동' });
  assert.ok(!calls.includes('molit_apt_dim'), '원본이 있으면 molit_apt_dim 을 조회하면 안 된다');
});

// ── B7 — getTransactionsByAptSeqMerged: 원본 + 이력 병합 ───────────────────────
test('B7: 원본 6개월 + 이력 6개월 → 12개월로 병합·같은 달 중복 0·이력 행에 dim 의 aptName 이 채워짐', async () => {
  const seq = '99999-107'; // 실제 데이터와 충돌하지 않는 전용 fixture 시퀀스(캐시 키도 이걸로 격리됨)
  const liveMonths = ['2025-06', '2025-05', '2025-04', '2025-03', '2025-02', '2025-01']; // 원본 최근 6개월
  const histMonths = ['2024-12', '2024-11', '2024-10', '2024-09', '2024-08', '2024-07']; // 이력 6개월(원본과 안 겹침)

  const liveRows = liveMonths.map((ym, i) => ({
    apt_name: '원본이름', sigungu: '도봉구', umd_nm: '방학동', exclu_use_ar: 84.99, build_year: 1998,
    floor: 10 + i, deal_year: Number(ym.slice(0, 4)), deal_month: Number(ym.slice(5, 7)), deal_day: 15,
    deal_amount: 50000 + i, lawd_cd: '11320', apt_seq: seq, jibun: '530-1',
  }));
  const histRows = histMonths.map((ym, i) => ({
    deal_date: `${ym}-10`, exclu_use_ar: 8499, deal_amount: 40000 + i, floor: 5 + i, // ㎡×100 = 84.99㎡
  }));
  const dimRow = { apt_name: '이력채움이름', lawd_cd: '11320', sigungu: '도봉구', umd_nm: '방학동', build_year: 1998, jibun: '530-1' };

  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: liveRows, error: null },
    molit_transactions_hist: { data: histRows, error: null },
    molit_apt_dim: { data: [dimRow], error: null },
  }, calls);

  const merged = await transactionService.getTransactionsByAptSeqMerged(seq, 12);

  assert.equal(merged.length, 12, '원본 6 + 이력 6 = 12개월이 그대로 합쳐져야 한다(중복 0)');
  const ymOf = (t) => `${t.dealYear}-${String(t.dealMonth).padStart(2, '0')}`;
  const ymSet = new Set(merged.map(ymOf));
  assert.equal(ymSet.size, 12, '같은 달 중복이 없어야 한다');
  for (const ym of liveMonths) assert.ok(ymSet.has(ym), `원본 달 ${ym} 이 있어야 한다`);
  for (const ym of histMonths) assert.ok(ymSet.has(ym), `이력 달 ${ym} 이 있어야 한다`);

  const histDerived = merged.filter((t) => histMonths.includes(ymOf(t)));
  assert.equal(histDerived.length, 6);
  for (const t of histDerived) {
    assert.equal(t.aptName, dimRow.apt_name, '이력 행은 dim 의 aptName 으로 채워져야 한다');
    assert.equal(t.sigungu, dimRow.sigungu);
    assert.equal(t.umdNm, dimRow.umd_nm);
    assert.equal(t.buildYear, dimRow.build_year);
    assert.equal(t.jibun, dimRow.jibun);
    assert.equal(t.excluUseAr, 84.99, 'hist.exclu_use_ar 는 ㎡×100 이므로 100 으로 나눠야 한다');
  }
  const liveDerived = merged.filter((t) => liveMonths.includes(ymOf(t)));
  assert.equal(liveDerived.length, 6);
  for (const t of liveDerived) assert.equal(t.aptName, '원본이름', '원본 달은 원본 이름을 유지해야 한다(dim 으로 덮어쓰지 않는다)');

  // 내림차순 정렬(최신 달 우선) 확인
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1].dealYear * 10000 + merged[i - 1].dealMonth * 100 + merged[i - 1].dealDay;
    const b = merged[i].dealYear * 10000 + merged[i].dealMonth * 100 + merged[i].dealDay;
    assert.ok(a >= b, '최신 달부터 내림차순이어야 한다');
  }
});

test('B7: 이력이 붙을 달이 없으면(오늘 실제 상태) 원본과 완전히 동일한 배열을 반환한다 — 동작 변화 0', async () => {
  const seq = '99999-108';
  const liveRows = [{
    apt_name: '단독원본', sigungu: '도봉구', umd_nm: '방학동', exclu_use_ar: 59.98, build_year: 2001,
    floor: 7, deal_year: 2026, deal_month: 8, deal_day: 1, deal_amount: 70000, lawd_cd: '11320', apt_seq: seq, jibun: '272',
  }];
  const calls = [];
  state.admin = makeAdmin({
    molit_transactions: { data: liveRows, error: null },
    molit_transactions_hist: { data: [], error: null }, // 이력에 이 apt_seq 의 행이 없다
  }, calls);

  const merged = await transactionService.getTransactionsByAptSeqMerged(seq, 12);
  const live = await transactionService.getTransactionsByAptSeq(seq, 12);

  assert.deepEqual(merged, live, '이력이 없으면 원본과 완전히 동일해야 한다(배선만, 동작 변화 0)');
});

// ── B3·B2 — 정적 단언(파일 내용) ────────────────────────────────────────────────
test('B3: cron.js molit-ingest 핸들러가 refresh_molit_apt_dim 을 호출한다(POST/GET 공유 함수 1곳)', () => {
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cron.js'), 'utf8');
  const dimCallCount = (cronSrc.match(/\.rpc\('refresh_molit_apt_dim'\)/g) || []).length;
  assert.equal(dimCallCount, 1, 'refresh_molit_apt_dim RPC 호출은 정확히 1곳이어야 한다');
  // /molit-ingest 는 POST/GET 이 handleMolitIngest 하나를 공유한다(쌍둥이 코드 분기가 아니다) —
  // 즉 이 1곳의 호출이 두 라우트 모두에 적용된다("쌍둥이면 둘 다" 요건을 공유 함수로 만족).
  assert.match(cronSrc, /router\.post\('\/molit-ingest',\s*handleMolitIngest\)/);
  assert.match(cronSrc, /router\.get\('\/molit-ingest',\s*handleMolitIngest\)/);
});

test('B2: index.html — 옛 "거래 N건" 라벨은 사라지고 "최근 거래 N건" 이 정확히 1곳', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  assert.equal((html.match(/`거래 \$\{p\.dealCount\?\?p\.dealCount6m\}건`/g) || []).length, 0,
    '옛 라벨(거래 N건)이 남아 있으면 안 된다');
  assert.equal((html.match(/최근 거래 \$\{p\.dealCount\?\?p\.dealCount6m\}건/g) || []).length, 1,
    '새 라벨(최근 거래 N건)이 정확히 1곳이어야 한다');
});
