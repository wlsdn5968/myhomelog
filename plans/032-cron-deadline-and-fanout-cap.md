# Plan 032: cron 하나에 빠진 데드라인 가드를 이식하고, 외부 API 팬아웃에 동시성 상한을 건다

> **Executor instructions**: 단계별로 따르라. 각 단계의 검증 명령을 실행하고 기대 결과를 확인한 뒤
> 다음으로 넘어가라. "STOP conditions" 에 해당하면 **즉시 멈추고 보고**하라.
> 끝나면 `plans/README.md` 의 상태 행을 갱신하라.
>
> **Drift check (가장 먼저)**:
> `git diff --stat 530ca3c..HEAD -- backend/jobs/aptMasterSync.js backend/routes/report.js`
> 바뀌었으면 아래 "Current state" 인용과 대조하고, 다르면 STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `530ca3c`, 2026-08-17

## Why this matters

이 저장소는 이미 두 가지 방어 관례를 갖고 있다 — **cron 은 `maxDuration` 전에 스스로 멈춘다**,
**외부 API 팬아웃은 동시성을 명시적으로 제한한다.** 두 관례 모두 실제 사고를 겪고 도입됐다.

문제는 **한 곳씩 빠져 있다는 것**이다:

- `aptMasterSync` 만 데드라인 가드가 없다. 다른 backfill job 4개에는 전부 있다.
  AptInfo API 가 느려지면 82개 지역 루프가 300s 를 넘겨 **임의 시점에 잘린다.**
- 보고서의 amenities 조회만 동시성 상한이 없다. 콜드 캐시일 때 **최대 20×6 = 120 개의 Kakao
  호출이 동시에** 나갈 수 있다. 다른 곳은 전부 3~8 로 묶여 있다.

둘 다 "지금 당장 터지고 있다" 는 증거는 없다. 고치는 이유는 **이미 검증된 패턴이 한 곳에만 빠져
있고, 이식 비용이 거의 0** 이기 때문이다. 관례가 일관되면 다음 사람이 새 job 을 쓸 때 그대로 따른다.

## Current state

### A) `aptMasterSync` — 가드 없음

`backend/jobs/aptMasterSync.js:190` 부터:

```js
async function runAptMasterSync() {
  if (!APT_INFO_KEY || APT_INFO_KEY === 'your_molit_api_key') { ... }
  const admin = adminClient();
  const codes = Object.values(LAWD_CODES);
  const started = Date.now();
  const results = [];

  // 동시 5 worker (AptInfo 는 MOLIT 보다 rate limit 여유 — 보통 일 10K 호출 가능)
  const queue = [...codes];
  async function worker() {
    while (queue.length) {
      const code = queue.shift();
      if (!code) break;
      try {
        const r = await syncOneSgg(admin, code);
        results.push(r);
      } catch (e) {
        logger.warn({ err: e.message, code }, 'syncOneSgg 실패');
        results.push({ lawdCd: code, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
```

`started` 는 있지만 **경과 시간을 측정만 하고(`elapsedMs`) 중단에는 쓰지 않는다.**

### B) 이미 있는 검증된 패턴 (이식 대상)

`backend/jobs/molitIngest.js:402`:

```js
  const HARD_DEADLINE = started + 250000;
```

`backend/jobs/molitIngest.js:418`:

```js
      if (Date.now() > HARD_DEADLINE) break; // maxDuration 보호 — 남은 큐는 다음 run 이 이어받음(멱등)
```

같은 패턴이 `facilityBackfill.js`, `geocacheBackfill.js`, `buildingRegisterBackfill.js` 에도 있다
(`grep -l "HARD_DEADLINE\|budgetMs" backend/jobs/*.js` 로 확인 가능 — 4개 파일).

**핵심**: 이 패턴이 안전한 이유는 **작업이 멱등이라 남은 큐를 다음 run 이 이어받기 때문**이다.
`aptMasterSync` 의 `syncOneSgg` 도 upsert 기반이므로 같은 성질을 갖는다.

### C) amenities 팬아웃 — 상한 없음

`backend/routes/report.js:1209`:

```js
    // amenities 병렬 (좌표 있는 단지만)
    await Promise.all(out.map(async (c) => {
      if (!c.lat || !c.lng) return;
      try {
        const amen = await getNearbyAmenities(c.lat, c.lng);
        if (amen) {
          c.amenities = amen; // { school, mart, hospital(종합병원), subway, cvs, park }
        }
      } catch (e) {
        logger.warn({ err: e.message, apt: c.apt_name }, 'amenities 호출 실패');
      }
    }));
```

`out` 은 최대 20개이고, `getNearbyAmenities` 하나가 내부에서 Kakao 를 6번 부른다.
→ 콜드 캐시 시 최대 120 동시 호출.

**주의**: `getNearbyAmenities` 내부에는 캐시가 있다(3일). 그래서 **캐시가 더운 대부분의 경우엔
상한을 걸어도 체감 변화가 없다.** 이 수정은 콜드 케이스의 버스트만 막는다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 문법 | `node -c backend/jobs/aptMasterSync.js && node -c backend/routes/report.js` | exit 0 |
| 백엔드 테스트 | `cd backend && npm test` | 72 pass, 0 fail |
| 보안 가드 | `node scripts/security-regression-check.js` | 위반 0건 |
| 패턴 확인 | `grep -l "HARD_DEADLINE\|budgetMs" backend/jobs/*.js` | 수정 후 5개 파일 |

## Scope

**In scope**:
- `backend/jobs/aptMasterSync.js`
- `backend/routes/report.js` (amenities 블록만)
- `plans/README.md` (상태 행)

**Out of scope** (건드리지 마라):
- `syncOneSgg` 내부의 재시도·백오프 로직 — 이미 `MAX_PAGE_RETRY` 로 설계돼 있다.
- worker 개수(5) — rate limit 근거가 주석에 있다. 바꾸지 마라.
- `vercel.json` 의 `maxDuration` — 값 변경은 별도 판단이다.
- `getNearbyAmenities` / `kakaoService.js` 내부 — 캐시·호출 구조를 바꾸지 마라.
  **이 계획은 호출부에서 동시성만 제한한다.**
- `backend/jobs/pushNotify.js` — 감사에서 검토했으나 **구독자 실측 3명**이라 지금은 무해로 판정,
  의도적으로 범위에서 제외했다. 손대지 마라.

## Git workflow

- 브랜치: `advisor/032-cron-deadline-and-fanout-cap`
- 커밋 메시지: `perf(jobs): <한글 설명>` / `perf(report): <한글 설명>`
- **push·PR 금지.**

## Steps

### Step 1: `aptMasterSync` 에 데드라인 상수 추가

`const started = Date.now();` 바로 아래에 추가한다. **다른 job 과 같은 값(250000)** 을 쓰고,
왜 이 값인지 주석으로 남겨라.

```js
  // DEADLINE-2026-08-17 (Plan 032): 다른 backfill job(molitIngest·facility·geocache·buildingRegister)
  //   과 동일한 maxDuration 보호. AptInfo 가 느려지면 82개 지역 루프가 300s 를 넘겨 임의 시점에
  //   잘린다. syncOneSgg 는 upsert 기반(멱등)이라 남은 큐는 다음 run 이 그대로 이어받는다.
  const HARD_DEADLINE = started + 250000;
```

**Verify**: `grep -c HARD_DEADLINE backend/jobs/aptMasterSync.js` → 1 이상

### Step 2: worker 루프에 중단 조건 추가

`worker()` 의 `while (queue.length)` 안, **`queue.shift()` 앞**에 넣는다.

```js
    while (queue.length) {
      if (Date.now() > HARD_DEADLINE) break; // maxDuration 보호 — 남은 큐는 다음 run 이 이어받음(멱등)
      const code = queue.shift();
```

**Verify**:
- `node -c backend/jobs/aptMasterSync.js` → exit 0
- `grep -l "HARD_DEADLINE\|budgetMs" backend/jobs/*.js` → **5개 파일**(기존 4 + aptMasterSync)

### Step 3: 중단 사실을 로그에 남긴다

가드가 실제로 발동했는지 나중에 알 수 있어야 한다. 이 job 의 기존 `logger.info({ source: 'apt-master-sync', ... })`
블록에 **남은 큐 길이**를 필드로 추가하라.

```js
    remaining: queue.length,   // >0 이면 데드라인에 걸려 중단됐다는 뜻 — 다음 run 이 이어받는다
```

**정직성 규칙**: 필드 이름을 지어내지 말고, 그 블록의 기존 필드 작명 스타일(`sggs`, `fetched` 등
소문자 카멜)을 따르라.

**Verify**: `node -c backend/jobs/aptMasterSync.js` → exit 0

### Step 4: amenities 팬아웃에 동시성 상한

`backend/routes/report.js:1209` 의 `await Promise.all(out.map(...))` 를 **청크 단위 순차**로 바꾼다.
**콜백 본문은 한 글자도 바꾸지 마라** — 청크로 나누는 것만 한다.

```js
    // FANOUT-CAP-2026-08-17 (Plan 032): 콜드 캐시일 때 out(최대 20) × Kakao 6콜 = 최대 120 동시 호출이
    //   나갔다. 이 저장소의 다른 외부 API 팬아웃은 전부 동시성을 명시 제한한다(molitIngest 3, 지오코딩 4~8).
    //   getNearbyAmenities 내부 캐시(3일)가 있어 캐시가 더운 경우엔 체감 변화가 없다 — 콜드 버스트만 막는다.
    const AMENITY_CONCURRENCY = 4;
    for (let i = 0; i < out.length; i += AMENITY_CONCURRENCY) {
      await Promise.all(out.slice(i, i + AMENITY_CONCURRENCY).map(async (c) => {
        // (기존 콜백 본문 그대로)
      }));
    }
```

**Verify**:
- `node -c backend/routes/report.js` → exit 0
- `git diff backend/routes/report.js` 를 읽고, 콜백 본문(`getNearbyAmenities` 호출·`c.amenities` 대입·
  catch 로깅)이 **변경되지 않았는지** 직접 확인

### Step 5: 전체 게이트

- `cd backend && npm test` → 72 pass, 0 fail
- `node scripts/security-regression-check.js` → 위반 0건
- `node scripts/extract-inline-js.js && npx eslint backend scripts api .lint-tmp` → exit 0

## Test plan

- **새 단위 테스트는 만들지 않는다.** 두 변경 모두 외부 API/cron 실행에 의존해 로컬에서 의미 있게
  돌릴 수 없고, 동작 결과(수집된 데이터·amenities 값)는 바뀌지 않는다.
- 기존 72개가 전부 통과하는 것이 회귀 없음의 근거다.
- **배포 후 관측이 실제 검증이다.** 보고서에 아래를 적어라:
  - `aptMasterSync` 가 다음 주간 실행에서 정상 종료하는지, 로그의 `remaining` 이 0 인지
    (0 이 아니면 데드라인에 걸린 것 — 그 자체는 정상 동작이지만 AptInfo 지연을 뜻한다)
  - 보고서 생성이 이전과 같은 amenities 값을 내는지(비어 있으면 안 된다)

## Done criteria

- [ ] `grep -l "HARD_DEADLINE\|budgetMs" backend/jobs/*.js` → **5개 파일**
- [ ] `aptMasterSync` worker 루프 안에 `Date.now() > HARD_DEADLINE` 중단 조건이 있다
- [ ] 로그에 `remaining` (남은 큐) 필드가 추가됐다
- [ ] `report.js` 의 amenities 호출이 청크 단위로 나뉘고 상한 상수가 명시돼 있다
- [ ] `git diff` 상 amenities **콜백 본문에 변경이 없다**
- [ ] `node -c` 두 파일 exit 0
- [ ] `cd backend && npm test` → **72 pass, 0 fail**
- [ ] `node scripts/security-regression-check.js` → 위반 0건
- [ ] In scope 외 파일 무변경
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

- `syncOneSgg` 가 **멱등이 아니라는 증거**를 발견했다(같은 지역을 두 번 돌리면 데이터가 중복되거나
  덮어써서 손실이 난다). → 중단 가드를 넣으면 안 된다. 근거와 함께 보고하라.
- worker 개수나 `MAX_PAGE_RETRY` 를 바꿔야 할 것 같다는 판단이 든다 → **바꾸지 마라.** 범위 밖이다.
- amenities 청크화 후 테스트가 깨진다 → 한 번 고쳐보고 또 깨지면 STOP.
- `AMENITY_CONCURRENCY` 를 4 보다 크게 하고 싶어진다 → 근거(측정) 없이 올리지 마라.
  이 저장소의 다른 팬아웃은 3~8 이다.

## Maintenance notes

- 새 cron/backfill job 을 만들 때는 **`HARD_DEADLINE` 패턴을 처음부터 넣어라.** 지금 5개 파일이
  같은 패턴을 쓰므로, 여섯 번째가 빠지면 그때도 같은 종류의 감사 지적이 나온다.
- 데드라인에 자주 걸린다면(로그의 `remaining` 이 계속 >0) 그건 가드 문제가 아니라 **AptInfo 응답이
  느려졌다는 신호**다. 가드를 늘리기 전에 원인을 보라.
- 리뷰 포인트: 외부 API 를 `Promise.all(list.map(...))` 로 부르는 새 코드가 들어오면 **동시성 상한이
  있는지** 확인할 것. 이 저장소는 그걸 관례로 삼고 있다.
- amenities 상한은 **캐시가 더운 경우 성능에 영향이 없다.** 만약 보고서 생성이 눈에 띄게 느려졌다면
  캐시가 안 먹고 있다는 뜻이므로 상한을 올리지 말고 캐시부터 확인하라.
