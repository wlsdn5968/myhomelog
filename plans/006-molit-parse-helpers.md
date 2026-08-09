# Plan 006: MOLIT 응답 파싱 공통 헬퍼를 신설해 5곳 복붙을 제거하고 숫자타입 금액 TypeError 잠재결함을 종결한다

> **Executor instructions**: 단계 순서대로, 각 검증 통과 후 진행. STOP 발생 시 보고.
> 완료 시 `plans/README.md` 상태 갱신.
>
> **Drift check (가장 먼저)**: `git diff --stat ee84415..HEAD -- backend/jobs/molitIngest.js backend/services/transactionService.js backend/services/rentService.js backend/services/buildingRegisterService.js`
> 변경 시 "Current state" 발췌와 대조, 불일치면 STOP.

## Status

- **Priority**: P1
- **Effort**: S~M
- **Risk**: LOW (동작 변화는 "숫자타입 금액 → 기존 TypeError 크래시 → 정상 파싱" 1건뿐, 나머지 전부 동작 불변 치환)
- **Depends on**: none
- **Category**: bug + tech-debt
- **Planned at**: commit `ee84415`, 2026-08-09

## Why this matters

MOLIT(국토부 실거래가) API item 파싱이 공유 모듈 없이 4개 파일 5개 지점에 독립 복붙돼 있다.
이 산재는 이미 실장애를 냈다: 2026-06-14 `88e9303` — 전월세 API 가 `monthlyRent` 를 **숫자**(390)로
반환하는데 문자열 전제 `.replace()` 호출 → TypeError → 전세가율·갭 전 단지 null. 그때
`rentService.js` 만 `String()` 래핑으로 수정됐고, **완전 동형의 `dealAmount` 파싱이
`molitIngest.js:185` 와 `transactionService.js:342` 에 그대로 남아 있다** — MOLIT 이 dealAmount 를
숫자로 내려주는 날 일배치 ETL 과 라이브 폴백이 동시에 죽는다. 배열 정규화 문구
(`Array.isArray(items) ? items : items ? [items] : []`)도 5곳 동일 복제, 취소거래(cdealType) 판정도
3곳 독립 구현이다. 공통 헬퍼 1개 모듈로 모으고 회귀 테스트로 고정한다(현재 item 필드 파싱 테스트 0건).

## Current state

- `backend/jobs/molitIngest.js` — 일배치 ETL. L127 배열 정규화, L163 cdealType 필터, L185 금액 파싱:
  ```js
  const items = body?.items?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];   // L126-127
  ...
  .filter(item => !String(item.cdealType || '').trim()) // 해제 거래 제외   L163
  ...
  deal_amount: parseInt((item.dealAmount || '0').replace(/,/g, '')) || 0,  // L185
  ```
- `backend/services/transactionService.js` — 라이브 API 폴백. L288-289 배열 정규화, L324-331
  cdealType 필터(`cancelledCount++` 로깅 포함 — **유지할 것**), L342 금액 파싱(molitIngest 와 동일 문구).
- `backend/services/rentService.js` — 전월세. L72-73 배열 정규화, L106-113 cdealType 필터
  (cancelledCount 로깅 포함), L127-128 금액 파싱 — 여기만 이미 `String()` 래핑됨(RENT-TYPE-FIX-2026-06-14
  주석 L123-126, 헬퍼로 치환하되 이 실장애 주석은 보존/요약 이전).
- `backend/services/buildingRegisterService.js` — L81-82(resolveJibun), L132-133(getBuildingTitle)
  배열 정규화 2곳. cdealType 필터 없음(jibun 추출 용도라 의도적 — 바꾸지 말 것). 금액 파싱 없음.
- 공유 파서 모듈 없음(`backend/utils/` 에 aptName.js·geo.js 등만 존재).
- 테스트 스위트: `backend/test/characterization.test.js` — node --test, 순수 함수 고정 스타일
  (예: molitErrReason 테스트 L157-183). 신규 테스트는 이 스타일을 따를 것.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 구문 | `cd backend && node -c utils/molitParse.js && node -c jobs/molitIngest.js && node -c services/transactionService.js && node -c services/rentService.js && node -c services/buildingRegisterService.js` | exit 0 |
| 테스트 | `cd backend && npm test` | 전부 pass (기존 15 + 신규) |

## Scope

**In scope**:
- `backend/utils/molitParse.js` (신설)
- `backend/jobs/molitIngest.js`, `backend/services/transactionService.js`,
  `backend/services/rentService.js`, `backend/services/buildingRegisterService.js` — 위 발췌 지점만 치환
- `backend/test/characterization.test.js` — 헬퍼 3종 테스트 추가

**Out of scope**:
- `aptMasterSync.js`·`aptInfoService.js`·`aptFacilityService.js` — KAPT/AptInfo 계열은 envelope 이
  다름(`body.items` 가 직접 배열 등, 1af72ac 실장애의 교훈). RTMS 용 헬퍼를 강제하면 오히려 깨진다.
- item→객체 **필드 매핑 통합 금지** — 파일마다 계약이 다름(molitIngest 는 snake_case DB row + jibun +
  sigungu LAWD 역매핑, transactionService 는 camelCase + 기본값 0, rentService 는 rent 필드).
  기본값 차이(null vs 0)·필드 유무 차이는 실동작이므로 이번에 건드리지 않는다.
- 페이징 루프·에러 처리(break vs throw) 통합 — 별도 판단 필요, 이번 범위 아님.

## Git workflow

- 커밋: `refactor(molit): 파싱 공통 헬퍼 utils/molitParse - 5곳 복붙 제거 + 숫자금액 TypeError 종결 (Plan 006)`
- push 는 운영자 승인 후(이번 라운드는 사전 승인됨).

## Steps

### Step 1: `backend/utils/molitParse.js` 신설

```js
/**
 * MOLIT(data.go.kr RTMS 계열) 응답 item 공통 파싱 헬퍼 — Plan 006
 * ⚠ RTMS(실거래가·전월세·건축물대장) envelope 전용. KAPT/AptInfo 계열은 body.items 가
 *   직접 배열이라 이 헬퍼 대상이 아님(1af72ac 실장애 참고).
 */

/** body?.items?.item → 항상 배열 (단일 객체·undefined 정규화) */
function itemArray(items) {
  return Array.isArray(items) ? items : items ? [items] : [];
}

/**
 * 금액(만원 단위 콤마 문자열 또는 숫자) → 정수.
 * RENT-TYPE-FIX-2026-06-14 (88e9303): MOLIT 이 금액을 숫자로 반환하는 경우가 실재
 * (monthlyRent=390) — 문자열 전제 .replace 는 TypeError. String() 래핑으로 양쪽 안전.
 */
function parseAmountManwon(v) {
  return parseInt(String(v ?? '0').replace(/,/g, ''), 10) || 0;
}

/** 해제(취소) 거래 여부 — cdealType 이 비어있지 않으면 해제 */
function isCanceled(item) {
  return !!String((item && item.cdealType) || '').trim();
}

module.exports = { itemArray, parseAmountManwon, isCanceled };
```

**Verify**: `cd backend && node -c utils/molitParse.js` → exit 0

### Step 2: molitIngest.js 치환

`require` 추가 후: L127 → `const list = itemArray(items);`,
L163 → `.filter(item => !isCanceled(item)) // 해제 거래 제외`,
L185 → `deal_amount: parseAmountManwon(item.dealAmount),`

**Verify**: `cd backend && node -c jobs/molitIngest.js` → exit 0

### Step 3: transactionService.js 치환

L289 → `const pageItems = itemArray(items);`,
L324-331 필터 내부 판정만 교체(카운트 로깅 유지):
```js
.filter(item => {
  if (isCanceled(item)) { cancelledCount++; return false; }
  return true;
})
```
L342 → `dealAmount: parseAmountManwon(item.dealAmount),`

**Verify**: `cd backend && node -c services/transactionService.js` → exit 0

### Step 4: rentService.js 치환

L73 → `itemArray(items)`, L106-113 → Step 3 과 동일 형태, L127-128 →
`deposit: parseAmountManwon(item.deposit), monthlyRent: parseAmountManwon(item.monthlyRent),`
(RENT-TYPE-FIX 실장애 주석은 한 줄 요약으로 유지 — 근거 소실 금지).

**Verify**: `cd backend && node -c services/rentService.js` → exit 0

### Step 5: buildingRegisterService.js 치환

L82·L133 → `itemArray(items)`. cdealType 필터를 **추가하지 말 것**(jibun 추출 용도).

**Verify**: `cd backend && node -c services/buildingRegisterService.js` → exit 0

### Step 6: 테스트 추가 + 전체 회귀

`backend/test/characterization.test.js` 에 molitParse 테스트 블록 추가(Test plan 참조).

**Verify**: `cd backend && npm test` → 전부 pass

## Test plan

`characterization.test.js` 의 기존 스타일(describe/it 아닌 `test()` — 실제 파일 스타일 확인 후 일치)로:
- `parseAmountManwon`: `'82,500'`→82500, `390`(숫자)→390 **(88e9303 회귀 고정)**, `'0'`→0,
  `null`/`undefined`/`''`→0, `0`→0
- `itemArray`: 배열→그대로, 단일 객체→`[obj]`, `undefined`/`null`→`[]`
- `isCanceled`: `{cdealType:'O'}`→true, `{cdealType:''}`→false, `{cdealType:'  '}`→false,
  `{}`→false, `{cdealType: 1}`→true

## Done criteria

- [ ] `grep -rn "Array.isArray(items) ? items" backend/` → 0 매치 (5곳 전부 헬퍼로 치환됨)
- [ ] `grep -n "replace(/,/g" backend/jobs/molitIngest.js backend/services/transactionService.js backend/services/rentService.js` → 0 매치
- [ ] `cd backend && npm test` 전부 pass (신규 포함)
- [ ] in-scope 밖 파일 무변경 (`git status --short`)
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- 발췌 위치의 코드가 다르면(드리프트) STOP.
- 치환 후 기존 테스트가 깨지면 STOP(숨은 계약 존재 신호).
- buildingRegisterService 에 cdealType 필터를 넣고 싶어지면 STOP — 의도된 미필터.

## Maintenance notes

- 새 MOLIT/RTMS 계열 연동은 반드시 `utils/molitParse.js` 를 쓸 것(직접 파싱 재복붙 금지).
  단, KAPT/AptInfo 계열(envelope 다름)은 대상 아님 — 모듈 헤더 주석 참조.
- parseInt radix 10 명시가 기존 코드와 다르지만 MOLIT 금액 문자열(십진+콤마)에는 결과 차이 없음.
- 리뷰 포인트: transactionService/rentService 의 cancelledCount 로깅이 사라지지 않았는지.
