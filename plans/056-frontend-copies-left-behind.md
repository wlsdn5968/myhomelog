# Plan 056: 백엔드만 고치고 남은 프론트 사본 3종 (등급 라벨 · 필드명 · 주석 드리프트)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**: `git diff --stat e737af3..HEAD -- frontend/index.html`

## Status

- **Priority**: **P1** · **Effort**: S · **Risk**: MED(사용자에게 보이는 문구가 바뀐다) · **Depends on**: 없음
- **Category**: bug (사본 한쪽만 고침) · **Planned at**: commit `e737af3`, 2026-09-06
- **출처**: 2026-09-06 적대적 감사 생존 결함 #1·#2·#9·#10·#12 — 계획자가 코드를 직접 열어 재확인함

## 왜 중요한가

2026-09-06 라운드가 백엔드에서 고친 것 **셋이 프론트 사본에 그대로 남아 있다.**
이 저장소가 반복해 당한 **"사본 한쪽만 고침"** 계열이고, 그중 하나는 **운영자 절대 룰 ①** 에 걸린다.

⚠ 세 건 모두 **같은 파일(`frontend/index.html`)** 이라 한 번에 처리한다.
⚠ 이 파일은 CRLF 다. **편집 스크립트를 쓸 거면 Write 도구로 만들어라** — Bash heredoc 은
백슬래시를 반으로 줄이고 `\n` 앵커가 0매치가 된다(이 저장소의 확립된 함정).

---

## 결함 ① — 절대 룰 ①: 041 이 지운 등급 라벨이 프론트에 그대로 (**가장 중요**)

Plan 041(커밋 `a21b674`)이 백엔드 조건 카드에서 등급·해석 표현을 제거했다.
현재 백엔드 — `backend/services/analysisService.js:265-274` (**정본. 이 문체에 맞춘다**):

```js
  // ① 가격 위치 백분위 — 백분위 수치와 6개월 창은 유지, 구간을 재서술하는 등급 표현은 제거.
  if (percentile !== null) {
    if (percentile <= 30) {
      score += 2;
      conditions.push({ label: '가격 위치', status: 'green', desc: `최근 6개월 하위 ${percentile}%` });
    } else if (percentile <= 65) {
      score += 1;
      conditions.push({ label: '가격 위치', status: 'yellow', desc: `최근 6개월 ${percentile}% 구간` });
    } else {
      conditions.push({ label: '가격 위치', status: 'red', desc: `최근 6개월 상위 ${100 - percentile}%` });
    }
```

전세가율 — `analysisService.js:315-323`:

```js
    if (jeonseRate >= 60) {
      conditions.push({ label: '전세가율', status: 'green', desc: `${jeonseRate}% (${jeonseBasisDesc})` });
    } else if (jeonseRate >= 45) {
      conditions.push({ label: '전세가율', status: 'yellow', desc: `${jeonseRate}% (${jeonseBasisDesc})` });
    } else {
      conditions.push({ label: '전세가율', status: 'red', desc: `${jeonseRate}% (${jeonseBasisDesc}) — 역전세 위험 확인 필요` });
    }
```

⚠ **red 분기의 `— 역전세 위험 확인 필요` 는 041 이 의도적으로 남긴 것이다.** 위험 고지는 등급 라벨이 아니다.

### 프론트 사본 (a) — `frontend/index.html:8966` → `:8984` 렌더

```js
    const pctColor=pct<=30?'var(--grn)':pct<=65?'var(--amb)':'var(--red)';
    const pctDesc=pct<=30?'시세 하단 구간':pct<=65?'시세 중간 구간':'시세 상단 구간';
    // PCT-LABEL-2026-07-15 (Sprint MMMMM, 실측 발각): "하위 97% — 시세 상단"은 '하위'가 정반대 인상 —
    //   50% 초과면 "상위 X%"로 자동 전환(같은 수치, 읽기만 직관화).
    const pctLabel = pct > 50 ? `상위 ${100-pct}%` : `하위 ${pct}%`;
```

```js
      <div class="pct-result" style="color:${pctColor}">${pctLabel} — ${pctDesc}<br><span …>${rangeText}…</span></div>
```

### 프론트 사본 (b) — `frontend/index.html:9065`

```js
      <div class="gap-card"><div class="gap-lbl">전세가율</div><div class="gap-val" style="color:${g.jeonseRate>=60?'var(--grn)':g.jeonseRate>=45?'var(--amb)':'var(--red)'}">${g.jeonseRate}%</div><div class="gap-sub">${g.jeonseRate>=60?'역전세 위험 낮음':g.jeonseRate>=45?'보통':'역전세 위험 확인 필요'}</div></div>
```

**두 사본은 같은 탭(`t4`) 안에서 조건 카드 바로 아래에 렌더된다** — `frontend/index.html:9085`:

```js
    ${reliabilityBanner}${heroHtml}${condsHtml}${pctHtml}${volHtml}${gapHtml}
```

즉 사용자는 중립화된 `가격 위치 · 최근 6개월 하위 20%` 바로 아래에서
`하위 20% — 시세 하단 구간` 을, `전세가율 · 72% (…)` 아래에서 `72% / 역전세 위험 낮음` 을 본다.
**한 화면에 두 문체가 섞여 있고, 041 의 목적은 화면 단위로 달성되지 않았다.**

---

## 결함 ② — 038 이 고친 필드명이 모바일 하단 시트에 그대로

`frontend/index.html:7654-7658` (**038 이 고친 정본**):

```js
  // T0-HERO-FIELD-2026-09-06: 추천 응답은 dealCount6m(6개월 창), 검색·지도 응답은 dealCount(그룹 합산)
  //   으로 **다른 이름**을 쓴다. 히어로가 dealCount 만 읽어 추천 경로에서 셀과 배지가 통째로 빠졌다
  //   (프론트에 dealCount6m 참조가 0건이었다 — 오류가 안 나서 린트·테스트가 못 잡는 계열).
  //   백엔드 이름은 그대로 둔다: dealCount6m 이 의미상 더 정확하고, 바꾸면 rec 캐시·정렬 소비자에 번진다.
  const _t0DealN = Number(p.dealCount ?? p.dealCount6m) || 0;
```

`grep -n "dealCount6m" frontend/index.html` 결과 **`:7657`(주석)·`:7658`(코드) 두 줄뿐**이다.

**남은 사본 — `frontend/index.html:5711`** (모바일 지도 하단 시트):

```js
    const meta=[(p.buildYear?`${p.buildYear}년 준공`:''),(kind==='pop'?(p.dealCount60d?`60일 ${p.dealCount60d}건`:''):(p.dealCount?`거래 ${p.dealCount}건`:''))].filter(Boolean).join(' · ');
```

추천 경로 마커를 모바일에서 탭하면 `p.dealCount` 가 `undefined` 라 **거래 건수가 조용히 사라진다.**
오류가 없고 셀만 빠지므로 린트·테스트가 못 잡는다.

⚠ **`kind==='pop'` 분기(`dealCount60d`)는 건드리지 마라.** 인기 단지 응답은 다른 필드다.

⚠ `:6266`·`:6314`·`:6377`·`:8167`·`:11975` 등 다른 `dealCount` 사용처가 있다.
**추천 응답을 그리는 곳인지 직접 확인하고, 아닌 곳은 건드리지 마라.** 확인 결과를 보고에 적어라.

---

## 결함 ③ — 되돌린 정책을 현재형으로 설명하는 주석 (사용자 영향 0, 다음 사람 오도)

`frontend/index.html:9135-9141`:

```js
// ACQ-REG-CALC-2026-09-02 (감사 후속): 다주택 취득세 중과는 **조정대상지역** 기준이다(지방세법 §13-2).
//   종전엔 2주택+ 를 지역과 무관하게 항상 8% 로 계산했다. 각주로 "비조정지역은 더 낮을 수 있다"고
//   고지는 했지만, 같은 단지 상세 화면의 세금 시뮬레이션 카드는 이미 지역을 보고 계산하고 있어서
//   **한 화면에 서로 다른 취득세 금액 두 개**가 동시에 떴다.
//   → 지역을 아는 호출부는 isRegulated 를 넘겨 정확히 계산한다. 모르면 undefined → 종전대로 보수적 8%
//     (모를 때 낮게 안내하면 과소 안내가 된다). 백엔드 calcTotalCost 와 같은 규칙·같은 인자다.
function calcTotalCostHTML(price,loan,houseStatus,isFirstBuyer,isRegulated){
```

바로 10줄 아래 `ACQ-UNKNOWN-COUNT-2026-09-06`(커밋 `cb23d71`, Plan 036)이 **그 정책을 되돌렸다** —
`'2주택+'` 는 이제 지역과 무관하게 보수적 세율을 쓴다. 위 주석은 **정반대를 현재형으로 말한다.**
**백엔드 쌍둥이(`backend/services/analysisService.js:376` 부근)는 같은 커밋에서 교체됐다** —
즉 두 사본의 주석이 갈렸고, `plans/036` 이 명시적으로 금지한 상태다.

부수적으로 `frontend/index.html:9080`:

```js
  // 같은 화면의 세금 카드(_acqIsReg)와 **같은 근거**로 계산한다 — 한 화면에서 취득세가 갈리지 않게.
```

이 문장도 지금은 사실이 아니다(t0 세금 카드는 여전히 지역으로 분기하고, t4 계산기는 분기하지 않는다).
**갈림 자체는 Plan 036 이 승인한 것이므로 고칠 것은 코드가 아니라 문장이다.**

⚠ **`isRegulated` 매개변수를 시그니처에서 지우지 마라.** `plans/036` 이 남기라고 지시했고
백엔드 쌍둥이도 같다. 이번엔 **왜 남기는지**를 정확히 다시 적는 것이 조치다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **249 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 (프론트 인라인 JS 린트 포함) |

⚠ `npm run lint` 는 `scripts/extract-inline-js.js` 로 `frontend/index.html` 의 인라인 JS 를 검사한다.
⚠ **`lint` 의 인라인 검사는 `index.html` 전용**이다 — 다른 html 은 안 본다(이 계획 범위엔 없다).

## 범위

**In scope**: `frontend/index.html` · `backend/test/characterization.test.js`(⚠ **파일 끝에만 추가**)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/services/analysisService.js` — **정본이다. 건드리지 마라.**
- `status` 색(`--grn`/`--amb`/`--red`)과 임계값(30/65·60/45) — **색과 숫자는 그대로 둔다.**
  041 이 "색 자체를 바꾸는 건 디자인 변경이라 별도 기획 선행" 이라고 명시적으로 범위 밖에 뒀다.
  임계값 이중화도 별건이다(아래 유지보수 메모).
- `calcTotalCostHTML` 의 **계산 로직·시그니처** — 주석만 고친다.
- `kind==='pop'` 분기 · `dealCount60d`
- 백엔드 응답 필드명(`dealCount6m`) — 038 이 유지하기로 결정했다.

## 단계

### Step 0: 현재 렌더 결과를 고정한다

`pctHtml`·`gapHtml` 이 지금 만드는 문자열을 **실제로 찍어라**(함수를 추출해 `new Function` 으로
실행 — 이 저장소가 이미 쓰는 방식이다: `grep -n "new Function" backend/test/characterization.test.js`).
`pct` 는 20·50·80, `jeonseRate` 는 70·50·40 정도로.

**산출물**: before 문자열 표. 이후 after 와 대조한다.

### Step 1: 등급 라벨을 백엔드 문체에 맞춘다

- **(a) `pctDesc`** — 등급 표현을 **제거**한다. `pctLabel`(`하위 20%` / `상위 20%`)은 **유지**하라
  (그건 수치의 다른 표현이지 등급이 아니다). 렌더 줄의 `${pctLabel} — ${pctDesc}` 를 정리하라.
  ⚠ `pctColor` 는 그대로 둔다(색은 범위 밖).
  ⚠ `PCT-LABEL-2026-07-15` 주석이 설명하는 `pctLabel` 동작은 **바꾸지 마라.**
- **(b) `gap-sub`** — green/yellow 의 `역전세 위험 낮음`·`보통` 을 **제거**하고,
  **red 의 `역전세 위험 확인 필요` 는 유지**한다(백엔드와 같은 판단).
  ⚠ green/yellow 에서 `gap-sub` 를 빈 문자열로 두면 레이아웃이 무너질 수 있다 —
  `gap-card` 의 CSS 를 확인하고, 필요하면 **수치 근거**(예: 매매·전세 평균)를 넣거나
  요소를 **조건부로 생략**하라. 등급 라벨을 다른 말로 바꿔치기하지 **마라.**

⚠ **절대 룰 ①** — 새 문구에도 매수·매도 추천이나 가격 예측 표현이 없어야 한다.
⚠ **"모름"을 값으로 만들지 마라** — 값이 없으면 항목을 생략한다(이 파일의 확립된 "미확인 원칙").

마커: `RULE-DETERMINISTIC-FRONT-2026-09-06`

**검증**: Step 0 의 before/after 표. 수치(백분위·전세가율·신뢰구간·표본 건수)는 **전부 그대로**여야 한다.

### Step 2: 모바일 하단 시트 필드명

`:5711` 의 `p.dealCount` 를 `:7658` 과 **같은 형태**(`p.dealCount ?? p.dealCount6m`)로 맞춰라.
⚠ `??` 와 `||` 를 혼동하지 마라 — `:7658` 이 `??` 를 쓴다. **0 을 유효값으로 다루는 차이**가 있다.
같은 연산자를 써라.

마커: `T0-HERO-FIELD-2026-09-06` 을 **재사용하지 마라**(마커 원문은 저장소에 1회만).
새 마커: `SHEET-FIELD-2026-09-06`

**검증**: `grep -c "dealCount6m" frontend/index.html` 가 이전보다 증가

### Step 3: 주석 정정 (코드 무변경)

- `:9135-9140` 블록을 **백엔드 `analysisService.js` 의 대응 블록과 같은 내용**으로 교체하라.
  **백엔드 블록을 먼저 읽고**, 그 서술을 프론트 문맥에 맞게 옮겨라(그대로 복사가 아니라 같은 사실).
  ⚠ 백엔드 주석 원문에 계약 테스트가 걸리는 표현이 있을 수 있다 — 옮기기 전에
  `npm test` 로 확인하라(백엔드 주석 자체가 "원문은 옮기지 않는다" 고 경고한다).
- `:9080` 한 줄을 사실대로 고쳐라 — t0 카드와 t4 계산기가 **의도적으로 다른 기준**을 쓴다는 것,
  그 근거가 Plan 036 이라는 것.
- `isRegulated` 가 왜 시그니처에 남아 있는지 한 줄로 적어라.

**검증**: `node --check` 는 html 에 못 쓴다 → `npm run lint` 로 확인하라.

### Step 4: 테스트 (파일 **끝**에만 추가)

`backend/test/characterization.test.js` 에 **실행 테스트**를 추가한다
(프론트 함수를 정규식 추출 → `new Function` — 이 저장소의 확립된 방식):

1. `pctHtml` 결과에 등급 라벨 문자열이 **없다**(pct 20·50·80 전부)
2. `pctHtml` 에 백분위 수치·신뢰구간·표본 건수는 **그대로 있다**
3. `gapHtml` — rate 70·50 에 등급 라벨이 **없고**, rate 40 에는 `역전세 위험 확인 필요` 가 **있다**
4. 하단 시트 — `dealCount` 없이 `dealCount6m` 만 있는 객체로 meta 문자열에 건수가 **나온다**
5. 어떤 결과에도 매수 권유·가격 예측 표현이 없다

⚠ 소스 문자열 검사를 쓸 거면 **줄 주석을 먼저 제거**하라 — 이 저장소는 검사가 자기 주석을 잡는
사고를 **6회** 냈다. 특히 이 계획은 주석에 결함 문구를 인용할 수 없다는 뜻이다.

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 254

### Step 5: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. `pctDesc` 등급 라벨을 되살린다 → **fail** 해야 한다
2. `gap-sub` 의 green 라벨을 되살린다 → **fail** 해야 한다
3. `:5711` 을 `p.dealCount` 만 읽게 되돌린다 → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 안 잡히면 **STOP 조건**.

### Step 6: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `pct-result`·`gap-sub` 에 등급 라벨이 없다(red 의 위험 고지는 **유지**)
- [ ] 수치·색·임계값이 **변하지 않았다**(Step 0 표로 증명)
- [ ] `:5711` 이 `:7658` 과 같은 연산자·같은 필드 순서를 쓴다
- [ ] `:9135` 주석이 백엔드와 **같은 사실**을 말한다 · `:9080` 이 사실이다
- [ ] `calcTotalCostHTML` 의 **시그니처·계산 로직이 안 바뀌었다**
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 254 · `npm run verify` exit 0
- [ ] Step 5 의 주입 3건에서 각각 fail
- [ ] `git status --short` 에 `analysisService.js` 가 **없다**

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- `gap-sub` 를 비우면 레이아웃이 깨지는데 넣을 **사실 기반 대체 문구**가 안 떠오른다
  → 요소를 조건부 생략하고 그 판단을 보고하라. 등급 라벨을 다른 말로 바꿔치기하지 마라.
- 백엔드 주석을 옮겼더니 기존 계약 테스트가 깨진다 → 그 테스트가 **소스 문자열**을 훑는 것이므로
  표현을 바꿔 피하되, **무엇을 왜 바꿨는지 보고**하라.
- 수치가 하나라도 바뀐다 ← 가장 중요하다. 이건 문구 정리이지 계산 변경이 아니다.
- Step 5 의 주입이 잡히지 않는다.

## 유지보수 메모

- **임계값이 2벌이다** — 백엔드(`analysisService.js` 30/65·60/45)와 프론트(`:8965`·`:9065`)가
  같은 숫자를 각자 들고 있다. 한쪽만 바꾸면 같은 카드가 서로 다른 색·문구를 낸다.
  **이번 범위 밖**이지만 다음에 이 카드를 손대면 SSOT 로 묶을 후보다.
- **리뷰에서 볼 것**: ① 수치가 안 바뀌었는지 ② red 의 위험 고지가 살아 있는지
  ③ `??` 를 `||` 로 바꾸지 않았는지 ④ 주석 정정이 백엔드와 **같은 사실**인지.
