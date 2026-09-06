# Plan 035: `/share` 의 치환 문자열이 `$` 패턴으로 확장되지 못하게 막는다

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하는 일이 생기면
> 즉흥 판단하지 말고 멈추고 보고하라. 완료하면 `plans/README.md` 의 이 계획 행 Status 를
> 갱신하라(리뷰어가 색인을 직접 관리한다고 말한 경우는 제외).
>
> **드리프트 점검(가장 먼저)**: `git diff --stat e7dc1c6..HEAD -- backend/routes/share.js backend/test/characterization.test.js`
> 결과가 비어 있지 않으면 아래 "현재 상태" 발췌와 실제 코드를 대조하고, 다르면 STOP 조건으로 취급하라.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: security
- **Planned at**: commit `e7dc1c6`, 2026-09-06

## 왜 중요한가

`/share` 는 인증도 레이트리밋도 없는 공개 라우트다. 이 라우트는 987KB 짜리
`frontend/index.html` 전문을 읽어 OG 메타 8곳을 `String.prototype.replace(정규식, "문자열")`
로 치환한다. JavaScript 는 **문자열 형태의 replacement 를 다시 스캔해서** `` $` `` · `$&` ·
`$'` · `$$` 를 확장한다. 이 replacement 안에는 요청 쿼리에서 온 값이 들어간다.

`` $` `` 는 "매치 앞부분 전체" 로 확장되고, 8개 치환이 **커지는 문자열 위에서 연쇄**되므로
증폭이 곱셈으로 쌓인다. 계획 작성 시 실측(재현 스크립트로 측정):

| 입력 `apt` | 최종 응답 문자 수 | 원본 대비 |
|---|---|---|
| `반포자이` (정상) | 823,783 | ×1 |
| `` $` `` × 10 (20자) | **35,784,867** | **×43** |
| `` $` `` × 20 (40자) | `RangeError: Invalid string length` | 프로세스 문자열 상한 초과 |

`apt` 는 60자까지 받으므로(`share.js:39`) 상한 입력은 항상 `RangeError` 구간이다.
이 저장소는 결제·인증·cron 이 **같은 단일 서버리스 함수**에 얹혀 있으므로
(`vercel.json` 의 `api/index.js`), 그 인스턴스의 힙을 수백 MB 태우는 요청은 옆의
정상 요청까지 끌고 간다. 부수적으로 정상 범위 입력에서도 크롤러가 받는 `<title>`·OG
메타가 깨진 마크업이 된다.

수정은 **치환 결과 문자열의 의미를 바꾸지 않는다** — 지금도 리터럴이어야 할 값이므로
동작 변화가 없다.

## 현재 상태

### 파일

- `backend/routes/share.js` — 108줄. `/share?apt=&area=` 와 `/share?cmp=` 두 분기가 있고,
  **두 분기 모두** 같은 치환 체인을 갖는다(각각 `:58-72` 와 `:88-102`).
- `backend/server.js:310` — `app.use('/share', shareRouter)`. 이 마운트에는 리미터가 없다
  (`generalLimiter` 는 `backend/server.js:213` 에서 `/api/` 에만 걸린다).
- `backend/test/characterization.test.js` — 6,663줄 단일 테스트 파일. 여기에 테스트를 추가한다.

### 문제 코드 (있는 그대로)

`backend/routes/share.js:30-34` — 이스케이퍼. `$` 와 백틱은 통과시킨다:

```js
function escapeHtml(s) {
  return String(s || '').replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
  }[c]));
}
```

`backend/routes/share.js:88-102` — `?apt=` 분기의 치환 체인(문제의 형태):

```js
  const rewritten = html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${u}">`)
    // (주석 5줄 — SHARE-NOINDEX-2026-09-02. 그대로 보존할 것)
    .replace(/<meta name="robots" content="[^"]*">/, `<meta name="robots" content="noindex, follow">`);
```

`backend/routes/share.js:58-72` 의 `?cmp=` 분기도 **같은 8+1 치환**을 갖는다.
`cmp` 는 base64 JSON 을 디코드해 단지명 최대 6개(각 40자)를 이어 붙이므로
(`share.js:50-53`) 실질 페이로드가 `apt` 보다 넓다. **두 분기를 모두 고쳐야 한다.**

### 이 저장소의 관례 (반드시 맞출 것)

- **주석은 한글**, 변경 이유를 `[왜]`/`[실측]` 형태로 남긴다. 마커 규칙은
  `SHARE-NOINDEX-2026-09-02` 처럼 `<주제>-<YYYY-MM-DD>` 다. 이 변경의 마커는
  `SHARE-REPLACE-LITERAL-2026-09-06` 을 쓴다.
- 테스트는 `backend/test/characterization.test.js` 한 파일에 `node:test` 의 `test(...)`
  로 추가한다. 예시는 같은 파일의 `test('_pickTierRate(프론트) — …', () => { … })`
  (`characterization.test.js:885`).
- ⚠ **테스트 안에 금지 패턴 원문을 주석으로 쓰지 마라.** 이 저장소의 정적 검사
  (`scripts/security-regression-check.js`)는 소스를 문자열로 훑기 때문에 자기 주석을 잡는
  자충수가 6회 재발했다. 패턴 문자열은 저장소에 **정확히 1회**만 존재하게 하라.

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `pass 224` 이상, `fail 0` |
| 린트 | `npm run lint` (레포 루트) | exit 0, 에러 0 |
| 문법 | `node --check backend/routes/share.js` | exit 0, 출력 없음 |
| 보안 회귀 | `node scripts/security-regression-check.js` | `위반 0건` |
| 의존성 동기 | `node scripts/check-deps-sync.js` | `deps-sync OK` |

계획 작성 시점 기준선: **223 pass · 0 fail**. 이 계획은 테스트를 최소 1개 추가하므로
완료 후에는 224 이상이어야 한다.

## 범위

**In scope** (이 파일들만 수정):
- `backend/routes/share.js`
- `backend/test/characterization.test.js` (테스트 추가)
- `plans/README.md` (상태 행 갱신)

**Out of scope** (관련돼 보여도 건드리지 마라):
- `backend/server.js` — `/share` 에 레이트리미터를 다는 것은 **이 계획의 범위가 아니다**.
  증폭이 사라지면 이 라우트의 비용은 정적 파일 응답 수준으로 돌아간다. 리미터는 별도 판단
  사항이며, 잘못 조이면 카카오톡·X 미리보기 크롤러가 카드를 못 받는다.
- `frontend/index.html` — 치환 대상일 뿐 변경 대상이 아니다.
- `backend/routes/aptPage.js`·`regionPage.js`·`briefing.js` 의 `esc()` 사본들 —
  별건(백로그에 기록돼 있다).
- `SHARE-NOINDEX-2026-09-02` 주석 블록 — **삭제하지 마라.** 왜 `noindex, follow` 인지가
  적혀 있고, 이 계획과 무관하다.

## Git 작업 방식

- 브랜치: `fix/share-replace-literal` (이 레포는 `feature/*`·`fix/*`·`hotfix/*`·`chore/*` 를 쓴다)
- 커밋 메시지 형태(레포 관례 — `git log` 에서 확인 가능):
  `fix(공유): 치환 문자열의 $ 패턴 확장 차단 — 20자 쿼리가 응답을 35.8MB 로 부풀렸다`
  body 에 `[근본 원인]` `[Fix 내용]` `[회귀 위험]` 을 적는다.
- ⚠ **push·PR 은 운영자 승인 후에만.** 이 저장소의 절대 룰이다.
- ⚠ master 에 merge commit 을 만들지 마라.

## 단계

### Step 1: 치환을 함수 형태로 바꾼다

`backend/routes/share.js` 의 **두 분기 모두**(`:58-72`, `:88-102`)에서
`.replace(정규식, "문자열")` 을 `.replace(정규식, () => 문자열)` 로 바꾼다.
함수 형태의 replacement 는 `$` 패턴을 **원리적으로** 해석하지 않는다.

가독성과 중복 제거를 위해 파일 상단(`escapeHtml` 아래)에 헬퍼를 하나 두고 두 분기가
공유하게 하는 것을 권장한다. 목표 형태:

```js
// SHARE-REPLACE-LITERAL-2026-09-06:
// [왜] String.replace 의 replacement 가 **문자열**이면 JS 가 그 안의 `$&`·`` $` ``·`$'`·`$$` 를
//   다시 확장한다. 여기 들어가는 값은 요청 쿼리에서 오고, 치환 8개가 커지는 문자열 위에서
//   연쇄되므로 증폭이 곱으로 쌓인다.
// [실측 2026-09-06] apt 에 확장 패턴 10개(20자) → 응답 35,784,867자(원본 823,777자의 43배).
//   20개(40자)면 V8 문자열 상한을 넘겨 RangeError. apt 상한이 60자이므로 상한 입력은 항상 그 구간이다.
//   결제·인증·cron 이 같은 서버리스 함수에 있어 그 인스턴스가 함께 죽는다.
// [해결] replacement 를 **함수**로 준다 — 함수 반환값은 절대 재스캔되지 않는다.
const lit = (s) => () => s;
```

그리고 각 치환을 다음처럼 바꾼다:

```js
    .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
```

**9개 치환 전부**(마지막 `robots` 치환 포함 — 그 replacement 는 지금 상수라 현재는 무해하지만,
나중에 값이 들어가면 같은 함정이 생긴다) 를 두 분기 모두에서 바꾼다.

**검증**: `node --check backend/routes/share.js` → exit 0
**검증**: `grep -c "\.replace(/<" backend/routes/share.js` → `18` (분기 2개 × 9치환)
**검증**: 아래 명령이 `0` 을 출력해야 한다 — 문자열 replacement 가 남아 있지 않다는 뜻이다.
```
grep -n "\.replace(/<[^)]*, \`" backend/routes/share.js | wc -l
```

### Step 2: `escapeHtml` 에 `$` 를 추가한다 (심층 방어)

Step 1 만으로 증폭은 완전히 막힌다. 그래도 이스케이퍼에 `$` 를 추가하면, 앞으로 누군가
이 파일에 **문자열 형태** 치환을 다시 넣더라도 안전하다.

```js
function escapeHtml(s) {
  // SHARE-REPLACE-LITERAL-2026-09-06: `$` 를 함께 이스케이프한다 — 위 lit() 이 이미 확장을 막지만,
  //   나중에 문자열 형태 치환이 다시 들어와도 안전하도록 두 겹으로 둔다.
  return String(s || '').replace(/[<>"'&$]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;', '$': '&#36;',
  }[c]));
}
```

⚠ `String(s || '')` 의 `|| ''` 는 **그대로 두라.** 이 저장소는 `/share` 의 0 표기로 이미
사고 이력이 있고(`SHARE-ZERO-2026-09-02`), 그 의미 변경은 이 계획의 범위 밖이다.

**검증**: `node --check backend/routes/share.js` → exit 0

### Step 3: 회귀 테스트를 추가한다

`backend/test/characterization.test.js` **맨 끝**에 다음 성격의 테스트 1개를 추가한다.
프로덕션 코드는 더 이상 건드리지 않는다.

테스트가 단언해야 할 것:
1. 확장 패턴을 담은 `apt` 로 핸들러를 호출해도 **응답 길이가 원본 HTML 길이 + 4,096자 이내**다.
2. 정상 입력(`반포자이`)에서 `<title>` 에 단지명이 실제로 들어간다(치환이 여전히 동작한다).
3. `?cmp=` 분기도 같은 상한을 지킨다.

핸들러 추출은 이 파일에 이미 있는 패턴을 그대로 쓴다 —
`characterization.test.js:924-929` 의 `_billingHandler` 와 같은 형태로
`require('../routes/share')` 의 `router.stack` 에서 `l.route && l.route.path === '/'` 인
레이어의 마지막 핸들을 꺼낸다. 응답 목은 `characterization.test.js:930-937` 의 `_mockRes`
형태를 따르되, `/share` 는 `res.type('html').send(...)` 를 쓰므로 목에 `type()`(자기 자신 반환)과
`send(body)` 를 추가해야 한다. `req` 목에는 `query`, `protocol`, `get(name)` 이 필요하다
(`share.js:55`·`:83` 이 `req.protocol` 과 `req.get('host')` 를 쓴다).

확장 패턴 문자열은 테스트 안에서 **문자 코드로 조립**하라 — 소스에 리터럴로 두면
정적 검사가 자기 자신을 잡는 자충수(이 저장소에서 6회 재발)가 생긴다. 예:
```js
  const AMP = String.fromCharCode(36) + String.fromCharCode(96); // 확장 패턴 1쌍
```

**검증**: `cd backend && npm test` → `pass` 가 224 이상, `fail 0`

### Step 4: 회귀 주입으로 테스트가 실제로 잡는지 확인한다

⚠ **주입 전에 반드시** `git status --short` 가 비어 있는지 확인하라(= Step 1~3 을 이미
커밋했는지). 이 저장소는 `git checkout` 원복으로 **미커밋 수정을 통째로 날린 사고**가 있다.

커밋한 뒤, `share.js` 의 `lit(...)` 하나를 원래의 문자열 형태로 되돌리고
`cd backend && npm test` 를 돌려 **fail 1** 이 나오는지 확인한다. 확인 후 되돌린다
(`git checkout -- backend/routes/share.js`).

**검증**: 주입 시 `fail 1` → 원복 후 `fail 0`. 주입해도 잡히지 않으면 **STOP 조건**이다
(테스트가 실제 결함을 못 잡고 있다는 뜻).

### Step 5: 전체 게이트를 돌린다

```
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
cd backend && npm test
```

**검증**: 다섯 개 모두 exit 0.

## 테스트 계획

- **새 테스트**: `backend/test/characterization.test.js` 에 1개.
  - 케이스 ①: `?apt=` 에 확장 패턴 10쌍 → 응답 길이 ≤ 원본 + 4,096
  - 케이스 ②: `?apt=반포자이` → `<title>` 에 `반포자이` 포함(치환이 살아 있다)
  - 케이스 ③: `?cmp=` 분기(단지명에 확장 패턴을 넣은 base64) → 같은 길이 상한
- **구조 참고 파일**: `backend/test/characterization.test.js:885`(정규식 추출 + `new Function`)
  과 `:924-937`(라우터 핸들러 추출 + `_mockRes`). 두 패턴을 조합한다.
- **검증**: `cd backend && npm test` → 전부 통과, 신규 1개 포함.

## 완료 기준 (전부 기계 검증 가능)

- [ ] `node --check backend/routes/share.js` exit 0
- [ ] `grep -c "lit(" backend/routes/share.js` 가 `19` 이상 (헬퍼 정의 1 + 치환 18)
- [ ] `grep -n "\.replace(/<[^)]*, \`" backend/routes/share.js | wc -l` 가 `0`
- [ ] `cd backend && npm test` exit 0, `pass` ≥ 224, `fail 0`
- [ ] `npm run lint` exit 0
- [ ] `node scripts/security-regression-check.js` exit 0
- [ ] Step 4 의 회귀 주입에서 `fail 1` 을 확인했다
- [ ] `git status --short` 에 In scope 밖 파일이 없다
- [ ] `plans/README.md` 의 035 행 Status 갱신

## STOP 조건

즉흥 판단하지 말고 멈추고 보고하라:

- 드리프트 점검에서 `backend/routes/share.js` 가 `e7dc1c6` 이후 변경돼 있고, 위 "현재 상태"
  발췌와 실제 코드가 다르다.
- `share.js` 에 치환 분기가 2개가 아니거나, 치환 개수가 분기당 9개가 아니다.
- Step 4 의 회귀 주입에서 테스트가 **잡지 못한다**(fail 0) — 테스트가 무의미하다는 뜻이므로
  테스트를 고치기 전에 보고하라.
- 수정이 `backend/server.js` 나 `frontend/index.html` 을 건드려야 할 것 같다.
- `lit()` 도입 후 정상 입력의 응답 길이가 원본과 크게 달라진다(치환이 깨졌다는 뜻).

## 유지보수 메모

- **앞으로 이 파일에 치환을 추가할 때**: replacement 는 반드시 함수 형태(`lit(...)`)여야 한다.
  문자열 형태를 쓰면 같은 결함이 재발한다. Step 3 의 테스트가 길이 상한으로 잡아 준다.
- **리뷰에서 볼 것**: 두 분기(`?apt=`, `?cmp=`) **모두** 바뀌었는지. 이 저장소는 "한쪽만 고침"
  으로 취득세·규제 판정에서 반복 사고를 냈다.
- **의도적으로 미뤄둔 것**: (a) `/share` 레이트리밋 — 증폭이 사라지면 비용이 정적 응답 수준이라
  긴급하지 않고, 잘못 조이면 SNS 미리보기 크롤러를 막는다. (b) `escapeHtml` 과 형제 라우트
  3곳의 `esc()` 사본 통합 — 별건으로 백로그에 있다. (c) `String(s || '')` 의 0 처리 의미 변경.
