# Plan 040: 실패가 스스로 복구되게 한다 — 지역 경신 백오프 · 관심도 워밍 기아 · 브리핑 재계산 비수렴

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/services/priceRecordsService.js backend/services/naverDatalabService.js backend/jobs/interestWarm.js backend/services/briefingService.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.

## Status

- **Priority**: P2
- **Effort**: S (세 건 각각 S — 한 계획에 묶은 이유는 아래 참조)
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: perf
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

세 건은 파일이 다르지만 **같은 실패 모드**다: *한 번 실패하면 스스로 돌아오지 못한다.*
이 저장소의 cron 은 Vercel Hobby 라 **재시도가 없고 회차 누락도 가능**하다. 그래서
"다음 회차가 알아서 고쳐 준다" 는 전제가 성립하지 않는다.

**(A) 지역 경신 카드에만 실패 백오프가 없다.**
쌍둥이 함수 `getPriceRecords` 는 재계산 실패 시 10분 백오프 플래그를 심고 마지막 성공
스냅샷을 준다(`priceRecordsService.js:131-134`, `:161`). `getPriceRecordsByRegion` 에는
그 확인도 기록도 **없다**(`:193-215`). 워밍 cron 이 하루 한 번 실패하면 그날 하루 동안
`/region/:code`·`/api/transactions/records?lawdCd=`·`/api/og/region/:code` 의 **엣지 캐시
미스마다** RPC 를 다시 부른다. 이 RPC 는 30일 창(`REGION_DAYS = 30`)이고 PostgREST
`authenticator` 의 `statement_timeout` 은 8초다 — free 티어 Postgres 에서 그 쿼리가 반복되면
다른 요청 경로까지 경합에 끌려간다.

**(B) 관심도 워밍 큐가 막힌다.**
`naverDatalabService.js:294` 는 `ratio == null` 이면 아무것도 저장하지 않고 `continue` 한다
(주석: "모름은 저장하지 않는다 — 이름이 나아지면 다시 시도한다"). `todo` 는 캐시에 없는 항목이고
루프는 **앞에서부터** 하루 예산만큼만 처리한다(`:287`, `calls < maxCalls`). 정렬은
`deal_count desc` 로 매일 동일하다(`interestWarm.js:24`). 그래서 **원리적으로 값을 못 얻는
이름**(정규화 후 4자 미만 등 — `:103-113` 의 `buildKeywords` 가 빈 배열을 낸다)이 매일
`todo` 의 같은 앞자리를 차지하고 그날 예산을 먼저 먹는다. 누적이 240
(= `calls 60 × MAX_TARGETS_PER_CALL 4`)에 이르면 워밍이 **완전히 멈춘다**.
그러면 이 cron 이 존재하는 이유(`interestWarm.js:4-5` — "캐시 미스면 전 단지 중간값이라
변별력 0, 실측 히트 0/15")가 그대로 재발한다.
덧붙여 `interestWarm.run` 에는 **시간 예산이 없다**(`:14`) — 형제 cron `rentWarm.run` 은
`budgetMs = 240000` 과 루프 진입 가드를 갖고 있다(`rentWarm.js:27`, `:44`).

**(C) 브리핑 부분 스냅샷 재계산이 수렴하지 않는다.**
`briefingService.js:127-129` 는 30분이 지나고 결손이 있으면 전체를 다시 만들어 보고,
**더 좋아지지 않으면 `stored` 를 그대로 반환하고 아무것도 쓰지 않는다.** `generatedAt` 이
갱신되지 않으므로 `age >= PARTIAL_RETRY_MS` 조건이 계속 참이다 → **그날이 끝날 때까지 모든
캐시 미스가 전체 payload 를 다시 만든다**(ECOS·HF·`getPriceRecords`·popular 를 전부 부른다).
호출부가 페이지·OG 이미지·cron 세 곳(`routes/briefing.js:114`, `routes/ogImage.js:173`,
`routes/cron.js:201`·`:248`)이라 각각 미스를 낸다. 주석이 약속한 "30분마다" 는 코드에 없다.

## 현재 상태

### (A) `backend/services/priceRecordsService.js`

있는 쪽 — `:131-134` 와 `:161`:

```js
    // 신선 캐시가 비었다. 최근 재계산이 실패했으면(백오프) 마지막 성공 스냅샷을 준다 — 요청마다 8초를 태우지 않는다.
    if (cache.get(CK_FAIL) !== undefined) {
      const last = await _lastGood(CK_LAST);
      if (last) return _withStale(last);
    }
```
```js
    logger.warn({ err: e.message }, 'price records 조회 실패');
    cache.set(CK_FAIL, Date.now(), FAIL_BACKOFF_S);
```

없는 쪽 — `:193-215`(`getPriceRecordsByRegion`). 캐시 미스 → 바로 `_rpcWithRetry` →
실패하면 그때서야 `_lastGood(CK_REGION_LAST)` 폴백. **`CK_REGION_FAIL` 같은 키가 없다.**

관련 상수: `FAIL_BACKOFF_S`(파일 상단), `REGION_DAYS = 30`(`:50`), `REGION_LIMIT = 3`(`:51`),
`CK_REGION`·`CK_REGION_LAST`(파일 상단).

### (B) `backend/services/naverDatalabService.js` / `backend/jobs/interestWarm.js`

`naverDatalabService.js:284-298`:

```js
  const todo = usable.filter((it, i) => have.get(keys[i]) === undefined);
  let calls = 0, filled = 0, lastError = null;
  for (let i = 0; i < todo.length && calls < maxCalls; i += MAX_TARGETS_PER_CALL) {
    const chunk = todo.slice(i, i + MAX_TARGETS_PER_CALL);
    const res = await fetchBatch(chunk.map(c => c.aptName));
    calls++;
    if (!res) { lastError = lastFetchError; break; } // 실패하면 더 두드리지 않는다(한도·부하 보호)
    for (const c of chunk) {
      const ratio = res.get(c.aptName);
      if (ratio == null) continue;   // 모름은 저장하지 않는다 — 이름이 나아지면 다시 시도한다
      await writeCache(cacheKeyFor(c.aptName, c.sigungu, c.umd), ratio, c.lat, c.lng);
      filled++;
    }
  }
```

`interestWarm.js:14` — 시간 예산 인자 없음:

```js
async function run({ calls = 60, top = 2000 } = {}) {
```

대조 — `rentWarm.js:27`·`:44`:

```js
async function run({ codes, now = new Date(), dayIdx, budgetMs = 240000, concurrency = 3 } = {}) {
```
```js
      if (Date.now() - t0 >= budgetMs) { out.stopped = 'budget'; break; }
```

### (C) `backend/services/briefingService.js:121-133`

```js
  const isToday = day === kstDayString();
  if (stored) {
    // PARTIAL-SNAPSHOT-2026-09-05 (감사 G-5): 재료 일부가 비어 저장된 **오늘** 스냅샷은 30분마다 다시 만들어 보고,
    //   더 완전해졌을 때만 덮어쓴다. 과거 날짜는 절대 손대지 않는다(아카이브 불변 — 소급 생성 = 조작 가능성).
    const partial = Array.isArray(stored.partial) ? stored.partial : [];
    const age = Date.now() - (Date.parse(stored.generatedAt || '') || 0);
    if (!isToday || !partial.length || age < PARTIAL_RETRY_MS) return stored;
    const fresh = await buildBriefingPayload();
    if (!fresh.lines.length || (fresh.partial || []).length >= partial.length) return stored;
    await admin.from('briefing_snapshots').upsert({ day, payload: fresh }).then(() => {}, (e) => { … });
    return fresh;
  }
```

`PARTIAL_RETRY_MS = 30 * 60 * 1000`(`:108`).

### 이 저장소의 관례·제약

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `SELF-HEAL-2026-09-06`.
- **공유 production DB 직접 수정 금지**(절대 룰 ③). 이 계획은 **DDL 을 요구하지 않는다** —
  그렇게 되도록 설계했다. 스키마 변경이 필요해 보이면 STOP 조건이다.
- ⚠ **DB 값 설계 전 `pg_constraint` 전수 확인.** 이 저장소는 `(0,0)` sentinel 을 설계했다가
  CHECK 제약으로 INSERT 가 100% 거부돼 3일간 무동작한 사고가 있다. 그리고
  `supabase/schema.sql` 스냅샷은 **현재 낡았다**(별건 발견) — 파일을 믿지 말고
  `pg_catalog` 를 직접 조회해야 한다. **이 계획은 그래서 DB 에 값을 쓰지 않는 방식을 고른다.**
- 새 환경변수를 추가하면 `backend/.env.example` 을 반드시 함께 갱신하라
  (`scripts/check-env-example.js` 가 CI 를 **차단**한다).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 226` 이상, `fail 0` |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check <수정 파일>` | exit 0 |
| env 대조 | `node scripts/check-env-example.js` | 누락 0건 |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `backend/services/priceRecordsService.js` (A)
- `backend/jobs/interestWarm.js` (B)
- `backend/services/naverDatalabService.js` (B — `warmInterest` 시그니처에 옵션 추가만)
- `backend/services/briefingService.js` (C)
- `backend/test/characterization.test.js`
- `backend/.env.example` (새 env 를 도입하는 경우에만)
- `plans/README.md`

**Out of scope**:
- **어떤 DDL·마이그레이션도 만들지 마라.** `apt_amenities` 에 "모름 마커" 행을 쓰는 설계는
  CHECK 제약 위험 + 절대 룰 ③ 때문에 이번에 채택하지 않는다(대안은 Step 2 참조).
- `REGION_DAYS`(30일 창)를 줄이는 것 — 실측 근거가 파일에 적혀 있다(`:47-49`). 건드리지 마라.
- 30일 RPC 자체의 성능 튜닝 — 별건이고 엔드포인트 실측이 선행해야 한다.
- `getPriceRecords`(전국) 경로 — **이미 옳다.**
- `backend/routes/cron.js` — cron 등록·인가는 그대로. `interestWarm.run` 이 옵션 기본값을
  갖게 하면 호출부 변경이 필요 없다.
- 브리핑 payload 를 **필드 단위로 병합**하는 것 — 더 나은 설계지만 아카이브 의미(하루 기록)를
  건드리므로 별건이다. 유지보수 메모에 근거를 남긴다.

## Git 작업 방식

- 브랜치: `fix/self-healing-warm-backoff`
- 커밋은 세 건을 **따로** 만들어라(A/B/C). 하나가 문제되면 그것만 되돌릴 수 있어야 한다.
  - `fix(경신): 지역 블롭에도 실패 백오프 — 워밍 실패한 날 미스마다 8초 RPC 를 태우던 것`
  - `fix(관심도): 워밍 큐가 해결 불가 이름에 막히지 않게 회전 + 시간 예산`
  - `fix(브리핑): 부분 스냅샷 재계산이 수렴하도록 재시도 간격 보장`
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1 (A): `getPriceRecordsByRegion` 에 쌍둥이와 같은 백오프를 붙인다

파일 상단에 `CK_REGION_FAIL` 키를 추가하고(`CK_FAIL` 이 선언된 곳 바로 옆),
`getPriceRecordsByRegion` 을 다음처럼 대칭으로 만든다:

1. 캐시 미스 뒤, RPC 를 부르기 **전에** `cache.get(CK_REGION_FAIL) !== undefined` 이면
   `_lastGood(CK_REGION_LAST)` 를 `_withStale` 로 돌려준다.
2. `catch` 안에서 `cache.set(CK_REGION_FAIL, Date.now(), FAIL_BACKOFF_S)` 를 심는다.

주석:

```js
// SELF-HEAL-2026-09-06:
// [왜] 쌍둥이 getPriceRecords 에는 있는 실패 백오프가 여기에만 없었다. 워밍 cron 이 하루 한 번
//   실패하면(Hobby cron 은 재시도가 없다) 그날 내내 엣지 캐시 미스마다 30일 창 RPC 를 다시 부른다.
//   PostgREST authenticator 의 statement_timeout 이 8초라, free 티어에서 그 반복은 다른 요청까지 끌고 간다.
// [소비 경로] routes/transactions.js · routes/regionPage.js · routes/ogImage.js(→ loadRegionData) 셋.
```

⚠ `force: true` 경로(워밍 cron)는 백오프를 **건너뛰어야 한다** — `getPriceRecords` 가
`if (!force)` 블록 안에 백오프 확인을 둔 것과 같은 구조를 지켜라. 그래야 cron 이 다음 날
정상적으로 재계산할 수 있다.

**검증**: `node --check backend/services/priceRecordsService.js` → exit 0
**검증**: `grep -c "CK_REGION_FAIL" backend/services/priceRecordsService.js` → `3` 이상(선언 1·확인 1·기록 1)

### Step 2 (B): 워밍 큐를 회전시키고 시간 예산을 준다

**DB 에 "모름" 마커를 쓰지 않는다.** 대신 **큐를 회전**시켜 매일 다른 구간을 처리하게 한다.
이 방식은 스키마 변경이 없고, 해결 불가한 이름이 예산을 독점하는 문제를 구조적으로 없앤다.

**(2-1) `interestWarm.js`**: `rentWarm` 과 같은 형태로 `dayIdx`·`budgetMs` 를 받고,
`items` 를 그날의 오프셋만큼 회전시켜 `warmInterest` 에 넘긴다:

```js
// SELF-HEAL-2026-09-06:
// [왜] warmInterest 는 캐시 미스 목록(todo)을 **앞에서부터** 하루 예산만큼만 처리하고,
//   ratio 가 null 인 항목은 아무것도 저장하지 않아 다음 날 todo 의 같은 앞자리에 그대로 남는다.
//   정렬이 deal_count desc 로 매일 같으므로, 원리적으로 값을 못 얻는 이름(정규화 후 4자 미만 등)이
//   누적되면 유효 처리량이 단조 감소하고 240건(60콜×4)에 이르면 워밍이 완전히 멈춘다.
// [해결] 회전. 마커를 DB 에 쓰는 대안은 apt_amenities 의 제약을 프로덕션에서 확인해야 하고
//   (이 저장소는 sentinel 설계가 CHECK 로 100% 거부된 사고가 있다) 절대 룰 ③ 상 DDL 은 별도 승인이라,
//   스키마를 건드리지 않는 이 방식을 고른다.
async function run({ calls = 60, top = 2000, dayIdx, budgetMs = 240000 } = {}) {
```

`items` 를 만든 뒤(현재 `:39-44`) 회전한다:

```js
  const slot = dayIdx != null ? dayIdx : Math.floor(Date.now() / 86400000) % 7;
  const off = items.length ? (slot * Math.ceil(items.length / 7)) % items.length : 0;
  const rotated = off ? items.slice(off).concat(items.slice(0, off)) : items;
```

그리고 `dl.warmInterest(rotated, calls, { budgetMs })` 로 넘긴다.
반환 요약(`out`)에 `slot`·`off` 를 실어 로그에서 회전이 실제로 도는지 보이게 하라.

**(2-2) `naverDatalabService.warmInterest`**: 세 번째 인자로 옵션을 받아
루프 진입마다 시간 예산을 확인한다(`rentWarm.js:44` 와 같은 형태). 기본값을 주어
기존 호출부가 깨지지 않게 하라:

```js
async function warmInterest(items, maxCalls, { budgetMs = 240000 } = {}) {
```
```js
  const t0 = Date.now();
  for (let i = 0; i < todo.length && calls < maxCalls; i += MAX_TARGETS_PER_CALL) {
    if (Date.now() - t0 >= budgetMs) { stopped = 'budget'; break; }
```

`stopped` 를 반환 요약에 포함시켜라(`rentWarm` 의 `out.stopped` 와 같은 의미).

⚠ `ratio == null` 일 때의 `continue` 는 **그대로 두라.** 그 주석("이름이 나아지면 다시
시도한다")은 의도이고, 회전이 기아 문제를 대신 해결한다.

**검증**: `node --check backend/jobs/interestWarm.js backend/services/naverDatalabService.js` → exit 0
**검증**: `grep -c "budgetMs" backend/jobs/interestWarm.js backend/services/naverDatalabService.js` 합계 ≥ `4`

### Step 3 (C): 브리핑 재계산이 수렴하게 한다

`briefingService.js:127-133` 에서, **개선에 실패한 경우에도 재시도 간격이 지켜지도록**
프로세스 캐시에 마지막 재시도 시각을 남긴다(DB 를 건드리지 않는다):

```js
    // SELF-HEAL-2026-09-06:
    // [왜] 개선 실패 시 stored 를 그대로 반환하고 아무것도 쓰지 않아 generatedAt 이 갱신되지 않는다.
    //   그러면 age >= PARTIAL_RETRY_MS 가 계속 참이라, 업스트림이 하루 종일 죽어 있으면
    //   그날 내내 **모든 캐시 미스가 전체 payload 를 다시 만든다**(ECOS·HF·price records·popular).
    //   호출부가 페이지·OG 이미지·cron 셋이라 각각 미스를 낸다. 주석이 약속한 "30분마다" 가 코드에 없었다.
    // [해결] 재시도 시각을 프로세스 캐시에 남긴다. DB 스키마·아카이브 의미를 건드리지 않는다.
    //   ⚠ 서버리스는 인스턴스마다 이 캐시가 따로다 — 완전한 상한이 아니라 **인스턴스당 상한**이다.
    //   그래도 종전(무제한)보다 원본 부하가 인스턴스 수 배수로 줄어든다.
```

구현:
- 재계산 직전 `const rk = 'briefing:retry:' + day;` 를 만들고 `cache.get(rk) !== undefined` 면
  `stored` 를 그대로 반환(재계산 생략).
- 재계산을 시작하기 **전에** `cache.set(rk, Date.now(), PARTIAL_RETRY_MS / 1000)` 를 심는다
  (실패해도 간격이 지켜지도록 **전에** 심어야 한다).
- 개선에 성공해 `upsert` 한 경우에는 `generatedAt` 이 갱신되므로 그대로 두면 된다.

⚠ `briefingService` 가 `../cache` 를 이미 require 하고 있는지 확인하고, 없으면 추가하라.
⚠ 과거 날짜(`!isToday`)는 손대지 않는 기존 동작을 유지하라(아카이브 불변).

**검증**: `node --check backend/services/briefingService.js` → exit 0
**검증**: `grep -c "briefing:retry:" backend/services/briefingService.js` → `1`

### Step 4: 테스트를 추가한다

`backend/test/characterization.test.js` 맨 끝에 **행위 테스트 3개**를 추가한다.
소스 문자열 검사로 끝내지 마라.

1. **(A)** `priceRecordsService` 를 `require.cache` 스텁으로 감싸(`characterization.test.js:6231`
   근처에 이미 이 서비스용 스텁 예시가 있다) RPC 가 **실패**하도록 만든 뒤
   `getPriceRecordsByRegion()` 을 **두 번** 호출한다. 단언: RPC 호출 횟수가 **1회**다
   (두 번째는 백오프에 막힌다).
2. **(B)** `warmInterest` 에 항상 `null` ratio 를 돌려주는 스텁을 물리고,
   `interestWarm.run({ dayIdx: 0, … })` 과 `run({ dayIdx: 3, … })` 이 **서로 다른 항목 집합**을
   조회하는지 단언한다(회전이 실제로 돈다). 추가로 `budgetMs: 0` 이면 즉시 `stopped: 'budget'`
   으로 끝나는지 단언한다.
3. **(C)** `briefingService` 의 `buildBriefingPayload` 를 "항상 같은 결손" 을 내도록 스텁하고,
   `getOrCreateSnapshot` 을 **두 번** 호출해 `buildBriefingPayload` 가 **1회**만 불렸는지 단언한다.

⚠ 절대 날짜를 박지 마라. 상대 시각(`Date.now() - 40*60*1000` 등)을 써라.
⚠ 스텁은 `try/finally` 로 반드시 복원하라 — 빠뜨리면 그 뒤 테스트가 오염된 채 통과한다.

**검증**: `cd backend && npm test` → `pass` ≥ 226, `fail 0`

### Step 5: 회귀 주입

⚠ **주입 전 `git status --short` 가 비어 있어야 한다**(Step 1~4 를 커밋했는지).

세 가지를 하나씩 되돌려 각각 `fail` 이 나는지 확인하고 원복한다:
1. `CK_REGION_FAIL` 확인 제거 → fail
2. 회전(`rotated`) 제거 → fail
3. `briefing:retry:` 확인 제거 → fail

**검증**: 세 주입 모두 fail. 하나라도 안 잡히면 **STOP 조건**.

### Step 6: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0.

## 테스트 계획

- **새 테스트 3개**(A/B/C 각 1개).
- **패턴 참고**: `characterization.test.js:6231-6263`(priceRecordsService 스텁),
  `:6296-6338`(db/client + naverDatalab 스텁 — B 에 그대로 쓸 수 있다).
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `grep -c "CK_REGION_FAIL" backend/services/priceRecordsService.js` ≥ `3`
- [ ] `grep -c "budgetMs" backend/jobs/interestWarm.js` ≥ `2`
- [ ] `grep -c "briefing:retry:" backend/services/briefingService.js` → `1`
- [ ] `node --check` 가 수정한 4개 파일 모두 exit 0
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 226, `fail 0`
- [ ] `npm run lint` exit 0, `node scripts/check-env-example.js` 누락 0건
- [ ] `git status --short` 에 `supabase/migrations/` 변경이 **없다**(DDL 무추가)
- [ ] Step 5 의 주입 3건에서 각각 fail 확인
- [ ] 커밋이 A/B/C 로 **3개** 분리돼 있다
- [ ] `plans/README.md` 의 040 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 네 파일 중 하나가 "현재 상태" 발췌와 다르다.
- 수정이 **DDL·마이그레이션을 요구**한다(절대 룰 ③ — 운영자 승인 없이는 진행 불가).
- `warmInterest` 의 시그니처를 바꿨더니 다른 호출부가 깨진다 —
  `grep -rn "warmInterest(" backend/ --include=*.js` 로 호출부를 **먼저** 전수 확인하라.
- Step 5 의 주입 중 하나라도 테스트가 잡지 못한다.
- 새 환경변수가 필요해졌는데 `.env.example` 갱신이 누락된다(`check-env-example.js` 가 차단한다).

## 유지보수 메모

- **(A) 다음 레버**: 30일 창 RPC 자체가 8초 안에 안 끝난다면 백오프는 증상 완화일 뿐이다.
  근본 해결은 사전 집계(MV)이고, 그 전에 **엔드포인트 실측**이 선행해야 한다 —
  이 저장소는 `EXPLAIN` 시간을 매 요청 비용으로 오해해 없는 병목을 고칠 뻔한 이력이 있다.
  `20260905_price_records_perf.sql` 의 "13.1s → 1.26s" 는 **7일 창** 값이다. 30일 창이 아니다.
- **(B) 회전은 완치가 아니라 우회다.** 근본 해결은 "해결 불가한 이름" 을 짧은 TTL 로 표시하는 것인데,
  그러려면 `apt_amenities` 의 제약을 **`pg_catalog` 직접 조회로** 확인해야 한다
  (`supabase/schema.sql` 스냅샷은 현재 낡았다). 운영자 승인 후 별건으로.
  회전 후에도 `cron/warm-interest` 로그의 `filled` 가 계속 0 에 가까우면 그 신호다.
- **(C) 필드 단위 병합이 더 낫다.** 지금 판정은 **결손 개수 비교**뿐이라
  `stored.partial=['ecos','popular']`(2개) vs `fresh.partial=['records']`(1개) 면 덮어쓰는데,
  이때 `stored` 가 갖고 있던 `records` 를 잃는다. "더 완전해졌을 때만" 이라는 계약이 개수로만
  근사돼 있다. 아카이브 의미(하루 기록의 불변성)와 얽혀 있어 별건으로 남긴다.
- **리뷰에서 볼 것**: 커밋 3개가 각각 독립적으로 되돌릴 수 있는지. 그리고
  `supabase/migrations/` 에 새 파일이 없는지.
