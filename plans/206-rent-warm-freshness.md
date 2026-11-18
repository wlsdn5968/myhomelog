# Plan 206: 전월세 예열이 "캐시가 있다"가 아니라 "오늘 받았다"일 때만 건너뛰게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 206 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/services/rentService.js backend/jobs/rentWarm.js backend/services/redisCache.js`
> `rentService.js` 는 `plans/205` 가 먼저 고친다. 그 변경(읽기 세 곳이 `cache.getRows`, 쓰기 두 곳이 `cache.setRows`)만 있으면 정상이다. 그 밖의 차이가 있으면 "지금 상태"의 발췌와 견주고, 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: MED (국토부 API 를 예약 작업이 부르는 횟수가 설계값으로 늘어난다. 아래 "왜 필요한가" 끝을 읽을 것)
- **선행 계획**: `plans/205-rent-cache-noclone.md` (같은 파일을 고친다. 205 가 끝난 뒤에 한다)
- **범주**: perf
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

전월세 예열 작업(`backend/jobs/rentWarm.js`, 하루 한 번)은 지역과 달마다 국토부 전월세 자료를 미리 받아 Redis 에 넣어 둔다. 그래야 사용자가 단지 상세나 보고서를 열 때 국토부를 바로 부르지 않는다(바로 부르면 지역 하나에 여섯 번, 호출 사이 350ms 를 기다린다). 작업의 설계는 파일 머리말에 적혀 있다: 최근 두 달은 매일, 그 이전 넉 달은 지역을 7조로 나눠 주 1회 다시 받는다. Redis 수명은 최근 두 달 30시간, 그 이전 8일이다.

그런데 건너뛰기 판정이 "Redis 에 값이 있으면 건너뛴다"이다. 그래서 설계와 다르게 돈다.
- 그 이전 넉 달: 7일 뒤 다시 방문했을 때 값이 아직 하루 남아 있어 건너뛴다. 하루 뒤 만료되고, 다음 방문은 엿새 뒤다. 14일 가운데 엿새는 캐시가 비어 있다.
- 최근 두 달: 24시간 뒤 방문했을 때 값이 6시간 남아 있어 건너뛰고, 그 뒤 만료된다. 이 계산대로면 이틀 가운데 18시간이 비어 있다.

비어 있는 동안에는 사용자 요청이 국토부를 바로 부른다. 또 건너뛸지 보려고 Redis 에서 그 달의 목록 전체를 내려받는다(길이만 보는데도).

근거
- 코드: `rentService.js:70-72`(수명), `:87-96`(판정), `rentWarm.js:33-48`(방문 규칙), `vercel.json` 의 `30 20 * * *`.
- 운영 기록 한 회차(health `crons['warm-rent']`, 2026-11-16T21:09Z): 가져옴 234, 건너뜀 78, 실패 0, 84.5초, CPU 5,889ms. 그 회차의 계획 건수는 312(234+78)이고, 주 1회 조의 그 이전 달이 약 72건이다. 건너뜀 78 이 그 이전 달 건수와 거의 같다.
- 최근 두 달이 격일로 건너뛰어지는지는 한 회차 기록만으로는 확인하지 못했다. 위 계산은 코드의 숫자로만 한 것이다.

이 계획이 끝나면 건너뛰기는 "최근 12시간 안에 받은 값이 있을 때"(같은 날 두 번 불린 경우)만 일어나고, 판정은 Redis 의 남은 수명만 묻는다(목록을 내려받지 않는다).

알고 시작할 것: 예약 작업이 국토부를 부르는 횟수가 파일 머리말의 설계값(하루 약 320번)으로 돌아간다. 2026-11-16 회차는 234번이었다. 국토부 일일 한도는 운영자 콘솔에서만 볼 수 있다. 한도에 걸리면 작업은 이미 있는 장치로 바로 멈추고 사유를 남긴다(`stopped: 'quota'`).

## 지금 상태

- `backend/jobs/rentWarm.js` : 예열 작업. `run()` 이 방문 목록을 만들고 지역과 달마다 판정 뒤 받는다.
- `backend/services/rentService.js` : 전월세 조회. 판정 함수 `isRentCached`, 조회 함수 `getRentTransactions`, 국토부를 실제로 부르는 `_fetchRentMonth`.
- `backend/services/redisCache.js` : Redis 읽기와 쓰기 도우미 `rget`, `rset`. 키 앞에 `rc:` 를 붙인다.

`backend/jobs/rentWarm.js:6-10` (머리말)

```js
 * [범위] LAWD_CODES 전 지역(폐지 제외). 최근 2개월은 매일(계약 등록 지연 반영), 그 이전 4개월은 지역을 7조로 나눠
 *   하루 한 조(주 1회) — Redis TTL(최근 30h · 이전 8일)과 맞물린다. 하루 ≈ 124×2 + 18×4 ≈ 320콜 × 350ms ≈ 2분.
 * [한도] 국토부 일 트래픽 한도는 운영자 콘솔에서만 보인다 — 일 한도 초과(code=22)를 만나면 즉시 멈추고 사유를 남긴다.
 *   시간 예산 240s(함수 상한 300s 안). 초당 한도(code=23)는 rentService 의 페이서·1회 재시도가 맡고, 그래도 실패면 그 달만 건너뛴다.
 * [멱등] 이미 캐시된 (구,월)은 건너뛴다 → Hobby cron 이 두 번 불려도 부작용 없음(같은 날 재실행은 대부분 skip).
```

`backend/jobs/rentWarm.js:42-55`

```js
  const worker = async () => {
    while (idx < tasks.length && !out.stopped) {
      if (Date.now() - t0 >= budgetMs) { out.stopped = 'budget'; break; }
      const [code, ym] = tasks[idx++];
      try {
        if (await rent.isRentCached(code, ym)) { out.skipped++; continue; }
        await rent.getRentTransactions(code, ym);
        out.fetched++;
      } catch (e) {
        out.failed++;
        if (QUOTA_RE.test(String((e && e.reason) || ''))) { out.stopped = 'quota'; break; }
      }
    }
  };
```

`backend/services/rentService.js:70-72`

```js
function rentTtlSec(dealYm, now = new Date()) {
  return monthsWindow(now).slice(0, 2).includes(String(dealYm)) ? 30 * 3600 : 8 * 86400;
}
```

`backend/services/rentService.js:87-96` (`plans/205` 뒤에는 93행이 `cache.getRows(key)` 다)

```js
async function isRentCached(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  // (주석 생략)
  const local = cache.get(key);
  if (Array.isArray(local) && local.length) return true;
  const shared = await rget(key);
  return Array.isArray(shared) && shared.length > 0;
}
```

`backend/services/rentService.js:112-136` 의 `getRentTransactions` 는 로컬 캐시, Redis, 국토부 순서로 읽는다. 그래서 값이 남아 있는 달을 이 함수로 부르면 국토부까지 가지 않는다. 다시 받으려면 `_fetchRentMonth` 를 직접 불러야 하는데, 이 함수도 첫머리(163-167행)에서 로컬 캐시를 먼저 읽는다.

```js
  const cacheKey = `rent:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);            // plans/205 뒤에는 cache.getRows(cacheKey)
  if (cached !== undefined) {
    if (_isFailMark(cached)) _throwFailMark(cached);
    return cached || [];
  }
```

`_fetchRentMonth` 가 실패하면 던지는 오류에는 `reason` 이 붙는다(`rentService.js:291-295`). 예열 작업은 이 값으로 일일 한도를 알아본다.

`backend/services/redisCache.js:19-45`

```js
const PREFIX = 'rc:'; // rate-limit 등 기존 키와 네임스페이스 분리

/** @returns 캐시 값 또는 undefined(미스/미설정/오류) */
async function rget(key) {
  try {
    const r = getRedis();
    if (!r) return undefined;
    const v = await r.get(PREFIX + key);
    return v === null || v === undefined ? undefined : v;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'redisCache get 실패 (무시 — 로컬 캐시만 사용)');
    return undefined;
  }
}
...
module.exports = { rget, rset };
```

`getRedis()` 는 `@upstash/redis` 클라이언트를 돌려준다(`backend/redis.js:20-50`). 이 클라이언트의 `ttl(key)` 는 남은 초를 돌려주고, 키가 없으면 -2, 수명이 없는 키면 -1 을 돌려준다.

기존 검사: `backend/test/rent-jeonse.test.js:155-203` 이 예열 작업을 가짜 `rentService`(`monthsWindow`, `isRentCached`, `getRentTransactions`)로 돌린다. 이 계획은 작업이 부르는 함수 이름을 바꾸므로 이 검사의 가짜 객체도 고쳐야 한다.

저장소 규칙
- 주석은 한국어, 이름표는 `RENT-FRESH-1118`.
- 검사는 `node:test`, `node:assert/strict`.
- 운영 Redis 나 운영 주소를 부르지 않는다. 검사는 가짜 객체로만 한다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/rent-jeonse.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/rent-jeonse.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/services/redisCache.js` (`rttl` 추가)
- `backend/services/rentService.js` (`isRentFresh`, `refreshRentMonth` 추가와 내보내기)
- `backend/jobs/rentWarm.js` (판정과 받기 두 줄, 머리말 한 줄)
- `backend/test/rent-jeonse.test.js` (155행에서 시작하는 예열 검사의 가짜 객체와, 새 검사 추가)
- `plans/README.md` (206 줄의 상태만)

**고치면 안 되는 것**
- `rentTtlSec` 의 수명 값(30시간, 8일)과 `vercel.json` 의 예약 시각. 기존 검사가 이 값을 고정한다.
- `isRentCached` 와 `getRentTransactions` 의 동작. 사용자 요청 경로가 쓴다. 지우지도 않는다.
- 사용자 요청 경로(`getJeonseByApt`, `backend/routes/report.js`, `backend/services/analysisService.js`).
- `backend/routes/cron.js` 의 warm-rent 처리기.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/206-rent-warm-freshness`
- 커밋 제목: `fix(rent-warm): 오늘 받은 값만 건너뛰고 남은 수명으로 판정 (Sprint 1118-plan206)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: 남은 수명을 묻는 도우미를 더한다

`backend/services/redisCache.js` 의 `rset` 아래에 더하고 내보낸다.

```js
/**
 * RENT-FRESH-1118 (plans/206): 키의 남은 수명(초). 값을 내려받지 않는다.
 * @returns 남은 초(0 이상) | -2(키 없음) | -1(수명 없는 키) | undefined(Redis 미설정 또는 오류)
 */
async function rttl(key) {
  try {
    const r = getRedis();
    if (!r) return undefined;
    const v = Number(await r.ttl(PREFIX + key));
    return Number.isFinite(v) ? v : undefined;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'redisCache ttl 실패 (무시)');
    return undefined;
  }
}

module.exports = { rget, rset, rttl };
```

**확인**: `cd backend` 뒤 `node -e "console.log(typeof require('./services/redisCache').rttl)"` → `function`.

### 2단계: 전월세 서비스에 판정과 강제 받기를 더한다

`backend/services/rentService.js` 에서
1. 파일 위쪽의 `redisCache` 불러오는 줄을 찾아(`grep -n "redisCache" backend/services/rentService.js`) `rttl` 도 같이 받게 한다.
2. `isRentCached` 함수 바로 아래에 더한다.

```js
// RENT-FRESH-1118 (plans/206): 예열 작업 전용 판정. "값이 있다"가 아니라 "최근 12시간 안에 받았다"일 때만 참이다.
//   [왜] 값이 있으면 건너뛰던 때에는 수명이 다 돼 가는 값도 건너뛰어서, 다음 방문까지 캐시가 비어 있었다
//     (그 이전 달: 14일 가운데 엿새. 최근 두 달: 계산상 이틀 가운데 18시간). 빈 동안은 사용자 요청이 국토부를 바로 불렀다.
//   [어떻게] Redis 의 남은 수명만 묻는다(목록을 내려받지 않는다). 남은 수명이 "전체 수명 - 12시간"보다 길면 방금 받은 것이다.
//     Redis 를 쓸 수 없으면 예전 판정(isRentCached)으로 돌아간다.
const RENT_FRESH_WINDOW_S = 12 * 3600;
async function isRentFresh(lawdCd, dealYm, now = new Date()) {
  const remain = await rttl(`rent:${lawdCd}:${dealYm}`);
  if (remain === undefined) return isRentCached(lawdCd, dealYm);
  if (remain < 0) return false;
  return remain > rentTtlSec(dealYm, now) - RENT_FRESH_WINDOW_S;
}

// RENT-FRESH-1118: 예열 작업 전용. 로컬과 Redis 에 값이 남아 있어도 국토부에서 다시 받아 둘 다 고쳐 쓴다.
//   5분 실패 표식이 있으면 그대로 던진다(실패 직후 다시 두드리지 않는다). 빈 결과는 종전대로 Redis 에 쓰지 않는다.
async function refreshRentMonth(lawdCd, dealYm) {
  const key = `rent:${lawdCd}:${dealYm}`;
  const local = cache.getRows(key);
  if (_isFailMark(local)) _throwFailMark(local);
  cache.del(key);
  const rows = await _fetchRentMonth(lawdCd, dealYm);
  if (rows.length) await rset(key, rows, rentTtlSec(dealYm));
  return rows;
}
```

3. 파일 끝의 `module.exports` 에 `isRentFresh`, `refreshRentMonth` 를 더한다.

`plans/205` 가 아직 안 된 상태라면 `cache.getRows` 가 아니라 `cache.get` 을 써야 맞지만, 이 계획은 205 다음에 하므로 `cache.getRows` 로 쓴다. 205 가 안 돼 있으면 멈춤 조건이다.

**확인**: `node -e "const r=require('./services/rentService');console.log(typeof r.isRentFresh, typeof r.refreshRentMonth)"` → `function function`.

### 3단계: 예열 작업이 새 함수를 쓰게 한다

`backend/jobs/rentWarm.js:47-48` 을 바꾼다.

```js
        if (await rent.isRentFresh(code, ym, now)) { out.skipped++; continue; } // RENT-FRESH-1118: 오늘 받은 값만 건너뛴다
        await rent.refreshRentMonth(code, ym);
```

머리말의 `[멱등]` 줄(10행)을 고친다.

```js
 * [멱등] 최근 12시간 안에 받은 (구,월)은 건너뛴다(RENT-FRESH-1118, plans/206) → Hobby cron 이 같은 날 두 번 불려도 대부분 skip.
 *   값이 남아 있어도 그보다 오래됐으면 다시 받는다. 그래야 다음 방문 전에 수명이 끝나 캐시가 비는 일이 없다.
```

**확인**: `grep -n "isRentCached\|getRentTransactions" backend/jobs/rentWarm.js` → 결과 없음.

### 4단계: 기존 예열 검사의 가짜 객체를 고친다

`backend/test/rent-jeonse.test.js:162-166` 의 가짜 객체에서 이름 두 개를 바꾼다. 본문과 단언은 그대로 둔다.
- `isRentCached: async (c, ym) => cached.has(c + ':' + ym),` → `isRentFresh: async (c, ym) => cached.has(c + ':' + ym),`
- `getRentTransactions: async (c, ym) => { ... }` → `refreshRentMonth: async (c, ym) => { ... }` (중괄호 안은 글자 그대로)

검사 제목의 "캐시된 달은 건너뛰고"를 "오늘 받은 달은 건너뛰고"로 고친다.

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/rent-jeonse.test.js` → `ℹ fail 0`.

### 5단계: 새 검사를 더한다

같은 파일(`backend/test/rent-jeonse.test.js`)의 예열 검사 바로 아래에 검사 두 개를 더한다. 가짜 `redisCache` 를 끼우는 방식은 같은 파일 249-284행 검사를 본뜬다(`require.cache` 에 `{ rget, rset, rttl }` 를 넣고 `finally` 에서 되돌린다).

검사 A: `isRentFresh` 의 판정
- 가짜 `rttl` 이 돌려줄 값을 바꿔 가며 확인한다. `ym` 은 `rent.monthsWindow()[0]`(최근 달, 전체 수명 108,000초)과 `rent.monthsWindow()[4]`(그 이전 달, 691,200초)를 쓴다.
  - 최근 달, 남은 수명 107,000 → 참(방금 받음)
  - 최근 달, 남은 수명 21,600(6시간) → 거짓(어제 받은 값)
  - 그 이전 달, 남은 수명 86,400(하루) → 거짓(지난주에 받은 값)
  - 그 이전 달, 남은 수명 690,000 → 참
  - 남은 수명 -2(키 없음) → 거짓
  - `rttl` 이 `undefined`(Redis 없음)이고 로컬 캐시에 그 키로 행이 하나 있으면 → 참(예전 판정으로 돌아감). 로컬에도 없으면 거짓.
- `rget` 가 한 번도 불리지 않았는지 확인한다(Redis 가 있는 경우). 목록을 내려받지 않는다는 것이 이 계획의 요점이다.

검사 B: `refreshRentMonth` 는 값이 남아 있어도 국토부를 부른다
- 가짜 `dataGoKrClient` 가 호출을 세고 정상 응답(항목 1개)을 준다. 로컬 캐시에 같은 키로 옛 행을 먼저 넣어 둔다(`cache.setRows`).
- `refreshRentMonth` 를 부르면 가짜 클라이언트가 1번 불리고, 돌려준 행이 새 행이며, 가짜 `rset` 이 그 키와 `rentTtlSec` 값으로 1번 불린다.
- 가짜 클라이언트가 비정상 응답코드(`'22'`)를 주게 바꾸고 다른 지역 코드로 부르면 거절되고, 오류의 `reason` 이 비어 있지 않다. 곧바로 다시 부르면 가짜 클라이언트를 다시 부르지 않고 거절된다(5분 실패 표식).
- `process.env.RENT_MIN_GAP_MS = '0'`, `process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key'` 로 두고 `finally` 에서 되돌린다. 쓴 캐시 키를 지운다.

**확인**: `TZ=UTC node --test test/rent-jeonse.test.js` → `ℹ fail 0`, 검사 수가 2개 늘었다.

### 6단계: 전체 검증

저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`.

## 검사 계획

- 고치는 검사 1개: 예열 검사의 가짜 객체 이름(4단계).
- 새 검사 2개: 판정(A), 강제 받기(B).
- 본보기: `backend/test/rent-jeonse.test.js:249-284`.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -n "isRentCached\|getRentTransactions" backend/jobs/rentWarm.js` 결과 없음
- [ ] `backend/services/rentService.js` 의 `rentTtlSec` 본문이 그대로다(`30 * 3600`, `8 * 86400`)
- [ ] `isRentCached`, `getRentTransactions` 가 여전히 내보내진다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 206 줄 상태를 고쳤다

## 멈춤 조건

- `plans/205` 가 끝나 있지 않다(`grep -n "cache\.get(" backend/services/rentService.js` 에 결과가 있다).
- "지금 상태"의 발췌와 실제 코드가 다르다.
- `@upstash/redis` 클라이언트에 `ttl` 이 없다(`backend` 폴더에서 `node -e "const {Redis}=require('@upstash/redis');const r=new Redis({url:'https://example.invalid',token:'t'});console.log(typeof r.ttl)"` 를 돌려 `function` 이 아니면 멈춘다. 이 명령은 네트워크를 부르지 않는다. 이 패키지는 명령을 prototype 이 아니라 인스턴스에 붙이므로 `Redis.prototype.ttl` 로 보면 안 된다. 2026-11-18 에 1.39.0 에서 `function` 을 확인했다. 처음 계획은 prototype 으로 보라고 적어 실행자가 멈췄고, 그 뒤 이 줄을 고쳤다).
- 예열 검사 말고 다른 기존 검사가 깨진다.
- 수명 값이나 예약 시각을 바꿔야만 통과한다는 결론이 난다.

## 뒤에 맡을 사람에게

- 배포 뒤 며칠 동안 health 의 `crons['warm-rent']` 를 본다. 기대하는 모습: `fetched` 가 계획 건수에 가깝고(`skipped` 가 작다), `stopped` 가 없고, `remaining` 이 0 이다. 2026-11-16 회차는 가져옴 234, 건너뜀 78, 84.5초였다. 가져옴이 312 안팎이 되면 걸리는 시간이 늘어난다. 시간 예산은 240초다.
- `stopped: 'quota'` 가 보이면 국토부 일일 한도에 걸린 것이다. 그러면 `RENT_FRESH_WINDOW_S` 를 건드리지 말고, 그 이전 넉 달을 14조로 나눠 2주에 한 번 받게 하고 그 달의 수명을 15일로 늘리는 쪽을 검토한다(이 계획 범위 밖, 운영자 결정).
- 사용자 요청이 국토부를 바로 부른 횟수는 health 의 `crons['rent-live']` 에 남는다. 이 계획의 효과는 그 기록이 줄어드는 것으로 보인다. 지금 값은 재지 않았다.
- Redis 명령 수: 판정이 GET 한 번에서 TTL 한 번으로 바뀌어 명령 수는 같고 내려받는 양이 준다. 다시 받는 건수만큼 SET 이 는다(2026-11-16 회차 기준으로 건너뛴 78건이 다시 받는 쪽으로 넘어온다). Upstash 무료 한도는 `docs/ops/redis.md` 에 있다.
