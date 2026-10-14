/**
 * PARALLEL-2026-10-14 (Plan 140): /region/:lawdCd 의 독립 조회(대시보드·경신·주간 공개 건수·주요 단지)를
 * Promise.all 로 묶어도 **결과 HTML 이 같고, 한 조회가 throw 해도 200 HTML 이 나온다**는 것을 고정한다.
 *
 * [이 테스트의 성격 — 회귀 방지용]
 *   '결과가 같다'·'한 의존이 실패해도 200' 단언은 직렬이던 수정 전 코드에서도 통과한다(= 병렬화가 동작을
 *   바꾸지 않았음을 지키는 회귀 방지용). 병렬화 자체를 확인하는 것은 마지막 테스트(4개 조회가 모두 시작된 뒤에야
 *   첫 조회가 끝난다)뿐이며 이것만 수정 전 코드에서 실패한다. 호출 순서가 아니라 결과 HTML 의 핵심 값을 본다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const regionPageRouter = require('../routes/regionPage');
const regionRoutes = require('../routes/region');
const priceSvc = require('../services/priceRecordsService');
const dbClient = require('../db/client');

const handle = (() => {
  const layer = regionPageRouter.stack.find(l => l.route && l.route.path === '/:lawdCd');
  assert.ok(layer, '/:lawdCd 라우트를 못 찾았다');
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();

const DASH = {
  txTrend: { months: [{ ym: '202609', n: 4321 }], source: '국토교통부 실거래 신고' },
  priceIndex: { months: [{ ym: '202609', sale: 101.7 }], source: 'R-ONE' },
  unsold: { latest: { cnt: 777, ym: '202608' }, source: 'KOSIS' },
  netMigration: { latest: { net: -555, ym: '202608' }, source: 'KOSIS' },
};
const REC = { windowDays: 30, highCount: 11, lowCount: 3, comparedCount: 99, sinceDate: '2026-09-01', minPrior: 3, high: [], low: [] };
const APT_ROWS = [{ apt_seq: '11680-1', apt_name: '테스트단지가나다', umd_nm: '대치동', build_year: 2001, deal_count: 50 }];

/** getSupabaseAdmin 가짜 — molit_transactions(count 쿼리)와 molit_apt_index(단지 목록)를 구분해 답한다. */
function fakeAdmin({ weeklyCount = 1234, weeklyThrows = false, aptsThrows = false, onStart, delayMs = 0 } = {}) {
  const wait = () => new Promise(r => setTimeout(r, delayMs));
  return {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, gte() { return q; }, limit() { return q; },
        then(resolve, reject) {
          onStart && onStart(table);
          wait().then(() => {
            if (table === 'molit_transactions') {
              if (weeklyThrows) throw new Error('weekly boom');
              return { count: weeklyCount, error: null };
            }
            if (aptsThrows) throw new Error('apts boom');
            return { data: APT_ROWS, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

async function render({ dashFails = false, recFails = false, weeklyThrows = false, aptsThrows = false, onStart, delays = {} } = {}) {
  const saved = {
    build: regionRoutes.buildDashboard, get: priceSvc.getPriceRecordsByRegion, slice: priceSvc.sliceRegion, admin: dbClient.getSupabaseAdmin,
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms || 0));
  try {
    regionRoutes.buildDashboard = async () => { onStart && onStart('dash'); await sleep(delays.dash); if (dashFails) throw new Error('dash boom'); return DASH; };
    priceSvc.getPriceRecordsByRegion = async () => { onStart && onStart('rec'); await sleep(delays.rec); if (recFails) throw new Error('rec boom'); return { fake: true }; };
    priceSvc.sliceRegion = () => REC;
    dbClient.getSupabaseAdmin = () => fakeAdmin({ weeklyThrows, aptsThrows, onStart, delayMs: delays.db });
    const res = { code: 200, headers: {}, html: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, type() { return this; }, send(b) { this.html = b; return this; } };
    await handle({ params: { lawdCd: '11680' } }, res, (e) => { throw e || new Error('next 호출'); });
    return res;
  } finally {
    regionRoutes.buildDashboard = saved.build; priceSvc.getPriceRecordsByRegion = saved.get; priceSvc.sliceRegion = saved.slice; dbClient.getSupabaseAdmin = saved.admin;
  }
}

const MARK = {
  dash: '4,321건',            // 월별 실거래 건수 카드
  rec: '최고가 경신',          // 경신 카드 문장
  weekly: '1,234',            // 최근 7일 새로 공개된 실거래
  apts: '테스트단지가나다',     // 주요 단지 링크
};

test('회귀 방지용 — 네 조회가 모두 성공하면 HTML 에 네 조회의 핵심 값이 모두 들어간다 (완료 순서가 거꾸로여도 동일)', async () => {
  const a = await render({});
  const b = await render({ delays: { dash: 30, rec: 20, db: 10 } });   // 완료 순서를 뒤집는다
  for (const r of [a, b]) {
    assert.equal(r.code, 200);
    for (const [k, v] of Object.entries(MARK)) assert.ok(r.html.includes(v), `${k} 값(${v})이 HTML 에 없다`);
  }
  assert.equal(b.html, a.html, '완료 순서가 달라졌다고 HTML 이 달라지면 안 된다');
});

test('회귀 방지용 — 한 조회가 throw 해도 200 HTML 이고 나머지 값은 그대로 나온다', async () => {
  const cases = [
    ['dash', { dashFails: true }],
    ['rec', { recFails: true }],
    ['weekly', { weeklyThrows: true }],
    ['apts', { aptsThrows: true }],
  ];
  for (const [failed, opts] of cases) {
    const r = await render(opts);
    assert.equal(r.code, 200, `${failed} 실패에도 200 이어야 한다`);
    assert.ok(typeof r.html === 'string' && r.html.includes('<html'), `${failed} 실패 시 HTML 이 안 나왔다`);
    for (const [k, v] of Object.entries(MARK)) {
      assert.equal(r.html.includes(v), k !== failed, `${failed} 실패: ${k} 값(${v}) 포함 여부가 틀렸다`);
    }
  }
});

test('병렬화 확인 — 네 조회(대시보드·경신·주간 공개·주요 단지)가 겹쳐 실행된다 (수정 전 직렬 코드에서는 실패)', async () => {
  const started = [];
  await render({ onStart: (n) => started.push(n), delays: { dash: 40, rec: 40, db: 40 } });
  // 직렬이면 dash 가 끝나기 전에 rec 가 시작되지 않는다 — 시작 기록은 4개 모두 있어야 하고,
  // 첫 40ms 안에 전부 시작됐는지는 총 소요 시간으로 본다(직렬이면 4×40=160ms 이상).
  assert.deepEqual([...new Set(started)].sort(), ['dash', 'molit_apt_index', 'molit_transactions', 'rec']);
  const t0 = Date.now();
  await render({ delays: { dash: 60, rec: 60, db: 60 } });
  const ms = Date.now() - t0;
  assert.ok(ms < 60 * 4 - 20, `조회가 직렬로 보인다: ${ms}ms (병렬이면 ≈60ms, 직렬이면 ≥240ms)`);
});
