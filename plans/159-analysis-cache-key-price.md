# Plan 159: 단지 분석 캐시 키에 "현재 가격"을 넣어 다른 화면의 백분위가 섞이지 않게 한다

> **Executor instructions**: 단계 순서대로 따르고 각 검증의 기대 결과를 확인한다. "STOP conditions" 면 멈추고 보고한다.
> 끝나면 `plans/README.md` 159 행을 갱신한다.
>
> **Drift check (먼저 실행)**: `git diff --stat 217674a..HEAD -- backend/services/analysisService.js backend/test/rent-jeonse.test.js`
> 출력이 있으면 "Current state" 와 대조하고, 다르면 STOP.

## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `217674a`, 2026-10-18

## Why this matters
`GET /api/analysis?aptName=…&area=…&price=8.5` 는 `price`(억)로 "이 가격이 최근 실거래 중 몇 % 위치인가"(백분위)와
그에 기반한 시장 요약을 계산해 1시간 캐시한다. 그런데 캐시 키에 가격이 없다. 프런트는 화면마다 다른 가격을 넘긴다
(`frontend/index.html:9580` 은 `p.avgPrice` — 목록 검색에선 평형별 6개월 평균, 인기 목록에선 60일 평균 등 출처마다 다르다).
그래서 같은 단지를 두 번째로 연 사람은 **첫 사람이 넘긴 가격으로 계산된 백분위·`currentPrice`** 를 받는다.

## Current state
- `backend/routes/analysis.js:11,21` — `const { aptName, area, price, sigungu, umdNm } = req.query;` → `analyzeApt(lawdCd, aptName, parseFloat(price) || 0, sigungu || null, umdNm || null)`.
- `backend/services/analysisService.js:531-537`:
  ```js
  async function analyzeApt(lawdCd, aptName, currentPrice, sigungu, umdNm) {
    if (!lawdCd) lawdCd = '11350'; // fallback

    // CROSS-REGION-FIX-2026-06-03: sigungu/umdNm 도 캐시 키 포함 (동별 분리 — 동명 단지 캐시 오염 차단)
    const cacheKey = `analysis:${lawdCd}:${aptName}:${sigungu||''}:${umdNm||''}`;
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  ```
- 가격 의존 값(같은 함수): `:587` `const priceW = (currentPrice || 0) * 10000;` → `:593` `calcPricePercentile(filteredTx, priceW)` → 결과의 `percentile`·`percentileLow/High/N`·`marketSummary`(=`buySignal`, `summarizeMarketSignal(percentile, ...)`)·`currentPrice`. 저장은 `:655` `if (molitAvailable) cache.set(cacheKey, result, 3600);`.
- 캐시 키 문자열을 직접 쓰는 다른 곳: **테스트 한 곳뿐** — `backend/test/rent-jeonse.test.js:631` `cache.del('analysis:11350:배선단지::');` (그 아래 `:635` 에서 `analyzeApt(LAWD, '배선단지', 6.0)` 호출). 운영 코드에는 없다(`grep -rn "analysis:" backend --include=*.js` 로 확인됨).
- 내보내기(`:786-789`): `module.exports = { analyzeApt, calcTotalCost, getLawdCdFromArea, compareBatch, _internals: { ... } }`.
- 저장소 관례: 고친 곳 위에 `// <표식>-2026-10-18 (Plan 159): 이유` 한국어 주석.

## Commands you will need
| Purpose | Command (저장소 루트) | Expected |
|---|---|---|
| 관련 테스트 | `node --test backend/test/rent-jeonse.test.js` | `ℹ fail 0` |
| 전체 검증 | `npm run verify` | 종료 코드 0, `ℹ fail 0` |

## Scope
**In scope**: `backend/services/analysisService.js`(캐시 키 한 곳 + 키 함수), `backend/test/rent-jeonse.test.js`(`:631` 키 문자열), 새 테스트(같은 파일 끝 또는 `backend/test/analysis-cache-key.test.js` 신규).
**Out of scope**: 백분위·시장 요약 계산 로직, 캐시 TTL, 라우트 응답 형태, 프런트엔드가 넘기는 가격(어느 가격을 넘길지는 제품 결정 — 이 계획은 "넘긴 가격대로 정확히 계산"만 보장).

## Git workflow
- 브랜치 `advisor/159-analysis-cache-key-price`. 메시지 예: `fix(analysis): 캐시 키에 현재 가격 포함 — 다른 가격의 백분위가 섞이던 것 (Plan 159)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`.
- push·PR 은 운영자 지시가 있을 때만.

## Steps
### Step 1: 키 함수를 만들고 analyzeApt 가 쓰게 한다
`analyzeApt` 바로 위에 추가:
```js
// ANALYSIS-KEY-PRICE-2026-10-18 (Plan 159): 백분위·시장 요약·currentPrice 가 넘겨받은 가격에 따라 달라지는데
//   키에 가격이 없어, 같은 단지를 다른 가격으로 연 두 번째 사람이 첫 사람 가격의 결과를 받았다.
//   가격은 억 단위 소수 둘째 자리(만원 100 단위)로 정규화한다 — 0·NaN·음수는 0.
function _analysisCacheKey(lawdCd, aptName, sigungu, umdNm, currentPrice) {
  const p = Number(currentPrice);
  const pk = Number.isFinite(p) && p > 0 ? Math.round(p * 100) : 0;
  return `analysis:${lawdCd}:${aptName}:${sigungu||''}:${umdNm||''}:${pk}`;
}
```
`const cacheKey = ...` 줄을 `const cacheKey = _analysisCacheKey(lawdCd, aptName, sigungu, umdNm, currentPrice);` 로 바꾼다. `_internals` 에 `analysisCacheKey: _analysisCacheKey` 를 추가한다.
**Verify**: `grep -n "_analysisCacheKey" backend/services/analysisService.js` → 정의 1 + 사용 1 + 내보내기 1 = 3줄.

### Step 2: 기존 테스트의 키 문자열을 갱신한다
`backend/test/rent-jeonse.test.js:631` 의 `cache.del('analysis:11350:배선단지::');` 를
`cache.del('analysis:11350:배선단지:::600');` 로 바꾼다(그 테스트는 가격 6.0 → `Math.round(6.0*100)=600`, sigungu·umdNm 없음 → `::` 뒤에 `:600`).
**Verify**: `node --test backend/test/rent-jeonse.test.js` → `ℹ fail 0`.

### Step 3: 키 테스트를 추가한다
`backend/test/rent-jeonse.test.js` 끝(또는 새 파일 `backend/test/analysis-cache-key.test.js`, 같은 머리 형식 `'use strict'; const { test } = require('node:test'); const assert = require('node:assert/strict');`)에:
1. `_internals.analysisCacheKey('11680','은마','강남구','대치동', 34.15)` 와 `(…, 30)` 이 **서로 다르다**.
2. 같은 가격 `34.15` 와 `34.150000001` 은 **같은 키**(정규화).
3. `0`·`NaN`·`-1`·`undefined` 은 모두 끝이 `:0`.
4. 소스 고정: `analyzeApt` 본문에 `_analysisCacheKey(` 가 있고, 옛 형식 리터럴이 파일에 남아 있지 않다 — 옛 형식은 `${umdNm||''}` 바로 뒤가 **닫는 백틱**이고 새 형식은 그 뒤에 `:${pk}` 가 붙으므로, 검사는 `${umdNm||''}` + 닫는 백틱 조합이 0회인지로 한다.
**Verify**: 해당 테스트 파일 → 새 테스트 4개 포함 `ℹ fail 0`.

### Step 4: 전체 검증
`npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Test plan
Step 3 의 4개. 구조 모델: `backend/test/rent-jeonse.test.js` 의 기존 `_internals` 사용 테스트(`require('../services/analysisService')._internals`). 회귀 주입(권장): 키 함수에서 `:${pk}` 를 잠시 빼면 테스트 1이 실패해야 한다.

## Done criteria
- [ ] `grep -c "_analysisCacheKey" backend/services/analysisService.js` = 3
- [ ] `grep -n "analysis:11350:배선단지::'" backend/test/rent-jeonse.test.js` 결과 0줄(옛 키 제거)
- [ ] 새 키 테스트 4개 존재, `npm run verify` 종료 코드 0
- [ ] `git status` 에 in-scope 외 변경 없음, `plans/README.md` 159 행 갱신

## STOP conditions
- `analyzeApt` 의 캐시 키 줄이나 `cache.set(cacheKey, result, 3600)` 이 위 발췌와 다르다.
- 운영 코드(테스트 제외)에서 `'analysis:` 키를 직접 읽거나 지우는 곳이 새로 발견된다.
- `compareBatch`·`_compareOne` 이 `analyzeApt` 의 캐시에 의존하는 것으로 보인다(이 경우 그 경로도 확인 후 보고).

## Maintenance notes
- 캐시는 백엔드 전체가 공유하는 인스턴스별 메모리(`backend/cache.js`, `maxKeys` 2000)다. 가득 차면 키 10% 를 지우고 다시 넣는다(기능은 멈추지 않음). 정상 사용에선 프런트가 넘기는 가격 종류가 화면 수 정도라 키 증가는 작다.
- 가격은 자유 쿼리 값이라 일부러 바꿔 보내면 단지당 키가 늘고 매번 재계산(공공 API·DB 조회)된다. 다만 같은 키에 이미 들어 있는 `aptName`·`area` 도 자유 값이라 **새로운 종류의 노출은 아니다**. 경로는 `dataLimiter` 뒤에 있다(`server.js:312`) — 단, Redis 장애 중엔 일반 제한기가 fail-open 이라 이 보호가 약하다(알려진 운영 항목).
- 화면마다 다른 가격을 넘기는 것 자체("어느 가격 기준의 백분위인가")는 제품 결정 사항이다 — 가격 요약 통일 논의(방향 제안: 공용 가격 요약 함수)와 함께 다룬다.
