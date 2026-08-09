# Plan 002: 공개 geocode 라우트에 일일 총량 캡을 걸어 Kakao 쿼터 고갈 증폭 벡터를 막는다

> **Executor instructions**: 단계 순서대로 진행하고 각 검증을 통과한 뒤 넘어가라.
> "STOP conditions" 발생 시 멈추고 보고. 완료 시 `plans/README.md` 상태 갱신.
>
> **Drift check (가장 먼저)**: `git diff --stat b63da64..HEAD -- backend/routes/geocode.js backend/server.js backend/middleware/`
> in-scope 파일이 변경됐다면 "Current state" 발췌와 대조, 불일치 시 STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (캡을 너무 조이면 정상 지도 렌더링 저해 — 임계값 보수적으로)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `b63da64`, 2026-08-09

## Why this matters

`POST /api/geocode` 와 `POST /api/geocode/batch` 는 인증·일일한도 없이 IP 분당 30요청
(`dataLimiter`)만으로 열려 있다. 요청 body 의 자유 텍스트가 캐시 키가 되므로 공격자는 매 요청
캐시 미스를 보장할 수 있고, batch 1건(50 items)× 내부 다단계 Kakao 폴백으로 요청당 수백 회의
실제 Kakao 호출을 유발할 수 있다. 단일 IP 로도 Kakao 일일 무료 쿼터(10만, 내부 경고선 6만)를
수십 분 안에 소진 가능 — 쿼터 고갈 시 지도 마커·좌표·주변시설 등 지오코딩 의존 기능 전체가
전 사용자 대상으로 다운된다(가용성 장애). 로그인 강제는 프론트가 익명 상태로 이 라우트를 실사용
중이라 회귀를 일으킨다 — 해법은 **IP 일일 캡 + 서비스 전역 일일 캡**의 이중 상한이다.

## Current state

- `backend/server.js:195` — 마운트: `app.use('/api/geocode', dataLimiter, geocodeRouter);`
  (인증·dailyLimit 없음). `dataLimiter` 정의는 `server.js:140-143`:
  ```js
  const dataLimiter = makeRateLimiter({
    limit: 30,
    windowSec: 60,
    scope: 'data',
  ```
- `backend/routes/geocode.js:85-99` — 단건: 캐시 키 `geo:${aptName}|${sgg}|${umd}|${area||''}`
  (요청 텍스트 그대로), 미스 시 `kakaoGeocode(...)` (같은 파일 10~82행, 다단계 폴백).
- `backend/routes/geocode.js:106-135` — batch: `MAX_BATCH_ITEMS = 50`, 동시성 5 청크 순차.
  아이템별로 단건과 동일한 캐시 키·폴백.
- 비교 대상(레포에 이미 있는 일일 한도 패턴):
  - `backend/middleware/` 의 `dailyLimit` — `server.js:187` 사용례:
    `dailyLimit({ limit: DAILY_SEARCH_LIMIT, scope: 'search', loggedInBonus: 5 })`.
    IP(비로그인)/userId(로그인) 기준 일일 카운터. **이 미들웨어를 재사용하는 것이 1차 수단.**
  - 전역(서비스 단위) 일일 상한 패턴: `backend/services/globalAiBudget.js` — Redis 카운터로
    "전체 사용량 상한 도달 시 차단"을 구현한 선례. 전역 캡의 모범.
- 참고: 지도 초기 로드 시 프론트가 batch 를 수십 건 이하로 호출한다(geocode.js:103-104 주석
  "정상 프론트 호출(needGeo 수십 건 이하)"). 정상 사용자의 하루 지도 사용을 막지 않게
  IP 캡은 넉넉히(예: 일 60회 요청), 전역 캡은 Kakao 경고선 훨씬 아래(예: 일 8,000 Kakao 콜)로.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 테스트 | `cd backend && npm test` | 전부 pass |
| 구문 | `cd backend && node -c routes/geocode.js && node -c server.js` | exit 0 |

## Scope

**In scope**:
- `backend/server.js` — 195행 마운트 라인에 미들웨어 추가만
- `backend/routes/geocode.js` — 전역 캡 카운터 로직 추가
- `backend/test/characterization.test.js` — 캡 판정 순수 함수 테스트(전역 캡을 순수 함수로
  분리했을 때)

**Out of scope**:
- `frontend/index.html` — 프론트 호출부 변경 금지(익명 호출은 유지되어야 함).
- `backend/middleware/` 의 기존 미들웨어 구현 변경 — 재사용만 하라.
- `backend/services/geocodeCacheService.js` — 백필/서버측 지오코딩 경로는 별개(건드리지 마라).
- Kakao 키·쿼터 설정 자체.

## Git workflow

- 커밋: `fix(sec): 공개 geocode 라우트 IP 일일캡 + 전역 일일캡 - Kakao 쿼터 고갈 증폭 차단 (Plan 002)`
- push 금지(운영자 지시 시에만).

## Steps

### Step 1: IP 일일 캡 — 기존 `dailyLimit` 재사용

`backend/server.js:195` 를 다음 형태로 변경(미들웨어 추가만):
```js
app.use('/api/geocode', dataLimiter, dailyLimit({ limit: 60, scope: 'geocode' }), geocodeRouter);
```
`dailyLimit` 의 import 가 그 파일 상단에 이미 있는지 확인하고(187행에서 쓰므로 있음), scope
문자열은 다른 scope('search'/'chat')와 충돌하지 않는 신규 값 'geocode' 를 쓴다.

**Verify**: `cd backend && node -c server.js` → exit 0

### Step 2: 전역 일일 캡 — geocode.js 에 Redis 카운터

`backend/routes/geocode.js` 에 전역 카운터를 추가하라. 요구사항:
- Kakao 를 **실제 호출하기 직전에만** 증가(캐시 히트는 카운트 없음).
- Redis 키 예: `geocap:${YYYYMMDD}`(UTC), TTL 2일. `require('../services/redisCache')` 의
  rget/rset 은 get/set 용이므로, 원자 증가가 필요하면 `require('../redis').getRedis()` 로
  Upstash client 를 얻어 `incr` + `expire` 를 써라(레포 내 선례: `backend/services/globalAiBudget.js`
  를 열어 카운터 패턴을 확인하고 그 모양을 따르라).
- 일일 상한 상수 `GEOCODE_GLOBAL_DAILY_CAP = 8000` (파일 상단, 한글 주석으로 근거 명기:
  Kakao 경고선 60,000 의 13% — 백필 cron 등 다른 소비자 여유 확보).
- 상한 도달 시: Kakao 호출 없이 `{ lat: null, lng: null, error: 'quota' }` 반환(단건),
  batch 는 해당 아이템만 null. **500 을 던지지 마라** — 프론트는 null 좌표를 마커 생략으로
  이미 graceful 처리한다.
- Redis 미설정 시(getRedis() null) 카운터는 no-op — 기존 동작 유지(fail-open, 레포 컨벤션).

**Verify**: `cd backend && node -c routes/geocode.js` → exit 0

### Step 3: 캡 판정을 순수 함수로 분리 + 테스트

Step 2 의 "카운트 값·상한 → 허용/차단" 판정을 순수 함수(예: `_geocodeCapExceeded(count, cap)`)
로 분리해 export 하고, `backend/test/characterization.test.js` 에 경계 테스트를 추가하라:
- count=cap-1 → 허용, count=cap → 차단, count=null/undefined(Redis 미설정) → 허용.
- 구조 패턴: 같은 파일의 `cronStats._pick` 테스트를 모범으로.

**Verify**: `cd backend && npm test` → 전부 pass + 신규 테스트 포함

## Test plan

- 위 Step 3 의 경계 3케이스.
- 수동 스모크(로컬 서버 가능 시): 단건 POST 2회 — 첫 회 Kakao 경로, 둘째 회 캐시 히트(fromCache).

## Done criteria

- [ ] `cd backend && npm test` 전부 pass(신규 테스트 포함)
- [ ] `grep -n "scope: 'geocode'" backend/server.js` → 1 매치(마운트 라인)
- [ ] `grep -n "GEOCODE_GLOBAL_DAILY_CAP" backend/routes/geocode.js` → 상수 정의 + 사용부 매치
- [ ] in-scope 밖 파일 무변경 (`git status --short`)
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- `dailyLimit` 미들웨어 시그니처가 발췌(`{ limit, scope, loggedInBonus }`)와 다르면 STOP —
  임의 개조 금지.
- `globalAiBudget.js` 를 열었는데 Redis incr 패턴이 없거나 전혀 다른 구조면 STOP(모범 부재 —
  설계 재검토 필요).
- 프론트 회귀 의심(익명 지도 로드가 429/차단되는 구조가 되어버리면) — 캡 상수만 올리는 게 아니라
  설계를 재보고하라.

## Maintenance notes

- 임계값(IP 60/일, 전역 8,000/일)은 보수적 초기값 — 운영에서 정상 트래픽이 걸리면 상향은
  상수 수정 1줄. health 에 geocap 카운터를 노출하는 관측 확장은 후속 자유(cronStats 패턴).
- 리뷰 포인트: 캐시 히트 경로에서 카운터가 증가하지 않는지(증가하면 정상 사용자가 조기 차단됨).
