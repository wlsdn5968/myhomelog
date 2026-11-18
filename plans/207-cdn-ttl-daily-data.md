# Plan 207: 하루 한 번 바뀌는 자료의 CDN 수명을 30분에서 6시간으로 맞춘다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 207 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/routes/transactions.js backend/routes/analysis.js backend/routes/search.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음
- **범주**: perf
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

이 서비스는 Vercel Hobby 의 함수 CPU 한도(30일 합계)를 아껴야 한다(2026-11-08 에 한도 초과로 정지된 적이 있다). CDN 이 응답을 기억하고 있는 동안은 함수가 불리지 않는다. 실거래 자료는 하루 한 번, 밤 적재 작업(UTC 17:00~17:30, 한국 시간 새벽 2시대)으로만 바뀐다. 그래서 서버 메모리 캐시는 이미 6시간이다. 그런데 아래 네 응답의 CDN 수명은 30분이라, 같은 주소를 사람들이 계속 보는 동안 30분마다 함수가 다시 불린다. 이 저장소의 다른 응답(`backend/routes/transactions.js:97, 112` 의 이력과 기록)은 같은 이유로 이미 6시간을 쓴다. 이 계획이 끝나면 네 응답도 같은 값을 쓴다. 실제로 함수 호출이 얼마나 줄어드는지는 재지 않았다(CDN 적중률은 운영 값이 필요하다).

## 지금 상태

- `backend/routes/transactions.js` : `GET /api/transactions` (월별, 단지별 실거래 목록)
- `backend/routes/analysis.js` : `GET /api/analysis` (단지 가격 위치와 전세가율 분석)
- `backend/routes/search.js` : `GET /api/search/popular-region` (시도별 구별 순위), `GET /api/search/popular` (인기 단지)

`backend/routes/transactions.js:74`

```js
    res.set('Cache-Control', (!_partial && items.length > 0) ? 'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600' : 'no-store');
```

`backend/routes/analysis.js:10-11`

```js
// PARTIAL-FLAG-2026-11 (Plan 200): 완전한 응답만 CDN 에 30분. 빈 표본·일부 달 누락은 굳히지 않는다.
const CC = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600';
```

`backend/routes/analysis.js:35`

```js
    res.set('Cache-Control', (result.molitAvailable && !result.samplePartial && !result.jeonsePartial && (result.txCount || 0) > 0) ? CC : 'no-store');
```

`backend/routes/search.js:847` (popular-region)

```js
  const CC_OK = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';
```

`backend/routes/search.js:888-889` (popular)

```js
    const CDN_OK = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';
    const CDN_FALLBACK = 'public, max-age=0, s-maxage=120, stale-while-revalidate=600';
```

이미 6시간을 쓰는 본보기. `backend/routes/transactions.js:112`

```js
    const CC = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';
```

서버 메모리 캐시가 6시간이라는 근거. `backend/services/transactionService.js:378`

```js
      cache.setRows(cacheKey, fromDb, 21600); // REC-PERF-2026-07-10 (Sprint EEEE): 1h→6h — 데이터는 daily cron(17:00 UTC)만 갱신, 콜드 빈도 축소
```

품질이 떨어진 응답은 지금도 CDN 에 오래 두지 않는다. 이 분기는 그대로 둔다.
- `transactions.js:74` : 일부 달을 못 읽었거나 목록이 비면 `no-store`
- `analysis.js:35` : 표본이 불완전하면 `no-store`
- `search.js:854, 869, 873` : 순위가 비었으면 `no-store`, 시간에 걸려 덜 끝났으면 `s-maxage=120`
- `search.js:889, 945` : 대체 경로 결과는 `CDN_FALLBACK`(120초), 만료 스냅샷은 `s-maxage=120`

같은 글자열 `s-maxage=1800` 을 쓰지만 이 계획이 건드리지 않는 곳(2026-11-18 grep): `backend/routes/regulations.js:26`, `backend/routes/briefing.js:216`, `backend/routes/news.js:269`, `backend/routes/ogImage.js:209`. 자료가 바뀌는 주기가 달라서 따로 판단해야 한다.

이 값을 고정하는 기존 검사
- `backend/test/cache-degraded.test.js:286` 과 `:366` : `GET /api/search/popular` 의 정상 응답 헤더가 `'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400'` 인지 본다. 검사 제목에 "기존 30분 캐시"라는 말이 있다(281행, 357행).
- `backend/test/cache-degraded.test.js:69` : `regulations` 경로의 같은 글자열을 본다. 이 계획의 대상이 아니다. 고치지 않는다.
- `backend/test/partial-sample-200.test.js:70` : `GET /api/analysis` 의 정상 응답이 `/s-maxage=1800/` 에 맞는지 본다.

저장소 규칙
- 주석은 한국어, 이름표는 `CDN-6H-1118`.
- 검사는 `node:test`, `node:assert/strict`.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/<파일>.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/<파일>.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/routes/transactions.js` (74행의 글자열과 주석)
- `backend/routes/analysis.js` (10-11행)
- `backend/routes/search.js` (847행, 888행과 주석)
- `backend/test/cache-degraded.test.js` (281-290행, 357-366행 부근의 popular 검사 두 개)
- `backend/test/partial-sample-200.test.js` (70행)
- `plans/README.md` (207 줄의 상태만)

**고치면 안 되는 것**
- 품질이 떨어진 응답의 분기(`no-store`, `s-maxage=120`, `CDN_FALLBACK`). 값도 조건도 그대로 둔다.
- 서버 메모리 캐시 수명(`cache.set(..., 1800)` 같은 줄). `search.js:872, 908, 921` 의 1800 은 메모리 캐시라 이 계획 대상이 아니다.
- `regulations.js`, `briefing.js`, `news.js`, `ogImage.js` 의 캐시 헤더와 `cache-degraded.test.js:62-69` 의 regulations 검사.
- `vercel.json`.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/207-cdn-ttl-daily-data`
- 커밋 제목: `perf(cdn): 하루 한 번 바뀌는 실거래 응답의 CDN 수명을 6시간으로 (Sprint 1118-plan207)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

새 값은 네 곳 모두 같다: `'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400'`

### 1단계: 실거래 목록

`backend/routes/transactions.js:74` 의 `'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600'` 을 새 값으로 바꾼다. 그 줄 위에 주석을 더한다.

```js
    // CDN-6H-1118 (plans/207): 자료는 밤 적재(UTC 17시대) 한 번으로만 바뀐다. 서버 메모리 캐시(6시간)와 맞춰 CDN 도 6시간. 못 읽은 달이 있거나 빈 응답은 종전대로 no-store.
```

**확인**: `grep -n "s-maxage=1800" backend/routes/transactions.js` → 결과 없음.

### 2단계: 분석

`backend/routes/analysis.js:10-11` 을 바꾼다.

```js
// PARTIAL-FLAG-2026-11 (Plan 200): 완전한 응답만 CDN 에 둔다. 빈 표본·일부 달 누락은 굳히지 않는다.
// CDN-6H-1118 (plans/207): 30분에서 6시간으로. 실거래는 밤 적재 한 번, 전월세는 하루 한 번 예열로만 바뀐다.
const CC = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';
```

**확인**: `grep -n "s-maxage=1800" backend/routes/analysis.js` → 결과 없음.

### 3단계: 구별 순위와 인기 단지

`backend/routes/search.js:847` 의 `CC_OK` 와 `:888` 의 `CDN_OK` 값을 새 값으로 바꾼다. 각 줄 끝에 `// CDN-6H-1118 (plans/207): 하루 한 번 만드는 집계라 6시간` 을 붙인다. `CDN_FALLBACK`(889행)은 건드리지 않는다.

**확인**: `grep -n "s-maxage=1800" backend/routes/search.js` → 결과 없음. `grep -n "s-maxage=120" backend/routes/search.js` → 873행, 889행, 945행 세 줄이 그대로 있다.

### 4단계: 검사 기대값을 고친다

1. `backend/test/cache-degraded.test.js:286` 의 `CDN_OK` 글자열과 `:366` 의 기대 글자열을 새 값으로 바꾼다. 두 검사의 제목(281행, 357행)에서 "기존 30분 캐시"를 "6시간 캐시"로 고친다.
2. `backend/test/cache-degraded.test.js:69`(regulations 검사)는 고치지 않는다.
3. `backend/test/partial-sample-200.test.js:70` 의 `/s-maxage=1800/` 을 `/s-maxage=21600/` 으로 바꾼다.
4. `backend/test/partial-sample-200.test.js` 의 그 검사(68행에서 시작) 안에 단언 한 줄을 더한다: 정상 응답의 헤더에 `stale-while-revalidate=86400` 이 들어 있는지.

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/cache-degraded.test.js test/partial-sample-200.test.js` → `ℹ fail 0`.

### 5단계: 전체 검증

저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`, 검사 수는 기준과 같다(새 검사 파일은 없다).

## 검사 계획

- 고치는 검사: `cache-degraded.test.js` 의 popular 검사 두 개, `partial-sample-200.test.js` 한 개(단언 한 줄 추가).
- 품질이 떨어진 응답이 여전히 짧게 기억되는지는 `cache-degraded.test.js` 의 기존 검사들이 본다. 그 검사들은 고치지 않고 통과해야 한다.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -rn "s-maxage=1800" backend/routes/transactions.js backend/routes/analysis.js backend/routes/search.js` 결과 없음
- [ ] `grep -rn "s-maxage=1800" backend/routes` 의 결과가 `regulations.js`, `briefing.js`, `news.js`, `ogImage.js` 네 파일뿐이다
- [ ] `backend/test/cache-degraded.test.js:62-69` 의 regulations 검사가 그대로다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 207 줄 상태를 고쳤다

## 멈춤 조건

- "지금 상태"의 발췌와 실제 코드가 다르다.
- 4단계에 적힌 것 말고 다른 검사가 `s-maxage=1800` 때문에 깨진다. 그 검사가 어느 경로를 보는지 보고한다.
- 품질이 떨어진 응답의 분기를 고쳐야만 검사가 통과한다는 결론이 난다.

## 뒤에 맡을 사람에게

- 이 변경 뒤에는 밤 적재가 끝난 뒤에도 CDN 이 기억하던 응답이 최대 6시간 더 나간다. 수명이 끝난 뒤 첫 요청은 옛 응답을 받고 그때 뒤에서 새로 받는다(`stale-while-revalidate`). 한국 시간으로는 새벽 2시대 적재분이 늦으면 아침 8시대부터 보인다. 화면이 "언제 기준"을 보여 주는 곳(자료 동기화 시각, 인기 단지의 집계 창)은 응답 안의 값을 쓰므로 응답과 표시는 서로 맞는다.
- 자료를 급히 고친 날(잘못 적재된 달을 다시 받은 경우)에는 CDN 이 옛 응답을 최대 6시간 들고 있다. 새로 배포하면 Vercel 의 CDN 캐시가 비워지는지는 이 계획에서 확인하지 않았다. 필요하면 Vercel 문서에서 확인한다.
- 효과는 Vercel 사용량 화면의 Function Invocations 와 Fluid Active CPU 의 내집로그 하루 값으로 본다(2026-11-13~16 은 하루 2분 29초~3분 6초였다).
- 같은 종류로 남은 것(이 계획 범위 밖): 단지 서버 페이지에서 없는 단지와 거래 없는 단지가 `no-store` 인 것(`backend/routes/aptPage.js:421, 438`), 방문 수 응답의 60초(`backend/routes/visits.js:35`).
