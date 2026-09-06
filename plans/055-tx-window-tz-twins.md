# Plan 055: 거래 창 계산의 남은 쌍둥이 2벌 — 047 이 전월세만 고쳤다

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**:
> `git diff --stat e737af3..HEAD -- backend/services/transactionService.js backend/utils/txWindow.js`

## Status

- **Priority**: **P1** · **Effort**: S · **Risk**: LOW(SSOT 가 이미 있고 반환 형식이 같다) · **Depends on**: 없음
- **Category**: bug (조용한 표본 이동) · **Planned at**: commit `e737af3`, 2026-09-06
- **출처**: 2026-09-06 적대적 감사 생존 결함 #7·#8 — 계획자가 코드를 직접 열어 재확인함

## 왜 중요한가

`backend/utils/txWindow.js` 는 스스로 이렇게 선언한다 — **"최근 N개월의 시작일을 한 곳에서만 정한다".**
그리고 `TXWINDOW-KST-2026-09-05` 주석이 **두 가지 함정을 이미 문서화**해 두었다:

```js
// TXWINDOW-KST-2026-09-05 (감사 G-8): 두 가지를 고쳤다.
//   ① 호스트 TZ 의존 — 로컬(KST)에서 09시 이전에 실행하면 setDate(1) 뒤 toISOString() 이 **전월 말일**
//      (UTC 로 9시간 전)을 돌려줬다. 프로덕션(UTC)은 반대로 매달 1일 00~09시 KST 에 아직 전달을 봤다.
//      같은 코드가 환경·시각마다 다른 답을 내는 것 자체가 사고 유형이다.
//   ② 31일 오버플로 — setMonth 를 먼저 하면 7/31 → "2/31" → 3/3 로 넘친 뒤 setDate(1) 이 **3/1** 을 돌려줬다
//      (6개월 창의 시작이 2월이어야 하는데 3월). 달 경계는 날짜를 1로 만든 **뒤에** 달을 옮겨야 한다.
function txWindowStart(monthsBack = 6, now = Date.now()) {
  const { KST_OFFSET_MS } = require('./kstTime');
  const k = new Date(now + KST_OFFSET_MS);          // KST 벽시계를 UTC 필드로 다룬다
  k.setUTCDate(1);
  k.setUTCMonth(k.getUTCMonth() - (monthsBack - 1));
  return k.toISOString().slice(0, 10);
}
```

**그런데 같은 파일(`transactionService.js`) 안에 두 함정이 각각 그대로 살아 있다.**
Plan 047 은 `rentService.monthsWindow` 만 고쳤다 — **매매 쪽 쌍둥이는 손대지 않았다.**

⚠ 이 저장소가 반복해 당한 형태다: **SSOT 파일이 존재한다는 사실이 "이미 해결됨" 이라는 거짓 안심을 준다.**

---

## 쌍둥이 ① — 호스트 로컬 TZ · `backend/services/transactionService.js:436-441`

```js
  const now = new Date();
  const months = [];
  // 최근 N개월 조회 — 거래 희소 단지까지 커버
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
```

`getFullYear()`·`getMonth()` 는 **호스트 로컬 TZ** 다. 프로덕션(Vercel) 런타임은 **UTC** 이고
개발 호스트는 Asia/Seoul 이다. 따라서 **매월 1일 KST 00~09시** 동안 UTC 는 아직 전달이므로
6개월 창이 통째로 한 달 밀린다 — **최신 달이 빠지고 7개월 전 달이 들어온다.**

그런데 화면 문구는 `backend/services/analysisService.js` 가 만드는
`최근 6개월 하위 N%` 처럼 **기간을 단정**한다. 사실과 다른 기간을 단정하게 된다.

⚠ 이 함수는 `YYYYMM` **문자열 목록**을 만든다. `txWindowStart` 는 `'YYYY-MM-DD'` **하나**를
돌려준다 — **형태가 다르다.** 그대로 갈아끼울 수 없다. (아래 Step 1 참조)

⚠ 캐시 키는 `` `txapt:${lawdCd}:${aptName}:${monthsBack}` `` (`:432`) 로 **창을 포함하지 않는다.**
창이 바뀌어도 옛 결과가 캐시 수명만큼 남는다.

## 쌍둥이 ② — 31일 오버플로 · `backend/services/transactionService.js:784-786`

```js
    const since = new Date();
    since.setMonth(since.getMonth() - (monthsBack - 1));
    since.setDate(1);
```

`setMonth` 를 `setDate(1)` **보다 먼저** 호출한다 — `txWindow.js` 가 함정 ②로 문서화한 바로 그 순서다.
게다가 `since.toISOString()` 은 호스트 TZ 의 Date 를 UTC 로 바꾸므로 함정 ①도 함께 있다.

이 함수(`getTransactionsByAptSeq`)는 **공개 SEO 단지 페이지 `/apt/:seq`**(16,000여 URL)가 쓴다.
`monthsBack` 기본값을 **직접 확인하라** — 감사는 24개월이라고 보고했다.
연 6일(31일인 달의 말일에 실행될 때) 창이 조용히 한 달 짧아진다.

⚠ 여기는 `'YYYY-MM-DD'` 를 만든다 — **`txWindowStart(monthsBack)` 로 바로 치환 가능**하다.

⚠ 캐시 키는 `` `txseq:${seq}:${monthsBack}` `` (`:780`).

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **249 pass**) |
| 전체 게이트 | `npm run verify` | exit 0 |
| 문법 | `node --check backend/services/transactionService.js` | exit 0 |

⚠ backend test 는 `scripts/run-backend-tests-utc.js` 래퍼로 **TZ=UTC** 강제 실행된다(Plan 050).
이 계획은 **정확히 그 차이를 잡는 것**이므로, TZ=UTC 로 도는지 출력에서 확인하고 보고하라.

## 범위

**In scope**: `backend/services/transactionService.js`(위 두 곳 + 관련 캐시 키) ·
`backend/test/characterization.test.js`(⚠ **파일 끝에만 추가**)

**Out of scope** (최종 `git status --short` 에 있으면 실패):
- `backend/utils/txWindow.js` · `backend/utils/kstTime.js` — **구현을 바꾸지 마라.** 이미 옳다.
  필요하면 함수를 **추가**만 하라(그럴 필요가 있다고 판단되면 먼저 보고하라).
- `backend/services/rentService.js` — Plan 047 이 이미 고쳤다.
- `transactionService.js` 의 **다른 로직**(페이징·매퍼·`analyzeTransactions`·TRUST 게이트) — 창 계산만.
- `analysisService.js` 의 "최근 6개월" 문구 — 창이 맞으면 문구도 맞아진다. 건드리지 마라.
- DB·마이그레이션.

## 단계

### Step 0: 현재 값을 **고정 입력**으로 찍어라 (필수)

⚠ 이걸 먼저 하지 않으면 "고쳤다"를 증명할 수 없다.

두 함수의 창 계산 부분을 스크래치패드로 추출해, **고정된 시각**을 주입하고 현재 반환값을 표로 남겨라.
최소 케이스(전부 UTC 시각):

| 주입 시각(UTC) | KST | 왜 |
|---|---|---|
| `2026-09-30T15:00:00Z` | 10-01 00:00 | 달이 바뀌는 지점 |
| `2026-09-30T23:00:00Z` | 10-01 08:00 | UTC 는 아직 9월 ← **함정 ①** |
| `2026-08-31T12:00:00Z` | 08-31 21:00 | 31일인 달 말일 ← **함정 ②** |
| `2026-12-31T15:00:00Z` | 2027-01-01 | 연도 경계 |

⚠ **절대 날짜를 하드코딩하되 그것이 "고정 입력"이어야 한다** — `Date.now()` 에 의존하는 단언을
쓰지 마라. 이 저장소는 절대 날짜 테스트가 시간이 지나 무의미해진 이력이 있다.

**산출물**: 케이스별 before 값 표. 보고에 그대로 실어라.

### Step 1: 쌍둥이 ① — KST 기준으로 `YYYYMM` 목록을 만든다

`txWindowStart` 는 **형태가 달라 그대로 쓸 수 없다.** 두 가지 중 하나를 골라라:

- (a) `txWindow.js` 에 `txWindowMonths(monthsBack, now)` 를 **추가**하고 `txWindowStart` 와
  **같은 방식**(`KST_OFFSET_MS` + `setUTCDate(1)` **먼저**, 그다음 `setUTCMonth`)으로 구현한다.
  ⚠ 기존 함수 구현은 건드리지 않는다. 이 선택을 하려면 Out of scope 예외이므로 **보고에 명시**하라.
- (b) `transactionService.js` 안에서 같은 방식으로 고친다(사본이 생기지만 파일 경계를 안 넘는다).

**(a) 를 권장한다** — 이 계획의 전제가 "SSOT 가 있는데 사본이 남았다" 이므로 사본을 늘리는 건
같은 실수의 반복이다. 다만 판단은 네 몫이고, **고른 이유를 보고에 적어라.**

⚠ 반드시 **`setUTCDate(1)` 을 `setUTCMonth` 보다 먼저** 호출하라(함정 ②).

마커: `TXWINDOW-TWIN-2026-09-06`

**검증**: Step 0 의 케이스를 다시 돌려 **before/after 표**를 만들어라.
함정 ①·②에 해당하는 케이스에서 값이 **바뀌어야 한다**(그게 이 계획의 목적이다).
나머지 케이스는 **바뀌면 안 된다** — 바뀌면 STOP 조건.

### Step 2: 쌍둥이 ② — `txWindowStart` 로 치환한다

`:784-786` 의 3줄을 `txWindowStart(monthsBack)` 호출로 바꿔라. 반환 형식이 이미 `'YYYY-MM-DD'` 라
`.gte('deal_date', …)` 에 그대로 들어간다. `since.toISOString().slice(0, 10)` 사용부도 함께 정리하라.

**검증**: Step 0 의 케이스에서 31일 말일·KST 00~09시 케이스 값이 바뀐다.

### Step 3: 캐시 키를 검토한다 ⚠

두 함수의 캐시 키(`txapt:…`, `txseq:…`)에는 **버전 성분이 없다.**
창 산식을 바꿨으므로 옛 결과가 캐시 수명만큼 남는다 — 이 저장소의 확립된 함정이다.

**키에 버전 성분을 추가하라.** 다른 소비자가 있을 수 있으니 키 **형태**를 임의로 바꾸지 말고
접두 버전만 올려라. 바꾼 전/후 값을 보고에 적어라.
(TTL 이 짧아 무의미하다고 판단되면 **그 TTL 값을 근거로 제시하고** 안 올려도 좋다 — 추측 금지.)

### Step 4: 테스트 (파일 **끝**에만 추가)

**실행 테스트**로 고정하라:

1. 쌍둥이 ① — UTC 런타임에서 `2026-09-30T23:00:00Z`(KST 10-01 08:00) 주입 시
   창의 **첫 원소가 `202610`** 이다(현재는 `202609`)
2. 쌍둥이 ② — `2026-08-31T12:00:00Z` 주입 시 24개월 창 시작이 **오버플로 없이** 나온다
   (기대값을 **고정 문자열**로 단언하라)
3. `txWindowStart` 의 **기존 반환값이 바뀌지 않았다**(SSOT 보호)
4. `transactionService.js` 소스에 `new Date(now.getFullYear()` 같은 **로컬 TZ 게터**가
   창 계산에 남아 있지 않다 — ⚠ 소스 검사 전에 **줄 주석 제거** 필수

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 253

### Step 5: 회귀 주입 (반드시 수행)

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. 쌍둥이 ① 을 `getFullYear/getMonth` 로 되돌린다 → **fail** 해야 한다
2. 쌍둥이 ② 에서 `setUTCDate(1)` 과 `setUTCMonth` 의 **순서를 뒤집는다** → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 안 잡히면 **STOP 조건**.

### Step 6: 전체 게이트

```
npm run verify
```

## 완료 기준

- [ ] `grep -n "getFullYear()\|getMonth()" backend/services/transactionService.js` 가 **창 계산에는** 나오지 않는다
- [ ] `:784-786` 이 `txWindowStart` 를 쓴다
- [ ] Step 0 의 before/after 표가 있고, **함정 케이스만** 바뀌었다
- [ ] `txWindow.js`·`kstTime.js` 의 **기존 함수 구현이 바뀌지 않았다**
- [ ] 캐시 키 판단(올림 또는 근거 있는 미올림)이 보고에 있다
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 253 · `npm run verify` exit 0 · **TZ=UTC 확인**
- [ ] Step 5 의 주입 2건에서 각각 fail
- [ ] `git status --short` 에 Out of scope 파일이 없다

## STOP 조건

- 드리프트 점검에서 발췌와 실제 코드가 다르다.
- Step 1 에서 **함정과 무관한 케이스의 값이 바뀐다** ← 가장 중요하다. 표본 창이 바뀌면 화면 숫자가 바뀐다.
- `txWindow.js` 의 기존 함수를 **고쳐야** 할 것 같다.
- `monthsBack` 기본값이 감사 보고(24개월)와 다르다 → 실제 값을 보고하고 계속 진행하되,
  테스트의 기대값을 **실제 기본값 기준**으로 쓰라.
- Step 5 의 주입이 잡히지 않는다.

## 유지보수 메모

- **앞으로 '달 경계'를 계산할 때**: 반드시 `utils/txWindow` 를 임포트하라. 새 사본을 만들면
  프로덕션(UTC)에서만 어긋나는 버그가 되고 로컬(KST) 테스트로는 안 잡힌다 — 그래서 Plan 050 이
  테스트를 TZ=UTC 로 강제했다.
- **아직 안 본 곳**: `getRegionRecentTransactions` 등 다른 창 계산 지점이 더 있는지
  `grep -rn "setMonth\|setDate" backend/ --include=*.js | grep -v node_modules` 로 전수 확인할 가치가 있다.
  이 계획에서 **확인만 하고 결과를 보고**하라(고치지는 마라).
- **리뷰에서 볼 것**: before/after 표에서 함정 케이스만 바뀌었는지, 그리고 SSOT 파일이 안 바뀌었는지.
