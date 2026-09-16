# 095 — 인기 순위의 "이름 미등록 단지 제외" 필터에 회귀 테스트가 없다 — 스텁 client 로 `buildPopularResults` 통합 테스트 추가

**작성 기준 커밋**: `d5924bb` (2026-09-16) · 우선순위 P2 · 작업량 XS · 의존: 없음(테스트 파일만)

## 전제 확인 (계획자가 코드·재현으로 확인한 것)
- Plan 090 실행자가 master 최종본에서 **회귀 주입을 직접 재현**: `backend/services/popularService.js:150~151` 의 두 줄
  ```js
  const named = top.filter(t => !isUnnamedApt(_cleanName(t.apt_name)));
  if (named.length >= limit) top = named.slice(0, limit + 6);
  ```
  을 주석 처리해도 전체 스위트가 411/411 그대로 통과했다. 즉 인기 TOP12 에 `(50-5)` 가 다시 나타나도 테스트가 못 잡는다.
- `buildPopularResults(limit = 12, opts = {})` 는 `opts.client` 로 Supabase client 를 주입받는다(`:66~67`). 흐름: `admin.rpc('search_popular_apts', {p_limit}).abortSignal(...)` → RPC 행(camelCase: `aptName, sigungu, umdNm, lawdCd, buildYear, recentDealDate, dealCount60d, avgDealAmount`) → 21일 필터·시군구 캡(같은 시군구 ≤2) → **이름 미등록 필터** → `admin.from('apt_geocache').select(...).in('apt_name', names)` 좌표 join(키 `apt_name|sigungu|umd_nm`, 한국 범위 좌표만) → 미좌표는 `resolveCoordBatch`(geocodeCacheService) → 좌표 있는 순서대로 `limit` 개. 각 결과 행은 `{ aptName, sigungu, umdNm, …, lat, lng, displayName }`.
- 이미 있는 스텁 선례: `backend/test/cron-observability.test.js:134~175` — `rpc(name)` 이 `{ abortSignal: () => Promise.resolve({ data: rows, error: null }) }` 를, `from('apt_geocache')` 가 `{ select: () => ({ in: () => Promise.resolve({ data: coords, error: null }) }) }` 를 돌려주고, `../services/geocodeCacheService` 를 `require.cache` 로 바꿔 `resolveCoordBatch` 를 스텁한다(끝에 원복).
- 테스트 파일 `backend/test/apt-display-name.test.js` 는 `node:test` + `node:assert/strict`, 각 test 가 필요한 모듈을 안에서 require 한다.

## 범위
- 수정: `backend/test/apt-display-name.test.js` 에 test 1개 추가(파일 끝). **다른 파일 변경 금지**(서비스 코드 수정 없음).

## Step 1 — 테스트 추가 (파일 끝에 그대로)
```js
// POPULAR-UNNAMED-REGRESSION-2026-09-16 (Plan 095): popularService.js 의 이름 미등록 필터 두 줄을 지우면 이 테스트가 실패해야 한다.
//   스텁 형태는 cron-observability.test.js 의 popularService 테스트와 동일(rpc→abortSignal thenable, apt_geocache select→in).
test('buildPopularResults — 이름 미등록("(50-5)")은 인기 순위에서 빠지고, 지번 괄호 이름은 displayName 만 정리되어 남는다', async () => {
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { g: require.cache[geoPath], s: require.cache[svcPath] };
  const today = new Date().toISOString().slice(0, 10);
  // 13행: 2번째가 이름 미등록, 3번째가 지번 괄호 접미. 시군구를 전부 다르게 해 시군구 캡(≤2)에 걸리지 않게 한다.
  const names = ['공릉풍림아이원', '(50-5)', '충무주공(872)', '단지4', '단지5', '단지6', '단지7', '단지8', '단지9', '단지10', '단지11', '단지12', '단지13'];
  const rows = names.map((n, i) => ({
    aptName: n, sigungu: `시군구${i}`, umdNm: i === 1 ? '공항동' : `동${i}`, lawdCd: `111${String(i).padStart(2, '0')}`,
    buildYear: 2000, recentDealDate: today, dealCount60d: 100 - i, avgDealAmount: 100000,
  }));
  const coords = rows.map(r => ({ apt_name: r.aptName, sigungu: r.sigungu, umd_nm: r.umdNm, lat: 37.5, lng: 127.0 }));
  const client = {
    rpc: () => ({ abortSignal: () => Promise.resolve({ data: rows, error: null }) }),
    from: (table) => {
      if (table !== 'apt_geocache') throw new Error('예상 밖 테이블 ' + table);
      return { select: () => ({ in: () => Promise.resolve({ data: coords, error: null }) }) };
    },
  };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: { resolveCoordBatch: async () => [] } };
  delete require.cache[svcPath];
  try {
    const { buildPopularResults } = require('../services/popularService');
    const { results, usedFallback } = await buildPopularResults(12, { client });
    assert.equal(usedFallback, false);
    assert.equal(results.length, 12, '이름 미등록 1건을 빼고도 후보 12건으로 limit 을 채워야 한다');
    assert.ok(!results.some(r => r.aptName === '(50-5)'), '이름 미등록 단지가 인기 순위에 남아 있다 — popularService 의 named 필터 회귀');
    const cm = results.find(r => r.aptName === '충무주공(872)');
    assert.ok(cm, '지번 괄호 이름은 (제외가 아니라) 표시만 정리되어 남아야 한다');
    assert.equal(cm.displayName, '충무주공 (872번지)');
    assert.equal(results[0].displayName, '공릉풍림아이원');
    assert.ok(results.every(r => typeof r.displayName === 'string' && r.displayName), '모든 행에 displayName 이 있어야 한다');
  } finally {
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  }
});
```
- 이 파일에 이미 같은 이름의 test 가 있으면(없음이 확인됨) 중복 추가하지 않는다.
- `popularService` 가 로드 시 `../db/client` 를 require 한다 — env 없이도 로드되는지는 기존 테스트(cron-observability)가 증명하므로 db/client 는 스텁하지 않는다. 만약 `Supabase 미설정` 류 예외가 **로드 시점**에 나면 STOP 하고 보고.

## 검증·완료 기준
- `node --test backend/test/apt-display-name.test.js` 통과 → `npm run verify` `fail 0`, 테스트 411 + 1.
- **회귀 주입(필수, 수행 후 `git checkout -- backend/services/popularService.js` 로 원복)**: `popularService.js:150~151` 두 줄을 주석 처리 → 이 테스트가 `이름 미등록 단지가 인기 순위에 남아 있다` 로 fail 해야 한다. 원복 후 `git status --short` 에 테스트 파일만 남아야 한다.
- 커밋 1개: `test(인기): 이름 미등록 단지 제외 필터 회귀 테스트 — 스텁 client 로 buildPopularResults 통합 검증 (Plan 095)`.

## STOP 조건
- 회귀 주입에서 테스트가 fail 하지 않는다(필터를 지워도 통과) → 스텁이 필터 경로를 타지 않는 것이므로 `usedFallback`·`results` 값을 보고하고 STOP.
