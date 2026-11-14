/**
 * AUDIT4-1114: 가짜 푸시 구독 정리(retention.runFakePushPrune).
 * 실제 단지와 맞는 항목이 하나라도 있으면 남기고(알림 매칭과 같은 이름 정규화, 별칭 포함),
 * 조회가 하나라도 실패하면 아무것도 지우지 않으며, 단지 목록이 빈 지역의 항목은 맞음으로 본다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFakePushPrune } = require('../jobs/retention');

function makeAdmin({ subs, index, master, failTable }) {
  const deleted = [];
  const calls = { createdLt: 0, isNull: 0 };
  const from = (table) => {
    const q = { _f: {} };
    q.select = () => q;
    q.lt = () => { calls.createdLt++; return q; };
    q.is = () => { calls.isNull++; return q; };
    q.limit = () => Promise.resolve({ data: subs, error: null });
    q.eq = (c, v) => { q._f[c] = v; return q; };
    q.range = (a) => {
      if (table === failTable) return Promise.resolve({ data: null, error: { message: 'boom' } });
      const all = (table === 'molit_apt_index' ? index : master).filter((r) => r.lawd_cd === q._f.lawd_cd);
      return Promise.resolve({ data: all.slice(a, a + 1000), error: null });
    };
    q.delete = () => { q._del = true; return q; };
    q.in = (c, v) => { if (q._del) { deleted.push(...v); return Promise.resolve({ count: v.length, error: null }); } return q; };
    return q;
  };
  return { from, deleted, calls };
}

const subs = [
  { id: 1, items: [{ lawdCd: '11350', aptName: '없는단지A' }] },                       // 가짜
  { id: 2, items: [{ lawdCd: '11350', aptName: '공릉 풍림 아이원' }] },                 // 공백 차이(정규화로 맞음)
  { id: 3, items: [] },                                                                 // 항목 없음 = 가짜
  { id: 4, items: [{ lawdCd: '11680', aptName: '별칭이름' }] },                          // 마스터 별칭으로 맞음
  { id: 5, items: [{ lawdCd: '41135', aptName: '아무거나' }] },                          // 단지 목록이 빈 지역 = 남김
];
const index = [{ lawd_cd: '11350', apt_name: '공릉풍림아이원' }];
const master = [{ lawd_cd: '11680', apt_name: '정식이름', molit_aliases: ['별칭이름'] }];

test('실제 단지와 맞는 항목이 없는 구독만 지운다(정규화, 별칭, 빈 지역 보호)', async () => {
  const admin = makeAdmin({ subs, index, master });
  const r = await runFakePushPrune(admin);
  assert.equal(r.error, null);
  assert.deepEqual(admin.deleted.sort(), [1, 3]);
  assert.equal(r.fakePushPruned, 2);
  assert.equal(admin.calls.isNull, 0, '알림 이력(last_notified_at) 조건은 쓰지 않는다');
});

test('조회가 하나라도 실패하면 아무것도 지우지 않는다', async () => {
  const admin = makeAdmin({ subs, index, master, failTable: 'apt_master' });
  const r = await runFakePushPrune(admin);
  assert.ok(r.error);
  assert.deepEqual(admin.deleted, []);
});
