# Plan 003: AI 비용 카운터·좌표 저장의 fire-and-forget 에 await 를 붙여 서버리스 동결 유실을 막는다

> **Executor instructions**: 단계 순서대로, 각 검증 통과 후 진행. STOP 발생 시 보고.
> 완료 시 `plans/README.md` 상태 갱신.
>
> **Drift check (가장 먼저)**: `git diff --stat b63da64..HEAD -- backend/services/aiService.js backend/services/geocodeCacheService.js`
> 변경 시 "Current state" 발췌와 대조, 불일치면 STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (실패는 기존과 동일하게 삼킴 — 지연만 수십 ms 추가)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b63da64`, 2026-08-09

## Why this matters

Vercel 서버리스는 **응답 반환 후 인스턴스를 동결**하므로, 응답 직전에 발사한 미대기(promise)
작업은 완주 보장이 없다. 이 레포는 2026-08-08 에 정확히 이 클래스의 실사고를 겪었다 —
`backend/routes/cron.js` 의 RATE-WARM-2026-08-08 주석: "health 의 비차단 갱신은 응답 반환 후
서버리스 동결로 완주가 안 될 수 있다(HF 실측: 반복 ECONNABORTED)". 같은 패턴이 두 곳에 남아 있다:
(1) **AI 비용 카운터** — 사용자별 월 예산과 전역 kill-switch 의 증분 기록이 유실되면 비용 상한이
"구조적 보장"이 아니게 된다. (2) **좌표 캐시 저장** — 유실되면 같은 단지 재요청마다 Kakao 를
다시 호출한다(쿼터 낭비). 수정은 `await` 추가뿐이며 실패 시 동작(삼킴)은 불변이다.

## Current state

- `backend/services/aiService.js:265-272` (b63da64 기준):
  ```js
  // ── 2) post-call 사용량 기록 (fire-and-forget, 실패해도 응답은 정상) ──
  if (userId && response.usage) {
    budget.recordUsage(userId, response.usage).catch(() => { /* already logged */ });
  }
  // 전역 누적 기록 (익명 포함 전체 — kill-switch 카운터, fire-and-forget)
  if (response.usage) {
    globalAiBudget.recordGlobalAiUsage(response.usage).catch(() => { /* already logged */ });
  }
  ```
  이 코드는 async 함수 내부이며 곧 `return result` 로 이어진다(호출부는 응답 직후 res.json).
- `backend/services/geocodeCacheService.js:376-381` — `resolveCoord` 내부:
  ```js
  const fromKakao = await kakaoGeocode(apt, _diag);
  if (fromKakao) {
    // fire-and-forget UPSERT (응답 지연 최소화)
    saveToDb(key, { ...apt, ...fromKakao });
    return fromKakao;
  }
  ```
- 레포의 수정 선례(따라야 할 모범): `backend/routes/cron.js` 의 RATE-WARM-2026-08-08 블록 —
  같은 이유로 `await` + 한글 근거 주석. 수정부 주석 헤더는 `// FREEZE-FIX-2026-XX-XX (Plan 003): ...`
  형식으로, "서버리스 동결로 미대기 promise 완주 보장 없음(RATE-WARM-2026-08-08 실측 선례)" 을 명기.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 테스트 | `cd backend && npm test` | 전부 pass |
| 구문 | `cd backend && node -c services/aiService.js && node -c services/geocodeCacheService.js` | exit 0 |

## Scope

**In scope**:
- `backend/services/aiService.js` — 두 카운터 호출에 await (265-272행 블록만)
- `backend/services/geocodeCacheService.js` — `resolveCoord` 의 `saveToDb(...)` 1곳에 await

**Out of scope**:
- `saveToDb` 내부 구현·`resolveCoordBatch`·백필 잡 — 백필은 요청 경로가 아니라 동결 무관.
- `backend/routes/region.js`·`server.js` 등의 Redis 캐시 워밍 rset(...).catch() — 순수 캐시라
  유실 영향 낮음(계획 작성 시 의도적으로 제외).
- `budget`/`globalAiBudget` 서비스 내부.

## Git workflow

- 커밋: `fix(cost): AI 비용 카운터·좌표 저장 await - 서버리스 동결 유실 차단 (Plan 003)`
- push 금지(운영자 지시 시에만).

## Steps

### Step 1: aiService 카운터 2건에 await

`backend/services/aiService.js:265-272` 의 두 호출을 `await` 로 바꾸되 `.catch(() => {})` 는
유지하라(실패 삼킴 불변):
```js
if (userId && response.usage) {
  await budget.recordUsage(userId, response.usage).catch(() => { /* already logged */ });
}
if (response.usage) {
  await globalAiBudget.recordGlobalAiUsage(response.usage).catch(() => { /* already logged */ });
}
```
주석의 "fire-and-forget" 문구를 실제 동작에 맞게 갱신하고 FREEZE-FIX 헤더를 남겨라.

**Verify**: `cd backend && node -c services/aiService.js` → exit 0

### Step 2: resolveCoord 의 saveToDb 에 await

`backend/services/geocodeCacheService.js` 의 `resolveCoord` 내 `saveToDb(key, {...})` 호출을
`await saveToDb(key, { ...apt, ...fromKakao }).catch(() => {})` 로 바꿔라 — `saveToDb` 는 내부에서
예외를 이미 삼키지만, 반환 promise 거부 가능성에 대비해 `.catch` 를 명시한다. 주석
"fire-and-forget UPSERT (응답 지연 최소화)" 를 FREEZE-FIX 근거로 교체.

**Verify**: `cd backend && node -c services/geocodeCacheService.js` → exit 0

### Step 3: 회귀 확인

**Verify**: `cd backend && npm test` → 전부 pass

## Test plan

- 신규 테스트 불요(제어 흐름 변경 없음 — await 추가). 기존 스위트 통과가 게이트.
- 배포 후 수동 확인(운영자/리뷰어): `/api/health` 의 AI 사용량·`apt_geocache` 신규 행이
  온디맨드 요청 후 실제로 남는지 — 계획 범위 밖(참고용).

## Done criteria

- [ ] `grep -n "await budget.recordUsage" backend/services/aiService.js` → 1 매치
- [ ] `grep -n "await globalAiBudget.recordGlobalAiUsage" backend/services/aiService.js` → 1 매치
- [ ] `resolveCoord` 내 `await saveToDb` 존재 (`grep -n "await saveToDb" backend/services/geocodeCacheService.js` → 1 매치)
- [ ] `cd backend && npm test` 전부 pass
- [ ] in-scope 밖 파일 무변경 (`git status --short`)
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- 발췌 위치의 코드가 다르면(드리프트) STOP.
- `saveToDb` 가 promise 를 반환하지 않는 구조로 보이면 STOP(억지로 감싸지 마라).
- await 추가로 기존 테스트가 깨지면 STOP(비동기 타이밍에 의존하는 숨은 계약이 있다는 뜻).

## Maintenance notes

- 응답 지연이 요청당 수십 ms(Redis/DB 왕복 1~2회) 증가한다 — 채팅/지오코딩 응답 시간에 민감한
  최적화를 하게 되면 이 두 await 를 지우는 대신 Vercel `waitUntil`(응답 후 실행 보장 API) 도입을
  검토하라. 지우면 유실이 재발한다.
- 리뷰 포인트: `.catch` 가 유지됐는지(제거되면 카운터 실패가 응답 실패로 승격 — 금지).
