/**
 * AUDIT6-1114: 보안 점검 run-6 의 검증 필요 단서 중 코드로 묶은 것의 회귀 검사.
 *   익명 유입 기록 일반 이벤트 상한, 통근 조회 입력과 Kakao 관문, 주변 시설 조회 관문,
 *   지역 이름 글자 검증(시설 조회, 좌표 저장, 지도 목록), 단지 마스터 지역 값 출처, 공유 캐시 퇴거 순서.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function stub(p, exportsObj) {
  const saved = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (saved) require.cache[p] = saved; else delete require.cache[p]; };
}
function handlerOf(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} 라우트가 없다`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const mkRes = () => ({ code: 200, body: undefined, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });

test('유입 기록: 일반 이벤트는 서비스 전체 하루 2,000건을 넘으면 쌓지 않는다', async () => {
  const dlPath = require.resolve('../middleware/dailyLimit');
  const dbPath = require.resolve('../db/client');
  const routePath = require.resolve('../routes/attribution');
  const realDl = require('../middleware/dailyLimit');
  const counts = new Map();
  const inserted = [];
  const r1 = stub(dlPath, { ...realDl, incrementUsage: async (k) => { const n = (counts.get(k) || 0) + 1; counts.set(k, n); return { used: n }; } });
  const r2 = stub(dbPath, { getSupabaseAdmin: () => ({ from: () => ({ insert: async (row) => { inserted.push(row.event); return {}; } }) }) });
  const savedRoute = require.cache[routePath]; delete require.cache[routePath];
  try {
    const handle = handlerOf(require('../routes/attribution'), 'post', '/');
    // IP 를 바꿔 가며 2,005건: IP 상한(30)에는 안 걸리고 전체 상한에만 걸린다
    for (let i = 0; i < 2005; i++) {
      await handle({ body: { event: 'first_load' }, headers: {}, ip: `198.51.${Math.floor(i / 200)}.${i % 200}`, socket: {} }, mkRes());
    }
    assert.equal(inserted.length, 2000, `쌓인 행 ${inserted.length}`);
  } finally { r1(); r2(); if (savedRoute) require.cache[routePath] = savedRoute; else delete require.cache[routePath]; }
});

test('통근 조회: 잘못된 입력은 400, 관문은 캐시에 없을 때만 쓰이고, 길찾기는 한 번만 나간다(실제 서비스 함수, axios 만 가짜)', async () => {
  const axiosPath = require.resolve('axios');
  const kakaoPath = require.resolve('../services/kakaoService');
  const geoPath = require.resolve('../routes/geocode');
  const routePath = require.resolve('../routes/properties');
  const cache = require('../cache');
  const urls = [];
  let lastDirParams = null;
  const realAxios = require('axios');
  const fakeAxios = Object.assign(function () {}, realAxios, { get: async (url, cfg) => {
    urls.push(url);
    if (url.includes('keyword')) return { status: 200, data: { documents: [{ y: '37.4979', x: '127.0276', place_name: '시험역' }], meta: { total_count: 1 } } };
    lastDirParams = cfg.params;
    return { status: 200, data: { routes: [{ summary: { duration: 1800 } }] } };
  } });
  const r0 = stub(axiosPath, fakeAxios);
  const savedKey = process.env.KAKAO_REST_API_KEY; process.env.KAKAO_REST_API_KEY = 'unit-test-not-a-real-key';
  const savedKakao = require.cache[kakaoPath]; delete require.cache[kakaoPath];
  let gateOpen = true, gateAsked = 0, gateWeight = null;
  const realGeo = require('../routes/geocode');
  const r2 = stub(geoPath, Object.assign(function () {}, realGeo, { createKakaoGate: (w) => { gateWeight = w; return async () => { gateAsked += 1; return gateOpen; }; } }));
  const savedRoute = require.cache[routePath]; delete require.cache[routePath];
  const WP = '시험직장1114', OKEY = 'kkdir:37.6543,127.0612->37.4979,127.0276';
  cache.del([`kkkw:${WP}`, OKEY]);
  try {
    const handle = handlerOf(require('../routes/properties'), 'post', '/transit');
    let res = mkRes(); await handle({ body: { aptLat: 10, aptLng: 10, workplace: WP } }, res);
    assert.equal(res.code, 400, '한국 밖 좌표');
    res = mkRes(); await handle({ body: { aptLat: 37.65, aptLng: 127.06, workplace: '가'.repeat(61) } }, res);
    assert.equal(res.code, 400, '61자 직장 이름');
    res = mkRes(); await handle({ body: { aptLat: 37.65, aptLng: 127.06, workplace: [WP] } }, res);
    assert.equal(res.code, 400, '문자열이 아닌 직장 이름');
    assert.equal(urls.length, 0, '거절된 입력이 Kakao 를 불렀다');
    // 관문이 닫혀 있고 캐시에 없으면: 한도 안내, Kakao 호출 0
    gateOpen = false;
    res = mkRes(); await handle({ body: { aptLat: 37.654321, aptLng: 127.061234, workplace: WP } }, res);
    assert.deepEqual(res.body, { available: false, limited: true });
    assert.equal(urls.length, 0, '관문이 막았는데 Kakao 를 불렀다');
    assert.equal(gateWeight, 2);
    // 관문이 열리면: 키워드 1회, 길찾기 1회(예전에는 같은 길찾기가 두 번 나갔다)
    gateOpen = true;
    res = mkRes(); await handle({ body: { aptLat: '37.654321', aptLng: '127.061234', workplace: ` ${WP} ` } }, res);
    assert.equal(res.body.available, true);
    assert.deepEqual([res.body.carMinutes, res.body.transitMinutes], [30, 53]);
    assert.equal(urls.filter((u) => u.includes('keyword')).length, 1);
    assert.equal(urls.filter((u) => u.includes('directions')).length, 1, '길찾기가 한 번만 나가야 한다');
    assert.equal(lastDirParams.origin, '127.0612,37.6543', '좌표를 4자리로 맞춘다');
    // 같은 요청을 다시: 캐시에서 답하고 관문을 묻지 않는다(닫혀 있어도 답한다)
    gateOpen = false; const asked = gateAsked, n = urls.length;
    res = mkRes(); await handle({ body: { aptLat: 37.654321, aptLng: 127.061234, workplace: WP } }, res);
    assert.equal(res.body.available, true, '캐시에 있으면 관문과 무관하게 답한다');
    assert.equal(gateAsked, asked, '캐시 적중인데 관문을 물었다');
    assert.equal(urls.length, n, '캐시 적중인데 Kakao 를 불렀다');
  } finally {
    cache.del([`kkkw:${WP}`, OKEY]);
    r0(); r2();
    if (savedKey === undefined) delete process.env.KAKAO_REST_API_KEY; else process.env.KAKAO_REST_API_KEY = savedKey;
    if (savedKakao) require.cache[kakaoPath] = savedKakao; else delete require.cache[kakaoPath];
    if (savedRoute) require.cache[routePath] = savedRoute; else delete require.cache[routePath];
  }
});

test('주변 시설 조회: 공개 라우트가 Kakao 관문을 넘기고, 서비스는 캐시와 DB 에 없을 때만 관문을 묻는다', () => {
  const route = rd('routes/properties.js');
  assert.match(route, /getNearbyAmenities\(Math\.round\(lat \* 1e4\) \/ 1e4, Math\.round\(lng \* 1e4\) \/ 1e4, \{ gate: require\('\.\/geocode'\)\.createKakaoGate\(7, req\) \}\)/);
  const svc = rd('services/kakaoService.js');
  // 관문 줄은 DB 캐시 반환 뒤, Kakao 호출(try) 바로 앞에 있다
  assert.equal((svc.match(/if \(gate && !\(await gate\(\)\)\) return null;[^\n]*\n  try \{\n    const r = await axios\.get\(KAKAO_(CAT|KEY_SEARCH), \{/g) || []).length, 3); // 카테고리 수, 키워드 수, 직장 키워드 좌표
  assert.match(svc, /if \(opts && opts\.gate && !\(await opts\.gate\(\)\)\) return undefined;[^\n]*\n  try \{\n    const r = await axios\.get\(KAKAO_CAT, \{/);
  for (const c of ["'SC4', 1200, gate", "'MT1', 1500, gate", "'종합병원', 2000, gate", "'SW8', 1200, gate", "'CS2', 500, gate", "'공원', 1200, gate", '3000, { gate }']) assert.ok(svc.includes(c), c);
});

test('지역 이름 글자 검증: 실제 이름은 통과하고 따옴표, 쉼표, 괄호가 든 값은 막는다', () => {
  const { isSafeRegionText } = require('../utils/regionText');
  for (const ok of ['공릉동', '구지읍 창리', '종로1가', '성수동1가', '수원시영통구', '세종특별자치시']) assert.equal(isSafeRegionText(ok), true, ok);
  for (const bad of ['공릉동"', '공릉동,상계동', '공릉동)', "a'b", 'x(y', '', '가'.repeat(41), null, undefined, 123]) assert.equal(isSafeRegionText(bad), false, String(bad));
});

test('시설 조회와 지도 목록, 좌표 저장이 같은 검증을 쓴다', async () => {
  const s = rd('routes/search.js');
  const i = s.indexOf("router.get('/facility'");
  const head = s.slice(i, i + 2600);
  assert.match(head, /if \(\(sigungu && !_isSafeRegionText\(sigungu\)\) \|\| \(umdNm && !_isSafeRegionText\(umdNm\)\)\) \{\s*return res\.status\(400\)/);
  assert.ok(head.indexOf('_isSafeRegionText(sigungu)') < head.indexOf('const admin = adminClient();'), '검증이 DB 접근보다 앞이어야 한다');
  assert.match(s, /const umds = \[\.\.\.new Set\(coords\.map\(c => c\.umd_nm\)\.filter\(Boolean\)\)\]\.filter\(_isSafeRegionText\);/);
  // 좌표 목록 자체에서 걸러야 두 번째 in 목록(보충 거래)과 핀에도 안 들어간다
  assert.ok(s.includes('      .filter(c => !c.umd_nm || _isSafeRegionText(c.umd_nm));'), '좌표 목록 필터가 없다');
  // 좌표 저장: 지역 이름이 아닌 값이면 DB 를 건드리지 않는다(실제 함수 실행)
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/geocodeCacheService');
  const ops = [];
  const real = require('../db/client');
  const admin = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { ops.push('select'); return { data: null }; } }) }), upsert: async (row) => { ops.push(['upsert', row.umd_nm]); return {}; } }) };
  const r1 = stub(dbPath, { ...real, getSupabaseAdmin: () => admin, hasAdminEnv: () => true });
  const saved = require.cache[svcPath]; delete require.cache[svcPath];
  try {
    const g = require('../services/geocodeCacheService');
    const save = g._saveToDb || g.saveToDb;
    assert.equal(typeof save, 'function', 'saveToDb 를 테스트용으로 내보내야 한다');
    await save('name:x|노원구|공릉동"', { aptName: 'x', sigungu: '노원구', umdNm: '공릉동"', lat: 37.6, lng: 127.0 });
    assert.deepEqual(ops, [], '지역 이름이 아닌 값인데 DB 를 건드렸다');
    assert.ok(require('../cache').get('geo-db:name:x|노원구|공릉동"'), 'DB 저장은 건너뛰어도 메모리에는 1시간 기억한다');
    require('../cache').del('geo-db:name:x|노원구|공릉동"');
    await save('name:x|노원구|공릉동', { aptName: 'x', sigungu: '노원구', umdNm: '공릉동', lat: 37.6, lng: 127.0 });
    assert.ok(ops.some((o) => Array.isArray(o) && o[0] === 'upsert' && o[1] === '공릉동'), '정상 이름은 저장한다');
  } finally { r1(); if (saved) require.cache[svcPath] = saved; else delete require.cache[svcPath]; }
});

test('단지 마스터 런타임 저장은 요청 값이 아니라 지역 코드 표와 KAPT 응답을 쓴다', () => {
  const s = rd('services/aptFacilityService.js');
  assert.match(s, /sigungu: require\('\.\/transactionService'\)\.LAWD_CODE_TO_NAME\[lawdCd\] \|\| null,\n\s*umd_nm: lookup\.as3 \? String\(lookup\.as3\)\.trim\(\) : null,\n\s*source: 'kapt-lookup-runtime',/);
  assert.doesNotMatch(s, /sigungu: sigungu \|\| null,\n\s*umd_nm: umdNm \|\| \(lookup\.as3/);
});

test('공유 캐시: 가득 차면 자유 입력 키부터 지우고 다른 기능의 키는 남긴다', () => {
  const cachePath = require.resolve('../cache');
  const saved = require.cache[cachePath];
  const savedEnv = process.env.CACHE_MAX_KEYS;
  process.env.CACHE_MAX_KEYS = '20';
  delete require.cache[cachePath];
  try {
    const c = require('../cache');
    for (let i = 0; i < 8; i++) c.set(`tx:11350:2026${String(i + 1).padStart(2, '0')}`, [i], 600); // 다른 기능의 값진 키(먼저 넣음 = 가장 오래됨)
    c.set('kkkw:cnt:37.6,127.0:kw:공원:1200', 3, 600); // 좌표 격자 키(자유 입력 아님)
    assert.deepEqual(c._pickEvictions(['geo-db:name:x|a|b', 'kapt:1', 'tx:1', 'dl:attr:1', 'a', 'b', 'c', 'd', 'e', 'f']), ['geo-db:name:x|a|b'], '좌표 조회 키도 자유 입력 키다');
    for (let i = 0; i < 60; i++) assert.notEqual(c.set(`searchapt:v4:공격${i}:12`, { i }, 600), false);
    for (let i = 0; i < 8; i++) assert.notEqual(c.get(`tx:11350:2026${String(i + 1).padStart(2, '0')}`), undefined, `거래 키 ${i} 가 밀려났다`);
    assert.equal(c.get('kkkw:cnt:37.6,127.0:kw:공원:1200'), 3);
    assert.ok(c.keys().length <= 20);
    // 자유 입력 키가 모자라면 나머지에서 오래된 것을 지운다(예전 동작 유지)
    assert.deepEqual(c._pickEvictions(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 'searchapt:x']), ['searchapt:x', 'a']);
  } finally {
    if (savedEnv === undefined) delete process.env.CACHE_MAX_KEYS; else process.env.CACHE_MAX_KEYS = savedEnv;
    if (saved) require.cache[cachePath] = saved; else delete require.cache[cachePath];
  }
});
