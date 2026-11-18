# Plan 204: 국토부 매매 조회의 실패를 "거래 0건"으로 기억하지 않게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 204 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/services/transactionService.js backend/routes/transactions.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음. 같은 파일(`backend/services/transactionService.js`)을 고치는 다른 계획과 동시에 하지 않는다.
- **범주**: bug
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

국토부 실거래 API 가 오류 응답(일일 한도 초과 같은 비정상 응답코드, JSON 이 아닌 응답)을 주면, 지금 코드는 페이지 읽기를 그만두기만 하고 그때까지 모은 것(대개 빈 배열)을 정상 결과로 24시간 기억한다. 호출이 예외로 실패했을 때도 빈 배열을 5분 기억해서, 그 5분 안의 다음 조회는 예외 없이 "거래 0건"을 받는다. 그 결과 단지의 평균가, 가격 위치, 거래량이 한 달이 통째로 빠진 표본으로 계산되는데 "일부 달을 못 읽었다"는 표시가 붙지 않는다. 전월세 조회(`backend/services/rentService.js`)는 같은 문제를 2026-09-06 에 고쳤다. 매매 조회만 남아 있다. 이 계획이 끝나면 실패는 실패로 남고, 이미 있는 "일부 누락" 표시가 정상적으로 붙는다.

## 지금 상태

- `backend/services/transactionService.js` : 매매 실거래 조회. `getTransactions(lawdCd, dealYm)` 이 한 지역 한 달을 읽는다. DB 에 그 달이 없을 때만 국토부 API 를 부른다.
- `backend/services/rentService.js` : 전월세 조회. 이 계획이 본보기로 삼는 "실패 표식" 방식이 들어 있다.
- `backend/routes/transactions.js` : `GET /api/transactions`. 단지 이름 없이 부르면 `getTransactions` 를 바로 쓴다. 예외는 `handleMolitError(err, res)` 가 처리한다.

`backend/services/transactionService.js:21`

```js
const MOLIT_OK_CODES = new Set(['00', '000']);
```

`backend/services/transactionService.js:369-372`

```js
async function getTransactions(lawdCd, dealYm) {
  const cacheKey = `tx:${lawdCd}:${dealYm}`;
  const cached = cache.getRows(cacheKey);
  if (cached !== undefined) return cached || []; // null/[] 캐시도 hit 처리
```

`backend/services/transactionService.js:428-440` (페이지 루프 안)

```js
      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          resultCode: header.resultCode, resultMsg: header.resultMsg,
        }, 'MOLIT 거래 조회 비정상 응답코드');
        break; // 에러 응답이면 페이지 루프 중단
      } else if (!header && typeof response.data === 'string') {
        logger.warn({
          source: 'molit', lawdCd, dealYm, pageNo,
          sample: String(response.data).slice(0, 200),
        }, 'MOLIT 거래 비-JSON 응답');
        break;
      }
```

`backend/services/transactionService.js:488-498`

```js
    cache.setRows(cacheKey, result, 86400);
    return result;
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') throw err;
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.setRows(cacheKey, [], 300);
    const apiErr = new Error(`국토부 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
```

호출하는 쪽은 예외가 난 달만 "실패한 달"로 센다. `backend/services/transactionService.js:555-561, 592`

```js
  const _failedMonths = [];
  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch((e) => {
      _failedMonths.push(m);
      return [];
    }))
  );
  ...
  if (!_failedMonths.length) cache.setRows(cacheKey, sorted, 1800); else _markPartial(sorted);
```

본보기(전월세 쪽, 이미 고쳐진 코드). `backend/services/rentService.js:77-86`

```js
const RENT_FAIL = Symbol.for('myhomelog.rent.fail');
const _failMark = (reason) => ({ [RENT_FAIL]: true, reason: reason || null });
const _isFailMark = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && v[RENT_FAIL]);
function _throwFailMark(mark) {
  const err = new Error(`국토부 전월세 API 호출 실패(5분 캐시된 실패): ${mark.reason || ''}`);
  err.code = 'MOLIT_RENT_API_ERROR';
  err.status = 502;
  err.reason = mark.reason; // rentWarm.js 의 QUOTA_RE 가 이걸 본다
  throw err;
}
```

`backend/services/rentService.js:220-221` 은 비정상 응답코드에서 던진다.

```js
      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        throw new Error(`MOLIT 전월세 resultCode=${header.resultCode} msg=${header.resultMsg || ''}`);
```

알아 둘 것
- `cache.setRows(key, 값, ttl)` 은 값이 배열이 아니면 그냥 `cache.set` 으로 넣는다(`backend/cache.js:58-59`). `cache.getRows(key)` 는 그런 값을 그대로 돌려준다(`backend/cache.js:65-68`). 그래서 실패 표식 객체를 `setRows` 로 넣고 `getRows` 로 꺼낼 수 있다.
- `tx:` 로 시작하는 캐시 키를 읽는 코드는 `getTransactions` 한 곳뿐이다(2026-11-18 grep).
- `getTransactions` 를 부르는 곳은 `backend/routes/transactions.js:58` 과 `backend/services/transactionService.js:557` 두 곳뿐이다(2026-11-18 grep).

저장소 규칙
- 주석은 한국어로 쓰고, 고친 자리에 이름표를 붙인다. 이 계획의 이름표는 `TX-FAIL-MARK-1118` 이다. 주석에는 [왜], [어떻게]를 짧게 적는다(위 전월세 코드의 `RENT-DEGRADED-2026-09-06` 주석이 본보기다).
- 검사는 `node:test` 와 `node:assert/strict` 를 쓴다. 파일 첫 줄 근처에 `'use strict';`.
- Windows 에서 heredoc 으로 파일을 만들지 않는다. 편집 도구로 고친다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/<파일>.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/<파일>.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0`. 기준 커밋에서 검사 수는 1,274개다 |

전체 검증은 무겁다. 한 번에 하나만 돌리고 겹쳐 돌리지 않는다.

## 범위

**고쳐도 되는 파일**
- `backend/services/transactionService.js`
- `backend/test/tx-fail-mark-1118.test.js` (새로 만든다)
- 이 계획 때문에 기대값이 바뀌는 기존 검사 파일(아래 4단계에서 조건에 맞는 것만)
- `plans/README.md` (204 줄의 상태만)

**고치면 안 되는 것**
- `backend/services/rentService.js` : 본보기일 뿐이다. `plans/205`, `plans/206` 이 따로 고친다.
- `backend/routes/transactions.js` : 응답 형태와 캐시 헤더는 그대로 둔다.
- `backend/jobs/molitIngest.js` : 적재 작업은 이미 비정상 응답에서 던진다.
- `MOLIT_OK_CODES` 의 값.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/204-tx-fail-not-empty`
- 커밋 제목 형식(이 저장소의 실제 예: `refactor(frontend): 자료 상수 세 개를 frontend/js/data.js 로 옮김 (Sprint 1118-split4, plans/202 4단계 첫 묶음)`): `fix(tx): 국토부 매매 조회 실패를 빈 배열로 기억하지 않음 (Sprint 1118-plan204)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]` 세 줄을 적는다.
- 푸시하지 않는다. 운영 배포는 운영자가 "배포해"라고 할 때만 한다.

## 단계

### 1단계: 실패 표식 도우미를 더한다

`backend/services/transactionService.js` 의 `const MOLIT_OK_CODES = ...` 줄(21행) 바로 아래에 더한다.

```js
// TX-FAIL-MARK-1118 (plans/204): 실패를 빈 배열로 기억하면 5분 안의 다음 조회가 예외 없이 [] 를 받고,
//   getTransactionsByApt 의 _failedMonths 가 비어 "일부 달 누락" 표시가 사라진다(전월세 쪽 RENT-DEGRADED-2026-09-06 과 같은 문제).
//   5분 동안 외부 API 를 다시 두드리지 않는 것은 그대로 두고, 실패였다는 사실을 캐시에 담는다.
const TX_FAIL = Symbol.for('myhomelog.tx.fail');
const _txFailMark = (reason) => ({ [TX_FAIL]: true, reason: reason || null });
const _isTxFailMark = (v) => !!(v && typeof v === 'object' && !Array.isArray(v) && v[TX_FAIL]);
function _throwTxFailMark(mark) {
  const err = new Error(`국토부 API 호출 실패(5분 캐시된 실패): ${mark.reason || ''}`);
  err.code = 'MOLIT_API_ERROR';
  err.status = 502;
  throw err;
}
```

**확인**: `cd backend` 뒤 `node -e "require('./services/transactionService')"` → 오류 없이 끝난다.

### 2단계: 캐시에서 실패 표식을 만나면 다시 던진다

`getTransactions` 의 첫머리(지금 371-372행)를 아래처럼 바꾼다.

```js
  const cached = cache.getRows(cacheKey);
  if (cached !== undefined) {
    if (_isTxFailMark(cached)) _throwTxFailMark(cached); // TX-FAIL-MARK-1118: 캐시된 실패도 실패로 던진다
    return cached || []; // null/[] 캐시도 hit 처리
  }
```

**확인**: `node -e "require('./services/transactionService')"` → 오류 없음.

### 3단계: 비정상 응답과 JSON 이 아닌 응답은 던지고, 실패는 표식으로 기억한다

1. 428-440행의 두 `break` 를 던지기로 바꾼다. `logger.warn` 호출은 그대로 둔다.

```js
        }, 'MOLIT 거래 조회 비정상 응답코드');
        // TX-FAIL-MARK-1118: 종전엔 break 라 비정상 응답이 정상 0건으로 흘러 24시간 기억됐다. 던져서 아래 catch 가 5분 실패 표식을 심게 한다.
        throw new Error(`MOLIT 거래 resultCode=${header.resultCode} msg=${header.resultMsg || ''}`);
      } else if (!header && typeof response.data === 'string') {
        ...
        }, 'MOLIT 거래 비-JSON 응답');
        throw new Error('MOLIT 거래 비-JSON 응답');
      }
```

2. catch 블록(지금 493행)의 `cache.setRows(cacheKey, [], 300);` 을 아래로 바꾼다.

```js
    cache.setRows(cacheKey, _txFailMark(err.message), 300); // TX-FAIL-MARK-1118: 빈 배열이 아니라 실패 표식
```

`err.message` 에는 인증키가 들어가지 않는다(위에서 만든 문자열이거나 axios 오류 문장이다). 그래도 요청 주소나 `err.config` 를 표식에 넣지 않는다.

**확인**: `grep -n "setRows(cacheKey, \[\], 300)" backend/services/transactionService.js` → 결과 없음. `grep -c "TX-FAIL-MARK-1118" backend/services/transactionService.js` → 4 이상.

### 4단계: 회귀 검사를 쓴다

새 파일 `backend/test/tx-fail-mark-1118.test.js`. 구조는 `backend/test/rent-jeonse.test.js:249-284` 를 그대로 본뜬다. 그 검사는 `require.cache` 에 가짜 `../services/dataGoKrClient` 를 끼워 넣고, 끝나면 `finally` 에서 원래대로 돌린다.

준비
- `process.env.MOLIT_API_KEY = 'xxxxxxxx-test-molit-key'` 로 두고 끝나면 되돌린다.
- 검사 환경에는 Supabase 설정이 없어서 `DB_FIRST` 가 거짓이고 국토부 경로를 바로 탄다(`transactionService.js:24`). 만약 검사 실행 환경에 Supabase 환경 변수가 있으면 `process.env.MOLIT_DB_FIRST = 'false'` 로 두고 모듈을 다시 읽는다.
- 지역 코드는 실제로 안 쓰는 값(예: `'99994'`)을 쓰고, `finally` 에서 `tx:99994:` 로 시작하는 캐시 키를 지운다.

검사 4개
1. 비정상 응답코드(가짜 응답 `{ response: { header: { resultCode: '22', resultMsg: '일 트래픽 제한 초과' }, body: {} } }`)에서 `getTransactions` 가 `code === 'MOLIT_API_ERROR'` 로 거절된다.
2. 바로 이어서 같은 (지역, 달)을 다시 부르면(5분 캐시 경로) 가짜 클라이언트를 다시 부르지 않고(호출 횟수가 그대로) 역시 거절된다. 빈 배열이 돌아오면 실패다.
3. 응답이 문자열(`data: '<html>error</html>'`)이면 거절된다.
4. 정상 응답코드 `'000'` 에 항목이 0개면 예외 없이 `[]` 가 돌아오고, 다시 불러도 `[]` 다(진짜 0건은 종전대로 기억한다).

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/tx-fail-mark-1118.test.js` → `ℹ pass 4`, `ℹ fail 0`.

### 5단계: 전체 검증

저장소 루트에서 `npm run verify`.

기존 검사가 실패하면 그 검사가 무엇을 단언하는지 읽는다.
- "국토부가 실패한 뒤 5분 안에 다시 부르면 빈 배열이 온다"를 단언하는 검사라면, 그것이 이 계획이 없애는 동작이다. 거절을 기대하도록 고치고 커밋 본문에 파일 이름을 적는다.
- 그 밖의 이유로 실패하면 멈춤 조건이다.

**확인**: `npm run verify` → exit 0, `ℹ fail 0`, 검사 수 1,278개(1,274 + 새 검사 4).

## 검사 계획

- 새 검사: `backend/test/tx-fail-mark-1118.test.js` 4개(위 4단계).
- 본보기: `backend/test/rent-jeonse.test.js:249-284`.
- 확인: `npm run verify` → 모두 통과.

## 끝났다고 볼 조건

모두 참이어야 한다.

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `backend/test/tx-fail-mark-1118.test.js` 가 있고 4개가 통과한다
- [ ] `grep -n "setRows(cacheKey, \[\], 300)" backend/services/transactionService.js` 결과 없음
- [ ] `getTransactions` 의 페이지 루프 안(지금 428-440행 자리)에 `break; // 에러 응답이면 페이지 루프 중단` 이 없다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 204 줄 상태를 고쳤다

## 멈춤 조건

아래에 해당하면 멈추고 보고한다.

- "지금 상태"의 발췌와 실제 코드가 다르다.
- `tx:` 캐시 키를 `getTransactions` 밖에서 읽는 코드가 새로 생겼다(`grep -rn "\`tx:" backend --include=*.js` 로 확인. `backend/test` 는 뺀다).
- 5단계에서 "실패 뒤 빈 배열" 단언이 아닌 다른 이유로 기존 검사가 깨진다.
- 정상인데 응답코드가 `'00'`, `'000'` 이 아닌 사례(예: "자료 없음"을 다른 코드로 주는 경우)를 기존 검사나 주석에서 발견했다. 그 코드를 임의로 `MOLIT_OK_CODES` 에 더하지 않는다.
- 고치려면 범위 밖 파일을 건드려야 한다.

## 뒤에 맡을 사람에게

- 이 변경 뒤에는 국토부가 일일 한도에 걸린 날, 단지 이름 없는 월별 조회(`GET /api/transactions?lawdCd=..&dealYm=..`)가 그 달에 대해 빈 목록(200) 대신 오류 응답을 준다. 화면의 그 호출부가 오류를 "불러오지 못했어요"로 보여 주는지 배포 뒤 운영에서 한 번 본다(로컬에서는 DB 가 붙지 않아 이 경로를 볼 수 없다).
- 페이지 2 이상에서 비정상 응답이 오면 앞 페이지까지 모은 것도 버린다. 일부만 받은 달을 24시간 기억하는 것보다 낫다는 판단이다.
- `transactionService.js` 의 별칭 메모(696-707행, 1시간)를 늘리는 계획이 생기면 이 계획과 같은 파일이므로 차례로 한다.
