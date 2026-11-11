/**
 * AUDIT2-BR-1111 (보안 점검 run-2, properties-building-register-six-sequential-molit-calls-per-miss) 회귀 검사.
 *  - 단지 이름만 바꿔 요청해도 국토부 호출이 늘지 않는다((지역, 월) 응답을 기억한다)
 *  - 공개 경로는 인스턴스당 1시간 호출 수가 묶인다. 예약 작업 경로는 묶이지 않는다
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const dgk = require('../services/dataGoKrClient');
const dim = require('../services/aptDimService');
const svc = require('../services/buildingRegisterService');

function emptyAdmin() {
  const chain = { select: () => chain, eq: () => chain, not: () => chain, limit: () => chain, then: (res) => res({ data: [] }) };
  return { from: () => chain };
}
function withStubs(fn) {
  const origGet = dgk.get, origFind = dim.findByName, origKey = process.env.MOLIT_API_KEY;
  const calls = [];
  dgk.get = async (url, opts) => {
    calls.push(`${opts.params.LAWD_CD}|${opts.params.DEAL_YMD}`);
    return { data: { response: { body: { items: { item: [
      { aptNm: '가나다아파트', umdNm: '시험동', jibun: '12-3', sggNm: '시험구' },
      { aptNm: '지번없는단지', umdNm: '시험동', jibun: '', sggNm: '시험구' },
    ] } } } } };
  };
  dim.findByName = async () => null;
  process.env.MOLIT_API_KEY = 'test-key';
  svc._brMonth.clear(); svc._brLive.hour = 0; svc._brLive.n = 0;
  return fn(calls).finally(() => {
    dgk.get = origGet; dim.findByName = origFind;
    if (origKey === undefined) delete process.env.MOLIT_API_KEY; else process.env.MOLIT_API_KEY = origKey;
    svc._brMonth.clear(); svc._brLive.hour = 0; svc._brLive.n = 0;
  });
}

test('없는 이름을 바꿔 가며 물어도 같은 지역의 국토부 호출은 6회에서 늘지 않는다', () => withStubs(async (calls) => {
  const admin = emptyAdmin();
  for (let i = 0; i < 20; i++) {
    assert.equal(await svc.resolveJibun(admin, '11680', '시험동', `없는단지${i}`, { limited: true }), null);
  }
  assert.equal(calls.length, 6, `호출 ${calls.length}회`);
  assert.equal(new Set(calls).size, 6, '같은 (지역, 월)을 두 번 불렀다');
}));

test('기억한 응답에서도 단지를 찾아 지번을 돌려주고, 지번 없는 행은 고르지 않는다', () => withStubs(async (calls) => {
  const admin = emptyAdmin();
  const a = await svc.resolveJibun(admin, '11680', '시험동', '가나다아파트', { limited: true });
  assert.deepEqual(a, { jibun: '12-3', sigungu: '시험구', umdNm: '시험동' });
  assert.equal(calls.length, 1, '첫 달에서 찾았으면 더 부르지 않는다');
  const b = await svc.resolveJibun(admin, '11680', '시험동', '가나다아파트', { limited: true });
  assert.deepEqual(b, a);
  assert.equal(calls.length, 1, '두 번째는 기억한 응답으로 답한다');
  assert.equal(await svc.resolveJibun(admin, '11680', '시험동', '지번없는단지', { limited: true }), null);
}));

test('공개 경로는 1시간 호출 수가 묶이고, 예약 작업 경로는 묶이지 않는다', () => withStubs(async (calls) => {
  const admin = emptyAdmin();
  const regions = Array.from({ length: 30 }, (_, i) => String(11000 + i * 10));
  for (const r of regions) await svc.resolveJibun(admin, r, '', '없는단지', { limited: true });
  assert.equal(calls.length, svc.BR_LIVE_PER_HOUR, `공개 경로 호출 ${calls.length}회가 한도 ${svc.BR_LIVE_PER_HOUR} 와 다르다`);
  const before = calls.length;
  await svc.resolveJibun(admin, '99990', '', '없는단지'); // 예약 작업과 보고서 경로(limited 없음)
  assert.equal(calls.length, before + 6, '내부 경로까지 막혔다');
}));

test('공개 라우트가 limited 를 넘긴다', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/properties.js'), 'utf8');
  assert.match(src, /aptName: String\(apt\)\.slice\(0, 80\),\r?\n\s+limited: true,/);
});
