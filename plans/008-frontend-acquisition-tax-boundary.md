# Plan 008: 프론트 취득세 6억 경계를 '이하'로 맞추고, 프론트↔백엔드 계약 테스트로 고정

> **Executor instructions**: 이 계획을 단계대로 따르라. 각 단계의 검증 명령을 실행해
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP conditions" 에 해당하는 상황이 생기면
> 즉시 멈추고 보고하라 — 임의로 판단해 진행하지 마라. 완료하면 `plans/README.md` 의
> 이 계획 행 Status 를 갱신하라.
>
> **Drift check (가장 먼저 실행)**:
> `git diff --stat 9031f65..HEAD -- frontend/index.html backend/services/analysisService.js backend/test/characterization.test.js`
> 위 파일이 하나라도 바뀌었다면 아래 "Current state" 발췌와 실제 코드를 대조하라.
> 다르면 STOP 조건이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9031f65`, 2026-08-16

## Why this matters

매수가가 **정확히 6억원**인 매물의 "총 매입비용" 카드가 취득세를 1% 가 아니라 2% 로 계산한다.
6억 기준 취득세 600만원이 **1,200만원으로 표시**된다 — 사용자가 직접 보고 의사결정에 쓰는
금액이 약 600만원 과다하다.

지방세법 §11①8호는 "6억원 **이하** 1%" 다. 백엔드는 2026-07-25(`2b2441a`, Sprint QQQQQQ)에
이 경계를 이미 고쳤는데, **프론트의 주 계산 경로는 그때 누락됐다.** 당시 "프론트는 이미 맞다"고
판단한 근거는 프론트의 *하드코딩 폴백*(`price<=6?.01`)이었고, 실제 운영에서 상시 타는
`_pickTierRate` 경로는 검토되지 않았다. 그래서 지금 **백엔드와 프론트가 같은 입력에 다른 세액**을
보여준다.

이 계획이 끝나면 두 값이 일치하고, 같은 종류의 "한쪽만 고침" 재발을 테스트가 막는다.

## Current state

관련 파일과 역할:

- `frontend/index.html` — 단일 파일 SPA. 총 매입비용 카드의 취득세율 결정 로직이 여기 있다.
- `backend/services/analysisService.js` — 같은 계산의 백엔드 사본. **이쪽이 정답이다.**
- `backend/test/characterization.test.js` — 유일한 테스트 파일(41 테스트). 계약 테스트도 여기 둔다.

### 결함 위치 — `frontend/index.html:7413-7418` (수정 대상)

```js
function _pickTierRate(tiers, priceAuk, fallbackRate){
  for (const t of (tiers||[])) {
    if (priceAuk < (t.underAuk||0)) return t.rate ?? fallbackRate;
  }
  return fallbackRate;
}
```

`<` 이라 `priceAuk = 6`, `t.underAuk = 6` 일 때 `6 < 6 === false` 가 되어 1% tier 를 건너뛰고
다음 tier(9억, 2%)가 적용된다.

### 이 함수가 상시 경로임을 보여주는 호출부 — `frontend/index.html:7419-7434`

```js
function calcTotalCostHTML(price,loan,houseStatus,isFirstBuyer){
  if(!price)return`<div class="ibox y">매수가 정보 없음</div>`;
  const tc = window.__TAX_CONFIG;

  // ── 취득세율 ──
  let rate;
  if (tc?.acquisitionTax) {
    const at = tc.acquisitionTax;
    if (houseStatus==='2주택+') rate = at.twoHousePlus?.rate ?? 0.08;
    else if (houseStatus==='1주택') rate = _pickTierRate(at.oneHouse?.tiers, price, 0.03);
    else rate = _pickTierRate(at.noHouse?.tiers, price, 0.03);
  } else {
    if(houseStatus==='2주택+')rate=0.08;
    else if(houseStatus==='1주택')rate=price<=6?.01:price<=9?.02:.03;
    else rate=price<=6?.01:price<=9?.02:.03;
  }
```

`window.__TAX_CONFIG` 가 로드된 정상 상태에서는 **위쪽 `_pickTierRate` 분기**를 탄다.
아래 `else` 의 하드코딩 폴백(`price<=6?.01`)은 이미 '이하' 라 맞다 — **여기를 고치는 게 아니다.**

### 정답 형태 — `backend/services/analysisService.js:425-430` (수정하지 말 것, 참고용)

```js
function pickTierRate(tiers, priceAuk, fallbackRate) {
  for (const t of tiers || []) {
    if (priceAuk <= (t.underAuk ?? 0)) return t.rate ?? fallbackRate;
  }
  return fallbackRate;
}
```

바로 위 `analysisService.js:418-424` 주석이 이 결함의 근거를 이미 기록해 두었다(법령 조문·금액·
경계 재확인 결과 포함). 프론트는 그 수정에서 빠졌을 뿐 판단은 이미 검증돼 있다.

### 저장소 관례

- 테스트는 `backend/test/characterization.test.js` 한 파일에 모은다. 새 파일을 만들지 마라.
- **프론트 함수를 백엔드 테스트에서 검증하는 확립된 패턴이 이미 있다** — `characterization.test.js:87-94`:

```js
test('_isRegProp(프론트) — computeLTV 전 조합에서 규제/비규제 분류가 어긋나지 않는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/function _isRegProp\(p\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'frontend/index.html 에서 _isRegProp 를 찾지 못했다 (함수명 변경 시 이 테스트도 갱신할 것)');
  const _isRegProp = new Function('_regLtvLabel', `${m[0]}; return _isRegProp;`)(() => null);
```

**이 패턴을 그대로 따르라** — `index.html` 을 파일로 읽고, 정규식으로 함수 소스를 추출해
`new Function` 으로 되살린 뒤 assert 한다.

- 백엔드 쪽 같은 경계를 고정한 기존 테스트가 `characterization.test.js:65-80` 에 있다.
  tier 설정 구조(`{ underAuk, rate }`)를 여기서 그대로 가져와 쓰면 된다:

```js
  const cfg = { acquisitionTax: {
    noHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    oneHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    twoHousePlus: { rate: 0.08 },
  } };
```

- 주석은 한글로 쓴다. 기존 주석들처럼 **왜 이 코드가 이렇게 되어야 하는지**(결함 재발 방지 근거)를 남긴다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 결과 |
|---|---|---|
| 백엔드 테스트 | `cd backend && npm test` | exit 0, 모든 테스트 pass |
| 백엔드 테스트(서버 TZ 재현) | `cd backend && TZ=UTC npm test` | exit 0, 모든 테스트 pass |
| 보안 회귀 가드 | `node scripts/security-regression-check.js` | exit 0, "위반 0건" |
| 프론트 문법 검사 | 아래 Step 3 에 전체 명령 수록 | 오류 0 |

## Scope

**In scope** (이 파일들만 수정):
- `frontend/index.html` — `_pickTierRate` 의 비교 연산자 1곳 + 그 위 주석
- `backend/test/characterization.test.js` — 계약 테스트 1개 추가

**Out of scope** (관련돼 보여도 손대지 마라):
- `backend/services/analysisService.js` — **이미 정답이다.** 여기를 바꾸면 오히려 회귀다.
- `frontend/index.html:7430-7433` 의 하드코딩 폴백(`price<=6?.01:...`) — 이미 '이하' 라 정상.
- `frontend/index.html:7435` 이후의 6~9억 누진 보정식 — 이번 결함과 무관하고 법령 검증이 끝난 코드.
- 취득세 tier 값·세율 자체 — 값이 아니라 **경계 비교 연산자**만 고치는 계획이다.

## Git workflow

- 브랜치: 현재 브랜치에서 작업하라(이 저장소는 `master` 에 직접 커밋하는 관례다 — `git log` 확인).
- 커밋 메시지 형식은 저장소 관례를 따른다. 예: `fix(tax): 프론트 취득세 6억 경계 '이하' 로 정정 (Plan 008)`
  본문에 `[근본 원인] [Fix 내용] [회귀 위험]` 을 한글로 적는다.
- **push 하지 마라.** 이 저장소는 push 를 운영자 승인 후에만 한다.

## Steps

### Step 1: 프론트 `_pickTierRate` 의 비교 연산자를 '이하' 로 고친다

`frontend/index.html:7415` 의 `<` 를 `<=` 로 바꾼다. 그리고 함수 바로 위(7413행 앞)에
왜 '이하' 여야 하는지 한글 주석을 추가한다 — 지방세법 §11①8호 "6억원 이하 1%", 백엔드
`analysisService.js:425-430` 과 같은 판정이어야 한다는 사실, 2026-07-25 수정에서 이 경로가
누락됐다는 이력을 남긴다.

수정 후 형태:

```js
if (priceAuk <= (t.underAuk||0)) return t.rate ?? fallbackRate;
```

**Verify**: `grep -n "priceAuk <= (t.underAuk" frontend/index.html` → 1건 매치
그리고 `grep -n "priceAuk < (t.underAuk" frontend/index.html` → **0건**(매치 없음)

### Step 2: 프론트↔백엔드 계약 테스트를 추가한다

`backend/test/characterization.test.js` **맨 끝에** 테스트 1개를 append 한다.
위 "저장소 관례" 의 `_isRegProp` 패턴(파일 읽기 → 정규식 추출 → `new Function`)을 그대로 쓰되,
대상 함수는 `_pickTierRate` 다. 정규식은 `/function _pickTierRate\([\s\S]*?\n\}/` 형태를 쓴다.

테스트가 고정해야 할 것:

1. 프론트 `_pickTierRate` 가 위 cfg 의 `noHouse.tiers` 로 **6억에서 0.01** 을 돌려준다(핵심 회귀).
2. 5억 → 0.01, 9억 → 0.02, 10억 → fallback(0.03) 도 함께 고정한다.
3. **같은 입력에서 백엔드와 값이 일치**한다 — `require('../services/analysisService')` 로
   백엔드 함수를 직접 쓸 수 없다면(export 되어 있지 않다면) `calcTotalCost(price, 1, '무주택', false, cfg).taxRate`
   가 프론트 결과의 100배(퍼센트 표기)와 맞는지로 대조하라. `characterization.test.js:73` 이
   `rateOf` 헬퍼로 이미 그렇게 하고 있다.

테스트 위에는 한글 주석으로 **왜 추가하는지**를 남긴다: 같은 계산이 두 파일에 사본으로 존재하고,
2026-07-25 에 한쪽만 고쳐졌기 때문에 두 파일을 계약으로 묶는다는 취지.

**Verify**: `cd backend && npm test` → exit 0, 총 테스트 수가 **41 → 42** 로 늘어난다.

### Step 3: 프론트 문법이 깨지지 않았는지 확인한다

`frontend/index.html` 은 인라인 `<script>` 블록으로 되어 있고 이 저장소는 아래 방식으로 검사한다.
저장소 루트에서 실행하라:

```
node -e "const fs=require('fs');const html=fs.readFileSync('frontend/index.html','utf8');const blocks=[...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];let bad=0;blocks.forEach((m,i)=>{if(/ld\+json/.test(m[1])){try{JSON.parse(m[2])}catch(e){bad++;console.log('LD '+i+': '+e.message)}}else{try{new Function(m[2])}catch(e){bad++;console.log('JS '+i+': '+e.message)}}});console.log('문법 오류: '+bad)"
```

**Verify**: 출력이 `문법 오류: 0`

### Step 4: 회귀 주입으로 테스트가 실제로 잡는지 확인한다

Step 2 의 테스트가 형식만 통과하는 게 아닌지 확인한다.
`frontend/index.html:7415` 의 `<=` 를 **일시적으로** `<` 로 되돌리고 테스트를 돌린다.

**Verify**: `cd backend && npm test` → **실패해야 한다**(fail 1). 실패를 확인한 뒤
반드시 `<=` 로 되돌리고 다시 `cd backend && npm test` → exit 0 을 확인하라.

> 이 단계를 건너뛰지 마라. 이 저장소는 "가드가 실제로 잡는지"를 회귀 주입으로 확인하는 관례가 있다.

## Test plan

- **추가할 테스트**: 1개, `backend/test/characterization.test.js` 맨 끝.
- **커버 케이스**: 6억(핵심 회귀) · 5억 · 9억 · 10억 · 프론트↔백엔드 값 일치.
- **구조 모델로 삼을 기존 테스트**: `characterization.test.js:87-109`(프론트 함수 추출 패턴),
  `characterization.test.js:65-80`(취득세 경계 tier 설정).
- **검증**: `cd backend && npm test` → 42 pass.

## Done criteria

전부 만족해야 한다:

- [ ] `grep -n "priceAuk < (t.underAuk" frontend/index.html` → 0건
- [ ] `grep -n "priceAuk <= (t.underAuk" frontend/index.html` → 1건
- [ ] `cd backend && npm test` exit 0, 테스트 42개 pass
- [ ] `cd backend && TZ=UTC npm test` exit 0 (서버 런타임 타임존 재현)
- [ ] `node scripts/security-regression-check.js` exit 0
- [ ] Step 3 프론트 문법 검사 → `문법 오류: 0`
- [ ] Step 4 회귀 주입 시 테스트가 실패함을 확인했고, 원복 후 다시 통과함
- [ ] `git status` 에 `frontend/index.html`, `backend/test/characterization.test.js` 외 변경 파일이 없다
- [ ] `plans/README.md` 의 008 행 Status 갱신

## STOP conditions

멈추고 보고하라(임의 진행 금지):

- `frontend/index.html:7413-7418` 코드가 위 "Current state" 발췌와 다르다.
- `backend/services/analysisService.js:425-430` 이 `<=` 가 아니다 — 그렇다면 이 계획의 전제
  ("백엔드가 정답")가 무너진 것이다. 어느 쪽이 맞는지는 executor 가 판단하지 마라.
- Step 4 에서 회귀를 주입했는데도 테스트가 통과한다 — 테스트가 실제 경로를 안 타고 있다는 뜻이다.
- 정규식으로 `_pickTierRate` 를 추출하지 못한다(함수가 리팩터링돼 형태가 달라진 경우).
- 수정 후 `npm test` 에서 **기존 41개 중 하나라도** 깨진다.

## Maintenance notes

- 이 저장소에는 **같은 세금 계산이 프론트·백엔드 사본으로 존재**한다. 취득세 관련 변경은 항상
  두 곳을 함께 봐야 한다 — Step 2 의 계약 테스트가 그 안전망이다. 테스트가 깨지면 "테스트를 고치는"
  게 아니라 **두 사본이 어긋났다는 신호**로 읽어라.
- `_pickTierRate` 함수명을 바꾸면 계약 테스트의 정규식도 함께 갱신해야 한다(테스트 안 assert 메시지에
  그 경고를 남겨 두라 — `_isRegProp` 테스트가 같은 방식으로 경고한다).
- 리뷰어가 볼 곳: 연산자가 `<=` 로 바뀌었는지, 그리고 **폴백 경로(7430-7433)를 건드리지 않았는지**.
- 이번 계획에서 의도적으로 제외한 것: 프론트·백엔드 세금 계산 사본의 **통합**. 범위가 크고
  이전 감사에서 유사 통합(LTV 3중 구현)이 이미 검토된 바 있어, 여기서는 경계값 일치만 다룬다.
