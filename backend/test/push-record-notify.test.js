/**
 * backend/test/push-record-notify.test.js — RECORD-NOTIFY-2026-10-27: 관심 단지 알림에 "같은 면적 최고가 거래" 표시.
 *   정의는 get_price_records(2026-10-27 수정)와 같다: 같은 단지·같은 전용면적의 앞선 모든 거래 + 과거 이력 요약보다 높고, 이전 거래 3건 이상.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pn = require('../jobs/pushNotify');

function fakeAdmin({ rawMax, rawCount, histMx, histN, histError }) {
  const calls = [];
  return {
    calls,
    from(t) {
      const q = { _t: t, _f: {},
        select(_c, opt) { q._opt = opt; return q; },
        eq(k, v) { q._f[k] = v; return q; }, lt(k, v) { q._f['lt_' + k] = v; return q; },
        order() { return q; },
        limit() { calls.push(['raw', q._f]); return Promise.resolve({ data: rawMax == null ? [] : [{ deal_amount: rawMax }], count: rawCount, error: null }); },
        maybeSingle() { calls.push(['hist', q._f]); if (histError) return Promise.resolve({ data: null, error: histError }); return Promise.resolve({ data: histMx == null ? null : { mx: histMx, n: histN }, error: null }); },
      };
      return q;
    },
  };
}
const sub = [{ items: [{ aptName: '노원센트럴푸르지오', lawdCd: '11350', umdNm: '상계동' }] }];
const row = (amt, date = '2026-10-23') => ({ apt_name: '노원센트럴푸르지오', umd_nm: '상계동', lawd_cd: '11350', apt_seq: '11350-2275', exclu_use_ar: 84.99, deal_amount: amt, deal_date: date, ingested_at: '2026-10-27T00:00:00Z' });

test('앞선 원본 거래(10/14 11.545억)보다 낮으면 최고가 아님 — 10/23 11.30억', async () => {
  const r = row(113000); const a = fakeAdmin({ rawMax: 115450, rawCount: 7, histMx: 105300, histN: 9 });
  const out = await pn._markNewHighs(a, [r], sub, new Map());
  assert.equal(out.checked, 1); assert.equal(out.marked, 0); assert.equal(r._newHigh, undefined);
  assert.equal(a.calls[0][1].lt_deal_date, '2026-10-23', '그 거래 날짜보다 앞선 거래와 비교');
  assert.equal(a.calls[1][1].exclu_use_ar, 8499, '이력 요약은 면적×100 키');
});

test('원본·이력 최고보다 높고 이전 3건 이상이면 최고가 — 알림 제목·본문에 이전 최고를 함께', async () => {
  const r = row(116000); const a = fakeAdmin({ rawMax: 115450, rawCount: 7, histMx: 105300, histN: 9 });
  await pn._markNewHighs(a, [r], sub, new Map());
  assert.deepEqual(r._newHigh, { prevMan: 115450 });
  const entries = pn._matchItems(sub[0].items, [r], new Map(), new Date('2026-10-26T00:00:00Z'));
  assert.equal(entries[0].newHigh, true);
  assert.equal(pn._buildTitle(entries, ''), '관심 단지 같은 면적 최고가 거래');
  assert.equal(pn._buildBody(entries), '노원센트럴푸르지오 84.99㎡ 같은 면적 최고가 거래 신고 · 11억 6,000만 (이전 최고 11억 5,450만, 새 거래 1건)');
});

test('이전 거래 3건 미만이면 판정하지 않는다 · 관심 단지가 아닌 거래는 조회하지 않는다', async () => {
  const r = row(200000); const a = fakeAdmin({ rawMax: 100000, rawCount: 1, histMx: null });
  await pn._markNewHighs(a, [r], sub, new Map());
  assert.equal(r._newHigh, undefined);
  const other = { ...row(300000), apt_name: '다른단지' }; const b = fakeAdmin({ rawMax: 1, rawCount: 9 });
  const out = await pn._markNewHighs(b, [other], sub, new Map());
  assert.equal(out.checked, 0); assert.equal(b.calls.length, 0);
});

test('목표가 도달 알림이 최고가보다 앞선다(정렬 우선순위 유지)', () => {
  const s2 = [{ aptName: 'A', lawdCd: '11350', targetEok: 9 }, { aptName: '노원센트럴푸르지오', lawdCd: '11350' }];
  const rA = { apt_name: 'A', umd_nm: '', lawd_cd: '11350', deal_amount: 80000, ingested_at: '2026-10-27T00:00:00Z' };
  const rB = { ...row(116000), _newHigh: { prevMan: 115450 } };
  const e = pn._matchItems(s2, [rB, rA], new Map(), new Date('2026-10-26T00:00:00Z'));
  assert.equal(e[0].name, 'A'); assert.equal(e[0].hit, true); assert.equal(e[1].newHigh, true);
});

// ALIAS-EXACT-2026-10-27 / UMD-FILTER-2026-10-27 — 다른 동 비슷한 이름 단지 거래 혼입 차단(QA 실측: "상계주공7단지" 조회에 중계동 "주공7" 14건)
test('별칭 거래는 이름이 정확히 같은 것만 · 라우트는 별칭 경로 · 화면은 동을 넘긴다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { _filterExactAlias } = require('../services/transactionService');
  const arr = [{ aptName: '상계주공7(고층)' }, { aptName: '주공7' }, { aptName: '상계주공7 (고층)' }];
  assert.deepEqual(_filterExactAlias(arr, '상계주공7(고층)').map(t => t.aptName), ['상계주공7(고층)', '상계주공7 (고층)']);
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/transactions.js'), 'utf8'), /\? await getTransactionsByAptInclAliases\(lawdCd, aptName, _mb\)/);
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const fn = html.match(/function _umdFromArea\(area\)\{[^\n]*\}/)[0];
  const f = new Function(`${fn}; return _umdFromArea;`)();
  assert.equal(f('노원구 상계동'), '상계동'); assert.equal(f('중구 을지로3가'), '을지로3가'); assert.equal(f('노원구'), ''); assert.equal(f(''), '');
  assert.match(html, /fetchRecentTx\(lawdCd, apt, _umdFromArea\(area\)\)/);
  assert.match(html, /fetchRecentTx\(lawdCd, b\.aptName, b\.umdNm \|\| _umdFromArea\(b\.area\)\)/);
});

test('이력 요약 조회가 실패하면 최고가로 단정하지 않는다(Plan 180)', async () => {
  const r = row(116000); const a = fakeAdmin({ rawMax: 115450, rawCount: 7, histError: { message: 'boom' } });
  const out = await pn._markNewHighs(a, [r], sub, new Map());
  assert.equal(r._newHigh, undefined); assert.equal(out.marked, 0);
});

test('이력이 정말 없으면(오류 없음) 원본 기준으로 계속 판정한다(Plan 180)', async () => {
  const r = row(116000); const a = fakeAdmin({ rawMax: 115450, rawCount: 7, histMx: null });
  const out = await pn._markNewHighs(a, [r], sub, new Map());
  assert.deepEqual(r._newHigh, { prevMan: 115450 }); assert.equal(out.marked, 1);
});
