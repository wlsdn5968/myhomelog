/**
 * backend/test/geocache-name-heal.test.js — NAME-HEAL-2026-10-22: 근거 없는 키워드 좌표 재검색(2026-10-21 전수 514건).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { strictAptMatch } = require('../services/geocodeCacheService');
const job = require('../jobs/geocacheBackfill');

const D = (place, cat, addr, y = '37.49', x = '126.92') => ({ place_name: place, category_name: cat, address_name: addr, y, x });
const APT = '부동산 > 주거시설 > 아파트';

test('엄격 판정: 카테고리 아파트 + 장소 이름에 단지 이름 + 지번 주소에 시군구·동', () => {
  const q = { aptName: '엘리스', sigungu: '동작구', umdNm: '신대방동' };
  assert.equal(strictAptMatch(D('엘리스아파트', APT, '서울 동작구 신대방동 600'), q), true);
  assert.equal(strictAptMatch(D('앨리스성수동수제화', '쇼핑 > 패션', '서울 동작구 사당동 86-9'), q), false, '가게');
  assert.equal(strictAptMatch(D('엘리스아파트', APT, '서울 동작구 사당동 86-9'), q), false, '동이 다르면 거부');
  const q2 = { aptName: '인계푸르지오', sigungu: '수원시팔달구', umdNm: '인계동' };
  assert.equal(strictAptMatch(D('수원인계푸르지오아파트', APT, '경기 수원시 팔달구 인계동 1122', '37.27', '127.03'), q2), true);
  assert.equal(strictAptMatch(D('매교역푸르지오SKVIEW아파트', APT, '경기 수원시 팔달구 매교동 300', '37.27', '127.02'), q2), false, '다른 단지');
  assert.equal(strictAptMatch(D('수원인계푸르지오주상복합 정문', '교통,수송 > 입출구', '경기 수원시 팔달구 인계동 1122'), q2), false, '출입구는 아파트 카테고리가 아님');
});

test('짧은 이름(2글자 이하)은 정확히 같아야 — 청암 ↔ 청암빌라트 거부 · 읍면 동은 마지막 낱말로 대조', () => {
  const q = { aptName: '청암', sigungu: '서초구', umdNm: '방배동' };
  assert.equal(strictAptMatch(D('청암빌라트', APT, '서울 서초구 방배동 1000'), q), false);
  assert.equal(strictAptMatch(D('청암아파트', APT, '서울 서초구 방배동 1000'), q), true);
  const q3 = { aptName: '봉담자이라젠느', sigungu: '화성시효행구', umdNm: '봉담읍 동화리' };
  assert.equal(strictAptMatch(D('봉담자이라젠느', APT, '경기 화성시 효행구 봉담읍 동화리 100', '37.2', '126.9'), q3), true);
});

test('대상 판정·대체 표시: 장소 이름에 단지 이름이 없는 kakao·kakao-sub 만 대상 · 못 찾으면 주거시설 이름은 유지(u), 가게는 핀 제외(x)', () => {
  const U = job._isUntrustedNameCoord, F = job._healFallbackSource;
  assert.equal(U({ source: 'kakao', apt_name: '엘리스', place_name: '앨리스성수동수제화' }), true);
  assert.equal(U({ source: 'kakao', apt_name: '상계현대1차', place_name: '상계현대1차 아파트' }), false);
  assert.equal(U({ source: 'kakao-v', apt_name: '엘리스', place_name: '앨리스성수동수제화' }), false, '검증된 출처는 대상 아님');
  assert.equal(U({ source: 'kakao-sub', apt_name: '산본세종', place_name: '세종통신' }), true);
  assert.equal(F('앨리스성수동수제화'), 'kakao-x');
  assert.equal(F('동원택시'), 'kakao-x');
  assert.equal(F('세종통신'), 'kakao-x');
  assert.equal(F('문정동궁리치웰아파트 102동'), 'kakao-u');
  assert.equal(F('상지리츠빌8차아파트'), 'kakao-u');
});

test('배선: 매일 좌표 작업에 재검색 단계(400건·40초) · 통계 키 · 핀 3곳에서 kakao-x 제외', () => {
  const g = fs.readFileSync(path.join(__dirname, '../jobs/geocacheBackfill.js'), 'utf8');
  assert.match(g, /nameHeal = await rehealUntrustedNames\(admin, \{ cap: 400, budgetMs: 40000 \}\);/);
  assert.match(g, /nameHealTried: nameHeal\.tried, nameHealHealed: nameHeal\.healed/);
  assert.match(fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8'), /'nameHealTried', 'nameHealHealed', 'nameHealKept', 'nameHealHidden', 'nameHealLeft',/);
  // Plan 176 C(2026-10-30): 지도 영역 좌표는 DB 함수 geocache_in_bounds 가 거래 많은 순으로 고르고, kakao-x 제외도 그 함수 안에 있다.
  const _sr = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(_sr, /admin\.rpc\('geocache_in_bounds'/);
  assert.match(_sr, /if \(c\.source === 'kakao-x' \|\| c\.lat == null \|\| c\.lng == null\) continue;/, '본체(kapt:) 좌표 직접 조회도 kakao-x 를 뺀다');
  assert.match(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261030_geocache_in_bounds.sql'), 'utf8'), /AND g\.source IS DISTINCT FROM 'kakao-x'/);
  assert.match(fs.readFileSync(path.join(__dirname, '../services/popularService.js'), 'utf8'), /if \(c\.source === 'kakao-x'\) continue; \/\/ NAME-HEAL-2026-10-22/);
  const rp = require('../services/regionPopularService');
  assert.equal(rp.trustedCoord({ lat: 37.5, lng: 127, source: 'kakao-x', place_name: 'x' }, 'x'), false);
  assert.equal(rp.trustedCoord({ lat: 37.5, lng: 127, source: 'kakao-n' }, '엘리스'), true);
});

test('믿을 수 없는 좌표(kakao-x): 단건·배치는 좌표 없음(카카오 재검색·재저장 없음), /api/geocode 는 "위치 확인 중"', async () => {
  const dbc = require('../db/client');
  const cache = require('../cache');
  const orig = dbc.getSupabaseAdmin, origEnv = dbc.hasAdminEnv;
  const writes = [];
  const row = { apt_key: 'name:엘리스|동작구|신대방동', lat: 37.48, lng: 126.98, address: '서울 동작구 사당동 86-9', place_name: '앨리스성수동수제화', source: 'kakao-x' };
  const chain = () => { const q = {
    select() { return q; }, eq() { return q; }, is() { return q; }, limit() { return q; },
    in() { return Promise.resolve({ data: [row], error: null }); },
    maybeSingle() { return Promise.resolve({ data: row, error: null }); },
    upsert(v) { writes.push(v); return Promise.resolve({ error: null }); },
  }; return q; };
  try {
    dbc.getSupabaseAdmin = () => ({ from: chain });
    dbc.hasAdminEnv = () => true; // 모듈이 불러올 때 DB 사용 여부를 고정하므로 가짜로 켜고 다시 불러온다(안 켜면 모든 경로가 null 로 헛통과)
    for (const k of cache.keys()) if (String(k).startsWith('geo-db:')) cache.del(k);
    delete require.cache[require.resolve('../services/geocodeCacheService')];
    const g = require('../services/geocodeCacheService');
    const apt = { aptName: '엘리스', sigungu: '동작구', umdNm: '신대방동' };
    const co0 = await g.resolveCoordFromCacheOnly(apt);
    assert.equal(co0 && co0.untrusted, true, 'DB 경로를 실제로 탔는지 먼저 확인');
    assert.equal(await g.resolveCoord(apt), null);
    assert.deepEqual(await g.resolveCoordBatch([apt]), [null]);
    const co = await g.resolveCoordFromCacheOnly(apt);
    assert.equal(co && co.untrusted, true);
    assert.equal(writes.length, 0, '재저장하지 않는다');
    const r = fs.readFileSync(path.join(__dirname, '../routes/geocode.js'), 'utf8');
    assert.match(r, /if \(fromDb && fromDb\.untrusted\) return res\.json\(\{ lat: null, lng: null, error: '위치 확인 중' \}\);/);
    assert.match(r, /if \(fromDb && fromDb\.untrusted\) return \{ id, lat: null, lng: null \};/);
  } finally {
    dbc.getSupabaseAdmin = orig; dbc.hasAdminEnv = origEnv;
    for (const k of cache.keys()) if (String(k).startsWith('geo-db:')) cache.del(k);
    delete require.cache[require.resolve('../services/geocodeCacheService')];
  }
});
