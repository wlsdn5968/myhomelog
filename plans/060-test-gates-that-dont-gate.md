# Plan 060: 막는 줄 알았는데 안 막는 계약 테스트 7건 — 결함을 되돌려도 전부 초록이다

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat 18ff341..HEAD -- backend/test/characterization.test.js backend/services/analysisService.js`

## Status

- **Priority**: **P1** · **Effort**: M · **Risk**: LOW(테스트만 — 프로덕션 코드 변경 최소) · **Depends on**: 없음
- **Category**: test-coverage · **Planned at**: commit `18ff341`, 2026-09-06
- **출처**: 2026-09-06 푸시 직전 적대적 감사(79 에이전트) 생존 결함 — **7건 모두 실제 주입으로 확정됨**

## 왜 중요한가

이 계획의 7건은 **"결함을 되돌렸는데 게이트가 전부 초록"** 임을 감사자가 **미러 저장소에서 실제로
주입해 확인**한 것들이다. 추정이 아니다. 가장 심각한 것부터:

### ⚠ ① `/share` XSS 방어의 **호출부**를 지워도 초록 — `characterization.test.js:7060`

테스트는 `escapeHtml` **함수 정의**만 잘라내(`src.indexOf('function escapeHtml(')`) 문자 클래스에
`$` 가 있는지 검사한다. **호출부는 어디서도 안 본다.**

감사자 실측: `share.js` 의 `const t = escapeHtml(title);` → `const t = title;` 로 바꾸고 실행하니
`tests 249 / pass 249 / fail 0`, `security-regression-check` 도 "위반 0건", eslint exit 0.
그 상태에서 핸들러를 직접 호출하니 응답이
`<title></title><script>alert(1)</script> — 내집로그 분석</title>` 로 **원문 그대로** 나왔다.
`server.js` 의 CSP `scriptSrc` 에 `'unsafe-inline'` 이 있어 **브라우저에서 실제 실행된다.**

⚠ `/share` 는 **인증·레이트리밋이 없는 공개 SSR 경로**다. 7건 중 유일하게 보안 영향이 있다.

### ② JIBUN 계약 테스트가 `select` 문자열만 본다 — `:7634`

테스트 이름은 *"매퍼가 jibun 을 반환한다"* 인데 본문은 `.select('apt_name` 로 시작하는 줄만 센다.
`transactionService.js` 의 `jibun: r.jibun || ''` **매핑만 지워도** `pass 249 / fail 0`.
(참고: 두 번째 매퍼의 **기존** 테스트 `:6136-6140` 은 함수 범위를 잘라 select 와 매핑을 **둘 다** 본다 — 그게 옳은 형태다.)

### ③ 렌더 순서 계약이 **주석**을 앵커로 삼는다 — `:6750`

`html.indexOf('RECENTDEAL-2026-08-19') < html.indexOf('const _heroSection')`.
그런데 그 마커는 **주석 한 줄**이고 실제 정규화는 그 아래 `try{…}catch(_e){}` 블록이다.
주석은 그대로 두고 **블록만** 뒤로 옮기니 `pass 249 / fail 0` — Plan 038 이 고친 증상(첫 열람에
최근 거래일 셀 누락)이 그대로 복원됐다.
⚠ 이 저장소가 **6회 재발**했다고 기록한 "마커를 주석에 쓰면 소스 검사가 자기 문서를 잡는다" 의 쌍둥이다.

### ④ Plan 046 의 **배선**을 아무도 실행으로 확인하지 않는다 — `analysisService.js:596`

테스트 2개가 나뉘어 있다 — 하나는 `calcBuySignal` 을 직접 호출(4번째 인자를 손으로 넣음), 하나는
`metaIdx < filterIdx` 인덱스 비교뿐. **그 사이의 배선**(`analyzeApt` 가 `_jTotal/_jFailed` 를 실제로
넘기는가)은 아무도 안 본다. `:596` 을 `null,` 로 바꿔도 `pass 249 / fail 0` 이고
eslint 도 통과한다(`_` 접두라 미사용 경고 안 뜸).

### ⑤ 계측 화이트리스트가 **주석 처리된 호출**을 통과시킨다 — `:7374`

`new RegExp("\\.send\\('"+e+"'\\)").test(htmlSrc)` — 원문 문자열 존재만 본다.
`frontend/index.html` 의 `sendOnce('report')` 호출 줄을 `//` 로 주석 처리해도 `pass 249 / fail 0`.
이 테스트가 존재하는 이유가 *"백엔드는 4종을 받는데 프론트가 2종만 보내는 상태가 3개월 방치"* 였다.

### ⑥ account 테스트 스텁이 `auditLog` 에 **영구 전이 오염** — `:7888`

`db/client` 를 스텁하고 `routes/account` 를 재로드하는데, `middleware/auditLog.js` 가
**모듈 스코프에서 구조분해**(`const { requireSupabaseAdmin } = require('../db/client')`)한다 —
그 순간 스텁이 `auditLog` 클로저에 박힌다. `finally` 는 `db/client` 와 `routes/account` 만 되돌린다.
감사자 실측: 테스트 종료 후에도 `writeAudit` 이 `"이 테스트에서 사용되지 않아야 한다"` 로 실패한다.
**오늘은 이 테스트가 끝에서 두 번째라 뒤에 소비자가 없어 영향 0** — 순서가 바뀌거나 테스트를 더 붙이면 터진다.

### ⑦ `_withMockedDate` 가 async 콜백을 `await` 하지 않는다 — `:7829`

`try { return fn(); } finally { global.Date = OrigDate; }` — `fn` 이 async 면 **첫 await 에서 모킹이 닫힌다.**
지금 통과하는 유일한 이유는 `account.js:351` 의 연도 계산이 핸들러 첫 await **앞**에 있기 때문이다.
그 앞에 `await Promise.resolve();` 한 줄만 넣으면(프로덕션 동작 동일) `fail 1`.
위양성 초록은 아니고 **fail-loud** 지만, 의미 보존 리팩터가 스푸리어스 레드를 만든다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **292 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |

## 범위

**In scope**: `backend/test/characterization.test.js` (⚠ 기존 테스트 **수정**이 이 계획의 본체다 —
다른 계획과 달리 파일 끝 추가만으로는 못 고친다)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/routes/share.js` · `backend/services/transactionService.js` ·
  `backend/services/analysisService.js` · `frontend/index.html` — **프로덕션 코드는 이미 옳다.**
  이 계획은 **테스트가 그걸 지키게** 만드는 것이다. 프로덕션 코드를 고치고 싶어지면 STOP.
- `scripts/security-regression-check.js` — 별개 게이트다. 손대지 마라.
- `plans/`

## 단계

### Step 0: 7건이 **지금도** 재현되는지 먼저 확인한다

각 항목마다 위에 적힌 주입을 **하나씩** 해보고 `npm test` 가 **초록인지** 확인하라.
⚠ 주입 전 `git status --short` 가 비어 있어야 하고, 확인 후 **즉시 원복**하라.

**재현되지 않는 항목이 있으면** 그 항목은 이미 고쳐진 것이다 — **STOP 하지 말고 그 사실을 보고**한 뒤
나머지만 진행하라(다른 세션이 먼저 손댔을 수 있다).

**산출물**: 7건 각각 "지금 주입해도 초록인가" 표.

### Step 1: ①번(보안)부터 고친다 — **호출부**를 계약으로 고정

`share.js` 의 응답 생성 경로에서 **`escapeHtml` 이 실제로 호출되는지**를 고정하라.
방법은 네가 정하되 **아래를 만족해야 한다**:

- `const t = escapeHtml(title)` 를 `const t = title` 로 바꾸면 **fail** 한다
- 변수명·공백을 바꿔도(의미 보존 리팩터) **통과**한다 — 즉 문자열 exact match 에 의존하지 마라
- **가능하면 실행 테스트**로: 핸들러를 호출해 `apt` 에 `</title><script>` 를 넣고 응답에
  이스케이프된 형태가 나오는지 본다. 이 저장소는 `new Function` 승격 방식을 이미 쓴다
  (`grep -n "new Function" backend/test/characterization.test.js`).

⚠ 실행이 불가능하면 소스 계약으로 하되 **왜 그랬는지 주석에 남겨라.**

마커: `GATE-CALLSITE-2026-09-06`

### Step 2: ②③⑤ — "문자열이 존재하는가" 를 "실제로 그렇게 동작하는가" 로 승격

- **②** 매퍼 검사를 **함수 범위**로 잘라 select 와 **반환 객체 매핑을 둘 다** 보게 하라.
  기존 `:6136-6140`(두 번째 매퍼)이 이미 옳은 형태다 — **그 방식을 그대로 따르라.**
- **③** 앵커를 **주석이 아니라 코드**로 바꿔라(예: 정규화 블록의 실제 코드 조각).
  ⚠ 소스 검사 전에 **줄 주석을 제거**하는 전처리를 넣으면 이 계열이 원천 차단된다 —
  이 파일에 이미 그런 전처리가 있는지 먼저 찾아보고, 있으면 재사용하라.
- **⑤** 호출이 **주석 처리되면 fail** 해야 한다. 줄 주석 제거 전처리 후 검사하거나,
  실행으로 승격하라(`sendOnce` 가 실제로 불리는지).

### Step 3: ④ — 배선을 **실행으로** 확인한다

`analyzeApt`(또는 그 경로)를 실제로 돌려 `jeonseSample` 이 `summarizeMarketSignal` 까지
도달하는지 확인하라. 스텁이 필요하면 이 파일의 기존 방식을 따르라.
`analysisService.js:596` 을 `null,` 로 바꾸면 **fail** 해야 한다.

⚠ 프로덕션 코드는 **고치지 마라.** 지금 값은 옳다.

### Step 4: ⑥ — 스텁 오염을 막는다

`middleware/auditLog.js` 도 `finally` 에서 함께 복원하거나, 스텁 창 안에서 `auditLog` 가
로드되지 않도록 순서를 바꿔라. **어느 쪽이든 다음을 만족해야 한다**:

- 그 테스트 **뒤에** `writeAudit` 을 부르는 프로브 테스트를 붙이면 **통과**한다
- 프로브를 먼저 붙여 **현재 상태에서 fail 하는 것**을 확인한 뒤 고쳐라(순서 중요)

⚠ `_withRecStubs`(`:7255` 부근)의 복원 단언 방식이 참고가 된다. **다만 그 헬퍼는 "직접 스텁한
경로"만 보므로 이 계열을 원리적으로 못 잡는다** — 같은 한계를 새 코드에 복제하지 마라.

### Step 5: ⑦ — `_withMockedDate` 가 async 를 지원하게 한다

`return fn()` 을 `await` 하도록 고치고 헬퍼를 `async` 로 만들어라.
⚠ **기존 호출부가 깨지면 안 된다** — `grep -n "_withMockedDate(" backend/test/` 로 전수 확인하라.
`account.js:351` 앞에 `await Promise.resolve();` 를 임시로 넣어도 **통과**해야 한다(그 확인 후 원복).

### Step 6: 회귀 주입 (반드시 수행 — 이 계획의 본체다)

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

**Step 0 에서 재현했던 7건의 주입을 그대로 다시 하고, 이번엔 전부 fail 해야 한다.**
하나라도 안 잡히면 그 항목은 **미완**이다 — 보고에 명시하고 STOP 여부를 판단하라.

각각 원복 후 `fail 0` 재확인.

### Step 7: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] Step 0 의 "지금 초록인가" 표와 Step 6 의 "이제 fail 하는가" 표가 **둘 다** 보고에 있다
- [ ] 7건 각각 주입 시 fail (안 되는 항목이 있으면 **명시**)
- [ ] **프로덕션 코드가 바뀌지 않았다** — `git diff --stat` 에 `backend/test/` 만
- [ ] 의미 보존 리팩터(변수명·공백 변경)로는 fail 하지 않는다(과잉 고정 금지)
- [ ] `cd backend && npm test` `fail 0` · `npm run verify` exit 0

## STOP 조건

- 프로덕션 코드를 고쳐야 게이트가 성립할 것 같다 → **보고하고 멈춰라.** 이 계획은 테스트 계획이다.
- ①번 실행 테스트를 만들다가 `/share` 핸들러를 바꿔야 할 것 같다 → **하지 마라.**
- ⑥번을 고치려다 `auditLog` 나 `account.js` 를 고쳐야 할 것 같다 → 보고하고 멈춰라.
- Step 6 에서 3건 이상 안 잡힌다 → 접근이 틀린 것이다. 멈추고 보고하라.

## 유지보수 메모

- **이 7건의 공통 원인**: "그 문자열이 소스에 있는가" 를 계약으로 삼은 것. 이 저장소는
  정규식 계약이 **옳은 도구인 경우**(배선·부재·문구·설정)와 **원리적으로 못 잡는 경우**(분기 반전,
  호출부 삭제, 주석 처리)를 이미 구분해 기록해 뒀다. 새 계약을 쓸 때 **어느 쪽인지 먼저 판단**하라.
- **줄 주석 제거 전처리**를 공용 헬퍼로 두면 ③⑤ 계열이 구조적으로 사라진다. 이번에 만들면
  다음 계약 테스트들도 쓰게 될 것이다.
- **리뷰에서 볼 것**: 프로덕션 코드가 안 바뀌었는지, 그리고 Step 6 표에서 7건이 전부 fail 하는지.
