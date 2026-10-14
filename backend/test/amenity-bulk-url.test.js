/**
 * backend/test/amenity-bulk-url.test.js
 *
 * Plan 135 — 관심도 캐시 일괄 조회(readCacheBulk)의 요청 주소 길이.
 *   [배경] 키 200개씩 in(cache_key, …) 로 묶어 주소가 27,597~29,574자가 되자 게이트웨이가 400 으로
 *   거절했고(edge 로그 2026-10-08·11·13), 응답 error 를 읽지 않아 전부 캐시 미스로 처리됐다.
 *   같은 날 성공한 가장 긴 GET 주소는 14,043자 — 인코딩 길이 8,000자 단위로 묶는다.
 *   DB 클라이언트는 require.cache 스텁으로 끊는다(facility.test.js 와 같은 방식).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const svcPath = require.resolve('../services/naverDatalabService');
const clientPath = require.resolve('../db/client');

// 운영 로그의 실패 요청과 같은 모양(ni:이름|시군구|동)의 긴 한글 키
function longKey(i) {
  return `ni:힐스테이트지제역퍼스티움${i}|평택시|${i % 2 ? '지제동' : '세교동'}`;
}

function loadWith(admin) {
  const saved = { svc: require.cache[svcPath], client: require.cache[clientPath] };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  delete require.cache[svcPath];
  const mod = require(svcPath);
  const restore = () => {
    delete require.cache[svcPath];
    if (saved.svc) require.cache[svcPath] = saved.svc;
    if (saved.client) require.cache[clientPath] = saved.client; else delete require.cache[clientPath];
  };
  return { mod, restore };
}

const encodedListLength = (chunk) => chunk.reduce((s, k) => s + encodeURIComponent(k).length + 9, 0);

test('_chunkByEncodedLength — 모든 묶음이 예산 이하이고 순서·누락 없이 전부 담는다', () => {
  const { mod, restore } = loadWith(null);
  try {
    const keys = Array.from({ length: 2000 }, (_, i) => longKey(i));
    const chunks = mod._chunkByEncodedLength(keys);
    assert.equal(mod.BULK_URL_BUDGET, 8000);
    for (const c of chunks) assert.ok(encodedListLength(c) <= 8000, `묶음 인코딩 길이 ${encodedListLength(c)} > 8000`);
    assert.deepEqual(chunks.flat(), keys, '순서·누락 없이 그대로여야 한다');
    // 대조: 종전 방식(200개)이면 같은 키로 실패 구간(≥ 14,043자 넘어섬)에 들어간다
    assert.ok(encodedListLength(keys.slice(0, 200)) > 14043, '음성 대조 — 200개 묶음은 성공 최대 길이를 넘는다');
  } finally { restore(); }
});

test('getCachedInterest — 실제 조회 묶음이 예산 이하이고, 한 묶음이 실패해도 나머지 결과는 쓴다', async () => {
  const inCalls = [];
  let call = 0;
  const now = new Date().toISOString();
  const admin = {
    from() {
      const q = {
        select() { return q; },
        in(_col, vals) { q._vals = vals; inCalls.push(vals.slice()); return q; },
        limit() {
          call++;
          if (call === 1) return Promise.resolve({ data: null, error: { message: 'Bad Request' } });
          return Promise.resolve({ data: q._vals.map((k) => ({ cache_key: k, count: 5000, fetched_at: now })), error: null });
        },
      };
      return q;
    },
  };
  const { mod, restore } = loadWith(admin);
  try {
    const items = Array.from({ length: 600 }, (_, i) => ({ aptName: `힐스테이트지제역퍼스티움${i}`, sigungu: '평택시', umd: i % 2 ? '지제동' : '세교동' }));
    const out = await mod.getCachedInterest(items);
    assert.ok(inCalls.length >= 2, '여러 묶음으로 나뉘어야 한다');
    for (const vals of inCalls) assert.ok(encodedListLength(vals) <= 8000, `조회 묶음 인코딩 길이 ${encodedListLength(vals)} > 8000`);
    assert.equal(inCalls.flat().length, 600, '모든 키가 한 번씩 조회돼야 한다');
    assert.equal(out.size, 600 - inCalls[0].length, '실패한 첫 묶음만 빠지고 나머지는 결과에 담긴다');
  } finally { restore(); }
});
