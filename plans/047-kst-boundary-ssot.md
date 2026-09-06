# Plan 047: KST 하루 경계 SSOT 를 실제로 단일화한다 (파일은 만들어 놓고 3벌이 남아 있다)

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 에 해당하면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**: `git diff --stat 3d30ee2..HEAD -- backend/utils/kstTime.js backend/middleware/dailyLimit.js backend/routes/account.js backend/services/briefingService.js backend/services/rentService.js`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: **MED**(무료 한도 리셋 경로 포함) · **Depends on**: 없음
- **Category**: tech-debt · **Planned at**: commit `3d30ee2`, 2026-09-06

## 왜 중요한가

`backend/utils/kstTime.js:1-2` 는 스스로 이렇게 선언한다:

> KST-TIME-2026-09-05 (감사 G-8): '하루' 경계 계산을 **한 곳에**.

그런데 **임포터는 2곳뿐이고**(`geocodeCacheService.js`, `utils/txWindow.js`) **자체 사본이 3벌 남아 있다.**
SSOT 파일이 존재한다는 사실이 오히려 "이미 해결됨" 이라는 **거짓 안심**을 준다.

서버 런타임은 UTC 다. 이 저장소는 그 때문에 **일일 한도 리셋이 KST 09시에 일어나 안내(자정)와
9시간 어긋난 실사고**를 겪었다. 로컬(KST)에서는 통과하고 프로덕션에서만 어긋나는 종류다.

## 현재 상태

### SSOT — `backend/utils/kstTime.js` (전문)

```js
const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;
/** ts(epoch ms) 가 속한 KST 날짜의 **다음** 자정 — epoch ms. */
function nextKstMidnight(ts = Date.now()) {
  return (Math.floor((ts + KST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS;
}
/** ts 의 KST 날짜 'YYYY-MM-DD'. */
function kstDate(ts = Date.now()) {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10);
}
module.exports = { KST_OFFSET_MS, nextKstMidnight, kstDate };
```

### 남은 사본 3벌

**(1) `backend/middleware/dailyLimit.js:41-55`** — ⚠ **무료 한도 리셋 경로. 가장 조심할 곳.**

```js
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function todayKey() {
  const d = new Date(Date.now() + KST_OFFSET_MS); // UTC 시각 +9h = KST 벽시계
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

function secondsUntilMidnight() {
  const kstNow = Date.now() + KST_OFFSET_MS;
  const kstNextMidnight = Math.floor(kstNow / 86400000) * 86400000 + 86400000;
  return Math.max(60, Math.floor((kstNextMidnight - kstNow) / 1000));
}
```

**(2) `backend/routes/account.js:348`** — PIPA 활동 카운터의 연도

```js
    const kstYear = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
```

**(3) `backend/services/briefingService.js:25-28`** — 브리핑 날짜 키

```js
function kstDayString(d) {
  const base = d ? new Date(d) : new Date();
  return new Date(base.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
```

### 별건 — `rentService.monthsWindow` 는 **로컬 TZ 메서드**를 쓴다

`backend/services/rentService.js` 의 `monthsWindow`:

```js
function monthsWindow(now = new Date()) {
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);   // ← 로컬 TZ
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}
```

프로덕션(UTC)에서는 **매월 1일 KST 00~09시에 6개월 창이 한 달 밀린다.**
그 시간대의 예열 cron 이 새 달을 예열하지 않고, 09시 이후 첫 사용자 요청이 콜드로 가져간다.
실질 피해는 하루 몇 시간의 콜드 지연이지만 계열이 같으므로 **함께 고친다.**

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **241 pass**) |
| 린트 | `npm run lint` | exit 0 |
| 문법 | `node --check <수정 파일>` | exit 0 |

## 범위

**In scope**: `backend/middleware/dailyLimit.js` · `backend/routes/account.js` ·
`backend/services/briefingService.js` · `backend/services/rentService.js`(`monthsWindow` 만) ·
`backend/test/characterization.test.js`

**Out of scope**:
- `backend/utils/kstTime.js` — **구현을 바꾸지 마라.** 이미 옳다. 필요하면 함수를 **추가**만 하라.
- `backend/utils/txWindow.js`·`backend/services/geocodeCacheService.js` — 이미 SSOT 를 쓴다.
- `rentService` 의 다른 함수·TTL·페이서 — `monthsWindow` 만.
- DB·마이그레이션.

## 단계

### Step 0: 치환 **전에** 현재 동작을 고정한다 (필수)

⚠ 이것을 먼저 하지 않으면 "같은 값이 나온다" 를 증명할 수 없다.

각 사본에 대해 **여러 시각**(UTC 자정 직전/직후, KST 자정 직전/직후, 월말·연말 경계)에서
현재 반환값을 기록하는 스크립트를 스크래치패드에 만들어 돌려라. 최소 케이스:
- `2026-09-06T14:59:59Z` (KST 09-06 23:59:59)
- `2026-09-06T15:00:00Z` (KST 09-07 00:00:00) ← 하루가 바뀌는 지점
- `2026-12-31T15:00:00Z` (KST 2027-01-01) ← 연도가 바뀌는 지점
- `2026-09-30T15:00:00Z` (KST 10-01) ← 달이 바뀌는 지점

⚠ 함수들이 `Date.now()` 를 직접 부르므로, 시각을 주입하려면 테스트에서 `Date.now` 를 임시로
바꾸거나(복원 필수) 함수를 소스에서 추출해 실행하라. **추측하지 말고 실제 값을 찍어라.**

**산출물**: 케이스별 before 값 표. 이후 단계에서 after 와 대조한다.

### Step 1: 세 사본을 SSOT 로 치환한다

- `dailyLimit.js`: `KST_OFFSET_MS` 지역 상수를 제거하고 `require('../utils/kstTime')` 를 쓴다.
  · `todayKey()` → `kstDate(Date.now()).replace(/-/g, '')` (형식 'YYYYMMDD' 유지)
  · `secondsUntilMidnight()` → `nextKstMidnight()` 기반. ⚠ 기존 `Math.max(60, ...)` 하한을 **유지**하라.
- `account.js:348` → `Number(kstDate(Date.now()).slice(0, 4))`
- `briefingService.js` `kstDayString(d)` → `kstDate(d ? new Date(d).getTime() : Date.now())`
  ⚠ 이 함수는 **인자 있는 호출**이 있다. 시그니처·반환 형식을 그대로 유지하라.

각 치환에 마커 주석 `KST-SSOT-2026-09-06` 과 한 줄 근거를 남겨라.

**검증**: Step 0 의 케이스 표를 다시 돌려 **before 와 after 가 전부 일치**해야 한다.
하나라도 다르면 **STOP 조건**이다.

### Step 2: `monthsWindow` 를 KST 기준으로 고친다

`utils/txWindow.js` 가 이미 쓰는 방식(`KST_OFFSET_MS` + `getUTC*`)을 따르라.
⚠ 이건 **동작이 의도적으로 바뀌는** 유일한 부분이다(UTC 로컬 → KST). before/after 가 달라지는
시각대(매월 1일 KST 00~09시)를 테스트로 고정하라.

**검증**: `node --check backend/services/rentService.js` → exit 0

### Step 3: 테스트

`backend/test/characterization.test.js` 끝에 실행 테스트를 추가한다:
1. Step 0 의 경계 케이스에서 `todayKey`·`secondsUntilMidnight`·`kstDayString`·account 연도가
   **SSOT 기반 계산과 같은 값**을 낸다
2. `monthsWindow` — **UTC 런타임에서 매월 1일 KST 03시**에 그 달이 창의 첫 원소다
   (`new Date('2026-10-01T03:00:00+09:00')` 상당 시각을 주입)
3. ⚠ **절대 날짜를 하드코딩하되 그것이 "고정 입력"이어야 한다** — `Date.now()` 에 의존하는
   단언을 쓰지 마라(이 저장소는 절대 날짜 테스트가 시간이 지나 무의미해진 이력이 있다).
   즉 **입력은 고정, 기대값도 고정**으로 쓰라.

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 243

### Step 4: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.

1. `dailyLimit.todayKey` 를 로컬 메서드(`getFullYear` 등)로 되돌린다 → **fail** 해야 한다
2. `monthsWindow` 를 로컬 TZ 로 되돌린다 → **fail** 해야 한다

각각 원복 후 `fail 0` 재확인. 안 잡히면 **STOP 조건**.

### Step 5: 전체 게이트 (5종)

## 완료 기준

- [ ] `grep -rn "9 \* 60 \* 60 \* 1000\|9 \* 3600 \* 1000" backend/ --include=*.js | grep -v node_modules | grep -v test` 가
      **`backend/utils/kstTime.js` 만** 보여준다
- [ ] Step 0 의 before/after 표가 **전부 일치**(monthsWindow 제외 — 의도적 변경)
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 243 · `npm run lint` exit 0
- [ ] Step 4 의 주입 2건에서 각각 fail
- [ ] `backend/utils/kstTime.js` 의 기존 함수 **구현이 바뀌지 않았다**

## STOP 조건

- Step 1 의 before/after 가 **한 케이스라도 다르다** ← 가장 중요하다. 무료 한도 리셋이 걸려 있다.
- `kstDayString` 의 인자 있는 호출부가 깨진다(`grep -rn "kstDayString(" backend/` 로 먼저 전수 확인하라).
- Step 4 의 주입이 잡히지 않는다.
- `kstTime.js` 의 기존 함수를 고쳐야 할 것 같다.

## 유지보수 메모

- **앞으로 '하루'·'월' 경계를 계산할 때**: 반드시 `utils/kstTime` 을 임포트하라. 새 사본을 만들면
  프로덕션(UTC)에서만 어긋나는 버그가 되고 로컬 테스트로는 안 잡힌다.
- **리뷰에서 볼 것**: `dailyLimit` 의 before/after 일치 증거. 그 경로는 사용자에게 보이는 한도 안내와
  직결되고 이 저장소가 실제로 9시간 어긋난 이력이 있다.
