# Plan 036: 비조정지역 '2주택+' 취득세를 보수적 값으로 되돌린다 (3주택 이상 4,500만원 과소 안내)

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 즉흥 판단하지 말고
> 멈추고 보고하라. 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- frontend/index.html backend/services/analysisService.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.
>
> ⚠ **이 계획은 `frontend/index.html` 을 수정한다. Plan 038 도 같은 파일을 수정하므로
> 두 계획을 동시에 실행하지 마라.** 순서는 무관하다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음 (단 Plan 038 과 같은 파일 — 동시 실행 금지)
- **Category**: bug (금전)
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

2026-09-02 의 `ACQ-REG-CALC-2026-09-02` 변경이 "필요 현금" 계산에서 `houseStatus === '2주택+'`
이고 비조정지역이면 취득세를 **무주택 기본세율(1~3%)** 로 계산하게 바꿨다.

문제는 `'2주택+'` 칩이 **2주택과 3주택 이상을 구분하지 않는다**는 것이다. 지방세법 §13-2 상
비조정지역의 다주택 취득세는 **2주택 = 기본세율 / 3주택 = 8% / 4주택 이상 = 12%** 다.
그래서 지금 코드는 비조정지역 3주택자에게 8% 대신 1~3%, 4주택 이상에게 12% 대신 1~3% 를
안내한다. **9억 매수 기준 약 4,500만원 과소 안내**(정답 7,200만원 → 표기 2,700만원)다.

같은 상세 모달을 스크롤하면 "3주택+ 취득세 (비조정 8%)" 와 "필요 현금(기본세율 1~3%)" 이
동시에 보인다 — 이 변경이 없애려던 "한 화면에 취득세 두 값" 이 다른 축으로 재발했다.

무엇보다 이 변경은 **저장소 자신이 세운 원칙을 어겼다.** 같은 함수 바로 위 주석
(`frontend/index.html:9109-9110`)이 이렇게 적혀 있다:

> 지역을 아는 호출부는 isRegulated 를 넘겨 정확히 계산한다. 모르면 undefined → 종전대로 보수적 8%
> **(모를 때 낮게 안내하면 과소 안내가 된다).**

`'2주택+'` 는 주택 수가 **모르는** 상태다. 그런데 그 모르는 상태에 최저 세율을 골랐다.
금전 도구에서 과대 안내는 안전하고 과소 안내는 실제 피해다.

**이 계획이 하는 일**: `'2주택+'` 처럼 주택 수가 불확정이면 조정/비조정과 무관하게 보수적인
8% 로 되돌린다. 그리고 각주를 정직하게 다시 쓴다("이 칩은 2주택과 3주택 이상을 구분하지
않는다"). 칩을 `2주택`/`3주택+` 로 쪼개는 근본 해결은 **범위 밖**이다(아래 "범위" 참조).

## 현재 상태

### 파일

- `frontend/index.html` — 13,082줄 단일 파일 SPA. 취득세 계산은 `calcTotalCostHTML`
  (`:9111` 부터). 인라인 `<script>` 이며 별도 빌드 없음.
- `backend/services/analysisService.js` — `calcTotalCost`(`:359` 부터). 프론트 사본과
  **같은 규칙을 갖도록 계약 테스트로 묶여 있다.**
- `backend/test/characterization.test.js` — 계약 테스트 위치.

### 문제 코드 (있는 그대로)

`frontend/index.html:9116-9133`:

```js
  let rate;
  if (tc?.acquisitionTax) {
    const at = tc.acquisitionTax;
    // ACQ-REG-CALC-2026-09-02: 비조정지역이 확인되면 중과 대신 무주택 tier(기본세율)를 쓴다.
    if (houseStatus==='2주택+') rate = (isRegulated === false)
      ? _pickTierRate(at.noHouse?.tiers, price, 0.03)
      : (at.twoHousePlus?.rate ?? 0.08);
    else if (houseStatus==='1주택') rate = _pickTierRate(at.oneHouse?.tiers, price, 0.03);
    else rate = _pickTierRate(at.noHouse?.tiers, price, 0.03);
  } else {
    if(houseStatus==='2주택+')rate=(isRegulated===false)?(price<=6?.01:price<=9?.02:.03):0.08;
    else if(houseStatus==='1주택')rate=price<=6?.01:price<=9?.02:.03;
    else rate=price<=6?.01:price<=9?.02:.03;
  }
  // 지방세법 §11①8호: 1주택·무주택 6~9억 취득세는 누진(1~3%) — tier 평탄값 대신 정확식 (2026-06-22 law.go.kr 검증)
  // ACQ-REG-CALC-2026-09-02: 비조정지역이 **확인된** 2주택+ 도 이 기본세율 경로를 탄다.
  //   ⚠ 누진식 사본을 새로 만들지 않는다 — 조건만 넓혀 기존 식을 재사용한다(계약 테스트가 사본 수를 센다).
  if ((houseStatus !== '2주택+' || isRegulated === false) && price > 6 && price <= 9) rate = (price * 2/3 - 3) / 100;
```

`backend/services/analysisService.js:363-385` 이 **같은 규칙의 사본**이다
(`:366-370`, `:379`, `:385` — 세 곳 모두 프론트와 대응한다).

### 올바른 값의 근거 (같은 저장소 안에 이미 있다)

`frontend/index.html:7681-7688` — 같은 상세 모달의 세금 시뮬레이션 카드:

```js
      // ACQ-REG-2026-06-24 (운영자 "지역별 차이를 매물에 반영"): 다주택 취득세 중과(지방세법 §13의2)는
      //   '조정대상지역'만 적용 — 비조정지역은 2주택 기본세율·3주택 8%(4주택+ 12%). …
      const _acqIsReg = (p.area && typeof isRegFront === 'function') ? isRegFront(p.area, p.lawdCd) : true;
      const acqTax2H = _acqIsReg ? marketW * 0.08 : acqTax1H;        // 조정 2주택 8% / 비조정 2주택 기본세율
      const acqTax3H = _acqIsReg ? marketW * 0.12 : marketW * 0.08;  // 조정 3주택+ 12% / 비조정 3주택 8% (4주택+ 12%는 주택수 구간 한계로 8% 보수 표기)
```

이 카드는 박스 3개(1주택/2주택/3주택+)로 나뉘어 있어 구분이 가능하다.
"필요 현금" 은 칩이 하나뿐이라 구분이 불가능하다 — 그게 이 결함의 근원이다.

### 왜 칩을 쪼개지 않는가 (이번 범위 밖인 근거)

`'2주택+'` 문자열은 프론트에서 **12곳**, 백엔드에서 **5곳** 이 비교한다(실측):
`frontend/index.html:1829`(칩 정의)·`:9120`·`:9126`·`:9133`·`:9144`·`:9182`·`:10444`·
`:10623`·`:10727`, `backend/routes/report.js:130`(입력 `_enum` 화이트리스트)·
`backend/services/analysisService.js:366`·`:379`·`:385`·`:394`·
`backend/services/propertyService.js:274`(LTV 0%)·`backend/services/aiService.js:86`(프롬프트 표).

즉 칩 분할은 대출 한도(LTV)·보고서 입력 검증·AI 프롬프트까지 번지는 **L 급**이고, 새 칩은
UI 변경이라 이 저장소의 규칙상 **디자인 기획(claude.ai/design)이 선행**해야 한다.
그래서 이번에는 "모를 때 보수적" 원칙 복원만 한다.

### 이 저장소의 관례

- 주석은 한글, 마커는 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `ACQ-UNKNOWN-COUNT-2026-09-06`.
- ⚠ **누진식 사본을 새로 만들지 마라.** 기존 주석(`:9132`)이 명시하듯 계약 테스트가 사본 수를 센다.
- 세금 계산은 **프론트·백엔드 두 사본**이 항상 같은 값을 내야 하고, 그것을 계약 테스트가 지킨다
  (`backend/test/characterization.test.js:885` 의 `_pickTierRate` 대조 테스트가 그 예다).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 225` 이상, `fail 0` |
| 린트(프론트 인라인 JS 포함) | `npm run lint` | exit 0 |
| 백엔드 문법 | `node --check backend/services/analysisService.js` | exit 0 |
| 보안 회귀 | `node scripts/security-regression-check.js` | `위반 0건` |

기준선: **223 pass · 0 fail**(계획 작성 시 실측).

## 범위

**In scope**:
- `frontend/index.html` — `calcTotalCostHTML` 의 세율 분기 3곳(`:9120-9122`, `:9126`, `:9133`)과
  각주(`:9182`)
- `backend/services/analysisService.js` — `calcTotalCost` 의 대응 3곳(`:366-370`, `:379`, `:385`)
- `backend/test/characterization.test.js` — 계약 테스트 추가
- `plans/README.md`

**Out of scope** (관련돼 보여도 건드리지 마라):
- **칩 분할(`2주택` / `3주택+`)** — 위 근거대로 L 급 + 디자인 선행 필요. 후속으로 기록만 한다.
- `frontend/index.html:7678-7688` 의 세금 시뮬레이션 카드 — **이미 올바르다.** 건드리지 마라.
- `calcLTV`·`propertyService.js:274` 의 LTV 0% 판정 — 취득세와 무관하다.
- `backend/routes/report.js:130` 의 `_enum` 화이트리스트 — 칩을 안 바꾸므로 그대로.
- 생애최초 감면 로직(`:9144`, `analysisService.js:394`) — 이번 변경과 무관.

## Git 작업 방식

- 브랜치: `fix/acq-tax-unknown-house-count`
- 커밋: `fix(취득세): 주택수 불확정('2주택+')이면 비조정이어도 보수적 8% — 3주택 이상에 4,500만원 과소 안내`
  body 에 `[근본 원인]` `[Fix 내용]` `[회귀 위험]`.
- ⚠ push·PR 은 운영자 승인 후에만. master 에 merge commit 금지.

## 단계

### Step 1: 프론트 세율 분기를 보수적으로 되돌린다

`frontend/index.html` 에서 세 곳을 바꾼다.

**(1) `:9119-9122`** — `taxConfig` 경로. `isRegulated === false` 완화를 제거한다:

```js
    // ACQ-UNKNOWN-COUNT-2026-09-06:
    // [왜] '2주택+' 칩은 2주택과 3주택 이상을 **구분하지 않는다**. 지방세법 §13-2 상 비조정지역은
    //   2주택=기본세율 / 3주택=8% / 4주택+=12% 라, 이 칩에 기본세율을 주면 3주택 이상에 과소 안내가 된다
    //   (9억 기준 7,200만원 → 2,700만원). ACQ-REG-CALC-2026-09-02 가 바로 그 상태였다.
    // [원칙] 바로 아래 주석이 스스로 적어 둔 것과 같다 — 모를 때 낮게 안내하면 과소 안내다.
    //   주택 수가 불확정이면 조정/비조정과 무관하게 보수적 중과율을 쓴다. 각주가 그 한계를 밝힌다.
    // [근본 해결] 칩을 '2주택'/'3주택+' 로 분리하는 것. 문자열 비교 지점이 프론트 12·백엔드 5곳이라
    //   L 급이고 UI 변경이라 디자인 기획이 선행한다 — plans/README.md 백로그 참조.
    if (houseStatus==='2주택+') rate = (at.twoHousePlus?.rate ?? 0.08);
```

**(2) `:9126`** — 하드코딩 fallback. `(isRegulated===false)?…:` 를 제거해 `0.08` 만 남긴다:

```js
    if(houseStatus==='2주택+')rate=0.08;
```

**(3) `:9133`** — 누진식 조건에서 09-02 에 넓힌 부분을 되돌린다:

```js
  if (houseStatus !== '2주택+' && price > 6 && price <= 9) rate = (price * 2/3 - 3) / 100;
```

⚠ `:9130` 의 `지방세법 §11①8호 …` 주석은 **그대로 두고**, `:9131-9132` 의
`ACQ-REG-CALC-2026-09-02` 두 줄만 위 마커 설명으로 교체한다.

⚠ **`isRegulated` 인자 자체는 지우지 마라.** 각주(Step 3)가 계속 쓴다.
지우면 호출부 2곳(`:9052`, `:9066`)까지 바뀌어 범위가 넓어진다.

**검증**: `npm run lint` → exit 0 (프론트 인라인 JS 가 이 게이트에 포함된다)
**검증**: `grep -c "isRegulated === false\|isRegulated===false" frontend/index.html` → `0`

### Step 2: 백엔드 사본을 같은 규칙으로 맞춘다

`backend/services/analysisService.js` 에서 대응하는 세 곳을 같은 방식으로 바꾼다:

- `:366-370` → `if (houseStatus === '2주택+') { rate = (at.twoHousePlus?.rate ?? 0.08); }`
- `:379` → `if (houseStatus === '2주택+') rate = 0.08;`
- `:385` → `if (houseStatus !== '2주택+' && price > 6 && price <= 9) rate = (price * 2 / 3 - 3) / 100;`

`:354` 부터의 `ACQ-REG-CALC-2026-09-02` 주석 블록도 같은 마커 설명으로 갱신한다
(프론트와 **같은 내용**이어야 한다 — 두 사본의 주석이 갈리면 다음 사람이 어느 쪽이 정답인지 모른다).

⚠ **`isRegulated` 매개변수는 시그니처에서 지우지 마라.** 기존 호출부·테스트가 넘긴다.

**검증**: `node --check backend/services/analysisService.js` → exit 0
**검증**: `grep -c "isRegulated === false" backend/services/analysisService.js` → `0`

### Step 3: 각주를 정직하게 다시 쓴다

`frontend/index.html:9182` 의 삼항 각주에서 `isRegulated===false` 분기를 없애고,
`'2주택+'` 일 때 **항상** 다음 취지의 한 문장이 나오게 한다:

> ※ '2주택+' 는 2주택과 3주택 이상을 구분하지 않습니다. 취득세는 보유 주택 수와 조정대상지역
> 여부에 따라 달라지므로 보수적으로 다주택 중과(8%)를 적용했습니다. 비조정지역 2주택이면
> 기본세율(1~3%)로 더 낮고, 조정대상지역 3주택 이상이면 12%로 더 높습니다.

⚠ 이 문장은 사용자 노출 문구다. 매수·매도 추천이나 미래 가격 단정을 담지 마라(절대 룰 ①).
⚠ 생애최초 감면 각주(`fbDeduct>0` 분기)는 **그대로 두라.**

**검증**: `npm run lint` → exit 0
**검증**: `grep -c "비조정지역이라 2주택+ 취득세에 중과" frontend/index.html` → `0`

### Step 4: 계약 테스트를 추가한다

`backend/test/characterization.test.js` 맨 끝에 테스트 1개를 추가한다.
`characterization.test.js:885` 의 `_pickTierRate` 대조 테스트와 **같은 구조**로 쓴다
(정규식으로 프론트 함수를 추출해 `new Function` 으로 되살린 뒤 백엔드와 값 대조).

단언할 것:
1. **비조정(`isRegulated === false`) + `'2주택+'` + 9억 → 세율 8%** (프론트·백엔드 둘 다).
   ★ 이것이 이번 결함의 핵심 케이스다.
2. 조정(`isRegulated === true`) + `'2주택+'` + 9억 → 8% (변화 없음).
3. `isRegulated` 미지정(`undefined`) + `'2주택+'` → 8% (종전 동작 유지).
4. 무주택/1주택의 6~9억 누진은 **영향받지 않는다**: 7억 무주택 → `(7*2/3-3)/100`.
5. 프론트와 백엔드가 위 네 케이스에서 **같은 값**을 낸다.

`calcTotalCostHTML` 은 HTML 문자열을 반환하므로 세율을 직접 꺼내기 어렵다.
백엔드 `calcTotalCost` 는 `.taxRate` 를 반환한다(`characterization.test.js:910` 이 이미 그렇게 쓴다).
프론트 쪽은 함수 전체를 추출해 실행한 뒤 반환 HTML 에서 취득세 금액을 파싱하거나,
세율 분기 부분만 추출해 실행하는 방법 중 **하나를 골라** 쓰고 그 선택을 주석에 남겨라.
어느 쪽이든 **"소스 문자열이 이렇게 생겼다" 는 검사로 끝내지 마라** — 이 저장소는
그런 검사가 분기 반전을 못 잡는다는 것을 실측으로 확인했다(468/1,620 조합이 갈렸는데 전부 초록).

**검증**: `cd backend && npm test` → `pass` ≥ 225, `fail 0`

### Step 5: 회귀 주입으로 테스트가 실제로 잡는지 확인한다

⚠ **주입 전에 `git status --short` 가 비어 있는지 확인하라**(= Step 1~4 를 커밋했는지).
이 저장소는 `git checkout` 원복으로 미커밋 수정을 통째로 날린 사고가 있다.

커밋한 뒤 `analysisService.js:366` 의 분기를 09-02 형태(`isRegulated === false` 완화)로
되돌리고 `cd backend && npm test` 가 **fail** 하는지 확인한다. 그 다음 프론트 쪽도 같은 방식으로
한 번 확인한다. 각각 확인 후 `git checkout --` 로 되돌린다.

**검증**: 두 주입 각각 `fail` ≥ 1 → 원복 후 `fail 0`.
잡히지 않으면 **STOP 조건**이다.

### Step 6: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0.

## 테스트 계획

- **새 테스트 1개**, `backend/test/characterization.test.js` 끝에 추가.
- **패턴 참고**: `characterization.test.js:878-915`(Plan 008 의 프론트↔백엔드 취득세 계약).
  그 테스트의 헤더 주석 형식(왜 추가하는지, 어떤 실사고를 고정하는지)을 그대로 따라 쓴다.
- **커버 케이스**: 위 Step 4 의 다섯 가지.
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `grep -c "isRegulated === false\|isRegulated===false" frontend/index.html backend/services/analysisService.js` 합계 `0`
- [ ] `grep -c "비조정지역이라 2주택+ 취득세에 중과" frontend/index.html` → `0`
- [ ] `grep -c "(price \* 2/3 - 3) / 100\|(price \* 2 / 3 - 3) / 100" frontend/index.html backend/services/analysisService.js` 합계가 **2** (사본이 늘지 않았다)
- [ ] `node --check backend/services/analysisService.js` exit 0
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 225, `fail 0`
- [ ] `npm run lint` exit 0
- [ ] Step 5 의 회귀 주입 2건에서 각각 fail 을 확인했다
- [ ] `git status --short` 에 In scope 밖 파일이 없다
- [ ] `plans/README.md` 의 036 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 세 파일 중 하나가 변경돼 "현재 상태" 발췌와 다르다.
- `frontend/index.html:9133` 과 `analysisService.js:385` 의 누진식이 **두 개가 아니다**
  (사본이 이미 늘어났다는 뜻 — 별도 판단이 필요하다).
- Step 5 의 회귀 주입에서 테스트가 잡지 못한다.
- 수정이 `calcLTV`·`report.js:130`·칩 정의(`index.html:1829`)를 건드려야 할 것 같다
  — 그건 칩 분할이고 범위 밖이다.
- 각주 문구를 쓰다가 매수 추천·가격 예측처럼 읽힐 표현밖에 떠오르지 않는다(절대 룰 ①).

## 유지보수 메모

- **근본 해결은 칩 분할이다.** `'2주택+'` → `'2주택'` / `'3주택+'`. 그러면 비조정 2주택에
  기본세율을, 3주택에 8% 를, 4주택 이상에 12% 를 정확히 줄 수 있다. 이 계획은 그 전까지
  **과소 안내가 아니라 과대 안내 쪽에 서 있게** 하는 것이 전부다.
  분할 시 함께 봐야 할 곳: `frontend/index.html:1829`(칩)·`:10623`·`:10727`(LTV)·
  `backend/routes/report.js:130`(`_enum`)·`backend/services/propertyService.js:274`(LTV 라벨)·
  `backend/services/aiService.js:86`(프롬프트 표).
- **리뷰에서 볼 것**: 프론트·백엔드 **양쪽** 이 바뀌었는지. 이 저장소는 취득세에서만
  "한쪽만 고침" 사고를 두 번 냈다(2026-07-25 백엔드만, 2026-08-16 6억 경계).
- **세금 시뮬레이션 카드(`:7678-7688`)는 이번 변경 후에도 여전히 옳다** — 거기는 박스가 3개다.
  두 값이 다르게 보이는 것은 칩 granularity 차이지 버그가 아니며, 각주가 그것을 설명한다.
