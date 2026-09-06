# Plan 039: 추천 엔진의 예산 상한·후보 컷·게이트를 "소스 문자열 검사"에서 "실제 실행"으로 승격한다

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/services/propertyService.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.
>
> ⚠ **이 계획은 프로덕션 코드를 한 줄도 바꾸지 않는다.** 테스트만 추가한다.
> 추천 로직을 "테스트하기 쉽게" 리팩터링하려는 유혹이 들면 그것은 STOP 조건이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (프로덕션 코드 무변경)
- **Depends on**: 없음
- **Category**: tests
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

추천 엔진의 **예산 상한·후보 컷·소형 게이트·역 거리 단계**를 지키는 테스트가 전부
`assert.match(src, /정규식/)` — 즉 **소스 파일이 그렇게 생겼는지**만 본다.

이 저장소는 그 방식의 한계를 **실측으로 확인했다**: 취득세의 조정지역 분기를 뒤집었더니
1,620개 조합 중 468개가 갈렸는데 모양 검사는 **전부 초록**이었다. 정규식 계약 테스트는
"앞단 분기 반전" 과 "인자 교체" 를 원리적으로 잡지 못한다.

테스트 저자 본인이 그 한계를 파일에 적어 뒀다 — `backend/test/characterization.test.js:6017`
과 `:6081` 에 "주입 실측: 아래 단언들은 전부 초록이었다" 가 있다. 그런데 대응이
**정규식을 더 추가하는 것**이었다.

이것이 걸려 있는 대상은 **돈**이다. 운영자 실사고 "6.5억인데 6.8억이 나온다" 가 바로 이
카테고리이고, 현재 계약은 `const budgetMaxMan = maxBudget * 10000;` 이라는 **한 줄의 모양**만
지킨다. `p.avgPrice` 대신 다른 가격 기준이 들어가거나, 컷 순서는 유지된 채 비교 방향이
뒤집히거나, `_lensPick` 은 채워지되 `ranked` 필터가 어긋나면 — 223개 테스트가 전부 통과하면서
사용자에게 예산 밖 단지가 나간다.

2026-09-02 에 이 저장소는 같은 승격을 4건 해냈다(취득세·필터 조건·알림 창·백필).
이 계획은 그 방식을 추천 엔진에 적용한다.

## 현재 상태

### 승격 대상 테스트 (전부 소스 문자열 검사)

`backend/test/characterization.test.js`:

- `:5905-5913` — REC-BROAD-ALL(광역 = 시도 전체). `assert.match(src, …)` 5개 + `rec:v29` 확인.
- `:5916-5922` — **예산 상한(돈)**:
  ```js
  test('추천 예산 상한 — 대표가격이 예산 이하인 단지만(5% 여유 제거)', () => {
    const src = require('node:fs').readFileSync(require.resolve('../services/propertyService'), 'utf8');
    assert.match(src, /const budgetMaxMan = maxBudget \* 10000;/, '예산 상한이 1.0x 가 아니다');
    assert.ok(!/budgetMaxMan = maxBudget \* 10000 \* 1\.05/.test(src), '5% 여유가 되살아났다 — 6.5억 검색에 6.8억이 실린다');
    assert.match(src, /p\.avgPrice <= budgetMaxMan && p\.avgPrice >= budgetMinMan/, '표시값(avgPrice) 기준 예산 필터가 사라졌다');
  });
  ```
- `:5925` 부터 — REC-RANK-PROV(후보 컷을 임시 점수순으로).
- `:6010-6032` — TRANSIT-STAGE. `src.indexOf(...)` 로 **단계 순서까지 문자열 위치 비교**.
- `:6052-6084` — MULTI-LENS 합집합 · 검증 티어 · `LENS_UNVERIFIED` · SMALL-GATE-EARLY.

### 이미 있는 올바른 선례 (이 파일 안)

- `:21-38` — `computeLTV` 를 **실행**해서 값을 단언한다.
- `:4492-4497`, `:6043-6044` — `_applyFacilityToScore` 실행.
- `:1475-1484` — `_reportFn`: `report.js` 소스에서 함수를 정규식으로 뽑아 `new Function` 으로
  되살려 **실행**한다(프로덕션 코드 무변경).
- `:6296-6338`, `:6402-6455`, `:6486-6535` — `require.cache` 스텁 + `finally` 복원.

### 대상 함수와 의존성

`backend/services/propertyService.js:539` `getAIRecommendations(userCondition)` — 약 1,000줄.
**이미 export 돼 있다**(파일 마지막 줄):

```js
module.exports = { getAIRecommendations, pickRegions, computeLTV, buildJibunIndex, lookupByJibun, _applyFacilityToScore };
```

스텁이 필요한 의존성(파일 상단 `require` + 함수 안 지연 `require`):

| 경로 | 쓰이는 것 | 스텁 방침 |
|---|---|---|
| `./transactionService` | `getRegionRecentTransactions`, `getTransactionsByApt`, `analyzeTransactions`, `getAliasCanonicalMap`, `LAWD_CODES`, `LAWD_CODE_TO_NAME`, `RETIRED_LAWD_CODES` | ⚠ **실제 모듈을 펼친 뒤 네트워크/DB 함수만 덮어써라** (`{ ...require(실제), getRegionRecentTransactions: fake }`). 통째로 대체하면 `LAWD_CODES` 가 사라져 지역 판정이 무너진다. |
| `./aptFacilityService` | `getFacilitiesByKaptCodes`, `getAptListByLawdFromDb`, `verifyCandidate`, `resolveFacility`, `bonbun` | 고정 픽스처 반환 |
| `./aptInfoService` | `getAptListBySgg`, `getAptBasisInfo`, `getAptDtlInfo` | 빈 배열/null (광역 모드는 어차피 건너뛴다) |
| `./geocodeCacheService` | `resolveCoordBatch` | 입력 길이만큼 고정 좌표 배열 |
| `./schoolService` | `resolveSchoolsBatch`, `getCachedSchoolsBatch` | 빈 결과 |
| `./buildingRegisterService` | `getBuildingTitle` | `null` |
| `./kakaoService` | `nearestSubway`, `getNearbyAmenities` | 단지별로 **다른 거리**를 주는 결정적 함수 |
| `./naverDatalabService` | 관심도 | 캐시 미스(중간값 경로) |
| `./redisCache` | `rget`/`rset` | `rget → null`, `rset → noop` |

⚠ `../cache`(node-cache)는 **실제 모듈을 쓰되**, 테스트 시작 시 `rec:` 로 시작하는 키를 지워라.
기존 테스트가 그렇게 한다(`characterization.test.js:6450`, `:6529` 에 정규식 청소 예시).
지우지 않으면 앞 테스트가 남긴 3시간짜리 결과 캐시에 맞아 **스텁이 무시된 채 통과**한다.

⚠ `./regulationsService` 는 **스텁하지 마라** — 지역 판정이 실제 스냅샷 로직을 타야 의미가 있다.

### 이 저장소의 관례

- 테스트는 `backend/test/characterization.test.js` 한 파일. `node:test` 의 `test(...)`.
- 각 테스트 위에 **왜 이 테스트가 있는지 · 어떤 실사고를 고정하는지** 한글 주석을 단다.
- 스텁은 `require.cache` 교체 + `try/finally` 복원. **복원을 빠뜨리면 그 뒤 수천 줄이
  오염된 스텁으로 통과한다**(실패가 아니라 위양성 초록이라 아무도 모른다).
- 절대 날짜를 테스트에 박지 마라 — CI 가 시간이 지나면 무작위로 깨진다(실사고 이력).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 226` 이상, `fail 0` |
| 단일 테스트 확인 | `cd backend && node --test --test-name-pattern "추천" ` | 해당 테스트만 실행 |
| 린트 | `npm run lint` | exit 0 |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `backend/test/characterization.test.js` — 테스트 추가(및 필요 시 기존 정규식 테스트에
  "이 검사는 모양만 본다" 는 주석 추가)
- `plans/README.md`

**Out of scope** (강하게):
- **`backend/services/propertyService.js` 를 포함한 모든 프로덕션 코드.**
  export 추가도, 함수 분리도, "테스트하기 쉽게" 하는 어떤 변경도 하지 마라.
  이 저장소는 결제 테스트에서 같은 판단을 내렸다 — "결제 로직을 테스트 편의로 리팩터링하는 것이
  더 위험하다"(`characterization.test.js:922`).
- **기존 정규식 테스트를 지우는 것.** 남겨 두라. 배선·부재·설정 계약에는 정규식이 옳은 도구이고,
  지우면 무엇을 잃는지 알 수 없게 된다.
- `getAIRecommendations` 의 **결과 순서·점수 산식을 바꾸는 것**. 이 계획은 현재 동작을
  고정하는 것이지 개선하는 것이 아니다.
- 테스트 파일 분할 — 별건(백로그).

## Git 작업 방식

- 브랜치: `test/recommend-behavioral-contracts`
- 커밋: `test(추천): 예산 상한·후보 컷·소형 게이트를 소스 검사에서 실제 실행으로 승격`
  body 에 어떤 주입이 종전 테스트를 통과했는지 적어라(Step 4 의 실측 결과).
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: 스텁 하네스를 만든다

`backend/test/characterization.test.js` 맨 끝에 헬퍼 함수 하나를 추가한다.
이 헬퍼는 위 표의 모듈들을 `require.cache` 에 심고, 콜백을 실행한 뒤 `finally` 에서
**반드시** 복원한다. 시그니처 예:

```js
// REC-BEHAVIORAL-2026-09-06: 추천 엔진 계약을 소스 문자열이 아니라 **실행 값**으로 고정한다.
//   [왜] 기존 단언은 전부 assert.match(src, …) 라 앞단 분기 반전·인자 교체를 원리적으로 못 잡는다.
//   이 저장소가 취득세에서 실측한 실패 모드다(분기 하나 뒤집었더니 1,620조합 중 468이 갈렸는데 전부 초록).
//   [방식] 프로덕션 코드는 한 줄도 바꾸지 않는다 — require.cache 스텁으로 외부 의존만 고정 픽스처로 바꾼다.
async function _withRecStubs(fixture, fn) { /* … */ }
```

`fixture` 로 최소한 다음을 주입할 수 있어야 한다:
- 지역별 거래 목록(단지명·평형·가격·거래건수·세대수·지번)
- 단지별 시설 정보(세대수 확인/미확인)
- 단지별 역 거리

**복원 확인**: 헬퍼가 끝난 뒤 `require.cache[txPath]` 등이 원래 값으로 돌아왔는지
헬퍼 안에서 단언까지 하면 더 안전하다.

**검증**: `cd backend && npm test` → 기존 223 pass 유지, `fail 0`
(이 단계에서는 헬퍼만 추가하므로 개수가 그대로여야 한다)

### Step 2: 예산 상한을 실행으로 고정한다 (최우선)

테스트 1개 추가. 픽스처: 같은 지역에 단지 여러 개 — 예산 **6.5억** 입력에 대해
- 6.4억 단지(포함되어야 함)
- 정확히 6.5억 단지(포함되어야 함 — 경계는 "이하")
- 6.6억 단지(**제외되어야 함**)
- 6.8억 단지(**제외되어야 함** — 운영자 실사고 값)

단언:
1. 결과 배열의 모든 항목이 `avgPrice <= 6.5` 다.
2. 6.8억 단지가 결과에 **없다**.
3. 6.5억 단지는 **있다**(경계를 잘못 좁히지 않았다).

⚠ 결과 객체의 가격 필드명은 실제 반환값을 한 번 찍어 확인한 뒤 쓰라
(`propertyService.js:997` 근처가 `avgAuk` 를 만든다). **추측하지 마라.**

**검증**: `cd backend && npm test` → `pass` ≥ 224

### Step 3: 다중 렌즈 컷과 소형 게이트를 실행으로 고정한다

테스트 2개 추가.

**(A) MULTI-LENS 의 존재 이유**: 임시 점수는 낮지만 **거래가 많고 세대수가 큰** 단지가
최종 15곳에 들어가야 한다(`LENS_DEALS`·`LENS_SCALE` 이 그걸 위해 있다).
픽스처: 임시 점수 상위 40곳을 채우되, 거래 39건·1,590세대·역 108m 인 단지를
임시 점수 45위에 두고 — **그 단지가 결과에 있어야 한다**.

**(B) 소형 게이트**: **확인된** 세대수 80 인 단지는 제외되고, 세대수 **미확인(null)** 인
단지는 남아야 한다. 이 저장소는 "모름을 0 으로 취급해 407곳을 잘못 배제한" 실사고가 있다 —
그 방향을 여기서 고정한다.

**검증**: `cd backend && npm test` → `pass` ≥ 226

### Step 4: 회귀 주입으로 "종전 테스트가 놓치는가" 를 실측한다

이 단계가 이 계획의 **핵심 산출물**이다. 새 테스트가 실제로 무언가를 더 잡는지를 수치로 남긴다.

⚠ **주입 전 `git status --short` 가 비어 있어야 한다**(Step 1~3 을 커밋했는지 확인).
이 저장소는 `git checkout` 원복으로 미커밋 수정을 통째로 날린 사고가 있다.

커밋한 뒤, `propertyService.js` 에 다음을 **하나씩** 주입하고 매번 `cd backend && npm test` 를
돌려 **어느 테스트가 잡는지** 기록한다:

1. 예산 비교를 `<=` → `<` 로 (경계 반전)
2. 예산 필터 기준을 `p.avgPrice` → 다른 가격 필드로 (인자 교체)
3. `budgetMaxMan` 에 `* 1.05` 를 되살림
4. `LENS_DEALS` 합집합 한 줄을 제거
5. 소형 게이트의 세대수 비교를 `null` 도 걸리게 변경

각 주입마다 기록할 것: **(기존 정규식 테스트가 잡았는가 / 새 실행 테스트가 잡았는가)**.
주입 후에는 반드시 `git checkout -- backend/services/propertyService.js` 로 되돌린다.

기대: 최소 2건 이상에서 **"정규식은 통과, 실행 테스트가 잡음"** 이 나온다. 그것이 이 계획의 근거다.
결과를 커밋 메시지 body 와 `plans/README.md` 에 표로 남겨라.

**검증**: 5건의 주입 결과 표가 존재하고, 최소 2건에서 새 테스트만 잡았다.
새 테스트가 **하나도** 더 잡지 못하면 **STOP 조건**이다(그 경우 픽스처가 로직을 실제로
통과시키지 못하고 있을 가능성이 높다 — 보고하라).

### Step 5: 기존 정규식 테스트에 한계를 명시한다

`:5905`, `:5916`, `:6010`, `:6052` 위 주석에 한 줄씩 덧붙인다:

```js
//   ⚠ 아래 단언은 **소스의 모양**만 본다 — 분기 반전·인자 교체는 못 잡는다.
//     그 계약은 REC-BEHAVIORAL-2026-09-06 의 실행 테스트가 지킨다.
```

이렇게 해야 다음 사람이 "정규식이 지켜 주고 있다" 고 오해하지 않는다.

**검증**: `cd backend && npm test` → 여전히 통과(주석만 추가)

### Step 6: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0. `git status --short` 에 테스트 파일과 `plans/README.md` 외에
변경이 없어야 한다.

## 테스트 계획

- **새 테스트 3개**(예산 상한 / MULTI-LENS / 소형 게이트) + 스텁 헬퍼 1개.
- **패턴 참고**: `characterization.test.js:6296-6338`(스텁 + 복원), `:21-38`(실행 단언),
  `:1475-1484`(`_reportFn` — 소스에서 함수를 되살려 실행).
- **검증**: `cd backend && npm test` → `pass` ≥ 226, `fail 0`.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `cd backend && npm test` exit 0, `pass` ≥ 226, `fail 0`
- [ ] `grep -c "REC-BEHAVIORAL-2026-09-06" backend/test/characterization.test.js` ≥ `4`
      (헬퍼 1 + 테스트 3)
- [ ] `git status --short` 가 `backend/test/characterization.test.js` 와 `plans/README.md` 만 보여준다
      (**프로덕션 코드 변경 0** — 이 계획의 핵심 제약)
- [ ] Step 4 의 주입 5건 결과가 표로 기록됐고, 최소 2건에서 새 테스트만 잡았다
- [ ] `npm run lint` exit 0
- [ ] `plans/README.md` 의 039 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 `propertyService.js` 가 변경돼 있고, 위 export 줄이나 렌즈 상수가 다르다.
- 스텁을 아무리 맞춰도 `getAIRecommendations` 가 빈 배열만 돌려준다 —
  픽스처가 어느 단계에서 걸리는지 로그로 확인하고, 3회 시도 후에도 안 되면 보고하라.
  (**프로덕션 코드를 고쳐서 통과시키려 하지 마라.**)
- Step 4 에서 새 테스트가 **하나도** 더 잡지 못한다.
- 테스트를 통과시키기 위해 `propertyService.js` 에 export·훅·플래그를 추가하고 싶어진다.
- `rec:` 캐시를 지웠는데도 결과가 스텁을 무시한다(다른 캐시 계층이 있다는 뜻).

## 유지보수 메모

- **앞으로 추천 산식을 바꿀 때**: `rec:vNN` 캐시 키 버전을 올려야 한다
  (`propertyService.js:587`·`:589`, 테스트 `:5913`). 산식을 바꾸고 키를 안 올리면 옛 결과가
  3시간 서빙된다 — 이 저장소의 확립된 함정이다.
- **리뷰에서 볼 것**: `git status --short` 에 프로덕션 파일이 있는지. 있으면 이 계획의
  전제가 깨진 것이다.
- **의도적으로 미뤄둔 것**: (a) 6,663줄 단일 테스트 파일 분할 — `node --test` 가 파일 단위로만
  병렬화하고 `require.cache` 스텁 복원 누락이 위양성 초록을 만들 수 있다는 근거가 있으나 별건이다.
  (b) `fetchCandidateApts`(보고서 경로, `report.js:1219`)의 같은 승격 — 추천과 별개 경로다.
- **이 헬퍼는 재사용 자산이다.** 다음에 추천 관련 계약을 추가할 때 `_withRecStubs` 를 쓰면
  정규식으로 되돌아가지 않는다.
