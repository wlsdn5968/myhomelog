/**
 * backend/test/window-safe-ddl.test.js
 *
 * WINDOW-2026-09-27 (Plan 107b-2) — 창 자르기(107c) 전 DDL 3건(D1·D2·D3, 리뷰어 적용) +
 * 코드 2건(B8 재시도 창·B3 가시성) + 검색 "1건" 지어내기 제거(추가 1건)를 고정한다.
 *
 * 이 파일은 DB 에 붙지 않는다 — DDL 은 리뷰어가 이미 프로덕션에 적용했고(schema.sql·
 * 마이그레이션 기록으로 반영), 여기서는 ① 소스 텍스트가 실제로 바뀌었는지 ② cron.js 의
 * 숫자 플래그 분기가 실제로 동작하는지 ③ search.js 응답이 원본 거래 0건 단지를
 * "최근 거래 1건"으로 지어내지 않는지를 고정한다.
 *
 * [파일 분리 이유] 기존 테스트 파일(frontend-contracts.test.js·cron-observability.test.js·
 * search-chat.test.js 등)은 수정 금지 대상이라 건드리지 않는다 — 이 저장소 관례(aliases-cron.test.js
 * 등)대로 새 도메인 파일에 담는다. 공용 헬퍼(_requireCronMolitHandler·_mkCronRes·_withSearchDbStub)는
 * testSupport/_helpers.js 에서 그대로 가져다 쓴다(사본을 새로 만들지 않는다).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _requireCronMolitHandler, _mkCronRes, _withSearchDbStub, _mockRes } = require('../testSupport/_helpers');

// ORDER-DEP-FIX-2026-09-27 (같은 이유: _withSearchDbStub 의 require('../routes/search') 선행
//   호출 주석 — testSupport/_helpers.js 참고): _requireCronMolitHandler 는 db/client 를
//   hasAdminEnv 없는 축약 스텁으로 갈아치운 뒤 cron.js 를 다시 부른다. cron.js 는 top-level
//   에서 jobs/aptMasterSync → services/transactionService 를 require 하는데, 그 모듈들이
//   *이 프로세스에서 처음* 로드되는 시점이 스텁 이후면 top-level hasAdminEnv() 호출이 깨진다.
//   다른 테스트 파일이 먼저 돌아 자식 모듈을 실제 client 로 캐시해 둔 상태(전체 스위트 실행)에서는
//   드러나지 않지만, 이 파일만 단독 실행하면(예: 이 파일만 디버깅) 재현된다 — 실제 client 로
//   미리 한 번 로드해 자식 모듈의 top-level 상수를 먼저 캐시시킨다(이 파일이 실제로 스텁을
//   심는 대상은 cron.js·search.js 자신의 캐시 항목뿐이므로 안전하다).
require('../services/transactionService');
require('../routes/cron');
require('../routes/search');

const _molitIngestSrc = () => fs.readFileSync(path.join(__dirname, '../jobs/molitIngest.js'), 'utf8');
const _schemaSrc = () => fs.readFileSync(path.join(__dirname, '../../supabase/schema.sql'), 'utf8');


// ══════════════════════════════════════════════════════════════════════════
// ① B8 — 재시도 창(lookbackMonths)이 원본 창(16개월)과 같은 상수를 쓴다
// ══════════════════════════════════════════════════════════════════════════
test('molitIngest — retryFailedGaps 의 lookbackMonths 가 하드코드 18 이 아니라 WINDOW_MONTHS(16) 상수다 (Plan 107b-2/B8)', () => {
  const src = _molitIngestSrc();
  // 옛 하드코드(18개월 — 창(16)보다 길어 창 밖 달의 error/timeout 기록을 재적재할 수 있었다)가 사라졌다.
  assert.equal(/lookbackMonths:\s*18\b/.test(src), false,
    'lookbackMonths: 18 하드코드가 아직 남아 있다 — 원본 창(16)보다 길어 창 밖 달을 재적재할 위험');
  // 상수 선언 + 실제 사용처(기본값·호출부) 둘 다 있어야 "한 곳에 둔다"는 계획 의도가 성립한다.
  assert.match(src, /const WINDOW_MONTHS = 16;/, 'WINDOW_MONTHS = 16 상수 선언이 없다');
  assert.match(src, /WINDOW-2026-09-27 \(Plan 107b-2\/B8\)/, '상수 주석 태그가 없다');
  const usages = (src.match(/WINDOW_MONTHS/g) || []).length;
  assert.ok(usages >= 2, `WINDOW_MONTHS 참조가 ${usages}회뿐이다 — 선언 외 default·호출부 사용이 있어야 한다`);
  assert.match(src, /lookbackMonths\s*=\s*WINDOW_MONTHS/, 'retryFailedGaps 기본값이 WINDOW_MONTHS 를 쓰지 않는다');
  assert.match(src, /lookbackMonths:\s*WINDOW_MONTHS/, '호출부가 WINDOW_MONTHS 를 쓰지 않는다');
  // .in('status', ['error','timeout']) 은 그대로(archived 는 자동 제외) — 계획의 "절대 규칙" 고정.
  assert.match(src, /\.in\(\s*'status'\s*,\s*\[\s*'error'\s*,\s*'timeout'\s*\]\s*\)/,
    "retryFailedGaps 의 상태 필터가 바뀌었다 — ['error','timeout'] 그대로여야 한다");
});


// ══════════════════════════════════════════════════════════════════════════
// ② B3 가시성 — dimRefreshFailed 가 NUM 화이트리스트에 있고, 실패 분기(admin 없음·rpc throw)에서
//    숫자 1 로, 성공 시 0 으로 recordCronRun 에 실제로 실린다.
// ══════════════════════════════════════════════════════════════════════════

// cron.js 의 dim 갱신 블록(require('../db/client').getSupabaseAdmin())이 쓰는 admin 스텁.
//   MV 갱신(refresh_molit_apt_index)은 .rpc(...).abortSignal(...) 체인이고, dim 갱신
//   (refresh_molit_apt_dim)은 .rpc(...) 를 그대로 await 한다 — 두 호출 모양이 다르므로
//   반환 Promise 에 abortSignal 메서드를 얹어 둘 다 받게 한다.
function _dimCronAdmin({ dimReject, dimResult } = {}) {
  const chain = {
    select() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    rpc(name) {
      if (name === 'refresh_molit_apt_dim') {
        return dimReject ? Promise.reject(dimReject) : Promise.resolve(dimResult || { data: 12, error: null });
      }
      const p = Promise.resolve({ error: null }); // refresh_molit_apt_index — 이 테스트의 관심사가 아니므로 무해하게 성공 처리
      p.abortSignal = () => Promise.resolve({ error: null });
      return p;
    },
    from() { return chain; },
  };
}

test('cronStats._pick — dimRefreshFailed 가 화이트리스트에 있다 (Plan 107b-2/B3 가시성)', () => {
  const { _pick } = require('../services/cronStats');
  assert.deepEqual(_pick({ dimRefreshFailed: 1 }), { dimRefreshFailed: 1 });
  assert.deepEqual(_pick({ dimRefreshFailed: 0 }), { dimRefreshFailed: 0 });
  // dimRefreshError(문자열)는 기존과 같이 화이트리스트를 안 타는 별도 필드 — 숫자 플래그만 집계 대상.
  assert.equal('dimRefreshFailed' in _pick({ dimRefreshError: 'x' }), false);
});

test('cron molit-ingest — dim 갱신 rpc 가 실패(throw)하면 summary.dimRefreshFailed=1 이 기록된다', async () => {
  const admin = _dimCronAdmin({ dimReject: new Error('dim rpc 실패(스텁)') });
  const { handle, statsCalls, restore } = _requireCronMolitHandler(admin);
  try {
    const res = _mkCronRes();
    await handle({ query: {} }, res);
    const rec = statsCalls.find((c) => c.name === 'molit-ingest');
    assert.ok(rec, 'molit-ingest 실행 기록이 recordCronRun 으로 안 남았다');
    assert.equal(rec.summary.dimRefreshFailed, 1, 'rpc 가 throw 했는데 dimRefreshFailed 가 1 이 아니다');
    assert.equal(typeof rec.summary.dimRefreshError, 'string', '실패 사유(dimRefreshError)가 문자열로 함께 남아야 한다');
    assert.equal(res.body && res.body.ok, true, 'dim 갱신 실패해도 적재 cron 응답 자체는 ok 여야 한다(fail-open, 기존 규약)');
  } finally { restore(); }
});

test('cron molit-ingest — service_role 미설정(admin 없음)도 dimRefreshFailed=1 로 잡힌다', async () => {
  const { handle, statsCalls, restore } = _requireCronMolitHandler(null);
  try {
    const res = _mkCronRes();
    await handle({ query: {} }, res);
    const rec = statsCalls.find((c) => c.name === 'molit-ingest');
    assert.ok(rec, 'molit-ingest 실행 기록이 recordCronRun 으로 안 남았다');
    assert.equal(rec.summary.dimRefreshFailed, 1);
    assert.equal(rec.summary.dimRefreshError, 'service_role 미설정');
  } finally { restore(); }
});

test('cron molit-ingest — dim 갱신 rpc 가 성공하면 dimRefreshFailed=0, dimRefreshed 는 숫자로 남는다', async () => {
  const admin = _dimCronAdmin({ dimResult: { data: 7, error: null } });
  const { handle, statsCalls, restore } = _requireCronMolitHandler(admin);
  try {
    const res = _mkCronRes();
    await handle({ query: {} }, res);
    const rec = statsCalls.find((c) => c.name === 'molit-ingest');
    assert.equal(rec.summary.dimRefreshFailed, 0);
    assert.equal(rec.summary.dimRefreshed, 7);
    assert.equal(rec.summary.dimRefreshError, undefined, '성공했는데 실패 사유가 남았다');
  } finally { restore(); }
});


// ══════════════════════════════════════════════════════════════════════════
// ③ schema.sql — 리뷰어가 적용한 DDL 4건(dim timeout·D1·D2·D3)이 글자 단위로 반영돼 있다
// ══════════════════════════════════════════════════════════════════════════
test('schema.sql — refresh_molit_apt_dim() 에 statement_timeout 120s 가 반영됐다 (실측 37초 vs PostgREST 8s 컷)', () => {
  const schema = _schemaSrc();
  const idx = schema.indexOf('CREATE OR REPLACE FUNCTION public.refresh_molit_apt_dim()');
  assert.ok(idx >= 0, 'refresh_molit_apt_dim() 정의를 못 찾았다');
  const block = schema.slice(idx, idx + 300);
  assert.match(block, /SET statement_timeout TO '120s'/,
    'refresh_molit_apt_dim() 에 statement_timeout 120s 가 없다 — refresh_molit_apt_index 와 같은 처방이 빠졌다');
});

test('schema.sql — D1 함수 upsert_hist_peaks_for_month 가 계획서 SQL 그대로 반영됐다 (Plan 107b-2/D1)', () => {
  const schema = _schemaSrc();
  assert.match(schema, /CREATE OR REPLACE FUNCTION public\.upsert_hist_peaks_for_month\(p_ym text\)/,
    'upsert_hist_peaks_for_month 함수 선언이 없다');
  // 면적 변환식은 get_price_records* 의 조인식과 글자 단위로 같아야 한다(다르면 조인이 빗나간다).
  assert.match(schema, /least\(round\(t\.exclu_use_ar \* 100\), 32767\)::smallint/,
    'D1 의 면적 변환식이 get_price_records* 의 조인식과 다르다');
  assert.match(schema, /on conflict \(apt_seq, exclu_use_ar\) do update/,
    'D1 의 증분 upsert(on conflict)가 없다');
  assert.match(schema, /mx = greatest\(public\.molit_hist_peaks\.mx, excluded\.mx\)/, 'mx 갱신식이 다르다');
  assert.match(schema, /mn = least\(public\.molit_hist_peaks\.mn, excluded\.mn\)/, 'mn 갱신식이 다르다');
  assert.match(schema, /n\s*=\s*public\.molit_hist_peaks\.n \+ excluded\.n/, 'n 합산식이 다르다');
});

test('schema.sql — D2 MV molit_apt_index 가 molit_apt_dim 기반으로 교체됐다(deal_count_all 포함, 인덱스명 유지) (Plan 107b-2/D2)', () => {
  const schema = _schemaSrc();
  assert.match(schema, /create materialized view if not exists public\.molit_apt_index as\r?\nwith g as \(/,
    'D2 MV 정의가 molit_apt_dim 기반 CTE(with g as (...))로 바뀌지 않았다 — 옛 FROM molit_transactions 집계가 남아있을 수 있다');
  assert.match(schema, /from public\.molit_apt_dim d/, 'D2 MV 가 molit_apt_dim 을 기반으로 하지 않는다');
  assert.match(schema, /as deal_count,/, 'deal_count(원본 창 안 건수) 컬럼이 없다');
  assert.match(schema, /as deal_count_all,/, '신규 컬럼 deal_count_all 이 없다');
  // 유일 인덱스 이름은 그대로 — search.js 등 소비자가 이름으로 참조하지 않으므로 직접 영향은 없지만
  //   계획서가 "이름 유지"를 명시한 사실 확인.
  assert.equal((schema.match(/CREATE UNIQUE INDEX uq_molit_apt_index ON public\.molit_apt_index/g) || []).length, 1,
    '유일 인덱스 uq_molit_apt_index 가 정확히 1개, 이름 그대로 있어야 한다');
});

test('schema.sql — D3 molit_ingest_runs_status_chk 에 archived 가 추가됐다 (Plan 107b-2/D3)', () => {
  const schema = _schemaSrc();
  const m = schema.match(/molit_ingest_runs_status_chk CHECK \(\(status = ANY \(ARRAY\[([^\]]+)\]\)\)\);/);
  assert.ok(m, 'molit_ingest_runs_status_chk 정의를 못 찾았다');
  const values = m[1];
  for (const v of ['running', 'ok', 'error', 'skipped', 'timeout', 'archived']) {
    assert.match(values, new RegExp(`'${v}'::text`), `CHECK 배열에 '${v}' 가 없다`);
  }
  // 정확히 한 군데(CHECK 정의 자체)에만 있어야 한다 — 코드가 archived 를 실제로 쓰기 전에
  //   먼저 자리만 만들어 두는 단계(107c-1 이전)라 다른 곳에서 이 리터럴이 나타나면 안 된다.
  assert.equal((schema.match(/'archived'::text/g) || []).length, 1,
    "'archived'::text 가 CHECK 정의 1곳 외에 또 있다");
});


// ══════════════════════════════════════════════════════════════════════════
// ④ frontend-contracts 계약 — 새로 만든 RPC(upsert_hist_peaks_for_month)가 스냅샷에 선언돼
//    있다는 사실만 보조로 재확인한다(본 계약은 frontend-contracts.test.js 가 계속 고정한다 —
//    이 함수는 107c-1 전까지 코드에서 호출하지 않으므로 그 테스트의 "코드가 쓰는 RPC" 검사엔
//    아직 걸리지 않는다. 여기서는 "선언은 이미 돼 있다"만 별도로 고정한다).
// ══════════════════════════════════════════════════════════════════════════
test('schema.sql 선언 스캔 — upsert_hist_peaks_for_month 가 함수로 인식되는 형태(라인 시작 CREATE OR REPLACE FUNCTION public.)로 있다', () => {
  const schema = _schemaSrc();
  const declaredFns = new Set();
  for (const m of schema.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-zA-Z0-9_]+)/gm)) declaredFns.add(m[1]);
  assert.ok(declaredFns.has('upsert_hist_peaks_for_month'),
    'frontend-contracts.test.js 가 쓰는 것과 같은 정규식으로 스캔했을 때 upsert_hist_peaks_for_month 가 안 잡힌다 — 107c-1 이 이 RPC 를 호출하기 시작하면 계약 테스트가 실패할 것이다');
});


// ══════════════════════════════════════════════════════════════════════════
// 추가 1건 — 검색 "1건" 지어내기 제거 (리뷰어 실측: 시티팰리스9차 → 실제 원본 0·이력 146인데
//   응답 dealCount:1). MV 행에 _n(실측, 0 허용)·_nAll(전체 건수)을 얹고, 그룹 count 는 _n 을
//   합산, dealCountAll 을 신규로 응답에 싣는다. _w(랭킹·대표 apt_seq 선택)는 불변.
// ══════════════════════════════════════════════════════════════════════════
test('search /apt — 원본 거래 0건(deal_count:0)인 MV 행은 dealCount:0·dealCountAll 로 응답한다(1건을 지어내지 않는다)', async () => {
  const fixtureRow = {
    apt_name: 'PLAN107B2단독0건단지', sigungu: '노원구', umd_nm: '상계동', lawd_cd: '11350',
    build_year: 1995, recent_deal_date: '2020-01-01', deal_count: 0, deal_count_all: 146, apt_seq: 'PLAN107B2-SEQ-A',
  };
  const routes = [
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${fixtureRow.apt_name}%`, result: { data: [fixtureRow], error: null } },
  ];
  await _withSearchDbStub(routes, async (handler) => {
    const res = _mockRes();
    await handler({ query: { q: fixtureRow.apt_name, limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    const hit = res.body.results.find((r) => r.aptName === fixtureRow.apt_name);
    assert.ok(hit, `결과에 ${fixtureRow.apt_name} 이 없다: ${JSON.stringify(res.body.results)}`);
    assert.equal(hit.dealCount, 0, '원본 거래가 0건인데 dealCount 가 1로 지어내졌다(옛 _w 폴백 결함)');
    assert.equal(hit.dealCountAll, 146, 'dealCountAll(이력 포함 전체 건수)이 응답에 없거나 값이 다르다');
  });
});

test('search /apt — 원본 거래가 있는 단지는 종전과 동일하게 dealCount=dealCountAll=실거래수로 응답한다(회귀 없음)', async () => {
  const fixtureRow = {
    apt_name: 'PLAN107B2정상단지', sigungu: '강남구', umd_nm: '대치동', lawd_cd: '11680',
    build_year: 2001, recent_deal_date: '2026-08-01', deal_count: 59, deal_count_all: 59, apt_seq: 'PLAN107B2-SEQ-B',
  };
  const routes = [
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${fixtureRow.apt_name}%`, result: { data: [fixtureRow], error: null } },
  ];
  await _withSearchDbStub(routes, async (handler) => {
    const res = _mockRes();
    await handler({ query: { q: fixtureRow.apt_name, limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    const hit = res.body.results.find((r) => r.aptName === fixtureRow.apt_name);
    assert.ok(hit, `결과에 ${fixtureRow.apt_name} 이 없다: ${JSON.stringify(res.body.results)}`);
    assert.equal(hit.dealCount, 59);
    assert.equal(hit.dealCountAll, 59);
  });
});

test('search /apt — 같은 단지로 합쳐지는 두 MV 행은 dealCount·dealCountAll 을 각각 합산한다(그룹핑 회귀 없음)', async () => {
  const base = {
    apt_name: 'PLAN107B2합산단지', sigungu: '서초구', umd_nm: '반포동', lawd_cd: '11650', build_year: 2010,
  };
  const rowA = { ...base, recent_deal_date: '2026-05-01', deal_count: 3, deal_count_all: 3, apt_seq: 'PLAN107B2-SEQ-C1' };
  const rowB = { ...base, recent_deal_date: '2026-08-01', deal_count: 2, deal_count_all: 5, apt_seq: 'PLAN107B2-SEQ-C2' };
  const routes = [
    { table: 'molit_apt_index', col: 'apt_name', pattern: `%${base.apt_name}%`, result: { data: [rowA, rowB], error: null } },
  ];
  await _withSearchDbStub(routes, async (handler) => {
    const res = _mockRes();
    await handler({ query: { q: base.apt_name, limit: 10 } }, res, () => {});
    assert.equal(res.statusCode, 200);
    const hits = res.body.results.filter((r) => r.aptName === base.apt_name);
    assert.equal(hits.length, 1, `같은 단지 두 행이 그룹핑되지 않고 ${hits.length}개로 나왔다`);
    assert.equal(hits[0].dealCount, 5, 'dealCount 합산(3+2)이 틀렸다');
    assert.equal(hits[0].dealCountAll, 8, 'dealCountAll 합산(3+5)이 틀렸다');
    // 대표 apt_seq 는 seqCounts(그대로 _w 기반 가중치)가 가장 큰 행이 뽑힌다 — rowA(_w=3) > rowB(_w=2).
    //   이 선택 기준은 이번 변경(_n/_nAll 도입)과 무관하게 그대로여야 한다(랭킹 불변 확인).
    assert.equal(hits[0].aptSeq, rowA.apt_seq, '대표 apt_seq 선택(seqCounts, _w 기반)이 바뀌었다 — 랭킹 회귀');
  });
});
