/**
 * backend/test/public-key-surface.test.js
 *
 * PUBLIC-KEY-SURFACE-2026-10-02 (Plan 132 = Plan 129 2단계 코드) — 공개 키(publishable) 노출면 축소.
 *
 * [배경] 공개 키는 프런트 메타 태그에 공개돼 있다. 백엔드의 검색·지도·인기 라이브 집계가 그 키로 원본
 * 거래·단지·좌표·검색 색인을 읽었기 때문에 그 테이블들에 공개 읽기 권한이 필요했고, 누구나 같은 키로
 * Supabase REST 를 직접 불러 우리 레이트리밋 밖에서 대량 조회할 수 있었다. 이 경로들을 service_role 로
 * 옮겨야 DB 쪽 공개 읽기 권한을 닫을 수 있다(plans/129 §4). DB 권한을 닫은 뒤 누가 이 경로를 공개 키로
 * 되돌리면 조회가 42501 로 실패한다 — 그 회귀를 여기서 막는다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('search.js — 공개 데이터 조회는 service_role(getSupabaseAdmin), 사용자 소유 행(search_history)은 userScopedClient', () => {
  const src = read('routes/search.js');
  assert.match(src, /const adminClient = \(\) => getSupabaseAdmin\(\);/,
    'search.js 의 adminClient 가 service_role 이 아니다 — DB 공개 읽기 권한을 닫으면 검색·지도가 42501 로 실패한다');
  assert.equal((src.match(/getSupabaseReadonly\(/g) || []).length, 0,
    'search.js 가 공개 키 클라이언트(getSupabaseReadonly)를 다시 호출한다');
  assert.equal((src.match(/userScopedClient\(req\.accessToken\)/g) || []).length, 3,
    'search_history 3곳(저장·조회·삭제)은 사용자 토큰 클라이언트(RLS)여야 한다 — service_role 로 바꾸면 남의 기록을 읽고 쓸 수 있다');
  assert.equal((src.match(/\.from\('search_history'\)/g) || []).length, 3);
});

// popularService 를 추적용 스텁 클라이언트로 불러 어느 역할이 무엇을 불렀는지 기록한다.
function _withTrackedClients(fn) {
  const clientPath = require.resolve('../db/client');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], g: require.cache[geoPath], s: require.cache[svcPath] };
  const used = [];
  const make = (role) => ({
    rpc: (name) => ({ abortSignal: async () => { used.push(`${role}:rpc:${name}`); return { data: null, error: { message: 'stub' } }; } }),
    from: (table) => {
      used.push(`${role}:from:${table}`);
      const chain = {
        select: () => chain, gte: () => chain, order: () => chain, eq: () => chain,
        range: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseReadonly: () => make('anon'), getSupabaseAdmin: () => make('service_role') } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: { resolveCoordBatch: async () => [] } };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require('../services/popularService'), used)).finally(() => {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  });
}

test('popularService — 라이브 집계(사용자 경로 기본값)는 service_role 로 RPC·원본을 읽고 공개 키를 쓰지 않는다', async () => {
  await _withTrackedClients(async ({ buildPopularResults }, used) => {
    const { results, usedFallback } = await buildPopularResults(12); // opts.client 없음 = /api/search/popular 라이브 경로
    assert.deepEqual(results, []);
    assert.equal(usedFallback, true, '스텁 RPC 는 실패하므로 폴백 경로까지 타야 한다(두 조회 모두 검사)');
    assert.ok(used.includes('service_role:rpc:search_popular_apts'), `집계 RPC 가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(used.includes('service_role:from:molit_transactions'), `폴백의 원본 조회가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(!used.some((u) => u.startsWith('anon:')), `라이브 집계가 공개 키를 썼다 — DB 공개 읽기 권한을 닫으면 실패한다: ${used.join(' ')}`);
  });
});

test('popularService — 스냅샷 읽기(작은 공개 테이블)는 종전대로 공개 키', async () => {
  await _withTrackedClients(async ({ readPopularSnapshot }, used) => {
    const got = await readPopularSnapshot(12);
    assert.equal(got, null);
    assert.deepEqual(used, ['anon:from:popular_apts_snapshot']);
  });
});
