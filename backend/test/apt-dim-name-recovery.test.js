/**
 * backend/test/apt-dim-name-recovery.test.js
 *
 * DIM-RECOVERY-2026-09-26 (Plan 117): 협폭 이력에만 있는 단지 이름 복구 잡.
 * molit-hist-backfill.test.js 와 같은 기법 — require.cache 주입으로 admin(db/client)·
 * fetchRegionMonth/molitErrReason(molitIngest)을 스텁하고 runAptDimNameRecovery 를 실행한다.
 * DB 접근이 있는 시나리오는 **한 test() 안에서 순차 await** 한다 — require.cache 를 직접
 * 주고받는 스텁은 같은 모듈 경로를 여러 top-level test() 가 동시에 건드리면 서로 덮어쓸 수
 * 있어, 이 저장소는 그 위험을 등록조차 하지 않는 쪽을 택해왔다(molit-hist-backfill.test.js
 * 상단 주석과 동일한 이유).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── 스텁 admin — apt_dim_recovery_queue / molit_apt_dim / molit_transactions_hist 3개 테이블 ──
//   supabase-js 빌더는 체이닝되다 마지막 호출이 awaited 될 때 실행된다(postgrest-js thenable
//   관례) — molit-hist-backfill.test.js 의 스텁과 같은 형태.
function _makeAdmin({ queueRows = [], dimExisting = [], histRows = [], remainingCount = 0 } = {}) {
  const calls = { queueUpdates: [], dimUpserts: [], histQueries: [], dimExistsQueried: [] };
  const client = {
    from(table) {
      if (table === 'apt_dim_recovery_queue') {
        return {
          // select('*', {count:'exact', head:true}) → remaining 카운트(직접 awaited)
          // select('lawd_cd, deal_ym, apt_seqs') → 대상 목록(.eq().order().limit() 뒤에 awaited)
          select: (_cols, opts) => {
            if (opts && opts.head) {
              return { eq: async () => ({ data: null, count: remainingCount, error: null }) };
            }
            return {
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: queueRows, error: null }),
                }),
              }),
            };
          },
          update: (payload) => ({
            eq: (_c1, v1) => ({
              eq: async (_c2, v2) => {
                calls.queueUpdates.push({ payload, key: `${v1}|${v2}` });
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === 'molit_apt_dim') {
        return {
          select: () => ({
            in: async (_col, seqs) => {
              calls.dimExistsQueried.push(seqs);
              return { data: dimExisting.filter((s) => seqs.includes(s)).map((apt_seq) => ({ apt_seq })), error: null };
            },
          }),
          upsert: async (rows, opts) => {
            calls.dimUpserts.push({ rows, opts });
            return { error: null, count: undefined }; // count 미제공 — namesFound 가 길이로 대체되는 경로 확인용
          },
        };
      }
      if (table === 'molit_transactions_hist') {
        return {
          select: () => ({
            in: (_col, seqs) => ({
              order: () => ({
                order: () => ({
                  range: async (from) => {
                    calls.histQueries.push({ seqs, from });
                    if (from > 0) return { data: [], error: null };
                    return { data: histRows.filter((r) => seqs.includes(r.apt_seq)), error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error('apt-dim-name-recovery 테스트 스텁: 예상 밖 테이블 ' + table);
    },
  };
  return { client, calls };
}

// require.cache 주입 — molitHistBackfill.test.js 의 _runWithStubs 와 동일한 관례.
async function _runWithStubs(opts, admin, fetchImpl, errReasonImpl) {
  const jobPath = require.resolve('../jobs/aptDimNameRecovery');
  const ingestPath = require.resolve('../jobs/molitIngest');
  const clientPath = require.resolve('../db/client');
  const paths = [jobPath, ingestPath, clientPath];
  const saved = {};
  for (const p of paths) saved[p] = require.cache[p];
  const stub = (p, exportsObj) => { require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj }; };
  stub(ingestPath, { fetchRegionMonth: fetchImpl, molitErrReason: errReasonImpl || ((e) => (e && e.message) || 'unknown') });
  stub(clientPath, { requireSupabaseAdmin: () => admin });
  delete require.cache[jobPath];
  try {
    const { runAptDimNameRecovery } = require(jobPath);
    return await runAptDimNameRecovery(opts);
  } finally {
    for (const p of paths) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; }
  }
}

function rawRow({ apt_seq, apt_name, deal_date, lawd_cd = '11680', sigungu = '강남구', umd_nm = '개포동', jibun = '12-3', build_year = 1998 }) {
  return { apt_seq, apt_name, lawd_cd, sigungu, umd_nm, jibun, build_year, deal_date, exclu_use_ar: 84.97, floor: 5, deal_amount: 150000 };
}

test('runAptDimNameRecovery — 스텁 admin 시나리오: dim payload 계약 · 실패 격리/연속중단 · 시간예산', async () => {
  // ① dim upsert payload 계약: 키 정확히 10개 · do-nothing 옵션 · 이미 dim 에 있는 apt_seq 는 제외(기존행 불변)
  //    · 같은 응답 안 같은 apt_seq 는 최신 거래일 값 채택.
  {
    const queueRows = [{ lawd_cd: '11680', deal_ym: '202503', apt_seqs: 2 }];
    const fetchImpl = async (lawdCd, ym) => {
      assert.equal(lawdCd, '11680'); assert.equal(ym, '202503');
      return [
        rawRow({ apt_seq: '11680-1', apt_name: '구이름아파트', deal_date: '2025-03-01' }),
        rawRow({ apt_seq: '11680-1', apt_name: '새이름아파트', deal_date: '2025-03-10' }), // 최신 거래일 — 이 값이 채택돼야 한다
        rawRow({ apt_seq: null, apt_name: '식별불가', deal_date: '2025-03-05' }),          // apt_seq 없음 — 버려져야 한다
        rawRow({ apt_seq: '11680-9', apt_name: '이미있음아파트', deal_date: '2025-03-03' }), // dim 에 이미 존재 — upsert 대상에서 빠져야 한다
      ];
    };
    const histRows = [
      { apt_seq: '11680-1', deal_date: '2024-01-01' },
      { apt_seq: '11680-1', deal_date: '2024-06-15' },
      { apt_seq: '11680-1', deal_date: '2025-03-10' },
      { apt_seq: '11680-9', deal_date: '2025-03-03' }, // 대조군 — 11680-9 는 upsert payload 에 들어가면 안 된다
    ];
    const { client, calls } = _makeAdmin({ queueRows, dimExisting: ['11680-9'], histRows, remainingCount: 0 });
    const res = await _runWithStubs({}, client, fetchImpl);

    assert.equal(calls.dimUpserts.length, 1, 'molit_apt_dim upsert 가 정확히 1회 호출돼야 한다');
    const { rows, opts } = calls.dimUpserts[0];
    assert.equal(rows.length, 1, '이미 dim 에 있는 11680-9 는 upsert 대상에서 빠져야 한다');
    const row = rows[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'apt_name', 'apt_seq', 'build_year', 'deal_count', 'first_deal_date',
      'jibun', 'last_deal_date', 'lawd_cd', 'sigungu', 'umd_nm',
    ].sort(), 'dim upsert payload 키가 계획서와 다르다');
    assert.equal(row.apt_seq, '11680-1');
    assert.equal(row.apt_name, '새이름아파트', '같은 응답 안 같은 apt_seq 는 최신 거래일(deal_date) 값을 채택해야 한다');
    assert.equal(row.lawd_cd, '11680');
    assert.equal(row.sigungu, '강남구');
    assert.equal(row.umd_nm, '개포동');
    assert.equal(row.build_year, 1998);
    assert.equal(row.jibun, '12-3');
    assert.equal(row.first_deal_date, '2024-01-01');
    assert.equal(row.last_deal_date, '2025-03-10');
    assert.equal(row.deal_count, 3);
    assert.ok(!rows.some((r) => r.apt_seq === '11680-9'), '기존 dim 행(11680-9)의 값을 다시 만들면 안 된다 — do-nothing 계약');

    // on conflict (apt_seq) do nothing 계약 — 기존 22,672행을 절대 덮지 않는다는 성질을 옵션 자체로 고정.
    assert.equal(opts.onConflict, 'apt_seq');
    assert.equal(opts.ignoreDuplicates, true, 'ignoreDuplicates:true(=on conflict do nothing) 가 아니다 — 기존 dim 행을 덮어쓸 위험');

    // 큐 갱신 — ok · names_found 는 count 가 없으면(스텁이 undefined 반환) 후보 수로 대체된다.
    assert.equal(calls.queueUpdates.length, 1);
    assert.equal(calls.queueUpdates[0].payload.status, 'ok');
    assert.equal(calls.queueUpdates[0].payload.names_found, 1);
    assert.equal(res.processed, 1); assert.equal(res.ok, 1); assert.equal(res.err, 0);
    assert.equal(res.namesInserted, 1);
  }

  // ② fetch 실패 — 그 큐 행만 error 로 가고 다음 행은 정상 진행한다(격리).
  {
    const queueRows = [
      { lawd_cd: '11111', deal_ym: '202501', apt_seqs: 1 },
      { lawd_cd: '22222', deal_ym: '202502', apt_seqs: 1 },
    ];
    let call = 0;
    const fetchImpl = async () => { call++; if (call === 1) throw new Error('MOLIT 네트워크 오류(테스트)'); return []; };
    const { client, calls } = _makeAdmin({ queueRows, remainingCount: 0 });
    const res = await _runWithStubs({}, client, fetchImpl);

    assert.equal(res.processed, 2); assert.equal(res.ok, 1); assert.equal(res.err, 1);
    assert.equal(calls.queueUpdates.length, 2);
    assert.equal(calls.queueUpdates[0].payload.status, 'error');
    assert.ok(calls.queueUpdates[0].payload.error_message.includes('MOLIT 네트워크 오류'));
    assert.equal(calls.queueUpdates[1].payload.status, 'ok', '첫 행 실패가 둘째 행 처리를 막으면 안 된다');
  }

  // ③ 연속 실패 5회 — 남은 큐를 두들기지 않고 이번 회차를 끝낸다.
  {
    const queueRows = Array.from({ length: 8 }, (_, i) => ({ lawd_cd: String(10000 + i), deal_ym: '202501', apt_seqs: 1 }));
    let calledCount = 0;
    const fetchImpl = async () => { calledCount++; throw new Error('MOLIT 쿼터 소진(테스트)'); };
    const { client, calls } = _makeAdmin({ queueRows, remainingCount: 3 });
    const res = await _runWithStubs({}, client, fetchImpl);

    assert.equal(calledCount, 5, '연속 5회 실패 뒤엔 fetch 를 더 호출하면 안 된다');
    assert.equal(res.processed, 5); assert.equal(res.err, 5); assert.equal(res.ok, 0);
    assert.equal(calls.queueUpdates.length, 5, '처리하지 않은 나머지 3행은 갱신되면 안 된다');
  }

  // ④ 시간 예산 — timeBudgetMs:0 이면 첫 행을 끝낸 직후 멈추고, 남은 행은 pending 으로 남는다.
  //    remaining 은 큐 전체(별도 count 쿼리) 값을 그대로 전달해야 한다(가짜 0 으로 지어내지 않음).
  {
    const queueRows = [
      { lawd_cd: '11111', deal_ym: '202501', apt_seqs: 1 },
      { lawd_cd: '22222', deal_ym: '202502', apt_seqs: 1 },
    ];
    const fetchCalls = [];
    const fetchImpl = async (lawdCd, ym) => { fetchCalls.push([lawdCd, ym]); return []; };
    const { client } = _makeAdmin({ queueRows, remainingCount: 1737 });
    const res = await _runWithStubs({ timeBudgetMs: 0 }, client, fetchImpl);

    assert.equal(fetchCalls.length, 1, '예산 0 이면 정확히 1개만 처리하고 멈춰야 한다');
    assert.equal(res.processed, 1);
    assert.equal(res.budgetHit, true);
    assert.equal(res.remaining, 1737, 'remaining 이 큐 전체 pending 카운트 쿼리 결과와 다르다');
    assert.equal(typeof res.elapsedMs, 'number');
  }
});

// ── cron.js 배선 — hist 핸들러가 잡 호출을 정확히 1회만 가진다 ────────────────────
//   [왜] runAptDimNameRecovery 호출이 실수로 두 번(예: 요약 로그 찍는 곳에서 다시 부르는 등)
//   들어가면 같은 회차에 큐를 이중으로 소비하거나 시간 예산을 두 배로 쓴다. cron 인증 배선
//   테스트(cron-observability.test.js)와 같은 부류 — 형태를 소스에서 직접 고정한다.
test('cron.js — hist 핸들러가 runAptDimNameRecovery 를 정확히 1회 호출한다(POST/GET 각각, 있다면)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');

  const fnStart = src.indexOf('async function handleMolitHistBackfill(');
  assert.ok(fnStart >= 0, 'handleMolitHistBackfill 함수를 찾지 못했다 — cron.js 구조가 바뀌었다');
  const fnEnd = src.indexOf('module.exports', fnStart);
  assert.ok(fnEnd > fnStart, 'handleMolitHistBackfill 뒤에서 module.exports 를 찾지 못했다');
  const fnBody = src.slice(fnStart, fnEnd);

  const callMatches = fnBody.match(/\brunAptDimNameRecovery\(\{/g) || [];
  assert.equal(callMatches.length, 1, `hist 핸들러 안의 runAptDimNameRecovery 호출이 ${callMatches.length}회 — 정확히 1회여야 한다(큐 이중 소비 방지)`);
  const requireMatches = fnBody.match(/require\('\.\.\/jobs\/aptDimNameRecovery'\)/g) || [];
  assert.equal(requireMatches.length, 1, 'aptDimNameRecovery require 가 1회가 아니다');

  // 이 핸들러에 실제로 물린 라우트들 — 계획서는 "POST/GET 쌍둥이가 있으면 둘 다" 라고 조건부로
  // 요구했다. 2026-09-26 실측: 이 cron 은 GET 전용이다(warm-interest/warm-rent 와 같은 형태 —
  // vercel.json 이 GET 으로만 호출한다). 같은 함수를 공유하는 한(아래 라우트 배선) 위 "1회" 단언이
  // GET 에도 POST 에도(추가된다면) 그대로 적용된다.
  const getBound = /router\.get\('\/molit-hist-backfill',\s*handleMolitHistBackfill\);/.test(src);
  assert.ok(getBound, "GET /molit-hist-backfill 이 handleMolitHistBackfill 에 물려 있지 않다");
  const postBound = /router\.post\('\/molit-hist-backfill',\s*handleMolitHistBackfill\);/.test(src);
  assert.equal(postBound, false,
    '주의: POST /molit-hist-backfill 쌍둥이가 새로 생겼다 — 계획서 규칙대로 이 라우트도 같은 핸들러를 ' +
    '공유하는지(=위 1회 계약이 그대로 유지되는지) 확인했다면 이 줄의 기대값을 true 로 갱신할 것.');
});
