# Plan 046: 분석 카드의 전세가율이 표본 완전성을 밝히게 한다 (041 이 만든 "6개월" 주장 정직화)

> **실행자 안내**: 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려 기대 결과를 확인한 뒤 다음으로 가라.
> "STOP 조건" 에 해당하면 즉흥 판단하지 말고 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat 3d30ee2..HEAD -- backend/services/analysisService.js backend/services/rentService.js`
> 비어 있지 않으면 아래 발췌와 실제 코드를 대조하라.

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: 없음
- **Category**: bug (표시 정확도) · **Planned at**: commit `3d30ee2`, 2026-09-06

## 왜 중요한가

Plan 041 이 전세가율 문구를 이렇게 바꿨다(`backend/services/analysisService.js:305-313`):

```js
desc: `${jeonseRate}% (최근 6개월 전세 실거래 기준)`
```

**"최근 6개월" 이라는 사실 주장을 새로 추가한 것이다.** 그런데 Plan 037 이 밝혔듯 국토부 조회가
일부 달에 실패하면 표본은 6개월보다 얇다. 그때 이 문구는 **거짓말이 된다.**

**보고서 경로는 이미 정직하다** — `backend/routes/report.js` 가 `표본 n/6개월` 을 적는다.
같은 데이터인데 분석 카드만 밝히지 않는다. 이 저장소의 확립된 원칙("값이 틀렸다 보다 값이 왜
그런지 모른다가 더 나쁘다", `rentService.js:326` 주석)에 어긋난다.

재료는 이미 있다 — `getJeonseByApt` 가 반환 배열에 `monthsTotal`·`monthsFailed` 를 실어 보낸다
(`backend/services/rentService.js:327-328`).

## 현재 상태

### 재료가 만들어지는 곳 — `backend/services/rentService.js:326-328`

```js
  // 표본 메타: 몇 달이 빠졌는지 호출자가 알 수 있게 배열 속성으로 싣는다(JSON 직렬화엔 나가지 않는다).
  sorted.monthsTotal = months.length;
  sorted.monthsFailed = _failedMonths.slice();
```

### ⚠⚠ 재료가 사라지는 두 지점 — 이것이 이 계획의 핵심 함정이다

**(1) `.catch(() => [])`** — `backend/services/analysisService.js:522`:

```js
      getJeonseByApt(lawdCd, aptName).catch(() => []),
```
전체 실패 시 메타 없는 맨 배열이 된다.

**(2) `filter` 가 커스텀 속성을 버린다** — `backend/services/analysisService.js:~544`:

```js
    saleTx = saleTx.filter(_scope);
    jeonseT = jeonseT.filter(_scope);
```
`Array.prototype.filter` 는 **새 배열**을 반환한다. `monthsTotal`·`monthsFailed` 는 여기서 **소멸한다.**
따라서 **반드시 filter 앞에서 메타를 꺼내 별도 변수에 담아야 한다.**

### 소비 지점 — `backend/services/analysisService.js:248`, `:574`

```js
function summarizeMarketSignal(percentile, volumeSignalObj, jeonseRate) {
```
```js
    ? summarizeMarketSignal(percentile, volumeSignalObj, gapData.jeonseRate)
```

이 함수는 **비율만 받고 표본 메타를 못 받는다.** 넘겨줘야 한다.

### 기존 소비자 (깨뜨리면 안 된다)

- `backend/test/characterization.test.js:2539`·`:2548` 가 `calcBuySignal(percentile, volObj, rate)` 를
  **3인자**로 부른다(`_internals` 경유). → **네 번째 인자는 반드시 선택적**이어야 하고,
  없으면 **현재 문구 그대로**여야 한다.
- `_internals` export(`analysisService.js` 하단)는 이미 존재한다. **새 export 를 추가하지 마라.**

### 이 저장소의 관례

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `JEONSE-SAMPLE-2026-09-06`.
- ⚠ **절대 룰 ①**(매수·매도 추천 X / 미래 가격 예측 X) — 새 문구도 지켜야 한다.
- ⚠ **"모름"을 값으로 만들지 마라.** 메타를 못 얻었으면(전체 실패·미전달) **표본 표기를 생략**하라.
  "6/6" 이라고 단정하는 것이 바로 이 계획이 고치려는 결함이다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **241 pass**) |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check backend/services/analysisService.js` | exit 0 |

## 범위

**In scope**: `backend/services/analysisService.js` · `backend/test/characterization.test.js` · (색인은 리뷰어가 관리)

**Out of scope**:
- `backend/services/rentService.js` — 메타를 이미 올바르게 싣는다. 건드리지 마라.
- `backend/routes/report.js` — 이미 정직하다.
- `frontend/index.html` — `c.desc` 를 그대로 그리므로 백엔드만 고치면 된다. 최종 `git status` 에 있으면 실패다.
- `score` 가산·`status` 값·분기 조건 — 표시 문구만 다룬다.
- `summarizeMarketSignal` 의 기존 3인자 시그니처 의미 — **호환을 깨지 마라.**

## 단계

### Step 1: filter **앞에서** 표본 메타를 꺼낸다

`Promise.all` 직후(`:517-529` 부근), **`if (sigungu || umdNm)` 필터 블록보다 위**에서:

```js
  // JEONSE-SAMPLE-2026-09-06:
  // [왜] getJeonseByApt 는 monthsTotal·monthsFailed 를 **배열 속성**으로 싣는데,
  //   아래 filter 가 새 배열을 만들면서 그 속성이 사라진다. 반드시 여기서 꺼내 둔다.
  //   전체 실패(.catch(() => [])) 면 속성 자체가 없다 → 모름으로 둔다(0 으로 만들지 않는다).
  const _jTotal = Number.isFinite(jeonseT.monthsTotal) ? jeonseT.monthsTotal : null;
  const _jFailed = Array.isArray(jeonseT.monthsFailed) ? jeonseT.monthsFailed.length : null;
```

⚠ **`|| 0` 을 쓰지 마라.** 모름과 0을 섞으면 이 저장소가 반복해 당한 결함이 된다.

**검증**: `node --check backend/services/analysisService.js` → exit 0

### Step 2: `summarizeMarketSignal` 에 **선택적** 네 번째 인자를 추가한다

```js
function summarizeMarketSignal(percentile, volumeSignalObj, jeonseRate, jeonseSample) {
```

`jeonseSample` 은 `{ total, failed }` 또는 `null`/`undefined`.
전세가율 문구를 만들 때 **완전한 표본과 불완전한 표본을 구분**하라:

- 메타가 없거나(`null`) 실패가 0이면 → **지금 문구 그대로** `${jeonseRate}% (최근 6개월 전세 실거래 기준)`
- 실패가 있으면 → 실제로 쓴 개월 수를 밝힌다. 예:
  `${jeonseRate}% (전세 실거래 ${total - failed}/${total}개월 표본)`

정확한 문구는 재량이되 **다음을 지켜라**:
- 얻지 못한 것을 얻은 것처럼 말하지 않는다.
- 절대 룰 ① 준수(추천·예측 표현 금지).
- `red` 분기의 `— 역전세 위험 확인 필요` 는 **그대로 유지**한다(041 이 의도적으로 남긴 것).

호출부(`:574`)에 `{ total: _jTotal, failed: _jFailed }` 를 넘긴다.
⚠ `_jTotal` 이 `null` 이면 **객체를 넘기지 말고 `null` 을 넘겨라**(또는 함수가 그 경우를 현재 문구로 처리하게 하라).

**검증**: `node --check ...` → exit 0
**검증**: `grep -c "summarizeMarketSignal(percentile, volumeSignalObj, gapData.jeonseRate" backend/services/analysisService.js` → `0` (인자가 늘었으므로)

### Step 3: 테스트

`backend/test/characterization.test.js` 끝에 **실행 테스트 1개**를 추가한다
(`_internals.calcBuySignal` 을 직접 호출 — 이미 export 돼 있다):

1. `calcBuySignal(50, {signal:'neutral'}, 49)` — **3인자**(기존 호출 형태) → 전세가율 desc 가
   **현재 문구 그대로**(`(최근 6개월 전세 실거래 기준)` 포함). ★ 하위호환 고정
2. `calcBuySignal(50, {signal:'neutral'}, 49, { total: 6, failed: 0 })` → 같은 문구
3. `calcBuySignal(50, {signal:'neutral'}, 49, { total: 6, failed: 2 })` → **`4/6` 을 밝히는 문구**
   (`6개월` 이라고 단정하지 **않는다**)
4. `calcBuySignal(50, {signal:'neutral'}, 49, { total: null, failed: null })` → 현재 문구(모름 처리)
5. 어떤 경우에도 desc 에 매수 권유·가격 예측 표현이 없다

또한 **filter 가 메타를 버린다는 사실**을 계약으로 고정하라 —
`analysisService.js` 소스에서 메타 추출이 `filter` 보다 **앞**에 있는지 인덱스 비교로 단언한다
(이 순서가 뒤집히면 값이 조용히 null 이 된다).

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 242

### Step 4: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 비어 있어야 한다(= Step 1~3 을 커밋했는지).

1. 메타 추출을 `filter` **뒤로** 옮긴다 → `npm test` **fail** 해야 한다
2. `${total - failed}/${total}` 표기를 `6개월` 고정 문구로 되돌린다 → **fail** 해야 한다

각각 확인 후 `git checkout -- backend/services/analysisService.js` 로 원복하고 `fail 0` 재확인.
하나라도 안 잡히면 **STOP 조건**이다.

### Step 5: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

## 완료 기준

- [ ] 메타 추출이 `filter` 보다 앞에 있다(테스트로 고정)
- [ ] 3인자 호출의 문구가 **변하지 않았다**(하위호환)
- [ ] 실패 달이 있으면 실제 개월 수를 밝힌다
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 242
- [ ] `npm run lint` exit 0
- [ ] Step 4 의 주입 2건에서 각각 fail 확인
- [ ] `git status --short` 에 `frontend/index.html`·`rentService.js` 가 **없다**

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- `jeonseT.monthsTotal` 이 filter 앞에서도 `undefined` 다 — 그러면 이 계획의 전제가 틀렸으니
  실제 값을 찍어 보고하라(`getJeonseByApt` 반환 형태 변경 가능성).
- Step 4 의 주입이 잡히지 않는다.
- 새 문구를 쓰다가 추천·예측처럼 읽히는 표현밖에 안 떠오른다.
- `frontend/index.html` 을 고쳐야 할 것 같다.

## 유지보수 메모

- **같은 함정이 다른 곳에도 있다**: 배열에 커스텀 속성을 실어 보내는 패턴은 `map`/`filter`/`slice`/
  `concat` 을 통과하면 전부 사라진다. `readPopularSnapshot` 도 `computedAt` 을 배열 속성으로 싣는다
  (`popularService.js`) — 그 소비자에 같은 검토가 필요할 수 있다.
- **리뷰에서 볼 것**: 메타 추출이 filter 앞인지, 그리고 3인자 호출의 문구가 안 바뀌었는지.
