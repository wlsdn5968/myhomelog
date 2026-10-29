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
