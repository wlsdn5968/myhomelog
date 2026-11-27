/**
 * REPORT-POOL-1127 (plans/213 2단계): 보고서 후보 풀을 구별 거래 기억(getRegionRecentTransactions)으로 만들 때
 *  종전 조회(_newPageQuery: 면적, 가격, 시작일, lawd_cd 목록, deal_date desc, id desc, 상한 POOL_MAX)와 같은 결과인지.
 *  원본 행에 SQL 과 같은 조건과 순서를 적용한 기대값과, 실제 매핑 코드(getRegionRecentTransactions)를 거친 결과를 견준다.
 * 실행: cd backend && TZ=UTC node --test test/report-pool-region-1127.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const report = require('../routes/report');

const SELECT_COLS = ['apt_name', 'sigungu', 'umd_nm', 'lawd_cd', 'build_year', 'exclu_use_ar', 'deal_amount', 'deal_date', 'apt_seq', 'jibun'];

// 작은 결정적 난수(검사가 매번 같은 자료를 쓰게)
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// 구 셋, 날짜 동점이 구를 넘나들고, id 는 구와 무관하게 섞이게 만든다.
// 날짜는 실행하는 날의 시작일(txWindowStart(6)) 기준으로 만든다: 한 달 앞(창 밖)부터 다섯 달 뒤까지. 날이 지나도 검사가 비지 않게.
const SINCE = require('../utils/txWindow').txWindowStart(6);
function ymd(offsetMonths, day) {
  const d = new Date(Date.UTC(Number(SINCE.slice(0, 4)), Number(SINCE.slice(5, 7)) - 1 + offsetMonths, day));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), s: d.toISOString().slice(0, 10) };
}
function makeRaw(seed, perGu = 700) {
  const r = rng(seed);
  const gus = ['11110', '11140', '11170'];
  const raw = [];
  let id = 1;
  const ids = Array.from({ length: gus.length * perGu }, () => id++).sort(() => r() - 0.5);
  let k = 0;
  for (const g of gus) {
    for (let i = 0; i < perGu; i++) {
      const dt = ymd(-1 + Math.floor(r() * 6), 1 + Math.floor(r() * 3)); // 창 밖 한 달 포함, 날짜를 몰아 동점을 많이 만든다
      raw.push({
        id: ids[k++], apt_name: `단지${Math.floor(r() * 40)}`, sigungu: `구${g}`, umd_nm: `동${Math.floor(r() * 5)}`,
        exclu_use_ar: Math.round((40 + r() * 100) * 100) / 100, build_year: 1990 + Math.floor(r() * 30), floor: 1 + Math.floor(r() * 20),
        deal_year: dt.y, deal_month: dt.m, deal_day: dt.d, deal_date: dt.s,
        deal_amount: 30000 + Math.floor(r() * 90000), lawd_cd: g, apt_seq: `${g}-${i}`, jibun: `${1 + Math.floor(r() * 900)}`,
      });
    }
  }
  return { gus, raw };
}

// 종전 조회와 같은 뜻: 조건으로 거르고 deal_date desc, id desc 로 정렬, 상한까지, select 열만
function expectedPool(raw, codes, o) {
  return raw
    .filter((t) => codes.includes(t.lawd_cd) && t.exclu_use_ar >= o.minSqm && t.exclu_use_ar <= o.maxSqm
      && t.deal_amount >= o.minAmt && t.deal_amount <= o.maxAmt && t.deal_date >= o.since)
    .sort((a, b) => (a.deal_date < b.deal_date ? 1 : a.deal_date > b.deal_date ? -1 : b.id - a.id))
    .slice(0, o.max)
    .map((t) => Object.fromEntries(SELECT_COLS.map((c) => [c, t[c]])));
}

// 실제 getRegionRecentTransactions 를 가짜 DB 로 돌린다(검사 frontend-contracts 의 TX-PAGE-PAR 와 같은 주입 방식).
//   가짜 DB 는 eq('lawd_cd'), gte('deal_date') 를 지키고 deal_date desc, id desc 로 정렬해 range 로 자른다.
async function viaRegionCache(raw, codes, since) {
  const dbPath = require.resolve('../db/client');
  const txPath = require.resolve('../services/transactionService');
  const saved = { db: require.cache[dbPath], tx: require.cache[txPath] };
  const q = () => {
    const st = { lawd: null, since: null };
    const s = {
      select() { return s; }, order() { return s; },
      eq(c, v) { if (c === 'lawd_cd') st.lawd = v; return s; },
      gte(c, v) { if (c === 'deal_date') st.since = v; return s; },
      range(a, b) {
        const rows = raw.filter((t) => t.lawd_cd === st.lawd && t.deal_date >= st.since)
          .sort((x, y) => (x.deal_date < y.deal_date ? 1 : x.deal_date > y.deal_date ? -1 : y.id - x.id));
        return Promise.resolve({ data: rows.slice(a, b + 1), error: null });
      },
    };
    return s;
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { hasAdminEnv: () => true, getSupabaseAdmin: () => ({ from: () => q() }) } };
  try {
    delete require.cache[txPath];
    const { getRegionRecentTransactions } = require('../services/transactionService');
    const cache = require('../cache');
    for (const c of codes) cache.del(`txregion:${c}:6`);
    const perGu = await Promise.all(codes.map((c) => getRegionRecentTransactions(c, 6)));
    for (const c of codes) cache.del(`txregion:${c}:6`);
    return perGu;
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.tx) require.cache[txPath] = saved.tx; else delete require.cache[txPath];
  }
}

test('같은 원본에서 종전 조회와 같은 행, 같은 순서(구를 넘나드는 날짜 동점 포함)', async () => {
  const since = require('../utils/txWindow').txWindowStart(6);
  for (const seed of [1, 7, 42]) {
    const { gus, raw: data } = makeRaw(seed);
    const perGu = await viaRegionCache(data, gus, since);
    assert.ok(perGu.every((x) => Array.isArray(x)), '세 구 모두 받았다');
    for (const o of [
      { minSqm: 0, maxSqm: 999, minAmt: 45500, maxAmt: 78000 },
      { minSqm: 76, maxSqm: 109, minAmt: 35000, maxAmt: 120000 },
      { minSqm: 50, maxSqm: 75, minAmt: 30000, maxAmt: 60000 },
    ]) {
      const opts = { ...o, since, max: 12000 };
      const got = report._poolFromRegionRows(perGu, opts);
      const exp = expectedPool(data, gus, opts);
      assert.ok(exp.length > 100, '견줄 행이 충분하다(검사가 비어서 통과하지 않게)');
      assert.ok(got, '이 자료는 빈 값이 없어 기억 경로를 탄다');
      assert.deepEqual(got.rows, exp, `seed ${seed} ${JSON.stringify(o)}: 종전 조회와 다르다`);
      assert.equal(got.complete, exp.length < 12000);
    }
  }
});

test('상한에서 자를 때도 종전과 같은 앞부분이고 complete 는 false(상한과 같으면 종전도 false)', async () => {
  // 기억은 자기 규칙(txWindowStart(6))으로 거른 행만 담으므로 풀의 시작일도 같은 값이어야 한다(실제 호출부도 같은 _sinceDate).
  const since = require('../utils/txWindow').txWindowStart(6);
  const { gus, raw } = makeRaw(3);
  const perGu = await viaRegionCache(raw, gus, since);
  const o = { minSqm: 0, maxSqm: 999, minAmt: 0, maxAmt: 999999, since, max: 500 };
  const got = report._poolFromRegionRows(perGu, o);
  assert.deepEqual(got.rows, expectedPool(raw, gus, o));
  assert.equal(got.rows.length, 500);
  assert.equal(got.complete, false);
  const exact = report._poolFromRegionRows(perGu, { ...o, max: expectedPool(raw, gus, { ...o, max: 1e9 }).length });
  assert.equal(exact.complete, false, '상한과 정확히 같으면 다음 쪽 유무를 모르는 종전 판정과 같게 false');
});

test('경계값은 종전 조회처럼 양끝을 포함하고, 달이 바뀌기 전에 담긴 기억의 옛 행은 시작일로 거른다', () => {
  const base = { aptName: 'a', sigungu: 's', umdNm: 'u', lawdCd: '11110', aptSeq: 'q', jibun: '1', buildYear: 2000 };
  const o = { minSqm: 76, maxSqm: 109, minAmt: 45500, maxAmt: 78000, since: '2026-06-01', max: 12000 };
  const rows = [
    { ...base, id: 1, excluUseAr: 76, dealAmount: 45500, dealDate: '2026-06-01' },     // 모든 하한 경계: 포함
    { ...base, id: 2, excluUseAr: 109, dealAmount: 78000, dealDate: '2026-07-01' },    // 모든 상한 경계: 포함
    { ...base, id: 3, excluUseAr: 75.99, dealAmount: 50000, dealDate: '2026-07-01' },  // 면적 아래: 제외
    { ...base, id: 4, excluUseAr: 80, dealAmount: 45499, dealDate: '2026-07-01' },     // 가격 아래: 제외
    { ...base, id: 5, excluUseAr: 80, dealAmount: 78001, dealDate: '2026-07-01' },     // 가격 위: 제외
    { ...base, id: 6, excluUseAr: 109.01, dealAmount: 50000, dealDate: '2026-07-01' }, // 면적 위: 제외
    { ...base, id: 7, excluUseAr: 80, dealAmount: 50000, dealDate: '2026-05-31' },     // 지난달에 담긴 옛 행: 제외
  ];
  const got = report._poolFromRegionRows([rows], o);
  assert.deepEqual(got.rows.map((r) => r.deal_date + '/' + r.deal_amount), ['2026-07-01/78000', '2026-06-01/45500']);
});

test('같다고 장담할 수 없으면 null(종전 조회로 간다)', () => {
  const ok = { id: 1, aptName: 'a', sigungu: 's', umdNm: 'u', lawdCd: '11110', aptSeq: 'q', jibun: '1', buildYear: 2000, excluUseAr: 84, dealAmount: 50000, dealDate: '2026-07-01' };
  const o = { minSqm: 0, maxSqm: 999, minAmt: 0, maxAmt: 1e9, since: '2026-06-01', max: 12000 };
  assert.ok(report._poolFromRegionRows([[ok]], o));
  assert.equal(report._poolFromRegionRows([[ok], null], o), null, '구 하나를 못 받음');
  assert.equal(report._poolFromRegionRows([new Array(12000).fill(ok)], o), null, '구 하나가 12,000행(기억이 잘렸을 수 있음)');
  for (const k of ['id', 'dealDate', 'sigungu', 'umdNm', 'aptSeq', 'jibun', 'buildYear', 'excluUseAr', 'dealAmount']) {
    const bad = { ...ok, [k]: k === 'id' ? undefined : (typeof ok[k] === 'number' ? 0 : '') };
    assert.equal(report._poolFromRegionRows([[ok, bad]], o), null, `${k} 가 비면 쓰지 않는다`);
  }
});

test('지역 적용 함수에서 lawd_cd 목록만 읽는다(in 하나일 때만)', () => {
  const L = report._lawdCodesOfRegionOp;
  assert.deepEqual(L((qq) => qq.in('lawd_cd', ['11110', '11140'])), ['11110', '11140']);
  assert.equal(L((qq) => qq.like('sigungu', '%서구%')), null, '이름 like 는 기억 경로가 아니다');
  assert.equal(L(null), null, '지역 필터 없음(전국)');
  assert.equal(L((qq) => qq.in('lawd_cd', ['11110']).eq('x', 1)), null, '다른 조건이 섞이면 아니다');
  assert.equal(L((qq) => qq.in('lawd_cd', [])), null);
});

test('배선: 지역 판정 분기는 그대로이고, 기억 경로는 25구 이하에서만, 종전 조회는 그 밖에서 그대로 돈다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');
  assert.match(src, /const _poolCodes = _lawdCodesOfRegionOp\(_regionOp\);\r?\n\s*if \(_poolCodes && _poolCodes\.length <= 25\) \{/);
  assert.match(src, /getRegionRecentTransactions\(c, 6\)/);
  assert.match(src, /if \(_poolVia === 'query'\) \{\r?\n\s*\/\/ ① 첫 페이지 단독/);
  assert.match(src, /if \(_poolVia !== 'query'\) break;/);
  assert.match(src, /_st\.mark\('pool'\);\r?\n\s*if \(_poolVia === 'region'\) _st\.mark\('poolViaRegion'\);/);
  const tx = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  const body = tx.slice(tx.indexOf('async function getRegionRecentTransactions('), tx.indexOf('async function getTransactions('));
  assert.match(body, /\.select\('id, apt_name, [^']*\bdeal_date\b[^']*'\)/);
  assert.match(body, /id: r\.id, dealDate: r\.deal_date/);
  // 반증 검토 지적(확인됨): 단지 찾기 응답의 txHistory 가 원본 행을 그대로 실어 새 필드가 새어 나갔다. 빼고 싣는다.
  const ps = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.match(ps, /txHistory: \(apt\.rawList \|\| \[\]\)\.map\(\(\{ id: _id, dealDate: _dd, \.\.\.t \}\) => t\),/);
  assert.equal(/txHistory: apt\.rawList \|\| \[\],/.test(ps), false);
});

test('단지 찾기 응답 모양은 종전 그대로: 원본 행의 id, dealDate 를 빼고 나머지 필드는 그대로', () => {
  const strip = ({ id: _id, dealDate: _dd, ...t }) => t; // propertyService 의 txHistory 매핑과 같은 식
  const row = { aptName: 'a', dealAmount: 1, jibun: '1', id: 5, dealDate: '2026-07-01' };
  assert.deepEqual(strip(row), { aptName: 'a', dealAmount: 1, jibun: '1' });
  assert.equal(row.id, 5, '기억의 행은 바꾸지 않는다(새 객체)');
});
