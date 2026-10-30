/**
 * Plan 172 (2026-10-30): 적재 뒤 해제된 거래 정리.
 *   전에는 국토부 응답에서 해제 거래를 걸러 넣지 않기만 해서, 이미 넣은 거래가 나중에 해제되면 원본에 남았다.
 *   이제 다시 받은 달에서 해제로 표시된 거래를 키 + 금액이 같을 때만 지운다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function item(o) {
  return Object.assign({ aptNm: '상계주공7(고층)', aptSeq: '11350-41', sggNm: '노원구', umdNm: '상계동', excluUseAr: '45.55',
    buildYear: '1988', floor: '7', dealYear: '2026', dealMonth: '1', dealDay: '29', dealAmount: '36,000', cdealType: '' }, o);
}

test('fetchRegionMonth — 해제 거래는 결과에 넣지 않고 canceled 로 따로 넘긴다(열거되지 않음)', async () => {
  const dgk = require('../services/dataGoKrClient');
  const orig = dgk.get;
  const items = [
    item({ cdealType: 'O', floor: '7' }),                               // 해제
    item({ floor: '11', dealAmount: '54,000' }),                         // 유효
  ];
  dgk.get = async () => ({ data: { response: { header: { resultCode: '000' }, body: { totalCount: 2, items: { item: items } } } } });
  try {
    const { fetchRegionMonth } = require('../jobs/molitIngest');
    const rows = await fetchRegionMonth('11350', '202601');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].floor, 11);
    assert.equal(rows.canceled.length, 1);
    assert.equal(rows.canceled[0].deal_amount, 36000);
    assert.deepEqual(Object.keys(rows), ['0'], 'canceled 가 열거되면 다른 호출처의 반복이 바뀐다');
  } finally { dgk.get = orig; }
});

// DB 흉내: 후보 조회(select … in apt_seq, deal_date 범위)는 rows 를, id 삭제는 지운 수를 돌려준다
function fakeAdmin(rows, { selectError } = {}) {
  const calls = [];
  return { calls, from(t) {
    const c = { table: t, ops: [] }; calls.push(c);
    const q = {
      select(cols) { c.ops.push(['select', cols]); return q; },
      delete(opt) { c.ops.push(['delete', opt]); return q; },
      in(k, v) { c.ops.push(['in', k, v]); return q; },
      gte(k, v) { c.ops.push(['gte', k, v]); return q; },
      lte(k, v) { c.ops.push(['lte', k, v]); return q; },
      then(res) {
        if (c.ops[0][0] === 'select') return res(selectError ? { error: selectError } : { data: rows, error: null });
        const ids = c.ops.find(o => o[0] === 'in')[2];
        return res({ error: null, count: rows.filter(r => ids.includes(r.id)).length });
      },
    };
    return q;
  } };
}
const row = (o) => Object.assign({ apt_seq: '11350-41', apt_name: 'x', umd_nm: '상계동', exclu_use_ar: 45.55,
  deal_year: 2026, deal_month: 1, deal_day: 29, deal_date: '2026-01-29', floor: 7, deal_amount: 36000 }, o);

test('_removeCanceled — 키·금액이 같은 행만 지우고, 같은 키의 유효 거래가 있으면 건너뛴다(조회 1회 + 삭제 1회)', async () => {
  const { _removeCanceled, _rowKey } = require('../jobs/molitIngest');
  const revived = row({ floor: 9 });
  const active = new Map([[_rowKey(revived), revived]]);
  const db = [
    Object.assign(row({}), { id: 1 }),                       // 지울 대상
    Object.assign(row({ deal_amount: 54000 }), { id: 2 }),   // 같은 키지만 금액이 다름 — 남긴다
    Object.assign(row({ floor: 9 }), { id: 3 }),             // 되살아난 거래 — 남긴다
    Object.assign(row({ floor: 11 }), { id: 4 }),            // 해제 목록에 없음 — 남긴다
  ];
  const admin = fakeAdmin(db);
  const n = await _removeCanceled(admin, [row({}), revived, row({ apt_seq: null })], active, '11350', '202601');
  assert.equal(n, 1);
  assert.equal(admin.calls.length, 2, '조회 1회 + 삭제 1회');
  assert.deepEqual(admin.calls[1].ops, [['delete', { count: 'exact' }], ['in', 'id', [1]]]);
});

test('_removeCanceled — 층 없음(null)은 키에서 0 으로 맞춘다 · 지울 게 없으면 삭제를 부르지 않는다 · 조회 실패는 0', async () => {
  const { _removeCanceled } = require('../jobs/molitIngest');
  const a1 = fakeAdmin([Object.assign(row({ floor: null }), { id: 7 })]);
  assert.equal(await _removeCanceled(a1, [row({ floor: null })], new Map(), '11350', '202601'), 1);
  const a2 = fakeAdmin([Object.assign(row({ floor: 3 }), { id: 8 })]);
  assert.equal(await _removeCanceled(a2, [row({})], new Map(), '11350', '202601'), 0);
  assert.equal(a2.calls.length, 1, '이미 지운 건(후보 0)이면 삭제 호출 없음');
  const a3 = fakeAdmin([], { selectError: { message: 'timeout' } });
  assert.equal(await _removeCanceled(a3, [row({})], new Map(), '11350', '202601'), 0);
});

test('fetchRegionMonth — 페이지 상한에서 잘린 응답이면 해제 정리를 하지 않는다', async () => {
  const dgk = require('../services/dataGoKrClient');
  const orig = dgk.get;
  const page = Array.from({ length: 1000 }, (_, k) => item({ floor: String(k % 15 + 1), dealDay: String(k % 28 + 1), cdealType: k === 0 ? 'O' : '' }));
  dgk.get = async () => ({ data: { response: { header: { resultCode: '000' }, body: { totalCount: 20000, items: { item: page } } } } });
  try {
    const { fetchRegionMonth } = require('../jobs/molitIngest');
    const rows = await fetchRegionMonth('11350', '202601');
    assert.equal(rows.canceled.length, 0);
  } finally { dgk.get = orig; }
});

test('적재 결과 canceledRemoved 가 health 로 올라간다(Plan 110 교훈: 최상위 키 + NUM 등록)', () => {
  const fs = require('fs'), path = require('path');
  const cron = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const stats = fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8');
  assert.match(cron, /canceledRemoved: summary\.canceledRemoved/);
  assert.match(stats, /'canceledRemoved'\]/);
});
