# Plan 004: 결제 기간 이월과 규제지역 판정 — 실사고 이력 있는 두 경로에 계약 테스트를 세운다

> **Executor instructions**: 단계 순서대로, 각 검증 통과 후 진행. STOP 발생 시 보고.
> 완료 시 `plans/README.md` 상태 갱신.
>
> **Drift check (가장 먼저)**: `git diff --stat b63da64..HEAD -- backend/routes/billing.js backend/services/regulationsService.js backend/services/planService.js backend/test/characterization.test.js`
> 변경 시 "Current state" 발췌와 대조, 불일치면 STOP.

## Status

- **Priority**: P1
- **Effort**: S~M
- **Risk**: LOW (billing 은 동작 불변 리팩터+테스트, regulations 는 테스트만 추가)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b63da64`, 2026-08-09

## Why this matters

두 경로 모두 **과거 실사고 이력이 코드 주석에 남아 있는데 테스트가 0** 이다.
(1) 결제 기간 이월: "만료 전 재결제 시 잔여일 손실(분쟁 risk)" 을 고친 계산이 confirm 과
webhook 두 곳에 **독립 중복 구현** — 한쪽만 고치는 미래 수정이 사용자별로 다른 만료일을 만든다.
(2) 규제지역 판정 `isRegulatedRegion`: 오판 시 LTV 가 40%↔70% 로 바뀌어 사용자의 대출 계획을
직접 틀리게 하는 함수인데(레포의 characterization 테스트 문화가 시작된 사고 클래스) 백엔드 판정
자체는 어떤 테스트도 없다. 이 계획은 (1)을 순수 함수로 추출·단일화하고 두 경로 모두에
경계 테스트를 세운다.

## Current state

- `backend/routes/billing.js:248-256` — `/confirm` 의 이월 계산:
  ```js
  // P0 (Agent 3차 audit, 2026-05-04): 잔여 기간 누적 — 만료 전 재결제 시 잔여일 손실 차단
  const now = new Date();
  const { data: existing } = await admin.from('user_billing').select('current_period_end').eq('user_id', req.user.id).maybeSingle();
  const baseTime = (existing?.current_period_end && new Date(existing.current_period_end) > now)
    ? new Date(existing.current_period_end)
    : now;
  const periodEnd = new Date(baseTime.getTime() + 30 * 24 * 60 * 60 * 1000);
  ```
- `backend/routes/billing.js:393-399` — `/webhook` 에 **동일 계산이 중복**(주석 "webhook 도 동일 처리").
- `backend/services/regulationsService.js:263-274` — 판정 함수:
  ```js
  async function isRegulatedRegion(regionStr) {
    const r = String(regionStr || '').normalize('NFC').trim();
    if (!r) return false;
    const { keywords, seoulRegulated } = await getRegulatedKeywords();
    if (seoulRegulated) {
      if (r.includes('서울')) return true;
      for (const gu of SEOUL_GU_KEYWORDS) if (r.includes(gu)) return true;
    }
    for (const kw of keywords) if (r.includes(kw)) return true;
    return false;
  }
  ```
  `getRegulatedKeywords()` 는 같은 파일 205행 부근 — DB 스냅샷 기반이며 실패 시 하드코딩
  FALLBACK 경로가 있다(테스트에서 이 구조를 다뤄야 함 — Step 3 참고).
- 테스트 파일·실행: `backend/test/characterization.test.js`, `cd backend && npm test`(node --test).
  구조 모범: 그 파일의 computeLTV 테스트(순수 함수 import 후 assert.equal 경계 나열).
- 컨벤션: 함수 추출 시 한글 주석 헤더 + "동작 불변 이관" 명시. 날짜 계산에 라이브러리 추가 금지
  (레포는 순수 Date 사용).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 테스트 | `cd backend && npm test` | 전부 pass |
| 구문 | `cd backend && node -c routes/billing.js && node -c services/planService.js` | exit 0 |

## Scope

**In scope**:
- `backend/services/planService.js` — `computePeriodEnd` 순수 함수 추가(이 파일이 plan/구독
  도메인의 기존 서비스라 적합. 없으면 STOP 하지 말고 `billing.js` 파일 상단에 모듈 함수로 추가)
- `backend/routes/billing.js` — 두 곳의 인라인 계산을 함수 호출로 교체(동작 불변)
- `backend/test/characterization.test.js` — 테스트 추가

**Out of scope**:
- 결제 승인/캡처/멱등 로직·Toss API 호출부 — 이월 계산 외 어떤 로직도 변경 금지.
- `regulationsService.js` 의 구현 — **테스트만** 추가한다(판정 로직 수정 금지).
- DB 스키마·user_billing 테이블.

## Git workflow

- 커밋(2개 권장): `refactor(billing): 기간 이월 계산 computePeriodEnd 순수 함수 단일화 - 동작 불변 (Plan 004)`
  / `test(reg): isRegulatedRegion·이월 계산 경계 계약 테스트 (Plan 004)`
- push 금지.

## Steps

### Step 1: `computePeriodEnd(existingEndIso, now)` 순수 함수 추출

`backend/services/planService.js` 에 추가(export 포함):
```js
/** 구독 만료일 계산 — 기존 만료가 미래면 그 시점+30일(잔여 이월), 아니면 now+30일.
 *  P0(2026-05-04) "만료 전 재결제 시 잔여일 손실" 재발 방지의 단일 소스. (Plan 004) */
function computePeriodEnd(existingEndIso, now) {
  const base = (existingEndIso && new Date(existingEndIso) > now) ? new Date(existingEndIso) : now;
  return new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
}
```
기존 인라인 코드와 **완전히 같은 판정**(> now, +30일 ms 계산)이어야 한다 — 개선하지 마라.

**Verify**: `cd backend && node -c services/planService.js` → exit 0

### Step 2: billing.js 두 곳을 함수 호출로 교체

confirm(253-256)과 webhook(396-399)의 `baseTime`/`periodEnd` 인라인 계산을
`const periodEnd = computePeriodEnd(existing?.current_period_end, now);` 로 교체.
`existing` 조회·`now` 생성·upsert 는 그대로 둔다.

**Verify**: `cd backend && node -c routes/billing.js` → exit 0, 그리고
`grep -c "computePeriodEnd" backend/routes/billing.js` → 2 이상(양쪽 교체 확인)

### Step 3: 테스트 추가

`backend/test/characterization.test.js` 에 두 블록 추가(기존 computeLTV 테스트 구조 모방):

(a) `computePeriodEnd` — 고정 `now = new Date('2026-08-09T00:00:00Z')` 기준 4케이스:
  - existingEnd 없음(null/undefined) → now+30일
  - existingEnd 과거(now-1일) → now+30일
  - existingEnd 미래(now+5일) → 그 시점+30일 (잔여 5일 보존 — 이게 P0 의 핵심)
  - existingEnd == now 정확히 → now+30일 (`>` 비교이므로 이월 아님 — 현재 동작 고정)

(b) `isRegulatedRegion` — async 테스트. `getRegulatedKeywords` 가 DB 를 타므로, 테스트에서는
  DB 미설정 환경(로컬 npm test 에는 SUPABASE env 없음)에서 **FALLBACK 경로**로 결정적으로
  동작하는지 먼저 1회 호출로 확인하고, 다음 경계를 assert:
  - '서울', '강남', '송파구' → true / '' → false / '일산' → false / '분당' → true
  - **주의**: FALLBACK 키워드 셋이 위 기대와 다르면 그 기대값을 코드의 FALLBACK 정의에 맞춰
    조정하라(이 테스트의 목적은 정책 판단이 아니라 **현재 동작의 고정**이다). 단, '서울'→true 와
    ''→false 가 성립하지 않으면 STOP(판정 자체가 깨져 있다는 뜻 — 보고).

**Verify**: `cd backend && npm test` → 전부 pass, 신규 테스트 2블록 포함

## Test plan

(Steps 에 포함 — 별도 없음)

## Done criteria

- [ ] `grep -n "function computePeriodEnd" backend/services/planService.js` → 1 매치
- [ ] `grep -c "computePeriodEnd" backend/routes/billing.js` → ≥2
- [ ] billing.js 에 `baseTime` 인라인 계산 잔존 없음: `grep -n "baseTime" backend/routes/billing.js` → 0 매치
- [ ] `cd backend && npm test` 전부 pass(신규 포함)
- [ ] in-scope 밖 무변경 (`git status --short`)
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- billing.js 의 두 발췌 지점 코드가 다르면(드리프트) STOP.
- confirm 과 webhook 의 인라인 계산이 서로 **이미 다르게** 구현돼 있으면 STOP —
  "어느 쪽이 옳은가"는 계획 밖의 판단(보고 후 결정).
- isRegulatedRegion 이 로컬 테스트 환경에서 네트워크를 실제로 시도해 hang 하면 STOP
  (FALLBACK 이 동작하지 않는다는 뜻 — 테스트 강행 금지).

## Maintenance notes

- 구독 기간이 30일 고정이 아니게 되는 순간(연간 플랜 등) `computePeriodEnd` 에 기간 파라미터를
  추가해야 한다 — 두 호출부가 이미 단일 함수라 그때 수정은 1곳이다(이 계획의 목적).
- 리뷰 포인트: Step 1 함수가 기존 인라인과 정확히 동일 판정인지(개선·반올림·시간대 처리 추가 금지).
