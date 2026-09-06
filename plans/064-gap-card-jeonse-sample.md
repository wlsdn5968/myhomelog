# Plan 064: 같은 전세가율이 한 화면에 두 번 나오는데 표본 표기는 한쪽에만 있다 (046 의 마지막 절반)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat da4eb7f..HEAD -- backend/services/analysisService.js frontend/index.html`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: **061(프론트 점유 — 머지 후 시작)**
- **Category**: bug (표시 정직성) · **Planned at**: commit `da4eb7f`, 2026-09-06
- **출처**: 2026-09-06 적대적 감사 생존 결함 #13 — 계획자가 코드로 재확인함

## 왜 중요한가

Plan 046 은 조건 카드의 전세가율이 **표본 완전성을 밝히게** 만들었다.
`backend/services/analysisService.js:308-323` (현재):

```js
  const _jeonseSampleComplete = !jeonseSample
    || !Number.isFinite(jeonseSample.total)
    || !Number.isFinite(jeonseSample.failed)
    || jeonseSample.failed <= 0;
  const jeonseBasisDesc = _jeonseSampleComplete
    ? '최근 6개월 전세 실거래 기준'
    : `전세 실거래 ${jeonseSample.total - jeonseSample.failed}/${jeonseSample.total}개월 표본`;
  if (jeonseRate !== null) {
    if (jeonseRate >= 60) {
      conditions.push({ label: '전세가율', status: 'green', desc: `${jeonseRate}% (${jeonseBasisDesc})` });
```

**그런데 같은 탭(t4)의 갭 카드는 같은 수치를 아무 단서 없이 보여준다** —
`frontend/index.html:9076` (현재, Plan 056 적용 후):

```js
      <div class="gap-card"><div class="gap-lbl">전세가율</div><div class="gap-val" style="color:${g.jeonseRate>=60?'var(--grn)':g.jeonseRate>=45?'var(--amb)':'var(--red)'}">${g.jeonseRate}%</div>${g.jeonseRate<45?'<div class="gap-sub">역전세 위험 확인 필요</div>':''}</div>
```

국토부 조회가 일부 달 실패한 상태(Plan 037 이 드러낸 상황)에서 사용자는 **한 화면에서**
`전세가율 · 58% (전세 실거래 3/6개월 표본)` 이라는 정직한 문구와, 그 아래
`전세가율 58%` 라는 **아무 단서 없는 값**을 동시에 본다.

**046 이 막으려던 "얻지 못한 것을 얻은 것처럼" 이 두 번째 카드에 그대로 남아 있다.**

## ⚠ 재료가 프론트까지 오지 않는다 — 이것이 이 계획의 핵심

`analysisService.js:587-598`:

```js
  const gapData = calcGap(filteredTx, jeonsePure);
  …
  const marketSummary = reliability !== 'NONE'
    ? summarizeMarketSignal(
        percentile,
        volumeSignalObj,
        gapData.jeonseRate,
        _jTotal !== null ? { total: _jTotal, failed: _jFailed } : null,
      )
    : null;
```

`_jTotal`·`_jFailed` 는 **`summarizeMarketSignal` 에만 들어가고** 응답 payload 에는 실리지 않는다.
`gapData` 는 `calcGap` 이 만든 것이라 표본 메타를 모른다.
**따라서 프론트는 지금 그 정보를 받을 방법이 없다.**

⚠ **실제 파일을 읽어 확인하라** — 위는 계획 시점(`da4eb7f`)의 코드다.

## 설계 방침 — 임계값·문구를 프론트에 복제하지 마라

이 저장소는 **같은 판단이 두 사본으로 갈리는 결함**을 반복해 겪었다
(취득세 tier 2사본 → 3주간 600만원 과다 표기, 등급 라벨 백엔드만 정리 → Plan 056).

따라서 **프론트에서 `total-failed`/`total` 문자열을 다시 만들지 마라.**
백엔드가 이미 만든 **`jeonseBasisDesc` 문자열 자체를 payload 로 내려보내고**, 프론트는 그대로 그린다.
그러면 문구를 바꿔도 **한 곳만 고치면 된다.**

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준: 060~063 머지 후 값 — **직접 확인하라**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check backend/services/analysisService.js` | exit 0 |

## 범위

**In scope**: `backend/services/analysisService.js`(payload 노출 + 기존 문구 재사용) ·
`frontend/index.html`(갭 카드 렌더만) · `backend/test/characterization.test.js`(⚠ **파일 끝에만 추가**)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `summarizeMarketSignal` 의 **기존 시그니처·반환 형태** — 하위호환을 깨지 마라
  (`_internals.calcBuySignal` 을 3인자로 부르는 기존 테스트가 있다).
- `calcGap` · `rentService` · 임계값(60/45) · 색 — 건드리지 마라.
- 조건 카드 문구 — 이미 옳다.
- `backend/routes/report.js` — 보고서는 이미 `표본 n/6개월` 을 적는다(별개 경로).
- DB·마이그레이션

## 단계

### Step 0: 현재 렌더를 고정한다

`gapHtml` 을 정규식 추출 → `new Function` 으로 실행(이 저장소의 확립된 방식)해
`jeonseRate` 70·50·40 의 **현재 출력 문자열**을 찍어라. 표본 표기가 **없음**을 확인하라.

**산출물**: before 표.

### Step 1: 백엔드가 표본 문구를 payload 로 내보낸다

`jeonseBasisDesc` 를 만드는 지점에서 그 문자열을 **응답에 실어라**.

- 위치는 네가 정하되 **`gapData` 옆**(예: `gapData.jeonseBasis`)이 자연스럽다 — 프론트가 이미 `g` 로 받는다.
- ⚠ **`summarizeMarketSignal` 안에서 만들어진 지역 변수**라면, 그 함수 밖에서도 같은 값을 얻을 수 있게
  **작은 순수 함수로 뽑아라**(사본을 만들지 말고 그 함수가 그것을 쓰게 하라).
- ⚠ **표본이 "모름"이면 필드를 넣지 마라**(`null`·빈 문자열도 가급적 피하고 **키 자체를 생략**).
  프론트가 "모름"을 "완전한 6개월"로 오독하면 이 계획이 고치려는 결함을 그대로 만든다.
- `reliability === 'NONE'` 이면 `marketSummary` 가 `null` 이다 — 그 경로에서도 갭 카드는 그려진다.
  **그 경우에도 표본 문구가 옳게(또는 생략되게) 나오는지 직접 확인**하라.

마커: `GAP-SAMPLE-2026-09-06`

**검증**: `node --check backend/services/analysisService.js` → exit 0

### Step 2: 프론트 갭 카드가 그 문구를 그린다

`:9076` 의 전세가율 카드에 백엔드가 준 문구를 **그대로** 넣어라.

- ⚠ **red 분기의 `역전세 위험 확인 필요` 는 유지**한다(Plan 056 이 의도적으로 남긴 것).
  표본 문구와 **함께** 보여야 한다면 레이아웃을 확인하고 결정하라.
- ⚠ `gap-sub` 는 `font-size:10px` 한 줄이다. 두 문구가 겹치면 줄바꿈·별도 요소를 쓰되
  **새 CSS 클래스를 만들기 전에** 기존 클래스로 되는지 먼저 보라.
- ⚠ 필드가 **없으면 아무것도 그리지 마라**(모름 = 생략).
- ⚠ **임계값·문구를 프론트에서 다시 계산하지 마라.** 받은 문자열만 그린다.

마커: `GAP-SAMPLE-2026-09-06` 을 재사용하지 마라(마커 원문은 저장소에 1회).
새 마커: `GAP-SAMPLE-FRONT-2026-09-06`

**검증**: `npm run lint` → exit 0 (html 은 `node --check` 불가)

### Step 3: 테스트 (파일 **끝**에만 추가)

**실행 테스트**로:
1. 결측이 있을 때(`{total:6, failed:2}`) 갭 카드에 `4/6` 이 나온다
2. 결측이 없을 때 갭 카드가 **`6/6` 같은 단정을 만들지 않는다**(조건 카드와 같은 문구이거나 생략)
3. 표본이 **모름**이면 갭 카드에 표본 문구가 **없다**
4. 조건 카드 문구가 **변하지 않았다**(046 의 기존 테스트가 그대로 통과)
5. `역전세 위험 확인 필요` 가 red 분기에 **남아 있다**
6. 프론트가 임계값(60/45)이나 `total-failed` 산술을 **다시 하지 않는다**(소스 계약)

⚠ 소스 문자열 검사를 쓸 거면 **먼저 줄 주석을 제거**하라(자기 주석 오검출 6회 재발 이력).

### Step 4: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. 백엔드에서 payload 노출을 제거한다 → **fail** 해야 한다
2. "모름"일 때도 문구를 만들게 한다(예: `6/6` 고정) → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 안 잡히면 **STOP 조건**.

### Step 5: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] 갭 카드와 조건 카드가 **같은 표본 사실**을 말한다
- [ ] 모름이면 갭 카드에 표본 문구가 **없다**(`6/6` 단정 없음)
- [ ] 프론트에 임계값·산술 **사본이 없다**(백엔드 문자열을 그대로 그린다)
- [ ] `summarizeMarketSignal` 3인자 호출의 기존 동작이 **변하지 않았다**
- [ ] `역전세 위험 확인 필요` 가 유지된다
- [ ] `cd backend && npm test` `fail 0` · `npm run verify` exit 0
- [ ] Step 4 의 주입 2건에서 각각 fail

## STOP 조건

- `summarizeMarketSignal` 의 시그니처를 바꿔야 할 것 같다 → 기존 3인자 호출이 깨진다. 보고하고 멈춰라.
- `calcGap` 을 고쳐야 할 것 같다 → 보고하고 멈춰라(보고서 경로도 쓴다).
- 프론트에서 임계값을 다시 계산하고 싶어진다 → **하지 마라.** 이 계획의 존재 이유가 그것이다.
- Step 4 의 주입이 잡히지 않는다.

## 유지보수 메모

- **같은 수치가 한 화면에 두 번 나오는 곳이 더 있는지** 훑을 가치가 있다 — 이번 건은 전세가율이었다.
  두 번 나오는데 근거 표기가 한쪽에만 있으면 같은 결함이다.
- **리뷰에서 볼 것**: ① 프론트에 사본이 안 생겼는지 ② 모름일 때 아무것도 안 그리는지
  ③ 조건 카드가 안 바뀌었는지.
