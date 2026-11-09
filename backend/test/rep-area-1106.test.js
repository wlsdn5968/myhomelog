/**
 * 2026-11-06 기능별 불일치 전수조사 후속. 지도와 인기 목록의 평균도 상세 헤더와 같은 대표 평형 규칙을 쓴다.
 * 운영 실측: 공릉풍림아이원 상세 8.12억, 지도 7.91억.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repAreaStats, sortRecentFirst } = require('../utils/repArea');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const tx = (d, ar, amt) => ({ deal_date: d, exclu_use_ar: ar, deal_amount: amt });

test('대표 평형: 최다 평형만 평균, 동률이면 최근 거래의 평형, 30건 밖은 보지 않는다', () => {
  const r = repAreaStats([tx('2026-10-08', 84.99, 98500), tx('2026-10-06', 31.32, 32000), tx('2026-10-02', 59.94, 80000), tx('2026-09-30', 59.94, 82000)]);
  assert.deepEqual(r, { sqm: 60, py: 18, n: 2, avg: 81000 });
  assert.equal(repAreaStats([tx('2026-10-08', 84.99, 90000), tx('2026-10-06', 59.94, 80000)]).sqm, 85);
  const old = Array.from({ length: 5 }, () => tx('2026-01-01', 31, 30000));
  const recent = Array.from({ length: 30 }, (_, i) => tx('2026-10-01', i < 16 ? 60 : 85, 80000));
  assert.equal(repAreaStats([...recent, ...old]).n, 16);
  assert.equal(repAreaStats([]), null);
  assert.equal(repAreaStats([tx('2026-10-01', null, 90000)]), null, '평형을 모르면 지어내지 않는다');
});

test('여러 신고 이름을 합친 뒤에도 최신순으로 본다', () => {
  const a = [tx('2026-09-01', 60, 1), tx('2026-07-01', 60, 1)];
  const b = [tx('2026-10-01', 31, 1)];
  assert.equal(repAreaStats(sortRecentFirst([...a, ...b])).n, 2);
  assert.equal(sortRecentFirst([...a, ...b])[0].exclu_use_ar, 31);
});

test('구별 순위도 같은 규칙이고 내부 거래 목록은 응답에 싣지 않는다', () => {
  const { rankLawd } = require('../services/regionPopularService');
  const row = (name, d, ar, amt) => ({ apt_name: name, sigungu: '노원구', umd_nm: '공릉동', lawd_cd: '11350', build_year: 2001, deal_date: d, deal_amount: amt, exclu_use_ar: ar });
  const [e] = rankLawd([row('풍림', '2026-10-08', 84.99, 98500), row('풍림', '2026-10-02', 59.94, 80000), row('풍림', '2026-09-30', 59.94, 82000)], new Map());
  assert.equal(e.avgDealAmount, 81000);
  assert.deepEqual(e.repArea, { sqm: 60, py: 18, n: 2 });
  assert.equal(e._rows, undefined);
});

test('인기 단지: 순위 밖 신고 이름까지 다시 세고, 평균은 대표 평형으로 낸다', async () => {
  const svcPath = require.resolve('../services/popularService');
  const txPath = require.resolve('../services/transactionService');
  const saved = require.cache[txPath];
  const actual = require('../services/transactionService');
  const amap = new Map([['풍림아파트A|공릉동', '공릉풍림아이원'], ['풍림아파트B|공릉동', '공릉풍림아이원']]);
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: { ...actual, getAliasCanonicalMapEach: async () => amap } };
  delete require.cache[svcPath];
  const today = new Date().toISOString().slice(0, 10);
  const row = (name, ar, amt) => ({ apt_name: name, sigungu: '노원구', umd_nm: '공릉동', build_year: 2001, deal_date: today, deal_amount: amt, exclu_use_ar: ar });
  const deals = [...Array.from({ length: 5 }, () => row('풍림아파트A', 59.94, 80000)), row('풍림아파트A', 84.99, 98000), ...Array.from({ length: 3 }, () => row('풍림아파트B', 31.32, 32000))];
  const names = [];
  const client = {
    rpc: (fn, args) => ({ abortSignal: () => {
      assert.equal(args.p_limit, 400);
      return Promise.resolve({ data: [{ aptName: '풍림아파트A', sigungu: '노원구', umdNm: '공릉동', lawdCd: '11350', buildYear: 2001, recentDealDate: today, dealCount60d: 6, avgDealAmount: 83000 }], error: null });
    } }),
    from: (t) => {
      if (t === 'apt_geocache') return { select: () => ({ in: () => Promise.resolve({ data: [{ apt_name: '풍림아파트A', sigungu: '노원구', umd_nm: '공릉동', lat: 37.6, lng: 127.0 }], error: null }) }) };
      const chain = {
        select: () => chain,
        in: (c, v) => { if (c === 'apt_name' && t === 'molit_transactions') names.push(...v); return chain; },
        gte: () => chain, order: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        range: () => Promise.resolve({ data: deals, error: null }),
      };
      return chain;
    },
  };
  try {
    const { buildPopularResults } = require('../services/popularService');
    const { results } = await buildPopularResults(1, { client });
    assert.ok(names.includes('풍림아파트B'), '순위에 없던 신고 이름도 읽는다');
    assert.equal(results[0].aptName, '공릉풍림아이원');
    assert.equal(results[0].dealCount60d, 9);
    assert.equal(results[0].avgDealAmount, 80000);
    assert.deepEqual(results[0].repArea, { sqm: 60, py: 18, n: 5 });
  } finally {
    if (saved) require.cache[txPath] = saved; else delete require.cache[txPath];
    delete require.cache[svcPath];
  }
});

test('해제 정리: 일일 적재가 오래된 달 하나를 돌아가며 더 받는다(가장 오래된 달은 뺀다)', () => {
  const { _cancelTailMonth: f } = require('../jobs/molitIngest');
  const seen = new Set();
  for (let d = 0; d < 12; d++) seen.add(f(d * 86400000));
  assert.equal(seen.size, 12, '12일에 한 바퀴');
  const now = new Date();
  const ym = (back) => { const x = new Date(now.getFullYear(), now.getMonth() - back, 1); return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}`; };
  for (let b = 3; b <= 14; b++) assert.ok(seen.has(ym(b)), `${b}개월 전`);
  assert.ok(!seen.has(ym(2)) && !seen.has(ym(15)));
  const src = fs.readFileSync(path.join(__dirname, '../jobs/molitIngest.js'), 'utf8');
  assert.match(src, /if \(!opts\.months && !offsetMonths && !onlySet\) months\.push\(cancelTailMonth\(\)\);/);
});

test('화면: 지도 팝업과 인기 목록이 어느 평형 값인지 적는다', () => {
  assert.match(html, /p\.repArea\.sqm\}㎡\(\$\{p\.repArea\.py\}평\) 최근 \$\{p\.repArea\.n\}건 평균`\):'전 평형 평균'/);
  assert.equal((html.match(/<small class="hp-ar">/g) || []).length, 2);
  assert.match(html, /\.hp-ar\{/);
  assert.match(html, /최근 60일 \$\{p\.repArea\.sqm\}㎡ 실거래 평균/);
});

test('지도 영역 조회 결과를 화면 목록에 옮길 때 평형 정보도 옮긴다(빠지면 팝업이 대표 평형 값에 "전 평형 평균" 이름표를 단다)', () => {
  const i = html.indexOf('async function loadAptsInBounds(');
  const body = html.slice(i, html.indexOf('renderMarkers(props);', i));
  assert.match(body, /repArea: p\.repArea \|\| null,/);
  // 화면이 실제로 쓰는 팝업 함수가 그 값을 읽어 이름표를 고른다
  assert.match(html, /\$\{p\.repArea\?_escHtml\(`\$\{p\.repArea\.sqm\}㎡/);
});

test('도우미: 지역과 공식 단지 이름을 함께 물어도 공식 단지 표를 시군구로 찾는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  assert.match(src, /_am\(\)\.ilike\('sigungu', `\$\{region\}%`\)\.ilike\('apt_name', `%\$\{name\}%`\)/);
});
