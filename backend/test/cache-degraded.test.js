/**
 * 캐시 열화 판정 테스트 — Plan 070 (2026-09-06)
 *
 * [왜] 이 저장소는 "열화된(빈·부분 실패·저품질 폴백) 응답에 긴 s-maxage 를 붙여 엣지에 굳히는"
 *   사고 계열을 반복해서 겪었다(2026-08-29 지역 선택기 소실 — regions:[] 가 6시간 굳음).
 *   계획 070 은 backend/routes/{briefing,news,ogImage,region,regulations,search,share,
 *   sitemap,subscription}.js 의 s-maxage 지점 36개를 전수 검토해 "성공/열화 구분이 없는" 4곳을 찾아
 *   고쳤다: regulations.js GET '/'·sitemap.js GET '/'·ogImage.js GET '/apt/:aptSeq'·
 *   search.js GET '/popular'(캐시 히트 경로). 이 파일은 그 4곳을 "열화 시 짧은 캐시/no-store,
 *   정상 시 기존 헤더"로 고정한다.
 *
 * ⚠ 헬퍼는 이 파일 안에서만 정의한다(다른 테스트 파일에서 import 하지 않는다 — 계획 070 지시).
 *   require.cache 스텁·라우트 핸들러 추출 패턴은 backend/test/characterization.test.js 와 같은
 *   방식이지만, 프로덕션 코드는 한 줄도 바꾸지 않고 라우터 스택에서 핸들러만 꺼내 호출한다.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너 — 의존성 0)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function _mockRes() {
  const r = { headers: {}, statusCode: 200, body: null, sent: null, redirected: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.type = () => r;
  r.send = (b) => { r.sent = b; return r; };
  r.redirect = (c, url) => { r.statusCode = c; r.redirected = url; return r; };
  return r;
}
function _stubModule(modPath, exportsObj) {
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports: exportsObj };
}
function _routeHandler(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `라우터에서 ${path} 를 찾지 못했다(경로 변경 시 이 테스트도 갱신할 것)`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// ── regulations.js GET '/' ───────────────────────────────────────────────
// ⚠ regulations.js 는 모듈 로드 시 `const { getSnapshot } = require('../services/regulationsService')`
//   로 구조분해하므로, 스텁을 심은 **뒤** 라우트 캐시를 지워 재로드해야 반영된다(billing 테스트와 동일 이유).
async function _withRegulationsStub({ housing, tax }, fn) {
  const svcPath = require.resolve('../services/regulationsService');
  const routePath = require.resolve('../routes/regulations');
  const saved = { s: require.cache[svcPath], r: require.cache[routePath] };
  _stubModule(svcPath, {
    getSnapshot: async (key) => (key === 'acquisition_tax_2025' ? tax : housing),
  });
  delete require.cache[routePath];
  try {
    const router = require('../routes/regulations');
    const handler = _routeHandler(router, '/');
    return await fn(handler);
  } finally {
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
    if (saved.r) require.cache[routePath] = saved.r; else delete require.cache[routePath];
  }
}

test('regulations GET / — DB 정상 조회(source:db)면 기존 30분 캐시가 붙는다', async () => {
  await _withRegulationsStub({
    housing: { data: { ltv: {} }, source: 'db', validFrom: '2026-01-01' },
    tax: { data: {}, source: 'db' },
  }, async (handler) => {
    const res = _mockRes();
    await handler({}, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
  });
});

test('regulations GET / — DB 실패로 하드코딩 FALLBACK 을 썼으면 no-store(열화를 30분 굳히지 않는다)', async () => {
  await _withRegulationsStub({
    housing: { data: { ltv: {} }, source: 'fallback' },
    tax: { data: null, source: 'fallback' },
  }, async (handler) => {
    const res = _mockRes();
    await handler({}, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store', '열화(FALLBACK) 응답에 긴 캐시가 붙었다');
  });
});

// ── sitemap.js GET '/' ────────────────────────────────────────────────────
function _sitemapAdminStub({ briefingResult, aptPages }) {
  let aptIdx = 0;
  function makeChain(table) {
    const c = {
      select: () => c,
      order: () => c,
      gte: () => c,
      limit: () => Promise.resolve(table === 'briefing_snapshots' ? briefingResult : { data: [], error: null }),
      range: () => {
        if (table !== 'molit_apt_index') return Promise.resolve({ data: [], error: null });
        const r = (aptPages && aptPages[aptIdx]) || { data: [], error: null };
        aptIdx += 1;
        return Promise.resolve(r);
      },
    };
    return c;
  }
  return { from: (table) => makeChain(table) };
}
async function _withSitemapStub({ briefingResult, aptPages, lawdCodes }, fn) {
  const dbPath = require.resolve('../db/client');
  const txSvcPath = require.resolve('../services/transactionService');
  const briefSvcPath = require.resolve('../services/briefingService');
  const routePath = require.resolve('../routes/sitemap');
  const saved = {
    db: require.cache[dbPath], tx: require.cache[txSvcPath],
    br: require.cache[briefSvcPath], r: require.cache[routePath],
  };
  _stubModule(dbPath, { getSupabaseAdmin: () => _sitemapAdminStub({ briefingResult, aptPages }) });
  _stubModule(txSvcPath, { LAWD_CODES: lawdCodes || { seoul: '11680' } });
  _stubModule(briefSvcPath, { kstDayString: () => '2026-09-06' });
  delete require.cache[routePath];
  try {
    const router = require('../routes/sitemap');
    const handler = _routeHandler(router, '/');
    return await fn(handler);
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.tx) require.cache[txSvcPath] = saved.tx; else delete require.cache[txSvcPath];
    if (saved.br) require.cache[briefSvcPath] = saved.br; else delete require.cache[briefSvcPath];
    if (saved.r) require.cache[routePath] = saved.r; else delete require.cache[routePath];
  }
}

test('sitemap GET / — 지역·브리핑·단지 조회가 전부 성공이면 기존 6시간 캐시가 붙는다', async () => {
  await _withSitemapStub({
    briefingResult: { data: [{ day: '2026-09-01' }], error: null },
    aptPages: [{ data: [], error: null }],
  }, async (handler) => {
    const res = _mockRes();
    await handler({}, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
    assert.match(res.sent, /<urlset/, 'sitemap XML 이 생성되지 않았다');
    assert.match(res.sent, /<loc>https:\/\/myhomelog\.vercel\.app\/region\/11680<\/loc>/);
  });
});

test('sitemap GET / — briefing_snapshots 조회가 실패(부분 실패)하면 no-store(열화를 6시간 굳히지 않는다)', async () => {
  await _withSitemapStub({
    briefingResult: { data: null, error: { message: 'DB 장애 주입(Plan 070 회귀 테스트)' } },
    aptPages: [{ data: [], error: null }],
  }, async (handler) => {
    const res = _mockRes();
    await handler({}, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store',
      '부분 실패(briefing 조회 오류)인데 6시간 캐시가 붙었다 — CACHE-POISON-2026-08-29 와 같은 계열의 결함');
    // fail-open 원칙 — 실패해도 나머지(정적 + 지역) URL 은 그대로 나가야 한다.
    assert.match(res.sent, /<loc>https:\/\/myhomelog\.vercel\.app\/region\/11680<\/loc>/,
      '부분 실패가 나머지 URL 생성까지 막았다(fail-open 이 깨졌다)');
  });
});

test('sitemap GET / — 단지(molit_apt_index) 조회 예외도 no-store(부분 실패의 다른 경로)', async () => {
  await _withSitemapStub({
    briefingResult: { data: [], error: null },
    aptPages: [{ data: null, error: { message: '단지 URL 조회 실패 주입' } }],
  }, async (handler) => {
    const res = _mockRes();
    await handler({}, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store', '단지 URL 생성 실패인데 6시간 캐시가 붙었다');
  });
});

// ── ogImage.js GET '/apt/:aptSeq' ────────────────────────────────────────
// ogImage.js 는 aptPage.loadAptFacts·ogImageService.renderCard 를 매 요청마다 인라인 require() 하므로
// (모듈 최상단 구조분해가 아니다) 라우터 자체를 재로드할 필요 없이 require.cache 만 갈아치우면 된다.
async function _withOgAptStub({ facts, renderFail }, fn) {
  const aptPagePath = require.resolve('../routes/aptPage');
  const ogSvcPath = require.resolve('../services/ogImageService');
  const saved = { a: require.cache[aptPagePath], o: require.cache[ogSvcPath] };
  _stubModule(aptPagePath, { loadAptFacts: async () => facts });
  _stubModule(ogSvcPath, {
    renderCard: async () => {
      if (renderFail) throw new Error('렌더 실패 주입(Plan 070 회귀 테스트)');
      // ⚠ SCHEMA-SNAPSHOT-SCAN (characterization.test.js): `\.from\(` 정규식은 Supabase 여부를
      //   구분하지 않고 소스 전체를 훑는다 — `Buffer.from('문자열')` 도 "테이블 참조"로 오검출된다.
      //   Buffer.alloc 으로 만들어 그 스캔을 건드리지 않는다(내용은 테스트에서 안 본다).
      return Buffer.alloc(8, 0x50);
    },
  });
  try {
    const router = require('../routes/ogImage');
    const handler = _routeHandler(router, '/apt/:aptSeq');
    return await fn(handler);
  } finally {
    if (saved.a) require.cache[aptPagePath] = saved.a; else delete require.cache[aptPagePath];
    if (saved.o) require.cache[ogSvcPath] = saved.o; else delete require.cache[ogSvcPath];
  }
}

test('ogImage GET /apt/:aptSeq — 실거래 통계(stat)가 있으면 기존 6시간 캐시가 붙는다', async () => {
  await _withOgAptStub({
    facts: {
      region: '서울 노원구', aptName: '테스트단지', umd: '공릉동', buildYear: 1999,
      stat: { dealCount: 10, avgPriceAuk: '10.0', medianPrice: 100000, minPrice: 90000, maxPrice: 110000, recentDeal: '2026-08-01' },
    },
  }, async (handler) => {
    const res = _mockRes();
    await handler({ params: { aptSeq: '11350-1' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  });
});

test('ogImage GET /apt/:aptSeq — stat 이 없으면(거래 0건·조회 실패를 구분할 수 없음) no-store', async () => {
  // aptPage.js 는 같은 신호(stat 없음 = thin)로 페이지 자체를 이미 no-store 한다 — OG 카드도 같은 값을
  // 쓰는데 여기만 무조건 긴 캐시를 붙이던 것이 Plan 070 이 찾은 결함이다.
  await _withOgAptStub({
    facts: { region: '서울 노원구', aptName: '테스트단지', umd: '공릉동', buildYear: 1999, stat: null },
  }, async (handler) => {
    const res = _mockRes();
    await handler({ params: { aptSeq: '11350-1' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], 'no-store', 'stat 없는(thin) OG 이미지에 긴 캐시가 붙었다');
  });
});

test('ogImage GET /apt/:aptSeq — 렌더 실패는 여전히 정적 이미지 폴백 + no-store(기존 규약 유지 확인)', async () => {
  await _withOgAptStub({
    facts: { region: '서울 노원구', aptName: '테스트단지', umd: '공릉동', buildYear: 1999, stat: { dealCount: 1 } },
    renderFail: true,
  }, async (handler) => {
    const res = _mockRes();
    await handler({ params: { aptSeq: '11350-1' } }, res, () => {});
    assert.equal(res.redirected, '/og.png', '렌더 실패인데 정적 이미지로 떨어지지 않았다');
    assert.equal(res.headers['Cache-Control'], 'no-store', '렌더 실패 응답에 캐시가 붙었다');
  });
});

// ── search.js GET '/popular' — 캐시 히트가 저장된 품질 표식(cc)을 따르는지 ──
// [결함] pck(`popular:<limit>`) 캐시엔 저품질(usedFallback) 결과도 짧은 TTL 로 그대로 들어가는데,
//   예전 캐시-히트 분기는 그 사실을 모른 채 무조건 CDN_OK(30분+SWR 24시간)를 붙였다 — 로컬 캐시가
//   살아있는 최대 120초 동안 들어온 요청은 실제로는 열화 결과인데 엣지엔 긴 캐시 헤더가 나갔다.
//   고친 코드는 캐시 봉투에 { payload, cc } 로 품질 표식을 같이 저장해 캐시-히트 분기가 재사용한다
//   (client 로 나가는 JSON 은 payload 그대로라 응답 모양은 바뀌지 않는다).
function _popularHandler() {
  const router = require('../routes/search');
  return _routeHandler(router, '/popular');
}

test("search GET /popular — 캐시 히트가 성공 품질(cc)이면 기존 30분 캐시를 재사용하고 응답 모양이 그대로다", async () => {
  const cache = require('../cache');
  const handler = _popularHandler();
  const key = 'popular:27';
  const payload = { results: [{ aptName: 'CACHETEST-OK' }], window: { days: 60 } };
  const CDN_OK = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';
  cache.set(key, { payload, cc: CDN_OK }, 60);
  try {
    const res = _mockRes();
    await handler({ query: { limit: '27' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], CDN_OK);
    assert.deepEqual(res.body, payload, '캐시 봉투(cc)가 그대로 클라이언트 응답에 새면 안 된다');
  } finally {
    cache.del(key);
  }
});

test('search GET /popular — 캐시에 저품질(usedFallback) 결과가 들어 있으면 캐시 히트도 짧은 캐시를 쓴다(Plan 070 결함 수정)', async () => {
  const cache = require('../cache');
  const handler = _popularHandler();
  const key = 'popular:28';
  const payload = { results: [{ aptName: 'CACHETEST-FALLBACK' }], window: { days: 60 } };
  const CDN_FALLBACK = 'public, max-age=0, s-maxage=120, stale-while-revalidate=600';
  cache.set(key, { payload, cc: CDN_FALLBACK }, 60);
  try {
    const res = _mockRes();
    await handler({ query: { limit: '28' } }, res, () => {});
    assert.equal(res.headers['Cache-Control'], CDN_FALLBACK,
      '캐시 히트가 저품질 결과인데도 30분 캐시(CDN_OK)를 붙였다 — 열화가 엣지에 최대 30분 굳는다');
    assert.deepEqual(res.body, payload);
  } finally {
    cache.del(key);
  }
});

// 라이브(캐시 미스) 경로 — usedFallback 분기가 헤더뿐 아니라 캐시 봉투에도 같은 표식을 남기는지.
async function _withPopularServiceStub({ snapshot, live }, fn) {
  const svcPath = require.resolve('../services/popularService');
  const searchPath = require.resolve('../routes/search');
  const saved = { s: require.cache[svcPath], r: require.cache[searchPath] };
  _stubModule(svcPath, {
    buildPopularResults: async () => live,
    readPopularSnapshot: async () => snapshot,
    storePopularSnapshot: async () => {},
    popularWindow: () => ({ days: 60 }),
  });
  delete require.cache[searchPath];
  try {
    const router = require('../routes/search');
    const handler = _routeHandler(router, '/popular');
    return await fn(handler);
  } finally {
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
    if (saved.r) require.cache[searchPath] = saved.r; else delete require.cache[searchPath];
  }
}

test('search GET /popular — 라이브 집계가 usedFallback:true 면 짧은 캐시를 붙이고 캐시 봉투에도 같은 표식을 남긴다', async () => {
  const cache = require('../cache');
  await _withPopularServiceStub({
    snapshot: null,
    live: { results: [{ aptName: 'LIVE-FALLBACK' }], usedFallback: true },
  }, async (handler) => {
    const res = _mockRes();
    try {
      await handler({ query: { limit: '19' } }, res, () => {});
      assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=120, stale-while-revalidate=600');
      const stored = cache.get('popular:19');
      assert.ok(stored, '결과가 캐시에 저장되지 않았다');
      assert.equal(stored.cc, res.headers['Cache-Control'], '캐시 봉투의 품질 표식이 응답 헤더와 다르다');
    } finally {
      cache.del('popular:19');
    }
  });
});

test('search GET /popular — 라이브 집계가 정상(usedFallback:false)이면 기존 30분 캐시가 붙는다', async () => {
  const cache = require('../cache');
  await _withPopularServiceStub({
    snapshot: null,
    live: { results: [{ aptName: 'LIVE-OK' }], usedFallback: false },
  }, async (handler) => {
    const res = _mockRes();
    try {
      await handler({ query: { limit: '20' } }, res, () => {});
      assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
      const stored = cache.get('popular:20');
      assert.ok(stored, '결과가 캐시에 저장되지 않았다');
      assert.equal(stored.cc, res.headers['Cache-Control']);
    } finally {
      cache.del('popular:20');
    }
  });
});
