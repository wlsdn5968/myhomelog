# Plan 196: 가격 위치 백분위를 대표 평형끼리만 비교한다

> 실행자 지침: 단계마다 확인 명령을 돌려 기대 결과를 본 뒤 다음 단계로 간다. 아래 STOP 조건이 생기면 멈추고 보고한다. 끝나면 `plans/README.md` 의 196 행 상태를 고친다.
>
> 드리프트 확인(먼저 실행): `git diff --stat b1cc128..HEAD -- backend/services/analysisService.js backend/routes/analysis.js frontend/index.html`
> 범위 안 파일이 바뀌었으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP.

## 상태

- 우선순위: P1
- 작업량: S
- 위험: LOW
- 선행: 없음 (Plan 200 이 같은 파일을 고치므로 196 을 먼저 끝낸다)
- 분류: bug
- 작성 기준: 커밋 `b1cc128`, 2026-11-14

## 왜 하나

단지 상세의 "가격 위치 (최근 6개월 거래 대비)" 카드는 헤더 평균가가 최근 거래 중 몇 %보다 싼지를 보여 준다. 헤더 평균가는 2026-10-29 부터 대표 평형(최근 거래가 가장 많은 평형) 하나의 평균인데, 비교 대상 분포는 모든 평형 거래다. 그래서 84㎡ 평균을 39㎡부터 115㎡까지 섞인 분포에 대 보고 "하위 40%" 같은 틀린 숫자가 나온다. 서버 함수는 이미 평형 필터를 지원하지만 아무도 평형 값을 넘기지 않는다.

## 현재 상태

- `backend/services/analysisService.js:89-118` `calcPricePercentile(transactions, currentPrice, currentArea = null)`: `currentArea` 가 있으면 ±10% 평형 거래만 쓰고, 8건 미만이면 전체로 돌아간다. 거래 객체의 면적 필드는 `excluUseAr`.
  ```js
  if (currentArea && currentArea > 0) {
    const minA = currentArea * 0.9, maxA = currentArea * 1.1;
    const f = filtered.filter(t => (t.excluUseAr || 0) >= minA && (t.excluUseAr || 0) <= maxA);
    if (f.length >= 8) areaFiltered = f; // 충분하면 평형 분리, 부족 시 fallback
  }
  ```
- `backend/services/analysisService.js:510-514` 캐시 키:
  ```js
  function _analysisCacheKey(lawdCd, aptName, sigungu, umdNm, currentPrice) {
    ...
    return `analysis:v2:${lawdCd}:${aptName}:${sigungu||''}:${umdNm||''}:${pk}`;
  ```
- `backend/services/analysisService.js:516` `async function analyzeApt(lawdCd, aptName, currentPrice, sigungu, umdNm)` 이고 `:584` 에서 평형 없이 부른다:
  ```js
  const percentileObj = reliability !== 'NONE' ? calcPricePercentile(filteredTx, priceW) : null;
  ```
- `backend/routes/analysis.js:10-28` GET `/api/analysis`. 쿼리 `area` 는 면적이 아니라 지역 문자열("노원구 공릉동")이다. 혼동하지 말 것.
  ```js
  const { aptName, area, price, sigungu, umdNm } = req.query;
  ...
  const result = await analyzeApt(lawdCd, aptName, parseFloat(price) || 0, sigungu || null, umdNm || null);
  ```
- `frontend/index.html:10611-10616` `loadAnalysis(p)` 가 요청 URL 을 만든다. `price=${p.avgPrice||0}` 만 보내고 평형은 보내지 않는다.
- `frontend/index.html` 의 상세 객체 만들기(`const p = {` 가 있는 곳, b1cc128 기준 15490행 근처). 같은 함수 위쪽 15475행에서 `_repArea = _repAreaOf(txHistory)` 로 대표 평형을 구하고 그 평형 거래로 `avgPrice` 를 낸다. 단 추천 목록에서 연 경우(`_fromRec`)는 `avgPrice` 를 추천 값 `r.avgPrice` 로 쓴다.
  ```js
  const _fromRec = !!(r._priceBasis && Number(r.avgPrice) > 0);
  const p = {
    ...
    avgPrice: _fromRec ? Number(r.avgPrice) : avgPrice,
  ```
- `_repAreaOf(tx)` (`frontend/index.html:9159`) 는 `{sqm, py, n}` 를 돌려준다. `sqm` 은 `Math.round(excluUseAr)` 정수.
- 수정 대상 상세 객체는 `openAptDetail`(b1cc128 기준 15354행에서 시작) 안의 `const p = {`(15492행) 하나뿐이다. `loadAnalysis(p)` 호출은 `showDetail` 안 9951행 한 곳이다. 다른 `const p = {`(예: 8575행 관심 목록 가져오기)는 손대지 않는다. 이 객체는 필드를 하나씩 새로 만들고 `repArea` 를 복사하지 않는다.

규칙: 화면 문구를 새로 만들지 않는다. 서버는 값이 없거나 이상하면 지금처럼 전체 분포를 쓴다(하위 호환).

## 필요한 명령

| 목적 | 명령 | 성공 기준 |
|---|---|---|
| 단일 테스트 | `cd backend && node --test test/percentile-rep-area-196.test.js` | 전부 pass |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0 |

## 범위

수정할 파일만:
- `backend/services/analysisService.js`
- `backend/routes/analysis.js`
- `frontend/index.html` (`loadAnalysis` 와 상세 객체 `p` 두 곳만)
- `backend/test/percentile-rep-area-196.test.js` (새로 만듦)
- `backend/test/analyze-outliers-same-as-chart.test.js` (52행 캐시 키 판 단언만)
- `backend/test/rent-jeonse.test.js` (631행 `cache.del` 키 문자열만)

건드리지 말 것:
- `calcPricePercentile` 본문. 이미 맞게 동작한다.
- `/api/analysis/compare` 와 `_compareOne`. 다른 기능이다.
- 화면 문구, 카드 레이아웃.

## Git

- 브랜치: 지금 작업 트리 브랜치에 커밋한다. 푸시하지 않는다.
- 커밋 메시지 예: `fix(analysis): 가격 위치 백분위를 대표 평형끼리 비교 (Plan 196)`

## 단계

### 1단계: 서버가 평형 값을 받는다

`backend/routes/analysis.js` GET `/` 에서 새 쿼리 `exclArea` 를 읽는다. 숫자이고 10 이상 400 이하일 때만 쓰고 아니면 `null`.
```js
const _ea = Number(req.query.exclArea);
const exclArea = Number.isFinite(_ea) && _ea >= 10 && _ea <= 400 ? Math.round(_ea) : null;
const result = await analyzeApt(lawdCd, aptName, parseFloat(price) || 0, sigungu || null, umdNm || null, exclArea);
```
`analysisService.js` 에서 `analyzeApt` 에 여섯째 인자 `exclArea = null` 을 더하고, `:584` 를 `calcPricePercentile(filteredTx, priceW, exclArea)` 로 바꾼다. 캐시 키 함수에도 인자를 더하고 버전을 v3 로 올린다(옛 키 결과를 쓰지 않게). 면적 칸은 가격 칸 앞에 둔다. `backend/test/rent-jeonse.test.js:666-671` 이 "키가 `:0` 으로 끝난다" 를 단언하므로 가격 칸이 맨 끝에 남아야 한다:
```js
function _analysisCacheKey(lawdCd, aptName, sigungu, umdNm, currentPrice, exclArea) {
  ...
  return `analysis:v3:${lawdCd}:${aptName}:${sigungu||''}:${umdNm||''}:a${exclArea||''}:${pk}`;
}
```
`analyzeApt` 안의 호출도 `exclArea` 를 넘긴다. 결과 객체에 `percentileArea: (exclArea && percentileObj && percentileObj.n < filteredTx.length) ? exclArea : null` 를 더해, 평형 필터가 실제로 걸렸는지 응답에서 알 수 있게 한다(화면은 아직 안 쓴다).

확인: `grep -n "calcPricePercentile(filteredTx, priceW, exclArea)" backend/services/analysisService.js` → 1줄. `grep -n "analysis:v3" backend/services/analysisService.js` → 1줄. 기존 테스트 두 곳을 같이 고친다(계획 검토 때 확인된 곳):
- `backend/test/analyze-outliers-same-as-chart.test.js:52` 의 ``assert.match(ana, /return `analysis:v2:/, ...)`` 에서 `v2` 를 `v3` 로. 이 단언의 뜻이 "기준이 바뀌면 판을 올린다" 이므로 v3 로 올리는 것은 허용된 변경이다.
- `backend/test/rent-jeonse.test.js:631` 의 `cache.del('analysis:v2:11350:배선단지:::600');` 를 새 키 모양 `'analysis:v3:11350:배선단지:::a:600'` 로.

확인: `grep -rn "analysis:v2" backend` → 0줄. `cd backend && node --test test/analyze-outliers-same-as-chart.test.js test/rent-jeonse.test.js` → 전부 pass.

### 2단계: 화면이 대표 평형을 보낸다

상세 객체 `p` 에 필드 하나를 더한다. 추천 경로는 추천 값의 평형을 모르므로 보내지 않는다:
```js
_repSqm: _fromRec ? null : (_repArea ? _repArea.sqm : null),
```
`loadAnalysis(p)` 의 URL 끝에 평형을 붙인다:
```js
const _sqm = Number(p._repSqm) || 0;
... + (_sqm > 0 ? '&exclArea=' + Math.round(_sqm) : '')
```
확인: `grep -n "exclArea=" frontend/index.html` → 1줄. `grep -n "_repSqm" frontend/index.html` → 2줄 이상.

주의: `showDetail` 로 들어오는 다른 입구(관심 목록 `frontend/index.html:11426` 등)는 `_repSqm` 이 없으므로 평형 없이 보낸다. 이것이 맞는 동작이다(그 경로의 avgPrice 기준을 모른다).

### 3단계: 테스트

`backend/test/percentile-rep-area-196.test.js` 를 만든다. 형식은 `backend/test/analyze-outliers-same-as-chart.test.js` 를 따른다(그 파일이 `analysisService._internals` 를 쓰는 방식). 경우:
1. 단위는 만원이다(`dealAmount` 도, 함수의 `currentPrice` 도 만원. `analyzeApt` 가 억 단위 입력에 10000 을 곱해 넘긴다). `_internals.calcPricePercentile` 에 `{excluUseAr: 59, dealAmount: 30000~30900}` 10건과 `{excluUseAr: 84, dealAmount: 55000, 56000, ... 64000}` 10건을 넣고 현재가 60000, 면적 84 를 주면 59㎡ 거래가 빠져 값이 60 이다(84㎡ 10건 중 6건이 60000 이하). 면적 없이 주면 80 이다(20건 중 16건). 두 값을 정확히 단언.
2. `_internals.analysisCacheKey` 가 면적 84 와 null 에 서로 다른 키를 낸다.
3. 소스 계약: `routes/analysis.js` 에 `/_ea >= 10 && _ea <= 400/` 와 `/umdNm \|\| null, exclArea\)/` 가 있다.
4. 소스 계약: `frontend/index.html` 에서 `async function loadAnalysis(p){` 부터 다음 `\n}` 까지 구간에 `&exclArea=` 가 있고, 파일에 `/_repSqm: _fromRec \? null : \(_repArea \? _repArea\.sqm : null\)/` 가 있다.

확인: `cd backend && node --test test/percentile-rep-area-196.test.js` → 4 pass.

## 완료 기준

- [ ] `npm run verify` exit 0
- [ ] 새 테스트 4개 pass
- [ ] `git status --short` 에 범위 밖 파일 없음
- [ ] `plans/README.md` 196 행 갱신

## STOP 조건

- `_internals` 에 `calcPricePercentile` 이나 `analysisCacheKey` 가 없다(드리프트).
- `openAptDetail` 안 `const p = {` 근처 코드(`_fromRec`, `_repArea`)가 발췌와 다르다.
- 위에 적은 두 테스트 말고도 분석 캐시 키 모양을 고정한 테스트가 더 있다(`grep -rn "analysis:v" backend/test` 로 확인).

## 유지보수 메모

- 나중에 추천 경로가 평형 정보를 같이 내려주면 `_repSqm` 의 `_fromRec ? null` 을 그 값으로 바꾼다.
- 평형 거래가 8건 미만이면 함수가 전체로 돌아간다. 응답의 `percentileArea` 가 null 이면 그 상황이다. 화면에 "전 평형 기준" 을 적을지는 별도 결정(문구 규칙: 해요체, 내부 용어 금지).
