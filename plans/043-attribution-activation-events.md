# Plan 043: 계측기의 나머지 절반을 켠다 — `search`·`report` 이벤트 전송 (활성화 퍼널이 영영 0)

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- frontend/index.html backend/routes/attribution.js backend/routes/admin.js`
> 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하라.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: direction
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

`backend/routes/attribution.js:22` 는 네 가지 이벤트를 받는다:

```js
const EVENTS = new Set(['first_load', 'signup', 'search', 'report']);
```

그런데 **프론트에서 보내는 곳은 두 개뿐이다**(저장소 전수 grep):
- `frontend/index.html:228` — `signup`
- `frontend/index.html:3666`·`:3668` — `first_load`

`search` 와 `report` 를 보내는 코드는 **0건**이다. 즉 **도착과 가입만 보이고 활성화는 영영 0** 이다.

이게 왜 문제인지는 이 모듈이 스스로 적어 뒀다 — `attribution.js:5`:
"스레드·인스타 자동화가 돌아도 **어느 채널이 먹히는지 알 방법이 없었다.**"

현재 상태로는 "채널 A 가 100명을 데려왔는데 아무도 검색을 안 했는지" 와
"채널 B 가 10명을 데려와 8명이 보고서를 뽑았는지" 를 **구분할 수 없다.**
사용자 7명·최근 7일 로그인 0 인 지금, 이 구분이 운영자에게 남은 거의 유일한 의미 있는 신호다.

그리고 이건 새 기능이 아니다. **백엔드·스키마·집계 화면·보존 잡이 전부 완성돼 있다**:
- 수신: `backend/routes/attribution.js` (화이트리스트·길이 컷·개인정보 미수집)
- 집계: `backend/routes/admin.js:104` 가 `byEvent` 를 채널·리퍼러·캠페인과 함께 낸다
- 보존: `backend/jobs/retention.js:217`
- 설계 주석이 후속을 예고: `attribution.js:21` — "늘릴 때는 admin 집계 화면도 같이 본다"

**비어 있는 것은 프론트 호출 2줄이다.**

## 현재 상태

### 전송기 (`frontend/index.html:3627-3657`)

```js
  window._attr = (function(){
    var KEY = 'mhl_attr_v1';
    …
    return {
      data: a,
      // 실패는 조용히 — 계측이 사용자 경험을 막으면 안 된다.
      send: function(event){
        try {
          fetch(`${CFG.api}/attribution`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ event: event }, a)),
            keepalive: true,
          }).catch(function(){});
        } catch(_){}
      },
    };
  })();
```

### 기존 세션 가드 패턴 (`frontend/index.html:3663-3668`)

```js
  try {
    if (!sessionStorage.getItem('mhl_attr_fl')) {
      sessionStorage.setItem('mhl_attr_fl', '1');
      window._attr.send('first_load');
    }
  } catch(_) { try { window._attr.send('first_load'); } catch(_e){} }
```

⚠ 이 가드의 근거 주석(`:3658-3662`)이 중요하다: 세션당 1회로 제한하는 이유는
"SPA 재초기화·뒤로가기로 같은 방문이 여러 번 세지면 **채널 비교가 왜곡**된다" 이다.
`search` 는 `first_load` 보다 훨씬 자주 일어나므로 **같은 가드가 필수**다.

### 붙일 지점

- **검색**: `frontend/index.html:6628` 부근이 `/api/properties/recommend` 를 부르고,
  `:6655` 의 `const data=await res.json();` 뒤 `:6659` 에서 `props` 를 만든다.
  **성공적으로 결과를 받은 시점**에 보낸다.
- **보고서**: `frontend/index.html:4639` 이 `${CFG.api}/report/generate` 를 부른다.
  **응답이 성공(보고서를 실제로 받은)한 시점**에 보낸다.

⚠ 정확한 성공 판정 지점은 **실행자가 코드를 읽고 정하라.** 실패·429·타임아웃에서 보내면
"활성화" 지표가 오염된다.

### 왜 세션당 1회 상한이 이 작업의 실제 설계 포인트인가

`backend/routes/admin.js:93` 근처의 집계는 **1000행 캡**을 갖고 `truncated` 플래그를 낸다
(PostgREST 의 1000행 조용한 절단 — 이 저장소가 6회 재발시킨 함정이다).
검색은 빈발하므로 상한 없이 보내면 **검색 이벤트가 그 1000행을 혼자 다 먹고**
`first_load`·`signup`·`report` 가 집계에서 밀려난다. 그러면 퍼널을 보려고 만든 계측이
퍼널을 못 보게 만든다.

### 이 저장소의 관례

- 주석 한글, 마커 `<주제>-<YYYY-MM-DD>`. 이 변경의 마커: `ATTR-ACTIVATION-2026-09-06`.
- 프론트 인라인 JS 는 `npm run lint` 가 검사한다.
- 개인정보를 새로 수집하지 마라 — `attribution.js:8-10` 이 "user_id·IP·User-Agent·화면 크기를
  **아무것도** 남기지 않는다" 를 설계 원칙으로 못 박았다. `_attr.send(event)` 는 이벤트 이름만
  더하므로 그 원칙을 유지한다. **payload 에 다른 것을 추가하지 마라.**

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 린트(프론트 인라인 JS) | `npm run lint` | exit 0 |
| 테스트 | `cd backend && npm test` | `pass 224` 이상, `fail 0` |
| 보안 회귀 | `node scripts/security-regression-check.js` | `위반 0건` |

기준선: **223 pass · 0 fail**.

## 범위

**In scope**:
- `frontend/index.html` — `search`·`report` 전송 2곳 + 세션 가드
- `backend/test/characterization.test.js` — 계약 테스트
- `plans/README.md`

**Out of scope**:
- `backend/routes/attribution.js` — **이미 두 이벤트를 받는다.** 바꿀 것이 없다.
- `backend/routes/admin.js` 의 집계 화면 — `byEvent` 가 이미 이벤트별로 센다.
  1000행 캡 자체를 늘리는 것은 별건(그리고 세션 가드가 그 압력을 줄인다).
- 새 이벤트 종류 추가 — 화이트리스트 4종 안에서만 작업한다.
- payload 에 새 필드 추가 — 개인정보 미수집 원칙(위 참조).
- UTM 파라미터 처리 — 이미 `_attr` 초기화(`:3632-3641`)가 한다.

## Git 작업 방식

- 브랜치: `feature/attribution-activation-events`
- 커밋: `feat(계측): 검색·보고서 활성화 이벤트 전송 — 도착·가입만 보이고 활성화는 영영 0이었다`
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: 세션당 1회 가드를 재사용 가능한 형태로 만든다

`_attr` 모듈(`:3644-3656`)에 `sendOnce(event)` 를 추가한다. `first_load` 가 쓰는 것과
**같은 sessionStorage 가드 패턴**을 일반화한다:

```js
      // ATTR-ACTIVATION-2026-09-06:
      // [왜] search 는 first_load 보다 훨씬 자주 일어난다. 상한 없이 보내면 admin 집계의 1000행 캡을
      //   검색 이벤트가 혼자 먹어 first_load·signup·report 가 밀려난다 — 퍼널을 보려고 만든 계측이
      //   퍼널을 못 보게 만든다. 세션당 1회면 "이 방문에서 검색까지 갔는가" 라는 퍼널 질문에 충분하다.
      sendOnce: function(event){
        try {
          var k = 'mhl_attr_1_' + event;
          if (sessionStorage.getItem(k)) return;
          sessionStorage.setItem(k, '1');
        } catch(_){ /* sessionStorage 불가(프라이빗 모드 등) — 가드 없이 1회 보낸다 */ }
        this.send(event);
      },
```

⚠ `sessionStorage` 접근은 **반드시 try/catch** 로 감싸라(프라이빗 모드·차단 설정에서 throw 한다).
기존 `first_load` 코드가 그렇게 하고 있다.
⚠ `this.send` 가 아니라 클로저 참조를 쓰는 편이 안전할 수 있다 — `sendOnce` 를 분리된
콜백으로 넘길 가능성을 고려하라.

**검증**: `npm run lint` → exit 0
**검증**: `grep -c "sendOnce" frontend/index.html` ≥ `3` (정의 1 + 호출 2)

### Step 2: 검색 성공 지점에 붙인다

`/api/properties/recommend` 응답을 **성공적으로 파싱해 결과가 있는** 지점
(`frontend/index.html:6655-6665` 부근)에서:

```js
        try { if (window._attr) window._attr.sendOnce('search'); } catch(_){}
```

⚠ 다음 경우에는 **보내지 마라**: fetch 실패, 비-200 응답, cold-start 재시도 중,
결과가 `_notice`(데이터 일시 조회 실패 안내) 뿐인 경우.
`backend/services/propertyService.js` 가 실패 시 `_notice: true` 항목 하나만 담은 배열을
돌려주므로, 그것을 "검색 성공" 으로 세면 지표가 오염된다.

**검증**: `npm run lint` → exit 0

### Step 3: 보고서 성공 지점에 붙인다

`frontend/index.html:4639` 의 `${CFG.api}/report/generate` 호출이 **성공해 보고서를 받은**
지점에서 같은 방식으로 `sendOnce('report')` 를 보낸다.

⚠ 429(한도 초과)·타임아웃·503 에서는 보내지 마라 — 그건 "보고서를 받았다" 가 아니다.
⚠ 캐시 히트(`fromCache: true`)는 **보낸다** — 사용자 입장에서는 보고서를 받은 것이다.

**검증**: `npm run lint` → exit 0

### Step 4: 계약 테스트를 추가한다

`backend/test/characterization.test.js` 맨 끝에 테스트 1개를 추가한다.
이것은 **배선 계약**이므로 정규식 검사가 옳은 도구다(이 저장소의 판단 기준).

단언:
1. `backend/routes/attribution.js` 의 `EVENTS` 화이트리스트 4종을 파싱한다.
2. 그 4종 **전부**에 대해 `frontend/index.html` 에 전송 코드가 존재한다
   (`send('<event>')` 또는 `sendOnce('<event>')`).
   ★ 이 단언이 이번 결함(2종 미전송)의 재발을 막는다.
3. `search`·`report` 는 `sendOnce` 로만 보낸다(상한 없는 `send` 로 되돌아가면 fail).

⚠ 검사 전 줄 주석을 제거하고 검사하라 — 이 저장소는 소스 문자열 검사가 **자기 주석을 잡는**
자충수를 6회 재발시켰다. 그리고 이 계획서의 이벤트 이름 문자열이 테스트 안에서
`EVENTS` 파싱으로 **유도**되게 하라(하드코딩 목록을 새로 만들지 마라).

**검증**: `cd backend && npm test` → `pass` ≥ 224, `fail 0`

### Step 5: 회귀 주입

⚠ **주입 전 `git status --short` 가 비어 있어야 한다.**

`sendOnce('search')` 한 줄을 지우고 `cd backend && npm test` 가 **fail** 하는지 확인한 뒤 원복.

**검증**: fail ≥ 1 → 원복 후 fail 0. 안 잡히면 **STOP 조건**.

### Step 6: 라이브에서 실제로 전송되는지 확인한다

Browser 패널로:
1. 앱을 열고 네트워크 요청을 관찰한다 — `POST /api/attribution` 이 `first_load` 로 1회.
2. 검색을 실행한다 → `POST /api/attribution` 이 **1회 더**(`search`).
3. **같은 세션에서 검색을 한 번 더** 한다 → 추가 요청이 **없어야 한다**(세션 가드).
4. 보고서를 생성한다 → `report` 1회.
5. 응답이 204 인지 확인한다.

⚠ 요청 본문에 개인 식별자가 들어가지 않았는지도 확인하라
(`utmSource`·`utmMedium`·`utmCampaign`·`referrerHost`·`landingPath`·`event` 만 있어야 한다).

**검증**: 3번에서 중복 요청이 없다. 5번이 204. 본문에 개인 식별자 없음.

### Step 7: 전체 게이트

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

## 테스트 계획

- **새 테스트 1개**(Step 4 — 화이트리스트 4종 ↔ 프론트 전송 지점 배선 계약).
- **패턴 참고**: 이 파일의 다른 배선 계약 테스트들(예: `vercel.json` cron ↔ 라우트 대조).
- **검증**: `cd backend && npm test` → 전부 통과.

## 완료 기준

- [ ] `grep -c "sendOnce" frontend/index.html` ≥ `3`
- [ ] `grep -c "sendOnce('search')" frontend/index.html` → `1`
- [ ] `grep -c "sendOnce('report')" frontend/index.html` → `1`
- [ ] `npm run lint` exit 0
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 224, `fail 0`
- [ ] Step 5 의 회귀 주입에서 fail 확인
- [ ] Step 6 의 라이브 확인: 같은 세션 두 번째 검색에서 중복 요청 **없음**
- [ ] `backend/routes/attribution.js` 가 **변경되지 않았다**(`git status --short`)
- [ ] `plans/README.md` 의 043 행 Status 갱신

## STOP 조건

- 드리프트 점검에서 `_attr` 모듈이나 `EVENTS` 목록이 발췌와 다르다.
- 검색 성공 판정 지점을 정할 수 없다(코드 흐름이 여러 갈래) — 어떤 갈래가 있는지
  목록으로 보고하고 멈춰라. 잘못 붙이면 지표가 오염된다.
- Step 5 의 주입이 잡히지 않는다.
- Step 6 에서 중복 요청이 계속 발생한다(세션 가드가 안 먹는다).
- payload 에 개인 식별자를 넣고 싶어진다 — 절대 금지. `attribution.js:8-10` 의 설계 원칙이다.

## 유지보수 메모

- **이 계측을 켠 뒤 1주는 그냥 두라.** 데이터가 쌓이기 전에는 채널 실험이 의미가 없다.
  `/api/admin/attribution` 의 `byEvent` 로 **도착 → 가입 → 검색 → 보고서** 4단 퍼널이
  실제로 그려지는지 먼저 확인하는 것이 이 계획의 진짜 완료 조건이다.
- **1000행 캡을 지켜보라**(`admin.js:93` 의 `truncated` 플래그). 세션 가드가 있어도
  트래픽이 늘면 캡에 닿는다. 그때는 캡을 늘리는 게 아니라 **집계를 서버에서 GROUP BY** 하는 게 답이다
  (PostgREST 의 1000행 조용한 절단은 이 저장소가 6회 겪은 함정이다).
- **Plan 044·045 와의 관계**: 저 둘은 유입을 늘리고 전환을 개선하려는 시도인데,
  **이 계획이 먼저 들어가야 그 효과를 볼 수 있다.** 실행 순서에서 043 을 앞에 두라.
- **리뷰에서 볼 것**: 실패·429·`_notice` 경로에서 이벤트가 나가지 않는지.
