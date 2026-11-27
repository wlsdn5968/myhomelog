/**
 * VERIFY-SCOPE-1127 (plans/214 방안 A): 좌표 주소 재확인을 다시 하는 주기를 source 별로 둔다.
 *  이미 통과한 kakao-v 는 30일 지난 것만, kakao, kakao-sub, kakao-addr 는 7일 지난 것만. 통과 전 행을 먼저 집는다.
 *  손 보정(manual)과 숨김(kakao-x)은 대상이 아니다. 재확인 단계의 CPU 를 verifyCpuMs 로 따로 남긴다.
 * 실행: cd backend && TZ=UTC node --test test/geocache-verify-scope-1127.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const job = require('../jobs/geocacheBackfill');

// 체인을 기록하는 가짜 Supabase. apt_geocache select 는 source 묶음마다 정해 둔 행을 range 에 맞춰 돌려준다.
function fakeAdmin(rowsBySourceKey) {
  const calls = [];
  const admin = {
    from(table) {
      const q = { table, ops: [], kind: 'select' };
      calls.push(q);
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (res, rej) => Promise.resolve(answer(q)).then(res, rej);
          }
          return (...args) => {
            q.ops.push([prop, ...args]);
            if (prop === 'update') q.kind = 'update';
            return chain;
          };
        },
      });
      return chain;
    },
  };
  function answer(q) {
    if (q.kind === 'update') return { data: null, error: null };
    if (q.table !== 'apt_geocache') return { data: [], error: null };
    const src = q.ops.find((o) => o[0] === 'in' && o[1] === 'source');
    const rng = q.ops.find((o) => o[0] === 'range');
    const all = rowsBySourceKey[src[2].join(',')] || [];
    return { data: all.slice(rng[1], rng[2] + 1), error: null };
  }
  return { admin, calls };
}
const row = (k) => ({ apt_key: k, apt_name: '시험', sigungu: null, umd_nm: null, lat: 37.5, lng: 127, place_name: null, address: null });

test('대상 조회: 통과 전 묶음(7일)을 먼저, 통과한 묶음(30일)을 그다음에. 잠긴 출처는 넣지 않는다', async () => {
  const { admin, calls } = fakeAdmin({ 'kakao,kakao-sub,kakao-addr': [row('a'), row('b')], 'kakao-v': [row('c')] });
  const t0 = Date.now();
  const out = await job._verifyByOfficialAddress(admin, { cap: 4000, budgetMs: 5000 });
  const sel = calls.filter((c) => c.table === 'apt_geocache' && c.kind === 'select');
  assert.equal(sel.length, 2, '묶음마다 한 쪽(행이 적어 첫 쪽에서 끝남)');
  const srcOf = (c) => c.ops.find((o) => o[0] === 'in')[2];
  assert.deepEqual(srcOf(sel[0]), ['kakao', 'kakao-sub', 'kakao-addr']);
  assert.deepEqual(srcOf(sel[1]), ['kakao-v']);
  for (const c of sel) for (const s of srcOf(c)) assert.ok(!['manual', 'kakao-x'].includes(s), '잠긴 출처는 대상 아님');
  const ltDays = (c) => { const o = c.ops.find((x) => x[0] === 'lt'); assert.equal(o[1], 'cached_at'); return (t0 - Date.parse(o[2])) / 86400000; };
  assert.ok(Math.abs(ltDays(sel[0]) - 7) < 0.01, '통과 전 행은 7일 지난 것');
  assert.ok(Math.abs(ltDays(sel[1]) - 30) < 0.01, '통과한 행은 30일 지난 것');
  // 정렬은 종전 그대로(cached_at 오래된 순, apt_key)
  for (const c of sel) {
    const ords = c.ops.filter((o) => o[0] === 'order').map((o) => o[1]);
    assert.deepEqual(ords, ['cached_at', 'apt_key']);
  }
  assert.equal(out.rows, 3);
  assert.equal(out.skippedNoAddr, 3, '주소가 없는 시험 행은 건너뛰고');
  const touched = calls.filter((c) => c.kind === 'update').length;
  assert.equal(touched, 3, '진행 보장: 건너뛴 행도 cached_at 을 갱신한다(종전 동작)');
});

test('cap 이 차면 두 번째 묶음을 읽지 않고, 쪽 크기는 남은 칸까지만', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => row('o' + i));
  const { admin, calls } = fakeAdmin({ 'kakao,kakao-sub,kakao-addr': many, 'kakao-v': [row('v')] });
  const out = await job._verifyByOfficialAddress(admin, { cap: 1200, budgetMs: 1 });
  const sel = calls.filter((c) => c.table === 'apt_geocache' && c.kind === 'select');
  assert.equal(out.rows, 1200);
  assert.deepEqual(sel.map((c) => c.ops.find((o) => o[0] === 'range').slice(1)), [[0, 999], [1000, 1199]]);
  assert.ok(sel.every((c) => c.ops.find((o) => o[0] === 'in')[2][0] === 'kakao'), 'kakao-v 묶음은 읽지 않음');
});

test('첫 묶음이 cap 을 못 채우면 두 번째 묶음은 0 쪽부터 여러 쪽을 남은 칸만큼 읽는다(반증 검토 지적 B)', async () => {
  const other = Array.from({ length: 300 }, (_, i) => row('o' + i));
  const passed = Array.from({ length: 1500 }, (_, i) => row('v' + i));
  const { admin, calls } = fakeAdmin({ 'kakao,kakao-sub,kakao-addr': other, 'kakao-v': passed });
  const out = await job._verifyByOfficialAddress(admin, { cap: 1600, budgetMs: 1 });
  const sel = calls.filter((c) => c.table === 'apt_geocache' && c.kind === 'select');
  const rg = sel.map((c) => [c.ops.find((o) => o[0] === 'in')[2][0], ...c.ops.find((o) => o[0] === 'range').slice(1)]);
  assert.deepEqual(rg, [['kakao', 0, 999], ['kakao-v', 0, 999], ['kakao-v', 1000, 1299]]);
  assert.equal(out.rows, 1600, '300 + 1,000 + 300');
});

test('대상이 0행이면 바로 끝나고 아무것도 갱신하지 않는다', async () => {
  const { admin, calls } = fakeAdmin({});
  const out = await job._verifyByOfficialAddress(admin, { cap: 4000, budgetMs: 5000 });
  assert.equal(out.rows, 0);
  assert.equal(calls.filter((c) => c.kind === 'update').length, 0);
});

test('배선: 주기 값, 재확인 CPU 기록, 통계 키(마지막 항목은 canceledRemoved 그대로)', () => {
  assert.deepEqual({ ...job.VERIFY_RECHECK_DAYS }, { passed: 30, other: 7 });
  const g = fs.readFileSync(path.join(__dirname, '../jobs/geocacheBackfill.js'), 'utf8');
  assert.match(g, /const _vCpu0 = process\.cpuUsage\(\);\r?\n\s*try \{ addrVerify = await verifyByOfficialAddress\(admin, \{ cap: 4000, budgetMs: 120000 \}\); \}/);
  assert.match(g, /verifyRows: addrVerify\.rows, verifyCpuMs,/);
  const cs = fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8');
  assert.match(cs, /'verifyFast', 'verifyRows',[\s\S]*?'verifyCpuMs',/);
  assert.match(cs, /'canceledRemoved'\];/);
});
