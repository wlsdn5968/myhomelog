# Plan 007: Supabase 클라이언트 생성을 backend/db/client.js 단일 소스로 통합해 env명 드리프트 장애 클래스를 종결한다

> **Executor instructions**: 단계 순서대로, 각 검증 통과 후 진행. STOP 발생 시 보고.
> 완료 시 `plans/README.md` 상태 갱신.
>
> **Drift check (가장 먼저)**: `git diff --stat ee84415..HEAD -- backend/db/client.js backend/routes backend/services backend/jobs backend/middleware`
> 아래 "Current state" 의 패턴 분류와 실코드가 다르면 STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (24개 파일 기계적 치환 — 파일당 diff 는 작지만 접촉면이 넓음. 각 콜사이트의
  null/throw 의미 보존이 핵심)
- **Depends on**: none (006 과 독립 — 단 같은 파일을 만지는 transactionService 는 006 먼저 커밋 후 진행)
- **Category**: tech-debt + security-hygiene
- **Planned at**: commit `ee84415`, 2026-08-09

## Why this matters

공유 모듈 `backend/db/client.js`(getSupabaseAdmin/getSupabasePublic 싱글톤)가 있는데도 **24개
파일 · 약 29개 지점이 자체 `createClient` 를 복제**하고 있다. 이 산재는 실장애를 냈다:
2026-05-21 `458ddd4`(Sentry NODE-2) — `regulationsAiCheck.js` 만 `SUPABASE_SECRET_KEY` 라는 자기만의
env 를 읽어 cron 이 매 실행 실패했고, 커밋 메시지가 "코드베이스 표준은 SUPABASE_SERVICE_ROLE_KEY
(다른 17개 파일 모두 동일)" 라고 못박았다. 그 외에도: `billing.js:61` 인라인 생성은 유일하게 env
가드가 없고, "공개 읽기용" 클라이언트 4곳은 `PUBLISHABLE||ANON||SERVICE_ROLE` 폴백 체인을 각자
복제하며, `search.js` 의 `adminClient` 는 이름과 달리 공개 키 우선이라 이름-권한 불일치다.
생성 지점을 db/client.js 의 4개 팩토리로 모으면 env 드리프트·가드 누락·체인 복제가 원리적으로
재발 불가능해진다.

## Current state — 패턴 분류 (2026-08-09 전수조사, 본 계획의 마이그레이션 지도)

`backend/db/client.js` 현재 export: `{ getSupabaseAdmin, getSupabasePublic, schema }`.
- `getSupabaseAdmin()`: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY || service_role`, env 미설정 시
  `logger.warn` + **null 반환**, `{ auth: { persistSession: false, autoRefreshToken: false } }`, 싱글톤.
- `getSupabasePublic()`: `SUPABASE_PUBLISHABLE_KEY`, 동일 구조.

자체 createClient 지점 분류 (**실행 시 파일마다 직접 열어 아래 분류와 일치하는지 확인 후 치환**):

**(A) admin + env 미설정 시 throw** → `requireSupabaseAdmin(context?)` 로 치환:
| 파일:줄 | 비고 |
|---|---|
| `backend/middleware/auditLog.js:32` | |
| `backend/jobs/retention.js:44` | |
| `backend/jobs/regulationsAiCheck.js:42` | ⚠ `SUPABASE_SECRET_KEY||SERVICE_ROLE||service_role` 체인 — SECRET_KEY 우선순위는 **의도적으로 제거**(ENV-FIX-2026-05-21 주석이 "표준은 SERVICE_ROLE_KEY" 명시. 라이브는 SERVICE_ROLE_KEY 로 동작 중이므로 안전) |
| `backend/jobs/molitIngest.js:42` | 기존 메시지 "Supabase service_role 미설정 — ETL 불가" → `requireSupabaseAdmin('ETL 불가')` |
| `backend/jobs/aptMasterSync.js:40` | 동일 형태 |
| `backend/routes/account.js:55` | adminClient (회원탈퇴) |

**(B) admin + env 미설정 시 null 반환** → `getSupabaseAdmin()` 로 치환(콜사이트 null 체크 유지):
| 파일:줄 | 비고 |
|---|---|
| `backend/jobs/geocacheBackfill.js:198` | |
| `backend/jobs/facilityBackfill.js:33` | 동일 파일 L121-122 가 이미 `db/client` 지연 require — 치환 후 이중 인스턴스 자연 해소 |
| `backend/jobs/pushNotify.js:25` | |
| `backend/jobs/buildingRegisterBackfill.js:39` | |
| `backend/jobs/auditPrune.js:44` | |
| `backend/services/geocodeCacheService.js:44` | `DB_ENABLED` 게이트(L30) 있음 — Step 3 참조 |
| `backend/services/kakaoService.js:29` | `DB_ENABLED` 게이트(L25) |
| `backend/routes/kakao.js:37` | |
| `backend/services/popularService.js:51` | serviceClient |
| `backend/routes/push.js:28` | |
| `backend/services/schoolService.js:47` | `DB_ENABLED` 게이트(L29) |
| `backend/services/transactionService.js:27` | `DB_FIRST` 게이트(L22-23) — 이미 `||service_role` 폴백 보유 |

**(C) user-scoped (Bearer accessToken, per-request)** → `getUserScopedClient(accessToken)` 로 치환:
`backend/routes/account.js:45`, `billing.js:40`, `bookmarks.js:32`, `fieldNotes.js:29`,
`search.js:62`, `chatSessions.js:47` — 전부 동일 형태(throw '(Supabase 미설정)' + PUBLISHABLE_KEY +
`global.headers.Authorization: Bearer`). `fieldNotes.js` 만 옵션 키 순서가 반대(동작 동일).

**(D) 공개 읽기 폴백 체인 (`PUBLISHABLE||ANON||SERVICE_ROLE||service_role`)** → `getSupabaseReadonly()` 로 치환:
`backend/routes/search.js:78`(이름은 adminClient — 치환 시 지역 함수명도 정리),
`backend/services/popularService.js:42`(anonClient), `backend/services/regulationsService.js:119`
(snapshotClient — L108-112 에 "defense in depth, publishable 우선" 의도 주석 → db/client.js 로 이전),
`backend/jobs/regulationsCheck.js:36`.

**(E) 인라인 무가드**: `backend/routes/billing.js:61`(`/plans` 라우트) → `getSupabasePublic()` +
null 체크로 치환(기존 유일 무가드 → 표준 에러로 개선).

참고 발췌 — (C) 의 공통 형태(`backend/routes/billing.js:38-44`):
```js
function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 구문(파일별) | `cd backend && node -c <file>` | exit 0 |
| 테스트 | `cd backend && npm test` | 전부 pass |
| 산재 소멸 확인 | `grep -rln "@supabase/supabase-js" backend/ --include=*.js` | `backend/db/client.js` 와 `backend/test/*` 외 0건 |

## Scope

**In scope**: `backend/db/client.js` + 위 (A)~(E) 의 24개 파일 + `backend/test/characterization.test.js`.

**Out of scope**:
- `frontend/index.html`·`billing.html` 의 브라우저 클라이언트(CDN v2.45.4 — backend ^2.105.4 와
  버전 불일치는 백로그로 기록만) — 프론트 옵션(detectSessionInUrl 차이 등)은 의도된 설계.
- 이미 db/client 만 쓰는 파일들(auth.js, cron.js, feedback.js, report.js, news.js, planService.js,
  budgetService.js, aptFacilityService.js, buildingRegisterService.js, server.js) — 무변경.
- RLS 정책·env 값·키 체인의 **동작 변경**(폴백 체인 자체는 보존, 위치만 SSOT 로).
- Drizzle schema.js.

## Git workflow

- 커밋: `refactor(db): Supabase 클라이언트 생성 SSOT - 24개 파일 자체 createClient 제거 (Plan 007)`
- push 는 운영자 승인 후(이번 라운드는 사전 승인됨).

## Steps

### Step 1: db/client.js 에 팩토리 3종 추가

기존 두 함수는 무변경. 추가:
```js
/** admin 필수 경로용 — 미설정이면 throw (기존 각 파일의 throw형 가드 표준화) */
function requireSupabaseAdmin(context) {
  const c = getSupabaseAdmin();
  if (!c) throw new Error(`Supabase 미설정${context ? ' — ' + context : ''}`);
  return c;
}

/** 공개 읽기용 키 선택 — 순수 함수(테스트 고정용 export).
 *  publishable 우선(defense in depth: RLS 적용 키를 우선 사용하고, 공개읽기 RLS 가 열려있는
 *  테이블만 조회하므로 service_role 폴백도 동작상 안전) — 구 regulationsService 주석 이전 */
function _pickReadonlyKey(env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY
      || env.SUPABASE_SERVICE_ROLE_KEY || env.service_role || null;
}

let _readonly = null;
/** 공개 데이터 읽기용 (RLS 공개 SELECT 전제) — 미설정 시 null */
function getSupabaseReadonly() { /* 싱글톤, _pickReadonlyKey(process.env) 사용, 미설정 warn+null */ }

/** 로그인 사용자 RLS 컨텍스트 — per-request 생성(토큰별이라 싱글톤 금지), 미설정 throw */
function getUserScopedClient(accessToken) { /* PUBLISHABLE_KEY + Bearer 헤더, throw 'Supabase 미설정' */ }
```
`module.exports` 에 4종 + `_pickReadonlyKey` 추가.

**Verify**: `cd backend && node -c db/client.js` → exit 0

### Step 2: (A)·(C)·(D)·(E) 파일 치환

파일마다: 자체 팩토리 함수·`require('@supabase/supabase-js')`·전용 env 상수를 제거하고
db/client 의 해당 팩토리 호출로 교체. 지역 함수명을 유지해 콜사이트 diff 를 최소화해도 되고
(`const userScopedClient = getUserScopedClient;` 식 별칭 금지 — 직접 호출로 교체), 파일 내 사용처가
많으면 지역 래퍼 한 줄(`const adminClient = () => requireSupabaseAdmin();`)은 허용.

**Verify**: 파일마다 `node -c` → exit 0

### Step 3: (B) 파일 치환 — 게이트 의미 보존

- `DB_ENABLED`/`DB_FIRST` 를 env 상수로 계산하던 파일(geocodeCacheService·kakaoService·
  schoolService·transactionService)은 db/client.js 에 `hasAdminEnv()`(boolean, env 존재만 판정)를
  추가해 그걸로 계산식만 교체 — 게이트 동작 불변.
- 나머지는 `adminClient()` 지역 함수를 `getSupabaseAdmin()` 호출로 교체(null 체크 흐름 유지).

**Verify**: 파일마다 `node -c` → exit 0

### Step 4: 산재 소멸 + 회귀 확인

**Verify**:
- `grep -rln "@supabase/supabase-js" backend/ --include=*.js` → `backend/db/client.js` 만
- `cd backend && npm test` → 전부 pass

### Step 5: 테스트 추가

`characterization.test.js` 에 `_pickReadonlyKey` 체인 순서 4케이스 + `getUserScopedClient` env
미설정 시 throw 는 **환경 의존이라 테스트하지 말 것**(로컬 .env 유무로 flaky) — 순수 함수만 고정.

**Verify**: `cd backend && npm test` → 전부 pass

## Test plan

- `_pickReadonlyKey`: publishable 만 → publishable, anon+service → anon, service 만 → service,
  `service_role`(소문자) 만 → 그 값, 빈 객체 → null.
- 기존 15개 테스트 전부 통과가 회귀 게이트. 마이그레이션 자체는 배포 후 라이브 실측으로 검증
  (transactions·search/apt·popular·billing/plans — 각각 (B)(D)(D)(E) 경로 커버. (C) user-scoped 는
  로그인 세션 필요 — 운영자 Chrome 또는 Sentry 관찰).

## Done criteria

- [ ] `grep -rln "@supabase/supabase-js" backend/ --include=*.js` → db/client.js (와 테스트 파일) 만
- [ ] `grep -rn "SUPABASE_SECRET_KEY" backend/` → 0 매치
- [ ] `cd backend && npm test` 전부 pass
- [ ] 각 (A) 파일의 throw 의미·각 (B) 파일의 null-게이트 의미가 보존됨(파일별 diff 리뷰)
- [ ] `plans/README.md` 상태 갱신

## STOP conditions

- 어떤 파일의 실코드가 위 분류표와 다르면(예: 표에 없는 옵션, 다른 키 체인) 그 파일은 건너뛰고
  기록 후 계속 — 3개 이상 불일치면 전체 STOP(조사 자체가 드리프트).
- 치환 후 기존 테스트 실패 시 STOP.
- (C) 치환에서 Bearer 헤더 형태를 바꾸고 싶어지면 STOP — RLS auth.uid() 의존 경로.
- `getSupabasePublic` 과 `getSupabaseReadonly` 를 합치고 싶어지면 STOP — 폴백 체인 유무가 다른
  의도된 두 정책이다.

## Maintenance notes

- 새 파일에서 Supabase 접근이 필요하면 **무조건 db/client.js 의 팩토리** — `createClient` 직접 호출
  금지. 리뷰에서 `@supabase/supabase-js` require 가 새로 생기면 반려.
- 프론트 CDN v2.45.4 vs backend ^2.105.4 버전 불일치는 이번 범위 밖 백로그.
- 싱글톤화로 웜 인스턴스가 요청 간 공유됨 — admin/readonly 는 무상태 REST 라 안전. user-scoped 는
  절대 싱글톤화하지 말 것(토큰 누수).
