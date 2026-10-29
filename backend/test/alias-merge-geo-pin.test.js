/**
 * backend/test/alias-merge-geo-pin.test.js
 *
 * 2026-10-29 운영 실측(공릉풍림아이원 = 풍림아파트A 725번지 + 풍림아파트B 727번지) 회귀 고정.
 *   ① 별칭 거래를 "A 전부 → B 전부"로 이어 붙여 화면(앞 30건)에서 B 거래 8건이 통째로 빠졌다 → 계약일 최신순 정렬.
 *   ② 좌표 API 가 단지 코드 키(kapt:…) 좌표를 보지 않고 카카오 '지역' 주소 결과(동 중심점)를 단지 좌표로 답해
 *      핀이 본체에서 약 800m 떨어진 공릉동 한가운데 찍혔다 → 단지 코드 키 조회 + 지역 이름뿐 결과 거부.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('별칭 거래 병합 — 계약일 최신순 정렬·중복 제거(B 거래가 앞 30건에서 빠지지 않는다)', () => {
  const { _mergeAliasTx } = require('../services/transactionService');
  const tx = (aptName, y, m, d, ar, amt) => ({ aptName, dealYear: y, dealMonth: m, dealDay: d, excluUseAr: ar, floor: 5, dealAmount: amt });
  // 운영 응답 재현: A 31건(2026-10-02 ~ 2026-05-01) 뒤에 B 8건(2026-08-14 ~ 2026-05-09)
  const A = [];
  for (let i = 0; i < 31; i++) A.push(tx('풍림아파트A', 2026, 10 - Math.floor(i / 6), 28 - (i % 6) * 4, 59.94, 80000 + i));
  const B = [tx('풍림아파트B', 2026, 8, 14, 31.32, 31800), tx('풍림아파트B', 2026, 7, 3, 31.32, 30500)];
  const merged = _mergeAliasTx([A, B, [A[0]]]); // 마지막 배열은 중복 — 지워져야 한다
  assert.equal(merged.length, 33);
  const key = (t) => t.dealYear * 10000 + t.dealMonth * 100 + t.dealDay;
  for (let i = 1; i < merged.length; i++) assert.ok(key(merged[i - 1]) >= key(merged[i]), `정렬 깨짐 at ${i}`);
  const top30 = merged.slice(0, 30);
  assert.ok(top30.some((t) => t.aptName === '풍림아파트B' && t.dealMonth === 8 && t.dealDay === 14), '8/14 B 거래가 앞 30건에 있어야 한다');
  assert.deepEqual(_mergeAliasTx(null), []);
  assert.deepEqual(_mergeAliasTx([null, undefined]), []);
});

test('getTransactionsByAptInclAliases 는 병합 결과를 _mergeAliasTx 로 만든다(이어 붙이기 회귀 차단)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function getTransactionsByAptInclAliases'), src.indexOf('// (b) 지역 단위'));
  assert.match(body, /const merged = _mergeAliasTx\(aliasArrays\);/);
});

test('좌표 API — 지역 이름뿐인 주소 결과(동 중심점)는 단지 좌표로 받지 않는다', () => {
  const { _isRegionOnly } = require('../routes/geocode');
  assert.equal(_isRegionOnly({}, '서울 노원구 공릉동'), true);           // 운영 실측: 공릉풍림아이원 → 동 중심점
  assert.equal(_isRegionOnly({}, '서울 노원구'), true);
  assert.equal(_isRegionOnly({}, '서울 노원구 상계1동'), true);          // 숫자가 든 동 이름도 번지가 아니다
  assert.equal(_isRegionOnly({}, '서울 노원구 공릉동 725'), false);      // 번지 주소는 받는다
  assert.equal(_isRegionOnly({}, '경기 안양시 동안구 호계동 946-13'), false);
  assert.equal(_isRegionOnly({ place_name: '공릉풍림아파트' }, '서울 노원구 공릉동'), false); // 장소 결과는 기존 채점에 맡긴다
});

function withStubDb(tables, fn) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/geocodeCacheService');
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  const calls = [];
  const admin = {
    from(table) {
      const f = {};
      const q = {
        select() { return q; },
        eq(k, v) { f[k] = v; return q; },
        is(k, v) { f[k] = v; return q; },
        limit() { calls.push({ table, f: { ...f } }); return Promise.resolve({ data: tables[table](f) }); },
        maybeSingle() { calls.push({ table, f: { ...f } }); const r = tables[table](f); return Promise.resolve({ data: Array.isArray(r) ? (r[0] || null) : r }); },
      };
      return q;
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin, hasAdminEnv: () => true } };
  delete require.cache[svcPath];
  return Promise.resolve()
    .then(() => fn(require('../services/geocodeCacheService'), calls))
    .finally(() => {
      if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
      if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    });
}

test('좌표 캐시 — 이름 키가 없으면 같은 시군구·동의 단지 코드 키 좌표를 쓴다(공릉풍림아이원 재현)', async () => {
  const geocache = {
    'kapt:A13980513': { lat: '37.6291648', lng: '127.0668155', address: '서울 노원구 공릉동 725', place_name: '공릉풍림아파트', source: 'kakao-v' },
  };
  await withStubDb({
    apt_geocache: (f) => (f.apt_key ? (geocache[f.apt_key] || null) : null), // 이름 키·이름 조합은 없음(운영과 같음)
    apt_master: (f) => (f.apt_name === '공릉풍림아이원' && f.sigungu === '노원구' && f.umd_nm === '공릉동' ? [{ kapt_code: 'A13980513' }] : []),
  }, async (svc) => {
    const r = await svc.resolveCoordFromCacheOnly({ aptName: '공릉풍림아이원', sigungu: '노원구', umdNm: '공릉동' });
    assert.ok(r && Math.abs(r.lat - 37.6291648) < 1e-9 && Math.abs(r.lng - 127.0668155) < 1e-9, JSON.stringify(r));
    assert.equal(r.placeName, '공릉풍림아파트');
  });
});

test('좌표 캐시 — 같은 동에 같은 이름 단지가 둘이면 코드 키를 추측하지 않는다', async () => {
  await withStubDb({
    apt_geocache: () => null,
    apt_master: () => [{ kapt_code: 'A1' }, { kapt_code: 'A2' }],
  }, async (svc) => {
    assert.equal(await svc.resolveCoordFromCacheOnly({ aptName: '현대', sigungu: '노원구', umdNm: '상계동' }), null);
    assert.equal(await svc.getFromDbByMasterKapt({ aptName: '현대', sigungu: '노원구', umdNm: '' }), null); // 동 없으면 조회 안 함
  });
});

test('상세 헤더 평균가 — 전 평형 섞지 않고 거래 최다 평형만(공릉풍림 30건 재현), 라벨에 평형 표기', () => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const src = html.match(/function _repAreaOf\(tx\)\{[\s\S]*?\n\}/)[0];
  const f = new Function(`${src}; return _repAreaOf;`)();
  const t = (ar, n, m, d) => Array.from({ length: n }, () => ({ excluUseAr: ar, dealAmount: 80000, dealYear: 2026, dealMonth: m, dealDay: d }));
  // 운영 실측 구성: 31㎡ 5 · 60㎡ 16 · 85㎡ 7 · 115㎡ 2
  const tx = [...t(31.32, 5, 8, 14), ...t(59.94, 16, 9, 19), ...t(84.99, 7, 10, 2), ...t(114.78, 2, 7, 28)];
  assert.deepEqual(f(tx), { sqm: 60, py: 18, n: 16 });
  // 동률이면 가장 최근 거래의 평형
  assert.equal(f([...t(59.94, 3, 5, 1), ...t(84.99, 3, 9, 1)]).sqm, 85);
  assert.equal(f([]), null);
  assert.equal(f([{ excluUseAr: 0, dealAmount: 1 }]), null);
  assert.match(html, /_repArea \? `\$\{_repArea\.sqm\}㎡\(\$\{_repArea\.py\}평\) 최근 \$\{_repArea\.n\}건 평균`/);
  assert.doesNotMatch(html, /`전 평형 최근 \$\{txHistory\.length\}건 평균`/);
});

test('경신 목록 — 신고 원본 이름을 정식 이름으로(하늘(주공3) → 하늘아파트), 원본은 rawName, 대응표 실패 시 원본 그대로', async () => {
  const txPath = require.resolve('../services/transactionService');
  const routePath = require.resolve('../services/priceRecordsService');
  const saved = require.cache[txPath];
  const real = require('../services/transactionService');
  let fail = false;
  require.cache[txPath] = { id: txPath, filename: txPath, loaded: true, exports: { ...real, getAliasCanonicalMap: async (l) => {
    if (fail) throw new Error('DB 오류');
    assert.deepEqual(l.sort(), ['30140', '41390']);
    return new Map([['하늘(주공3)|중촌동', '하늘아파트']]);
  } } };
  delete require.cache[routePath];
  try {
    const { canonRecords: _canonRecords } = require('../services/priceRecordsService');
    const data = { high: [{ aptName: '동진', umdNm: '복현동', lawdCd: '41390' }], low: [{ aptName: '하늘(주공3)', umdNm: '중촌동', lawdCd: '30140' }], highCount: 1 };
    const out = await _canonRecords(data);
    assert.equal(out.low[0].aptName, '하늘아파트');
    assert.equal(out.low[0].rawName, '하늘(주공3)');
    assert.equal(out.high[0].aptName, '동진'); assert.equal(out.high[0].rawName, undefined);
    assert.equal(out.highCount, 1);
    fail = true;
    assert.deepEqual(await _canonRecords(data), data, '대응표 실패 시 원본 그대로');
    assert.deepEqual(await _canonRecords({ high: [], low: [] }), { high: [], low: [] });
  } finally {
    if (saved) require.cache[txPath] = saved; else delete require.cache[txPath];
    delete require.cache[routePath];
  }
});

test('지도 핀 — 동 번호만 다른 신고 이름(같은 동·같은 해·150m 안·공통 이름 3자+)은 공통 이름 핀 하나로', () => {
  const { _mergeNearDuplicateGroups: m } = require('../routes/search');
  const g = (n, lat, lng, by, c, src) => ({ aptName: n, umdNm: '죽전동', lat, lng, sum: c * 50000, n: c, source: src || 'molit', buildYear: by || 2001 });
  let r = m([g('한솔노블(104동)', 37.3200, 127.1000, 0, 2), g('한솔노블(105동)', 37.3205, 127.1003, 0, 1), g('한솔노블(101,102동)', 37.3203, 127.1001, 0, 3)]);
  assert.equal(r.length, 1); assert.equal(r[0].aptName, '한솔노블'); assert.equal(r[0].n, 6);
  assert.deepEqual(r[0]._mergedNames.sort(), ['한솔노블(101,102동)', '한솔노블(104동)', '한솔노블(105동)']);
  assert.equal(m([g('한솔노블(104동)', 37.32, 127.1, 0, 1), g('한솔노블(105동)', 37.33, 127.1, 0, 1)]).length, 2, '150m 밖은 합치지 않는다');
  assert.equal(m([g('우일(101동)', 37.32, 127.1, 0, 1), g('우일(102동)', 37.3201, 127.1, 0, 1)]).length, 2, '공통 이름 2자는 합치지 않는다');
  assert.equal(m([g('한솔노블(104동)', 37.32, 127.1, 2001, 1), g('한솔노블(105동)', 37.3201, 127.1, 2003, 1)]).length, 2, '건축년도 다르면 합치지 않는다');
  assert.equal(m([g('관저더샵2차', 37.32, 127.1, 0, 1), g('관저더샵', 37.3201, 127.1, 0, 1)]).length, 2, '기존 규칙(숫자 다르면 별개) 유지');
  const master = m([g('당정한솔솔파크', 37.32, 127.1, 2008, 5, 'master'), g('한솔솔파크(101,102동)', 37.3201, 127.1, 2008, 1)]);
  assert.equal(master[0].aptName, '당정한솔솔파크', '정식 단지 이름은 바꾸지 않는다');
});
