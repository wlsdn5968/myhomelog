# Plan 038: 상세 첫 탭 히어로가 추천 경로에서 잃어버리는 셀 2개와 표본 배지를 되살린다

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- frontend/index.html backend/services/propertyService.js backend/test/characterization.test.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건이다.
>
> ⚠ **이 계획은 `frontend/index.html` 을 수정한다. Plan 036 도 같은 파일을 수정하므로
> 두 계획을 동시에 실행하지 마라.** 순서는 무관하다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음 (단 Plan 036 과 같은 파일 — 동시 실행 금지)
- **Category**: bug
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

2026-09-05 에 상세 모달의 첫 탭을 "실거래 요약 기본" 으로 바꿨다(`T0-HERO-2026-09-05`).
그 히어로가 **추천 경로에서는 존재하지 않는 필드를 읽는다.**

1. **`p.dealCount`** — 히어로가 `:7628`(거래 건수 셀)과 `:7632`(표본 배지)에서 읽는다.
   검색·지도 경로는 이 필드를 싣지만(`backend/routes/search.js:385`, `:803`),
   **추천 경로는 `dealCount6m` 이라는 다른 이름으로 싣는다**(`backend/services/propertyService.js:1058`).
   `frontend/index.html` 에 `dealCount6m` 참조는 **0건**(실측). 그래서 추천 카드로 들어오면
   거래 건수 셀과 표본 배지가 **통째로 사라진다**.
2. **`p.recentDealDate`** — 히어로가 `:7629` 에서 읽는데, 이 값을 만드는 정규화 코드는
   **같은 함수의 `:8216-8220`**, 즉 히어로 HTML 이 `:7635` 에서 이미 쓰인 **뒤**에 있다.
   그 코드가 `p` 객체를 직접 변형하고 `props[i]` 는 같은 참조이므로,
   **같은 카드를 두 번째로 열면 셀이 나타난다.** 같은 단지가 열 때마다 다르게 보이는
   비결정적 표시다.

오류가 나지 않으므로 린트·문법 검사·테스트가 잡지 못한다. 이 저장소가
`c.facts` ↔ `c.objectiveFacts` 로 이미 겪은 **속성명 매달림**과 같은 계열이다
(그때도 라이브에서 7곳 전부 null 이 나올 때까지 몰랐다).

추천은 이 서비스의 핵심 진입 경로이고(`:6955` 의 `showDetail(props[i])`), 첫 탭은 이번
스프린트가 만든 화면이다. 지금 그 화면이 가장 흔한 경로에서 반쪽으로 뜬다.

## 현재 상태

### 파일

- `frontend/index.html` — 13,082줄 단일 파일 SPA(인라인 `<script>`, 빌드 없음).
  히어로는 `:7616-7634`, `recentDealDate` 정규화는 `:8216-8220`. 둘은 **같은 함수 안**이다.
- `backend/services/propertyService.js:1058` — 추천 응답이 `dealCount6m` 을 싣는다.
- `backend/routes/search.js:385`·`:803` — 검색/지도 응답이 `dealCount` 를 싣는다.
- `backend/test/characterization.test.js` — 프론트 계약 테스트가 있는 곳.

### 문제 코드 (있는 그대로)

`frontend/index.html:7628-7634`:

```js
  if (Number(p.dealCount) > 0) _t0Cells.push(_t0hc('거래 건수', `${Number(p.dealCount).toLocaleString()}건`, false, ''));
  if (p.recentDealDate) _t0Cells.push(_t0hc('최근 거래일', _escHtml(String(p.recentDealDate).slice(0,10).replace(/-/g,'.')), false, ''));
  if (p.buildYear) _t0Cells.push(_t0hc('준공년도', `${_escHtml(p.buildYear)}년`, false, 'KAPT·건축물대장'));
  const _heroSection = `<div class="t0-hero">
    <div class="t0h-hd">실거래 요약${Number(p.dealCount)>0?`<span class="t0h-bdg">표본 ${Number(p.dealCount).toLocaleString()}건</span>`:''}</div>
    <div class="t0h-g">${_t0Cells.join('')}</div>
  </div>`;
  document.getElementById('t0').innerHTML=`
    ${_heroSection}
```

`frontend/index.html:8216-8220` — 히어로보다 **580줄 뒤**에서 값을 만든다:

```js
  try{
    const _t0=p.txHistory&&p.txHistory[0];
    if(_t0&&_t0.dealYear)p.recentDealDate=_t0.dealYear+'-'+String(_t0.dealMonth||1).padStart(2,'0')+'-'+String(_t0.dealDay||1).padStart(2,'0');
    else if(!p.recentDealDate&&p.recentDeal)p.recentDealDate=String(p.recentDeal).replace(/\./g,'-');
  }catch(_e){}
```

`backend/services/propertyService.js:1057-1059` — 추천 응답의 필드명:

```js
      txHistory: apt.rawList || [],
      dealCount6m: apt.dealCount,
      recentDeal: apt.recentDeal,
```

추천 응답에는 `priceSampleN`(`propertyService.js:1018`)도 있는데, 이것은 **헤드라인 가격의
표본**(대표 평형 기준)이라 단지 전체 거래 건수와 **다른 수**다. 이 계획에서는 건드리지 않는다
(아래 "유지보수 메모" 참조).

### 왜 백엔드가 아니라 프론트를 고치는가

`dealCount6m` 이라는 이름은 **더 정확하다** — 추천 응답의 그 값은 6개월 창의 거래 수이고,
검색 응답의 `dealCount` 는 그룹 전체 합산이다(`search.js:385` 주석). 백엔드에서 이름을
`dealCount` 로 바꾸면 의미가 흐려지고, `_sOk`(`propertyService.js:1321`)·rec 캐시 등
다른 소비자에 영향이 번진다. **프론트가 두 이름을 모두 받게** 하는 것이 최소·최선이다.

### 이 저장소의 관례

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `T0-HERO-FIELD-2026-09-06`.
- 사용자 노출 값에 **"모름" 을 0 으로 만들지 않는다**(이 저장소의 확립된 원칙).
  값이 없으면 셀을 만들지 않는 현재 동작(`if (…> 0)`)을 유지하라.
- 프론트 인라인 JS 는 `npm run lint` 가 검사한다(`no-undef` 포함). 이것이 매달린 참조를 잡는
  **유일한 게이트**다.
- 프론트 계약은 `backend/test/characterization.test.js` 에서 `frontend/index.html` 을 읽어
  검사한다. 예: `characterization.test.js:885`.

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 린트(프론트 인라인 JS 포함) | `npm run lint` | exit 0 |
| 테스트 | `cd backend && npm test` | `pass 224` 이상, `fail 0` |
| 보안 회귀 | `node scripts/security-regression-check.js` | `위반 0건` |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `frontend/index.html` — 히어로 블록(`:7616-7634`)과 `recentDealDate` 정규화 블록(`:8216-8220`)
- `backend/test/characterization.test.js` — 계약 테스트 추가
- `plans/README.md`

**Out of scope**:
- `backend/services/propertyService.js` — **필드명을 바꾸지 마라.** 위 근거 참조.
- `backend/routes/search.js` — 검색 경로는 이미 올바르다.
- `priceSampleN` 을 배지에 쓰는 문제 — 표시 의미 변경이라 별건(유지보수 메모 참조).
- 히어로의 레이아웃·CSS·셀 구성 — 디자인 변경은 이 저장소 규칙상 기획(claude.ai/design)이 선행한다.
- `:8212-8215` 의 `RECENTDEAL-2026-08-19` 주석 — 근거가 적혀 있으니 옮기되 **지우지 마라**.

## Git 작업 방식

- 브랜치: `fix/t0-hero-field-name`
- 커밋: `fix(상세): 첫 탭 히어로가 추천 경로에서 표본 배지·거래 건수·최근 거래일을 잃던 것`
  body 에 `[근본 원인]` `[Fix 내용]` `[회귀 위험]`.
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: `recentDealDate` 정규화를 히어로 렌더보다 앞으로 옮긴다

`frontend/index.html:8212-8220` 의 블록(주석 4줄 + `try{...}catch{}`)을 **통째로 잘라내어**,
히어로 셀 조립이 시작되는 `:7620`(`const _t0Cells = [];`) **직전**에 붙인다.

⚠ 옮길 때 확인할 것: 그 블록이 쓰는 `p.txHistory`·`p.recentDeal` 이 새 위치에서 이미
정의돼 있어야 한다. 둘 다 함수 인자 `p` 의 속성이므로 함수 진입 시점부터 존재한다 —
`:7616` 이후면 안전하다. 그래도 **옮긴 뒤 반드시 Step 4 의 라이브 확인을 하라.**

⚠ 원래 위치(`:8221` 의 `currentDetail=p;`)는 그대로 둔다. 옮기는 것은 정규화 블록뿐이다.

옮긴 블록 위에 이유를 남긴다:

```js
  // T0-HERO-FIELD-2026-09-06: 이 정규화가 히어로 렌더(_heroSection) **뒤**에 있어서,
  //   추천 경로 첫 열람에는 '최근 거래일' 셀이 없고 같은 카드를 두 번째로 열 때만 나타났다
  //   (p 객체를 직접 변형하고 props[i] 가 같은 참조라서). 렌더 앞으로 옮긴다.
```

**검증**: `npm run lint` → exit 0
**검증**: 정규화 블록이 히어로보다 앞인지 —
```
node -e "const s=require('fs').readFileSync('frontend/index.html','utf8');const a=s.indexOf('RECENTDEAL-2026-08-19');const b=s.indexOf('const _heroSection');console.log('정규화',a,'히어로',b,a>-1&&b>-1&&a<b?'OK':'FAIL')"
```
→ `OK`

### Step 2: 거래 건수를 두 이름 모두에서 읽는다

히어로 셀 조립 앞에 값을 한 번만 정규화하고(사본을 만들지 않는다), `:7628` 과 `:7632` 가
그 값을 쓰게 한다:

```js
  // T0-HERO-FIELD-2026-09-06: 추천 응답은 dealCount6m(6개월 창), 검색·지도 응답은 dealCount(그룹 합산)
  //   으로 **다른 이름**을 쓴다. 히어로가 dealCount 만 읽어 추천 경로에서 셀과 배지가 통째로 빠졌다
  //   (프론트에 dealCount6m 참조가 0건이었다 — 오류가 안 나서 린트·테스트가 못 잡는 계열).
  //   백엔드 이름은 그대로 둔다: dealCount6m 이 의미상 더 정확하고, 바꾸면 rec 캐시·정렬 소비자에 번진다.
  const _t0DealN = Number(p.dealCount ?? p.dealCount6m) || 0;
```

그리고:

```js
  if (_t0DealN > 0) _t0Cells.push(_t0hc('거래 건수', `${_t0DealN.toLocaleString()}건`, false, ''));
```
```js
    <div class="t0h-hd">실거래 요약${_t0DealN>0?`<span class="t0h-bdg">표본 ${_t0DealN.toLocaleString()}건</span>`:''}</div>
```

⚠ `??` 를 쓰는 이유: `||` 를 쓰면 `dealCount` 가 정상값 `0`(= 거래 없음) 일 때 `dealCount6m`
으로 넘어가 **"모름과 0 을 섞는"** 결과가 된다. 이 저장소가 반복해 겪은 결함 계열이다.

**검증**: `npm run lint` → exit 0
**검증**: `grep -c "p.dealCount ?? p.dealCount6m" frontend/index.html` → `1`
**검증**: `grep -c "Number(p.dealCount) > 0\|Number(p.dealCount)>0" frontend/index.html` → `0`

### Step 3: 계약 테스트를 추가한다

`backend/test/characterization.test.js` 맨 끝에 테스트 1개를 추가한다.
이 테스트는 **소스 문자열 모양 검사로 끝내지 말고**, 가능한 한 값으로 단언하라.

최소한 다음 두 가지를 단언한다:

1. **백엔드↔프론트 필드명 계약**: `backend/services/propertyService.js` 가 추천 응답에
   싣는 이름(`dealCount6m`)이 `frontend/index.html` 에서 **실제로 읽히고 있다**.
   (양쪽 파일을 읽어 대조 — 한쪽만 이름을 바꾸면 여기서 깨진다.)
2. **렌더 순서 계약**: `frontend/index.html` 안에서 `recentDealDate` 를 만드는 블록이
   `const _heroSection` 보다 **앞에 있다**(인덱스 비교). 뒤로 가면 비결정 표시가 재발한다.

가능하면 3번도 넣어라 — 정규식으로 히어로 셀 조립 부분을 추출해 `new Function` 으로 실행하고
`{ dealCount6m: 12 }` 만 가진 객체에서 "12건" 이 나오는지 확인한다
(`characterization.test.js:885`·`:891` 의 추출+실행 패턴 그대로). 추출이 어려우면
1·2 만으로 마치되, **왜 실행 검증을 못 했는지 주석에 남겨라**.

⚠ 테스트 이름·주석에 이 결함이 무엇이었는지 적어라(이 저장소의 관례).

**검증**: `cd backend && npm test` → `pass` ≥ 224, `fail 0`

### Step 4: 라이브에서 실제로 확인한다

이 결함은 **런타임에서만 드러나는 계열**이라 정적 검증만으로는 부족하다.
브라우저 도구(Browser 패널)로 다음을 확인한다:

1. 앱을 열고 **추천 검색**을 한 번 실행한다.
2. 결과 카드 하나를 열어 첫 탭에 **"표본 N건" 배지 · "거래 건수" 셀 · "최근 거래일" 셀**이
   **첫 열람에** 보이는지 확인한다.
3. 모달을 닫고 **같은 카드**를 다시 연다 — 표시가 **첫 열람과 동일**한지 확인한다
   (달라지면 비결정성이 남아 있다는 뜻).
4. 콘솔에 새 에러가 없는지 확인한다.

⚠ 이 저장소의 교훈: 스크린샷 대신 DOM/텍스트로 판정하라(캡처 타임아웃·줌 변동 이력이 있다).

**검증**: 3단계에서 두 번의 표시가 같다. 콘솔 신규 에러 0.

### Step 5: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0.

## 테스트 계획

- **새 테스트 1개**, `backend/test/characterization.test.js` 끝에.
- **패턴 참고**: `characterization.test.js:885-915`(프론트 함수 정규식 추출 + `new Function` 실행 +
  백엔드와 값 대조). 이 저장소가 2026-09-02 에 "소스 문자열 검사 → 실제 실행" 으로 승격한 방식이다.
- **커버**: 필드명 계약 / 렌더 순서 계약 / (가능하면) `dealCount6m` 만 있는 객체에서 셀이 나오는지.
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `grep -c "p.dealCount ?? p.dealCount6m" frontend/index.html` → `1`
- [ ] `grep -c "Number(p.dealCount) > 0\|Number(p.dealCount)>0" frontend/index.html` → `0`
- [ ] Step 1 의 순서 확인 스크립트가 `OK` 를 출력
- [ ] `npm run lint` exit 0
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 224, `fail 0`
- [ ] Step 4 의 라이브 확인에서 첫 열람과 두 번째 열람의 히어로 표시가 같다
- [ ] `backend/services/propertyService.js` 가 **변경되지 않았다**(`git status --short`)
- [ ] `plans/README.md` 의 038 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 `frontend/index.html` 의 히어로 블록이 "현재 상태" 발췌와 다르다.
- `recentDealDate` 정규화 블록을 옮겼더니 `npm run lint` 가 `no-undef` 를 낸다
  (= 그 위치에서 아직 정의되지 않은 것을 쓴다). 되돌리고 보고하라.
- Step 4 에서 추천 카드를 열었는데 히어로 자체가 안 뜬다(별개 결함일 수 있다).
- 수정이 `backend/services/propertyService.js` 를 건드려야 할 것 같다.
- 첫 열람과 두 번째 열람이 여전히 다르다 — 다른 곳에도 `p` 를 변형하는 코드가 있다는 뜻이므로
  범위를 넓히지 말고 보고하라.

## 유지보수 메모

- **앞으로 백엔드 응답 필드명을 바꿀 때**: 프론트가 그 이름을 읽는지 `grep` 으로 확인하라.
  오류가 나지 않는 종류의 결함이라 린트·테스트·CI 가 전부 통과한다. Step 3 의 계약 테스트가
  이 한 쌍만 지켜 준다 — 다른 필드에는 같은 보호가 없다.
- **리뷰에서 볼 것**: `??` 를 `||` 로 바꾸지 않았는지. `||` 는 정상값 0 을 "모름" 으로 오해하게 만든다.
- **의도적으로 미뤄둔 것**: 배지의 "표본 N건" 이 **어떤 표본**인지. 추천 경로의 헤드라인
  가격은 대표 평형 6개월 가중평균이고 그 표본은 `priceSampleN`(`propertyService.js:1018`)이라
  단지 전체 거래 건수와 다르다. 배지를 `priceSampleN` 으로 바꾸면 더 정확하지만 화면에 두 수가
  생겨 혼란할 수 있다 — **표시 의미 결정이라 디자인 기획이 선행해야 한다.** 이 계획은
  "빠진 것을 되살린다" 까지만 한다.
