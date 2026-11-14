# Plan 200: 일부 달이 빠진 거래 표본에 표식을 달고, 완전한 응답만 CDN 에 캐시한다

> 실행자 지침: 단계마다 확인 명령을 돌려 기대 결과를 본 뒤 다음으로 간다. STOP 조건이 생기면 멈추고 보고한다. 끝나면 `plans/README.md` 의 200 행을 고친다.
>
> 드리프트 확인: `git diff --stat b1cc128..HEAD -- backend/services/transactionService.js backend/services/analysisService.js backend/routes/analysis.js backend/routes/transactions.js`
> Plan 196 이 `analysisService.js` 와 `routes/analysis.js` 를 먼저 고친다. 그 변경(여섯째 인자 `exclArea`, 캐시 키 v3)은 정상이다. 그 밖의 차이가 있으면 STOP.

## 상태

- 우선순위: P2
- 작업량: M
- 위험: MED (캐시를 잘못 붙이면 틀린 값이 여러 시간 굳는다. 이 저장소의 실사고 유형)
- 선행: plans/196-percentile-rep-area.md (같은 파일)
- 분류: bug + perf
- 작성 기준: 커밋 `b1cc128`, 2026-11-14

## 왜 하나

두 가지가 얽혀 있다.

1. 정확성: `getTransactionsByApt` 는 6개월 중 어떤 달 조회가 실패하면 그 달을 빈 배열로 두고 경고만 남긴다(서버 캐시는 안 함). 호출자는 표본이 빠졌는지 모른다. 그래서 `analyzeApt` 가 빠진 표본으로 백분위와 거래량을 계산하고 그 결과를 서버 캐시에 1시간 저장한다(`analysisService.js:646`, 조건은 `molitAvailable` 뿐). 별칭 병합(`getTransactionsByAptInclAliases`)은 별칭 조회 실패를 `.catch(() => [])` 로 삼킨다.
2. 성능: `GET /api/transactions`(월별, 단지별 거래)와 `GET /api/analysis` 는 Cache-Control 이 없어 같은 URL 도 매번 함수가 돈다. 같은 파일의 `/history`, `/records` 는 이미 `s-maxage=21600` 을 쓴다. 데이터는 하루 한 번(17:00~19:00 UTC) 적재된다.

2를 먼저 하면 1의 빠진 결과가 CDN 에 굳는다. 그래서 표식을 먼저 달고, 표식이 없고 결과가 비어 있지 않을 때만 캐시한다.

## 현재 상태

- `backend/services/transactionService.js:529-603` `getTransactionsByApt(lawdCd, aptName, monthsBack = 6)`:
  ```js
  const _failedMonths = [];
  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch((e) => {
      _failedMonths.push(m);
      return [];
    }))
  );
  ...
  if (!_failedMonths.length) cache.set(cacheKey, sorted, 1800);
  return sorted;
  ```
  캐시 적중이면 `:540-541` 에서 `cached` 를 그대로 돌려준다(이것은 완전한 결과만 저장되므로 표식이 필요 없다).
- 같은 파일 `:645-678` `getTransactionsByAptInclAliases`: `base = await getTransactionsByApt(...)`, 별칭마다 `getTransactionsByApt(...).then(...).catch(() => [])`, `merged = _mergeAliasTx(aliasArrays)`, 실패 시 `catch (e)` 에서 `base` 반환.
- 저장소에 이미 있는 관례(`backend/jobs/molitIngest.js:171`): 배열에 열거되지 않는 속성을 단다.
  ```js
  Object.defineProperty(out, 'canceled', { value: ..., enumerable: false });
  ``` 열거되지 않는 속성은 `JSON` 응답과 `...` 펼치기, `.filter()` 결과에 따라가지 않는다. 그래서 표식은 반환 직후 읽어야 한다.
- `backend/services/analysisService.js:524-538` `[saleTx, jeonseT] = await Promise.all([getTransactionsByAptInclAliases(...), getJeonseByApt(...).catch(() => [])])`. 그 뒤 `:558`, `:564` 에서 `saleTx = saleTx.filter(...)` 로 다시 대입된다(표식이 사라진다). 비교 함수 `_compareOne`(`:743-764`)도 같은 서비스를 부르지만 이 계획 범위 밖이다. `:646` `if (molitAvailable) cache.set(cacheKey, result, 3600);`
- `backend/routes/analysis.js:28-29` `res.json(result)` (헤더 없음).
- `backend/routes/transactions.js:30-77` GET `/`. `aptName` 이 있으면 `getTransactionsByAptInclAliases`, 없으면 `getTransactions(lawdCd, dealYm)`(지역 월 전체, 실패면 예외라 500). `:73` `res.json({ count: items.length, items, isMock: false })` (헤더 없음).
- 캐시 규칙 본보기: `backend/routes/transactions.js:147-151`
  ```js
    // ⚠ CACHE-POISON-2026-08-29 (실사고): 콜드 경로에서 한 번 빈 목록이 나왔는데 s-maxage=6h 로 엣지에 그대로 굳어 ...
    res.set('Cache-Control', (degraded || data.stale) ? 'no-store' : CC);
  ```
- 서버 메모리 캐시(`backend/cache.js`)는 꺼낼 때 값을 복제한다(node-cache 기본 `useClones: true`). 복제하면 열거되지 않는 속성은 사라진다. 그래서 완전한 결과만 캐시에 넣는 지금 규칙을 유지해야 한다.

## 필요한 명령

| 목적 | 명령 | 성공 기준 |
|---|---|---|
| 새 테스트 | `cd backend && node --test test/partial-sample-200.test.js` | 전부 pass |
| 관련 기존 테스트 | `cd backend && node --test test/analyze-outliers-same-as-chart.test.js test/rent-jeonse.test.js test/sec-1030-core.test.js test/percentile-rep-area-196.test.js` | 전부 pass |
| 전체 검증 | 루트에서 `npm run verify` | exit 0 |

## 범위

수정: `backend/services/transactionService.js`(두 함수), `backend/services/analysisService.js`(`analyzeApt` 의 캐시 조건과 결과 필드), `backend/routes/analysis.js`, `backend/routes/transactions.js`(GET `/` 만), `backend/test/partial-sample-200.test.js`(새로 만듦).

건드리지 말 것: `getTransactions` 본문, 전세 조회 함수 본문(`getJeonseByApt`, 실패 달을 `monthsFailed` 배열 속성으로 이미 알려 준다. 이 계획은 그 값을 캐시 조건에 쓰기만 한다), `/history`, `/records`, 비교(`/compare`), `backend/cache.js`.

## 단계

### 1단계: 표식 도우미와 단지별 조회

`transactionService.js` 에 도우미를 둔다:
```js
// PARTIAL-FLAG-2026-11 (Plan 200): 일부 달을 못 읽은 표본. 열거되지 않는 속성이라 JSON 과 펼치기에는 안 따라간다. 반환 직후 읽을 것.
function _markPartial(arr) { Object.defineProperty(arr, 'partial', { value: true, enumerable: false }); return arr; }
function isPartialSample(arr) { return !!(arr && arr.partial); }
```
`getTransactionsByApt` 끝을 `if (!_failedMonths.length) cache.set(...); else _markPartial(sorted); return sorted;` 로 바꾼다. `isPartialSample` 과 `_markPartial` 을 `module.exports` 에 더한다(테스트용).

중요: 다른 파일(분석 서비스, 라우트)은 이 함수를 import 하지 않고 배열의 `partial` 속성을 직접 읽는다(`arr && arr.partial === true`). 이유: `backend/test/express5-migration.test.js:61-68, 80-95` 가 `transactionService` 모듈을 펼치기 없는 객체로 통째로 바꾸고 `GET /api/transactions` 가 200 이기를 단언한다. 라우트가 `isPartialSample` 을 import 하면 그 스텁에는 함수가 없어 TypeError 가 나고 테스트가 깨진다. 다른 테스트도 같은 방식의 스텁을 쓸 수 있다(전수 미확인).

확인: `grep -n "_markPartial(sorted)" backend/services/transactionService.js` → 1줄.

### 2단계: 별칭 병합이 표식을 이어받는다

`getTransactionsByAptInclAliases`(b1cc128 기준 645~678행)에서 함수 첫머리 `base` 다음에 `let partial = isPartialSample(base);`. 별칭 호출을 `.then(arr => { if (isPartialSample(arr)) partial = true; return _filterExactAlias(arr, p.name).filter(...); }).catch(() => { partial = true; return []; })` 로. `apt_master` 조회도 오류를 받는다: `const { data, error: _amErr } = await ...; if (_amErr) partial = true;`(그대로 계속 진행).

반환문은 6곳이다. 각각 이렇게 한다(`base` 는 표식이 이미 있으면 그대로 두어도 된다. 표식이 없는 `base` 에 새로 표식을 달 때만 `[...base]` 로 복사한다. 캐시에서 온 배열에 속성을 달지 않기 위해서다):
1. `if (!aptName) return base;` 그대로.
2. `if (!admin) return base;` 그대로.
3. `if (!aliases.length) return base;` → `return (partial && !isPartialSample(base)) ? _markPartial([...base]) : base;` (`_amErr` 일 때 여기로 온다).
4. `if (merged.length) return merged;` → `return partial ? _markPartial(merged) : merged;` (`merged` 는 새 배열).
5. 마지막 `return _yr.length ? base.filter(...) : base;` → 결과를 변수에 받고, `partial` 이면 새 배열(`base.filter` 결과는 새 배열, `base` 면 `[...base]`)에 표식.
6. `catch (e)` 의 `return base;` → `return _markPartial([...base]);`.

확인: `grep -n "partial = true" backend/services/transactionService.js` → 3줄 이상.

### 3단계: 분석이 빠진 표본을 캐시하지 않고 알린다

`analyzeApt` 의 `try { [saleTx, jeonseT] = await Promise.all([...]); }` 블록 바로 뒤(`catch` 가 끝난 다음 줄, `saleTx = saleTx.filter(...)` 재대입들보다 먼저)에 `const _samplePartial = !!(saleTx && saleTx.partial === true);` 를 둔다. import 는 더하지 않는다(1단계 "중요" 참조).

전세도 같은 원칙으로 본다. 이 함수는 이미 전세 표본 상태를 안다(b1cc128 기준 543~545행):
```js
  //   전체 실패(.catch(() => [])) 면 속성 자체가 없다 → 모름으로 둔다(0 으로 만들지 않는다).
  const _jTotal = Number.isFinite(jeonseT.monthsTotal) ? jeonseT.monthsTotal : null;
  const _jFailed = Array.isArray(jeonseT.monthsFailed) ? jeonseT.monthsFailed.length : null;
```
일부 달 실패(`_jFailed > 0`)와 통째 실패(`_jTotal === null`) 둘 다 완전하지 않은 응답이다. 그 계산 바로 뒤에 `const _jeonsePartial = _jTotal === null || (_jFailed || 0) > 0;` 를 두고 결과 객체에 두 필드를 더한다:
```js
    samplePartial: _samplePartial,
    jeonsePartial: _jeonsePartial,
```
서버 캐시 줄(b1cc128 기준 646행, `grep -n "if (molitAvailable) cache.set(cacheKey, result, 3600);"` 로 찾는다. Plan 196 뒤에는 행 번호가 바뀐다)을 `if (molitAvailable && !_samplePartial && !_jeonsePartial) cache.set(cacheKey, result, 3600);` 로 바꾼다. 이것은 동작 변경이다: 지금은 전세 달이 빠져도 1시간 저장한다. STOP 조건: 정상 단지에서도 `getJeonseByApt` 가 `monthsTotal` 을 싣지 않는 경로가 있으면(`backend/services/rentService.js` 에서 `monthsTotal` 을 다는 곳을 먼저 읽는다) 모든 응답이 캐시되지 않게 되므로 멈추고 보고한다.

확인: `grep -n "samplePartial\|jeonsePartial" backend/services/analysisService.js` → 4줄 이상. `cd backend && node --test test/rent-jeonse.test.js test/analyze-outliers-same-as-chart.test.js` → 전부 pass.

### 4단계: 라우트 캐시 헤더

공통 값은 `'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600'` 로 한다(30분. 단지 페이지보다 짧게 둔 이유: 별칭 갱신과 적재 직후 반영을 너무 늦추지 않으려고).

- `routes/analysis.js`: `res.set('Cache-Control', (result.molitAvailable && !result.samplePartial && !result.jeonsePartial && (result.txCount || 0) > 0) ? CC : 'no-store');` 를 `res.json(result)` 앞에. `catch` 의 오류 응답 앞에 `res.set('Cache-Control', 'no-store');`.
- `routes/transactions.js` GET `/`: 단지별 경로는 `list` 를 받은 직후 `const _partial = !!(list && list.partial === true);` (필터 전에 읽는다. `.filter()` 결과에는 표식이 없다. import 하지 않는다). 응답 직전 `res.set('Cache-Control', (!_partial && items.length > 0) ? CC : 'no-store');`. 응답 본문에 `partial: true` 를 넣을지는 넣지 않는다(화면 변경은 이 계획 밖).

확인: `grep -n "s-maxage=1800, stale-while-revalidate=3600" backend/routes/analysis.js backend/routes/transactions.js` → 각 1줄.

### 5단계: 테스트

`backend/test/partial-sample-200.test.js`. 서비스는 `require.cache` 로 `getTransactions` 를 스텁할 수 없으니(같은 모듈 내부 호출), 다음 둘로 한다.
1. 도우미 단위: `isPartialSample` 이 표식 단 배열에 true, `JSON.parse(JSON.stringify(arr))` 와 `[...arr]` 에 false (표식이 안 따라간다는 성질 고정).
2. 소스 계약: `getTransactionsByApt` 에 `_markPartial(sorted)`, 별칭 병합의 `.catch(() => { partial = true;`, `analyzeApt` 의 `molitAvailable && !_samplePartial`, 두 라우트의 조건식.
3. 라우트 동작: `backend/test/express5-migration.test.js` 의 `stubModule`(61~68행)과 같은 방법으로 `../services/analysisService` 를 `{ analyzeApt: async () => fixture, getLawdCdFromArea: () => null, compareBatch: async () => ({}) }` 로 바꾸고, `delete require.cache[require.resolve('../routes/analysis')]` 뒤 라우터를 다시 불러 GET `/` 핸들러(`router.stack` 에서 `route.path === '/'` 이고 `methods.get`)를 꺼낸다. 요청은 `{ query: { aptName: '은마', lawdCd: '11680' } }`(`11680` 은 알려진 지역 코드라 `isKnownLawdCd` 통과. 이 검사는 핸들러 안에서 실제 `transactionService` 를 require 한다). 가짜 `res` 는 `set(k, v)`, `status(c)`(자기 자신 반환), `json(b)` 를 기록한다. 경우: `{molitAvailable:true, samplePartial:false, jeonsePartial:false, txCount:5}` → `s-maxage=1800`; `samplePartial:true` → `no-store`; `jeonsePartial:true` → `no-store`; `txCount:0` → `no-store`. 끝나면 스텁을 되돌린다.
4. `express5-migration.test.js` 가 그대로 통과한다(`cd backend && node --test test/express5-migration.test.js`).

회귀 주입: 3단계 서버 캐시 조건에서 `&& !_samplePartial` 을 지우면 2번이 fail 하는지 확인하고 되돌린다.

## 완료 기준

- [ ] `npm run verify` exit 0
- [ ] 새 테스트 pass, 회귀 주입 때 fail
- [ ] `git status --short` 에 범위 밖 파일 없음
- [ ] README 200 행 갱신

## STOP 조건

- `getTransactionsByAptInclAliases` 를 부르는 다른 곳(`grep -rn "getTransactionsByAptInclAliases" backend --include=*.js`)이 결과 배열을 직접 고치거나 캐시에 넣는다. 표식이 엉뚱하게 퍼질 수 있으니 목록을 보고한다.
- Plan 196 이 아직 안 끝났다.
- 응답 크기가 큰데(단지별 거래 15개월) CDN 캐시가 같은 URL 을 거의 반복하지 않는다는 근거를 발견한다. 그 경우 헤더 부분(4단계)만 빼고 1~3단계를 끝낸 뒤 보고한다.

## 유지보수 메모

- 이 표식은 반환 직후에만 믿을 수 있다. `.filter`, `.map`, 캐시 복제를 거치면 사라진다. 새 소비자는 받은 즉시 `arr.partial === true` 로 읽는다(모듈 함수 import 는 통째 스텁 테스트를 깨뜨릴 수 있다).
- 화면에 "일부 달을 못 불러왔어요" 를 보여 줄지는 별도 결정(문구 규칙: 해요체, 내부 용어 금지).
- 나중에 `cache.js` 의 복제를 끄는 일(성능 백로그)을 하면, 캐시에 넣은 배열에 표식을 달면 안 된다는 규칙이 더 중요해진다.
