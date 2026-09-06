# Plan 037: 전월세 "열화된 빈 응답" 이 공유 캐시에 8일 굳는 것을 막고, 그 분기를 테스트로 고정한다

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 즉흥 판단하지 말고 멈추고
> 보고하라. 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- backend/services/rentService.js backend/jobs/rentWarm.js backend/routes/report.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: bug
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

전세가율은 이 서비스의 정확도 USP 다. 그 표본이 **조용히 0 이 되는** 경로가 세 겹으로 열려 있다.

1. 국토부가 **HTTP 200 + 비정상 `resultCode`** 를 주면 `_fetchRentMonth` 는 `break` 만 하고
   예외를 던지지 않는다(같은 저장소의 매매 경로 `backend/jobs/molitIngest.js:117-119` 는
   같은 조건에서 `throw` 한다 — 두 경로가 갈려 있다). 그 결과 `result = []` 가 **정상 0건**이
   되어 `cache.set(…, 86400)` 과 `recordCronRun('rent-live', { ok: 1 })` 까지 실행된다.
2. 2026-09-05 의 `RENT-REDIS` 변경(`rentService.js:91`)이 그 `[]` 를 **공유 Redis** 에
   `rentTtlSec()` TTL(최근 2개월 30h, 그 이전 **8일**)로 쓴다. 폭발 반경이
   **1인스턴스·24h → 전 인스턴스·8일** 로 커졌다.
3. `isRentCached` 가 `Array.isArray()` 만 보므로 빈 배열도 "캐시됨" 이다
   (`rentService.js:63-66`). 예열 cron 이 `out.skipped++` 로 그 (구,월)을 **TTL 내내 건너뛴다**
   (`backend/jobs/rentWarm.js:47`) — 스스로 복구되지 않는다.

여기에 더해, **일 한도 감지가 이 경로에서 작동하지 않는다.** `rentWarm.js:52` 는 예외에
실린 `e.reason`(= `rentService.js:234`, catch 경로에서만 설정)에서 `code=22` 를 찾는다.
비정상 `resultCode` 가 `break` 로 흘러 예외가 아니게 되면 **예열 cron 이 멈추지 않고**
남은 320여 콜을 계속 태우면서 그 전부를 `[]` 로 공유 캐시에 심는다.

마지막으로 **화면이 거짓말을 한다.** 실패 시 5분 오류 캐시(`rentService.js:230`,
`cache.set(cacheKey, [], 300)`)가 심기고, 그 5분 안의 다음 호출은 `rentService.js:84-85` 에서
예외 없이 `[]` 를 돌려준다. 그러면 `getJeonseByApt` 의 `_failedMonths`(`:259-267`, `catch` 로만
채워진다)가 **비게 되어** 보고서의 새 "표본 n/6개월" 표기가 사라진다 = 사용자는 **6/6 으로 읽는다**.
2026-09-05 에 그 표기를 만든 목적이 정확히 이것이었으므로, 이 부분을 함께 고치지 않으면
1~3 을 고쳐도 목적이 달성되지 않는다.

## 현재 상태

### 파일

- `backend/services/rentService.js` — 302줄. 국토부 전월세 조회 + 로컬(node-cache) 1차 캐시 +
  Redis 2차 캐시 + 프로세스 공용 페이서.
- `backend/jobs/rentWarm.js` — 63줄. 하루 1회 예열 cron.
- `backend/routes/report.js:1900-1909` — `monthsFailed` 를 읽어 `jeonse_months` 를 만든다.
- `backend/test/characterization.test.js` — 테스트.

### 문제 코드 (있는 그대로)

**(A) 비정상 응답이 `break` 로 성공 반환된다** — `backend/services/rentService.js:154-166`:

```js
      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        logger.warn({
          source: 'molit-rent', lawdCd, dealYm, pageNo,
          resultCode: header.resultCode, resultMsg: header.resultMsg,
        }, 'MOLIT 전월세 비정상 응답코드');
        break;
      } else if (!header && typeof response.data === 'string') {
        logger.warn({
          source: 'molit-rent', lawdCd, dealYm, pageNo,
          sample: String(response.data).slice(0, 200),
        }, 'MOLIT 전월세 비-JSON 응답');
        break;
      }
```

대조 — 매매 경로 `backend/jobs/molitIngest.js:117-119` 는 던진다:

```js
        if (header?.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
          throw new Error(`MOLIT resultCode=${header.resultCode} msg=${header.resultMsg}`);
        }
```

**(B) 그 `[]` 가 성공으로 기록되고 공유 캐시에 쓰인다** — `rentService.js:213-218`:

```js
    cache.set(cacheKey, result, 86400);
    // OBSERV-SUCCESS-2026-08-12 …
    require('./cronStats').recordCronRun('rent-live', { ok: 1 }).catch(() => {});
    return result;
```

그리고 `rentService.js:87-93`:

```js
  const p = (async () => {
    const shared = await rget(key); // 로컬 미스 → Redis(예열분) → 업스트림
    if (Array.isArray(shared)) { cache.set(key, shared, RENT_MEM_TTL_S); return shared; }
    const rows = await _fetchRentMonth(lawdCd, dealYm);
    rset(key, rows, rentTtlSec(dealYm)).catch(() => { /* rset 은 스스로 삼키지만 체인 경고 방지 */ });
    return rows;
  })().finally(() => _inflight.delete(key));
```

**(C) 빈 배열이 "캐시됨" 으로 읽혀 예열이 건너뛴다** — `rentService.js:63-66`:

```js
async function isRentCached(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  if (cache.get(key) !== undefined) return true;
  return Array.isArray(await rget(key));
}
```

**(D) 5분 오류 캐시가 실패를 실패로 안 보이게 한다** — `rentService.js:230` 과 `:84-85`:

```js
    cache.set(cacheKey, [], 300);          // :230 (catch 안)
```
```js
  const hit = cache.get(key);
  if (hit !== undefined) return hit || [];  // :84-85 — 예외 없이 빈 배열
```

그래서 `getJeonseByApt` 의 실패 집계가 비어 버린다 — `rentService.js:259-267`, `:298`:

```js
  const _failedMonths = [];
  for (let i = 0; i < months.length; i += CONC) {
    const chunk = await Promise.all(
      months.slice(i, i + CONC).map(m => getRentTransactions(lawdCd, m).catch((e) => {
        _failedMonths.push(m);
        …
        return [];
      }))
    );
    …
  }
  …
  sorted.monthsFailed = _failedMonths.slice();
```

### 테스트가 이 분기를 한 번도 지나가지 않는다

- `backend/test/characterization.test.js:6413` — 페이서·인플라이트 테스트의 dgk 스텁이
  **항상** `resultCode: '000'` 을 돌려준다.
- `backend/test/characterization.test.js:6494` — Redis 2차 캐시 테스트의 스텁도 마찬가지.
- 실패 시나리오는 `:6412`(HTTP 500 throw) 하나뿐 — **200 + 비정상 resultCode 경로는 미커버**다.
  그래서 위 결함 전체가 현재 게이트(223 pass)를 초록으로 통과한다.

### 이 저장소의 관례

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `RENT-DEGRADED-2026-09-06`.
- 열화 응답을 긴 캐시로 굳히지 않는다는 원칙이 이미 있다 —
  `backend/routes/transactions.js:109` 가 `degraded || data.stale → no-store` 로 쓴다.
- 테스트 스텁 인프라: `characterization.test.js:6400-6455`(dgk + rentService `require.cache` 스텁,
  `finally` 에서 복원), `:6486-6535`(+ redisCache 스텁). **그대로 재사용하라.**
- ⚠ 더미 시크릿은 `xxxxxxxx-…` 형태로 쓴다(gitleaks allowlist). 기존 테스트가
  `process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key'` 로 쓰고 있다.

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 226` 이상, `fail 0` |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check backend/services/rentService.js` | exit 0 |
| env 대조 | `node scripts/check-env-example.js` | 누락 0건 |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `backend/services/rentService.js`
- `backend/test/characterization.test.js` (테스트 추가)
- `backend/.env.example` — 새 환경변수를 **도입하는 경우에만**(권장하지 않는다. 도입하면
  `check-env-example.js` 게이트가 차단하므로 반드시 함께 갱신)
- `plans/README.md`

**Out of scope**:
- `backend/jobs/rentWarm.js` — **수정하지 마라.** 이 계획이 `throw` 를 복원하면
  `rentWarm.js:50-53` 의 기존 catch 와 `QUOTA_RE` 가 **저절로 다시 작동한다**.
  cron 쪽 변경은 불필요하고, 건드리면 그 사실이 가려진다.
- `backend/routes/report.js` — `monthsFailed` 소비 방식은 이미 옳다. 생산 측만 고친다.
- `backend/jobs/molitIngest.js` — 대조 근거일 뿐 변경 대상이 아니다.
- Redis 분산 페이서 도입 — 서버리스 인스턴스 간 초당 한도 곱셈 문제는 별건이고,
  코드가 그 한계를 이미 주석으로 밝혀 뒀다(`rentService.js:24-30`).
- 전월세 **DB 테이블 신설** — 운영자가 두 번 거부했다. 절대 제안하지 마라.

## Git 작업 방식

- 브랜치: `fix/rent-degraded-response`
- 커밋: `fix(전월세): 열화 응답을 성공으로 취급해 빈 표본이 공유 캐시에 8일 굳던 것 — 매매 경로와 같이 throw`
  body 에 `[근본 원인]` `[Fix 내용]` `[회귀 위험]`.
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: 비정상 응답을 예외로 승격한다 (매매 경로와 동일하게)

`backend/services/rentService.js:154-166` 의 두 `break` 를 `throw` 로 바꾼다.
던지는 에러는 **기존 catch 가 그대로 처리**한다(`:220-236`) — 즉 5분 음성 캐시·
`recordCronRun({ ok:false })`·`molitErrReason` 사유 부착이 자동으로 붙는다.

목표 형태:

```js
      // RENT-DEGRADED-2026-09-06:
      // [왜] 종전엔 `break` 라 비정상 응답이 **정상 0건**으로 흘러 cache.set(24h)·
      //   recordCronRun({ok:1})·rset(공유 Redis, 최대 8일)까지 갔다. 매매 경로
      //   (jobs/molitIngest.js 의 resultCode 검사)는 같은 조건에서 던지는데 여기만 갈려 있었다.
      // [영향] 예열 cron 이 isRentCached 로 그 (구,월)을 TTL 내내 skip 해 스스로 복구되지 않고,
      //   일 한도(code=22) 감지도 e.reason 이 없어 작동하지 않았다.
      // [해결] 던진다 — 아래 catch 가 5분 음성 캐시 + 사유 기록 + reason 부착을 이미 한다.
      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        throw new Error(`MOLIT 전월세 resultCode=${header.resultCode} msg=${header.resultMsg || ''}`);
      } else if (!header && typeof response.data === 'string') {
        throw new Error('MOLIT 전월세 비-JSON 응답');
      }
```

⚠ 기존 `logger.warn` 은 지워도 된다(catch 에서 사유가 기록된다). 지운다면 커밋 body 에 그 사실을 적어라.
⚠ `resultMsg` 를 에러 메시지에 넣을 때 **API 키가 섞이지 않게** 하라 — `resultMsg` 는 게이트웨이
문구이지 URL 이 아니므로 안전하지만, `response.config` 나 URL 을 메시지에 넣지 마라.

**검증**: `node --check backend/services/rentService.js` → exit 0
**검증**: `grep -c "MOLIT 전월세 비정상 응답코드" backend/services/rentService.js` → `0` (지운 경우)

### Step 2: 빈 결과를 공유 Redis 에 쓰지 않는다 (2차 방어)

`rentService.js:87-93` 의 `rset` 호출을 **행이 1건 이상일 때만** 하도록 좁힌다:

```js
    const rows = await _fetchRentMonth(lawdCd, dealYm);
    // RENT-DEGRADED-2026-09-06: 빈 결과는 공유 캐시에 쓰지 않는다. Step 1 이 열화를 예외로 올렸지만,
    //   "그 달에 실제로 거래가 0건" 인 경우와 구별이 안 되는 값을 전 인스턴스에 최대 8일 심는 것은
    //   이득보다 위험이 크다(거래 0건인 달은 다음 조회가 다시 0건을 받을 뿐이다).
    if (rows.length) rset(key, rows, rentTtlSec(dealYm)).catch(() => { /* rset 은 스스로 삼키지만 체인 경고 방지 */ });
```

**검증**: `node --check backend/services/rentService.js` → exit 0

### Step 3: `isRentCached` 가 빈 배열을 히트로 보지 않게 한다

`rentService.js:63-66` 을 고쳐, 로컬·Redis 어느 쪽이든 **비어 있으면 캐시로 치지 않는다**:

```js
async function isRentCached(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  // RENT-DEGRADED-2026-09-06: 빈 배열을 "캐시됨" 으로 보면 예열 cron 이 그 (구,월)을 TTL 내내
  //   건너뛰어 오염이 스스로 복구되지 않는다(rentWarm.js 의 skipped 경로).
  const local = cache.get(key);
  if (Array.isArray(local) && local.length) return true;
  const shared = await rget(key);
  return Array.isArray(shared) && shared.length > 0;
}
```

⚠ 이 변경은 "그 달에 실제로 거래가 0건" 인 (구,월)을 예열 cron 이 **매일 다시 조회**하게 만든다.
비용은 하루 몇 콜 수준이고(그런 달은 소수), 조용한 오염이 8일 지속되는 것보다 낫다.
이 트레이드오프를 주석에 남겨라.

**검증**: `node --check backend/services/rentService.js` → exit 0

### Step 4: 5분 오류 캐시가 실패를 감추지 않게 한다

`rentService.js:230` 의 `cache.set(cacheKey, [], 300)` 을 **구분 가능한 표식**으로 바꾸고,
`getRentTransactions`(`:84-85`)와 `_fetchRentMonth`(`:106-108`)의 캐시 히트 경로가 그 표식을
만나면 **다시 던지게** 한다. 5분 백오프(외부 API 재타격 방지)는 그대로 유지된다.

목표 형태(정확한 구현은 실행자 재량이되, 아래 성질을 만족해야 한다):

```js
// RENT-DEGRADED-2026-09-06: 실패를 빈 배열로 캐시하면 5분 안의 다음 호출이 예외 없이 []를 받고,
//   getJeonseByApt 의 _failedMonths 가 비어 "표본 n/6개월" 표기가 사라진다 = 화면은 6/6 으로 읽힌다.
//   백오프는 유지하되 **실패였다는 사실**을 캐시에 담는다.
const RENT_FAIL = Symbol.for('myhomelog.rent.fail');
const _failMark = (reason) => ({ [RENT_FAIL]: true, reason: reason || null });
const _isFailMark = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && v[RENT_FAIL]);
```

- `catch` 에서 `cache.set(cacheKey, _failMark(brief), 300)`
- `getRentTransactions` 의 캐시 히트 검사(`:84-85`)와 `_fetchRentMonth` 의 검사(`:107-108`)에서
  `_isFailMark(hit)` 이면 `reason` 을 실은 에러를 **던진다**(원래 실패와 같은 모양이 되도록
  `err.reason = hit.reason` 을 붙여라 — `rentWarm.js:52` 의 `QUOTA_RE` 가 그것을 본다).

⚠ **`isRentCached` 가 이 표식을 히트로 보면 안 된다.** Step 3 의 `Array.isArray` 검사가
이미 그것을 막는다 — 표식은 배열이 아니다. 그 사실을 주석에 남겨라.
⚠ `rget`/`rset` 은 이 표식을 다루지 않는다(Step 2 가 빈 결과를 Redis 에 안 쓰고, 실패는
애초에 `rset` 에 도달하지 않는다).

**검증**: `node --check backend/services/rentService.js` → exit 0

### Step 5: 미커버 분기를 테스트로 고정한다

`backend/test/characterization.test.js` 맨 끝에 테스트 2개를 추가한다.
스텁 인프라는 `characterization.test.js:6400-6455` / `:6486-6535` 를 **그대로 복제**해서 쓴다
(dgk `require.cache` 스텁 + `finally` 복원 + 인메모리 캐시 청소).

**테스트 ①: 200 + 비정상 resultCode**
- dgk 스텁이 `{ status: 200, data: { response: { header: { resultCode: '22', resultMsg: '…' }, body: {} } } }` 를 돌려준다.
- 단언: `getRentTransactions(...)` 가 **reject** 한다.
- 단언: redisCache 스텁의 `rset` 이 **호출되지 않았다**.
- 단언: `isRentCached(lawd, ym)` 가 `false` 다.
- 단언: 이어서 `getJeonseByApt(lawd, '아무단지')` 를 호출하면 `monthsFailed.length === 6`
  (5분 캐시 히트 경로에서도 실패가 실패로 남는다 — Step 4 의 핵심).

**테스트 ②: 빈 결과는 공유 캐시에 쓰지 않는다**
- dgk 스텁이 `resultCode: '000'` + `items` 빈 응답을 돌려준다(= 정상 0건).
- 단언: `rset` 이 호출되지 않았다.
- 단언: `isRentCached` 가 `false` 다.

⚠ 두 테스트 모두 `process.env.RENT_MIN_GAP_MS = '0'` 을 설정해 페이서 대기로 느려지지 않게 하고,
`finally` 에서 원래 값으로 복원하라(기존 테스트가 `:6403`·`:6421` 에서 그렇게 한다).
⚠ 절대 날짜를 테스트에 박지 마라 — `monthsWindow()` 의 반환값을 그대로 쓰거나 `now` 를 주입하라.
이 저장소는 절대 날짜 때문에 CI 가 무작위로 깨진 이력이 있다.

**검증**: `cd backend && npm test` → `pass` ≥ 226, `fail 0`

### Step 6: 회귀 주입

⚠ **주입 전 `git status --short` 가 비어 있어야 한다**(Step 1~5 를 커밋했는지 확인).

커밋한 뒤 세 가지를 각각 주입해 테스트가 잡는지 본다:
1. Step 1 의 `throw` 를 `break` 로 되돌린다 → `fail` ≥ 1 확인
2. Step 2 의 `if (rows.length)` 가드를 제거한다 → `fail` ≥ 1 확인
3. Step 4 의 실패 표식 검사를 제거한다(빈 배열 캐시로 복귀) → `fail` ≥ 1 확인

각각 확인 후 `git checkout -- <파일>` 로 되돌린다.

**검증**: 세 주입 모두 fail. 하나라도 안 잡히면 **STOP 조건**이다.

### Step 7: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0.

## 테스트 계획

- **새 테스트 2개**(Step 5). 필요하면 3개로 쪼개도 된다.
- **패턴 참고**: `backend/test/characterization.test.js:6400`(dgk 스텁·페이서) 과
  `:6486`(redisCache 스텁). 두 테스트의 `saved`/`finally` 복원 구조를 반드시 지켜라 —
  복원을 빠뜨리면 **그 뒤 수천 줄의 테스트가 오염된 스텁으로 통과**한다(위양성 초록).
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `grep -c "MOLIT 전월세 resultCode=" backend/services/rentService.js` ≥ `1`
- [ ] `rentService.js` 의 `_fetchRentMonth` 안에 `resultCode` 검사 뒤 `break` 가 없다:
      `grep -n "MOLIT_OK_CODES.has" -A 3 backend/services/rentService.js` 출력에 `break;` 없음
- [ ] `grep -c "if (rows.length) rset" backend/services/rentService.js` → `1`
- [ ] `node --check backend/services/rentService.js` exit 0
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 226, `fail 0`
- [ ] `npm run lint` exit 0
- [ ] `node scripts/check-env-example.js` 누락 0건
- [ ] Step 6 의 회귀 주입 3건에서 각각 fail 확인
- [ ] `backend/jobs/rentWarm.js` 가 **변경되지 않았다**(`git status --short` 로 확인)
- [ ] `plans/README.md` 의 037 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 `rentService.js` 가 변경돼 "현재 상태" 발췌와 다르다.
- Step 6 의 주입 중 하나라도 테스트가 잡지 못한다.
- `throw` 로 바꿨더니 기존 테스트가 깨진다 — 그 테스트가 무엇을 고정하고 있었는지
  **먼저 읽고** 보고하라. 그것이 의도된 계약이라면 이 계획의 전제가 틀린 것이다.
- 수정이 `rentWarm.js` 나 `report.js` 를 건드려야 할 것 같다(그렇다면 Step 1 의 전제
  — "기존 catch·QUOTA_RE 가 저절로 다시 작동한다" — 가 틀렸다는 뜻이므로 보고하라).
- 새 환경변수를 추가해야 할 것 같다(권장하지 않는다. 추가한다면 `.env.example` 동시 갱신 필수).

## 유지보수 메모

- **이 수정 뒤 관측 방법**: 프로덕션 런타임 로그에서 `전월세` 로 검색하면
  `'전월세 월별 조회 실패 — 그 달이 표본에서 빠진다'` 와
  `'전월세 표본 불완전 — 전세가율은 남은 달로만 계산된다'` 가 보인다.
  `/api/health` 의 `crons['rent-live']` 에 실패 사유가 남는다. 수정 전에는 같은 상황이
  `ok:1` 로 남았으므로 **health 가 조용해지는 대신 정직해진다** — 그게 의도다.
- **리뷰에서 볼 것**: `rentWarm.js` 가 안 바뀌었는지. 바뀌었다면 Step 1 이 불완전하다는 신호다.
- **앞으로 이 파일에 캐시 쓰기를 추가할 때**: "성공했는가" 를 판정한 뒤에만 공유 계층에 써라.
  이 저장소의 확립된 원칙이다(열화 응답을 긴 캐시로 굳히면 일시 장애가 캐시 수명만큼 지속된다).
- **의도적으로 미뤄둔 것**: (a) `MAX_PAGES` 상한 도달(부분 페이징, `:175-180`)도 지금은
  `logger.warn` 뿐이다 — 완주 여부를 결과에 실어 보내는 것이 정석이나 별건이다.
  (b) `monthsWindow`(`rentService.js:52-57`)가 호스트 로컬 TZ 메서드를 쓰는 문제 —
  프로덕션 런타임이 UTC 라 매월 1일 KST 00~09시에 6개월 창이 한 달 밀린다. 같은 스프린트에
  만든 `backend/utils/kstTime.js` 로 옮겨야 하지만 **이 계획의 범위가 아니다**(운영자가
  이번 라운드에서 선택하지 않았다). `plans/README.md` 백로그에 근거와 함께 기록돼 있다.
  여기서 고치지 마라.
