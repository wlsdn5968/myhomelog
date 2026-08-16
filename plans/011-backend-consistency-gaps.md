# Plan 011: 백엔드 일관성 공백 3건 — 미대기 저장, 상한 없는 RPC, 사실과 다른 주석

> **Executor instructions**: 이 계획을 단계대로 따르라. 각 단계의 검증 명령을 실행해
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP conditions" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **Drift check (가장 먼저 실행)**:
> `git diff --stat 9031f65..HEAD -- backend/routes/search.js backend/routes/cron.js`
> 바뀌었다면 아래 "Current state" 발췌와 실제 코드를 대조하라. 다르면 STOP 조건이다.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9031f65`, 2026-08-16

## Why this matters

세 건 모두 **이 저장소가 이미 채택한 패턴이 한 곳에만 적용되지 않은** 경우다. 새 규칙을 만드는
게 아니라 기존 규칙을 마저 적용하는 작업이라 판단 여지가 적고 위험이 낮다.

1. **미대기 저장(A)**: Vercel 서버리스는 응답을 보낸 뒤 인스턴스를 동결한다. 응답 후에 남은
   비동기 쓰기는 유실될 수 있다. 2026-08-09 Plan 003 이 정확히 이 이유로 좌표 저장을
   `await` 로 고쳤는데, 인기단지 스냅샷 저장은 그때 함께 고쳐지지 않았다. 유실되면 스냅샷이
   노화하고, 그러면 사용자 요청이 무거운 라이브 집계를 다시 타는 악순환으로 돌아간다.

2. **상한 없는 RPC(B)**: 2026-08-16 에 DB 호출마다 명시적 타임아웃 상한을 거는 패턴을
   도입했는데(검색 본조회 2.5s·후처리 1s·인기 스냅샷 RPC), 같은 날 추가된 MV 갱신 RPC 만
   상한이 없다. 이 호출이 지연되면 뒤따르는 `recordCronRun` 과 `res.json` 이 실행되지 못해
   — **적재가 성공했더라도 그날 cron 실행 기록 자체가 health 에 남지 않는다.**

3. **사실과 다른 주석(C)**: "프론트는 아직 쓰지 않지만" 이라 적혀 있으나 프론트는 이미 이 필드로
   사용자 안내 배너를 그린다. 이 주석을 믿고 필드를 정리하면 배너가 조용히 사라진다.

## Current state

### A — 미대기 저장, `backend/routes/search.js:571-577`

```js
    const payload = { results: out };
    if (out.length) cache.set(pck, payload, usedFallback ? 120 : 1800); // 빈 응답은 캐시 안 함
    // 정상 품질(RPC 성공본)이면 스냅샷도 갱신 — 다음 콜드 사용자를 위해 (fire-and-forget)
    if (!usedFallback && out.length && limit === 12) {
      storePopularSnapshot(out).catch(() => {});
    }
    return res.json(payload);
```

`storePopularSnapshot(...)` 앞에 `await` 가 없고, 주석도 "fire-and-forget" 이라 적고 있다.

**따라야 할 정답 패턴** — `backend/services/geocodeCacheService.js:432-435` (Plan 003 이 만든 것):

```js
    // FREEZE-FIX-2026-08-09 (Plan 003): fire-and-forget UPSERT 는 서버리스 동결로 유실될 수 있어
    //   (RATE-WARM-2026-08-08 실측 선례) 저장이 안 되면 같은 단지 재요청마다 Kakao 를 다시 호출한다
    //   — 응답 전에 완주(수십 ms). 실패는 기존대로 삼킨다.
    await saveToDb(key, { ...apt, ...fromKakao }).catch(() => {});
```

`await ... .catch(() => {})` — **대기하되 실패는 삼킨다.** 이 형태를 그대로 쓰라.

### B — 상한 없는 RPC, `backend/routes/cron.js:193-204`

```js
    let _mvRefreshMs;
    try {
      const sc = require('../db/client').getSupabaseAdmin();
      if (!sc) {
        logger.warn('검색 MV 갱신 skip — service_role 미설정(적재는 정상)');
      } else {
        const _t = Date.now();
        const { error: _mvErr } = await sc.rpc('refresh_molit_apt_index');
        if (_mvErr) logger.warn({ err: _mvErr.message }, '검색 MV 갱신 실패 — 적재는 정상(다음 cron 재시도)');
        else _mvRefreshMs = Date.now() - _t;
      }
    } catch (e) { logger.warn({ err: e.message }, '검색 MV 갱신 예외 — 적재는 정상'); }
```

`sc.rpc('refresh_molit_apt_index')` 에 `abortSignal` 이 없다.

같은 저장소의 상한 적용 예 — `backend/routes/search.js` 안에 상수와 사용처가 있다:
`MOLIT_ABORT_MS`(본조회), `ENRICH_ABORT_MS`(후처리)를 정의하고
`.abortSignal(AbortSignal.timeout(<상수>))` 를 체이닝한다. Node 20+ 라 `AbortSignal.timeout` 을 쓸 수 있다
(`backend/package.json` 의 `engines.node: ">=20"`).

⚠ 이 저장소는 **abort 시 postgrest-js 가 예외가 아니라 `{data:null, error}` 로 반환**한다는 사실을
확인해 두었고, 그에 맞춰 `search.js` 에 `_softQuery`/`_isAbortErr` 헬퍼를 두었다. 다만 여기 B 는
이미 `try/catch` + `if (_mvErr)` 로 양쪽을 모두 흡수하므로 **추가 헬퍼가 필요 없다.**

### C — 사실과 다른 주석, `backend/routes/search.js:509-511`

```js
    // degraded 를 응답에 명시 — 프론트는 아직 쓰지 않지만, 이 경로는 로그가 1시간이면 사라져
    //   "이 응답이 반쪽이었나"를 사후에 확인할 방법이 없다. 위장하지 않기 위한 표식.
    const payload = _degraded ? { results: out, query: q, degraded: true } : { results: out, query: q };
```

프론트는 이미 쓴다 — `frontend/index.html:9903`:

```js
      const _degNote = j.degraded
```

(이 필드로 "⚠ 일부 데이터를 불러오지 못해 결과가 불완전해요" 배너를 그린다.)

### 저장소 관례

- 주석은 한글. **무엇을 했는지가 아니라 왜 그런지**를 남긴다 — 기존 주석들이 전부 그렇다.
- 변경에 태그를 붙인다: `<TAG>-YYYY-MM-DD (Plan NNN)` 형식(예: `FREEZE-FIX-2026-08-09 (Plan 003)`).

## Commands you will need

| 목적 | 명령 | 성공 시 기대 결과 |
|---|---|---|
| 문법 검사 | `node -c backend/routes/search.js && node -c backend/routes/cron.js` | exit 0 |
| 로드 검사 | `node -e "require('./backend/routes/search.js'); require('./backend/routes/cron.js'); console.log('LOAD OK')"` | `LOAD OK` |
| 백엔드 테스트 | `cd backend && npm test` | exit 0, 41 pass |
| 보안 회귀 가드 | `node scripts/security-regression-check.js` | exit 0 |

> `node -c` 는 **import 누락을 잡지 못한다.** 이 저장소는 그 때문에 `node -e require()` 로드 검사를
> 함께 돌리는 관례가 있다. 둘 다 실행하라.

## Scope

**In scope**:
- `backend/routes/search.js` — A(1줄 + 주석), C(주석만)
- `backend/routes/cron.js` — B(1줄 + 상수/주석)

**Out of scope** (손대지 마라):
- `backend/services/geocodeCacheService.js` — **이미 정답이다.** 참고만 하라.
- `backend/services/popularService.js` — `storePopularSnapshot` 구현 자체는 바꾸지 않는다.
  호출 지점만 고친다.
- `search.js` 의 `_softQuery`/`_isAbortErr` 헬퍼 — B 에는 필요 없다(위 이유 참조).
- 프론트(`frontend/index.html`) — C 는 백엔드 주석만 고치는 것이다.

## Git workflow

- 현재 브랜치에서 작업한다(`master` 직접 커밋 관례 — `git log` 확인).
- 커밋 메시지 예: `fix(search,cron): 미대기 스냅샷 저장·MV RPC 상한·주석 정정 (Plan 011)`
  본문에 `[근본 원인] [Fix 내용] [회귀 위험]` 을 한글로.
- **push 하지 마라** — 운영자 승인 후에만 한다.

## Steps

### Step 1: A — 인기단지 스냅샷 저장을 대기한다

`backend/routes/search.js:575` 를 `await` 형태로 바꾼다:

```js
      await storePopularSnapshot(out).catch(() => {});
```

그리고 573행의 "(fire-and-forget)" 표현을 지우고, **왜 대기하는지**를 주석에 남긴다 —
서버리스 동결로 유실되면 스냅샷이 노화하고 사용자가 라이브 집계를 다시 타게 된다는 점,
Plan 003(`geocodeCacheService.js:432-435`)과 같은 이유라는 점을 적어라.

⚠ 이 코드가 `async` 함수 안에 있는지 먼저 확인하라(`router.get('/popular', async (req, res) => {`).
아니면 STOP 조건이다.

**Verify**:
- `grep -n "await storePopularSnapshot" backend/routes/search.js` → 1건
- `grep -n "storePopularSnapshot(out).catch" backend/routes/search.js` 결과에 `await` 가 없는 줄이 **없다**
- `node -c backend/routes/search.js` → exit 0

### Step 2: B — MV 갱신 RPC 의 실제 소요를 먼저 재고, 그 근거로 상한을 정한다

**측정 없이 숫자를 정하지 마라.** 먼저 프로덕션 DB 에서 갱신 소요를 잰다(읽기 아님 — 갱신이지만
`CONCURRENTLY` 라 읽기를 막지 않는다). Supabase MCP 또는 콘솔 SQL Editor 에서:

```sql
\timing on
REFRESH MATERIALIZED VIEW CONCURRENTLY molit_apt_index;
```

`\timing` 이 안 되는 환경이면 실행 전후 시각을 기록하라.

측정값을 근거로 상한을 정한다: **측정치의 약 3배, 최소 60초, 최대 120초** 범위에서 고르고,
왜 그 값인지(측정치 얼마 × 배수)를 주석에 남겨라.

그다음 `backend/routes/cron.js:200` 을 다음 형태로 바꾼다:

```js
        const { error: _mvErr } = await sc.rpc('refresh_molit_apt_index')
          .abortSignal(AbortSignal.timeout(MV_REFRESH_ABORT_MS));
```

`MV_REFRESH_ABORT_MS` 상수는 `cron.js` 파일 상단(다른 상수들 근처)에 정의하고, 위 측정 근거를
주석으로 남긴다.

⚠ `.rpc()` 반환값에 `.abortSignal()` 을 체이닝할 수 있는지 먼저 확인하라 — 이 저장소의
`@supabase/supabase-js` 는 `^2.105.4` 이고 `postgrest-js` 의 빌더가 `abortSignal(signal)` 을 제공한다.
체이닝이 타입/런타임에서 실패하면 STOP 조건이다.

**Verify**:
- `grep -n "MV_REFRESH_ABORT_MS" backend/routes/cron.js` → 정의 1건 + 사용 1건 = 2건
- `node -c backend/routes/cron.js` → exit 0
- `node -e "require('./backend/routes/cron.js'); console.log('LOAD OK')"` → `LOAD OK`

### Step 3: C — 사실과 다른 주석을 고친다

`backend/routes/search.js:509` 의 "프론트는 아직 쓰지 않지만" 을 지운다.
프론트가 이 필드로 강등 안내 배너를 그린다는 사실과 **위치**(`frontend/index.html` 의
`j.degraded` 사용부)를 적어, 나중에 이 필드를 지우려는 사람이 영향 범위를 알 수 있게 하라.
관측용 표식이라는 기존 설명은 유지한다.

**Verify**: `grep -n "프론트는 아직 쓰지 않지만" backend/routes/search.js` → **0건**

### Step 4: 전체 검증

```
node -c backend/routes/search.js && node -c backend/routes/cron.js
node -e "require('./backend/routes/search.js'); require('./backend/routes/cron.js'); console.log('LOAD OK')"
node scripts/security-regression-check.js
cd backend && npm test
```

**Verify**: 순서대로 exit 0 / `LOAD OK` / "위반 0건" / 41 pass.

## Test plan

- **새 단위 테스트는 추가하지 않는다.** 세 변경 모두 순수 함수가 아니라 라우트 내부의
  실행 순서·타임아웃·주석이라, 이 저장소의 테스트 방식(순수 함수 characterization)으로는
  의미 있게 고정하기 어렵다. 무리해서 모킹 테스트를 만들지 마라 — 모킹을 검증하는 테스트가 된다.
- 검증은 위 Step 별 grep + 문법/로드 검사 + 기존 41개 테스트 무회귀로 한다.
- **배포 후 관측으로 확인할 것**(이 계획의 실행자는 배포하지 않는다 — 운영자에게 인계):
  다음 molit-ingest cron 실행 뒤 `GET /api/health` 의 `crons['molit-ingest']` 에
  `mvRefreshMs` 필드가 존재하는지. 존재하면 B 가 정상 동작한 것이다.

## Done criteria

전부 만족해야 한다:

- [ ] `grep -n "await storePopularSnapshot" backend/routes/search.js` → 1건
- [ ] `grep -c "fire-and-forget" backend/routes/search.js` → 0 (해당 표현 제거)
- [ ] `grep -n "MV_REFRESH_ABORT_MS" backend/routes/cron.js` → 2건(정의+사용)
- [ ] `grep -n "프론트는 아직 쓰지 않지만" backend/routes/search.js` → 0건
- [ ] `node -c` 2파일 exit 0
- [ ] `node -e require()` 로드 검사 → `LOAD OK`
- [ ] `node scripts/security-regression-check.js` exit 0
- [ ] `cd backend && npm test` exit 0, 41 pass
- [ ] `git status` 에 `backend/routes/search.js`, `backend/routes/cron.js` 외 변경 없음
- [ ] `plans/README.md` 의 011 행 Status 갱신

## STOP conditions

멈추고 보고하라:

- 위 세 위치의 코드가 "Current state" 발췌와 다르다(드리프트).
- Step 1 의 호출부가 `async` 함수 안이 아니다 → `await` 를 넣을 수 없다.
- Step 2 에서 MV 갱신 소요를 **측정하지 못했다** → 상한 값을 추측으로 정하지 마라.
- Step 2 에서 `.rpc(...).abortSignal(...)` 체이닝이 런타임 오류를 낸다.
- MV 갱신 측정치가 60초를 넘는다 → 상한만으로 해결할 문제가 아니다(갱신 자체가 무겁다는 뜻).
- 기존 41개 테스트 중 하나라도 깨진다.

## Maintenance notes

- **서버리스 동결 규칙**: 응답(`res.json`) 이후에 남는 비동기 작업은 유실될 수 있다. 이 저장소는
  "응답 전에 완주시키되 실패는 삼킨다"(`await ... .catch(() => {})`)로 통일한다.
  새 코드에서 `.catch(() => {})` 만 있고 `await` 가 없는 저장·기록 호출을 보면 같은 결함이다.
- **DB 호출 상한 규칙**: 2026-08-16 이후 이 저장소의 DB 호출은 명시적 abort 상한을 갖는다.
  새 RPC/쿼리를 추가할 때 상한을 빼먹지 말 것. 값은 **측정 후** 정한다.
- B 를 넣은 뒤에도 MV 갱신이 자주 상한에 걸린다면, 그건 상한 문제가 아니라 갱신 주기·방식
  (예: cron slot 3개가 같은 MV 를 15분 간격으로 갱신하며 겹치는 구조)을 봐야 한다는 신호다.
- 리뷰어가 볼 곳: `await` 가 응답 전에 있는지, 상한 값의 **근거가 주석에 있는지**(숫자만 있으면 반려).
