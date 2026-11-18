# Plan 210: health 가 쓰지 않는 "월 예산"을 DB 에서 읽지 않게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 210 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/server.js frontend/index.html backend/services/budgetService.js`
> `frontend/index.html` 은 자주 바뀐다. 줄 번호가 달라졌으면 아래 발췌의 글자로 자리를 찾는다. 글자가 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P2
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음
- **범주**: perf
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

이 서비스는 무료이고 유료 AI 호출을 쓰지 않는다(2026-11-13 확정). 예전에 AI 호출 비용을 사용자별로 월 단위로 세던 장치가 있었다. 지금은 사용량을 적는 함수(`recordUsage`)를 부르는 곳이 하나도 없어서 값이 쌓이지 않는다. 그런데 `/api/health` 는 로그인한 사람이 부를 때마다 이 "월 예산"을 확인하려고 DB 를 읽는다(요금제 확인과 `user_budget` 표 조회). 화면은 진입할 때 health 를 부른다(얼마나 자주 부르는지는 이 계획에서 세지 않았다). 쌓이지 않는 값을 읽으려고 DB 조회와 함수 CPU 를 쓰는 셈이다. 화면에는 그 값으로 "이번 달 예산을 N% 썼어요"를 붙이는 분기가 있는데, 값이 쌓이지 않으니 뜰 수 없다. 이 계획이 끝나면 health 는 이 조회를 하지 않고, 화면의 죽은 분기도 없어진다. DB 를 아끼는 것이 이 서비스의 가장 중요한 운영 원칙이다.

## 지금 상태

- `backend/server.js` : `/api/health` 처리기가 여기 있다.
- `backend/services/budgetService.js` : 월 예산 확인(`checkBudget`)과 사용량 기록(`recordUsage`).
- `frontend/index.html` : 화면 본체. health 응답을 읽는 곳에 예산 분기가 있다.

`backend/server.js:567`

```js
const budgetService = require('./services/budgetService');
```

`backend/server.js:626-639` (health 처리기 안)

```js
  // 월 예산 (로그인 사용자 한정)
  let monthlyBudget = null;
  if (req.user?.id) {
    const b = await budgetService.checkBudget(req.user.id);
    if (b) {
      monthlyBudget = {
        usedUsd: (b.usedX1000 / 1000 / 1000).toFixed(3),
        limitUsd: (b.limitX1000 / 1000 / 1000).toFixed(2),
        remainingPct: Math.max(0, Math.round((1 - b.usedX1000 / b.limitX1000) * 100)),
        resetAt: b.resetAt.toISOString(),
        exceeded: !b.allowed,
      };
    }
  }
```

`backend/server.js:757` (health 응답 객체 안)

```js
    monthlyBudget,
```

`backend/services/budgetService.js:74-98` (`checkBudget`. 요금제를 확인하고 `user_budget` 을 읽는다)

```js
async function checkBudget(userId) {
  if (!userId) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const plan = await getActivePlan(userId);
  if (plan === 'admin') {
    return { allowed: true, usedX1000: 0, limitX1000: Number.MAX_SAFE_INTEGER, resetAt: nextMonthFirst(), plan };
  }
  ...
    const { data, error } = await admin
      .from('user_budget')
      .select('cost_usd_x1000, input_tokens, output_tokens')
      .eq('user_id', userId)
      .eq('month', mkey)
      .maybeSingle();
```

사용량을 적는 함수는 정의와 내보내기에만 있다(2026-11-18, `grep -rn "recordUsage" backend api --include=*.js` 에서 `backend/test` 를 빼면 `budgetService.js:118` 과 `:147` 두 줄뿐).

`budgetService` 와 `monthlyBudget` 을 쓰는 곳 전체(2026-11-18 grep, `backend/test` 포함)
- `backend/server.js:567, 627, 629, 631, 757`
- `backend/services/planService.js:85` (주석 한 줄)
- `frontend/index.html:7103, 7105`
- `backend/test` 에는 `monthlyBudget`, `checkBudget`, `budgetService` 를 쓰는 검사가 없다.

`frontend/index.html:7102-7106`

```js
      // 월 예산 90% 초과 시 선제적 경고 (아직 차단 전)
      if(d.monthlyBudget && !d.monthlyBudget.exceeded && d.monthlyBudget.remainingPct <= 10){
        const pill = document.getElementById('aiPill');
        if(pill) pill.title += `\n⚠ 이번 달 예산을 ${100-d.monthlyBudget.remainingPct}% 썼어요. 다 쓰면 서비스가 제한돼요`;
      }
```

저장소 규칙
- 파일 삭제는 운영자 승인 뒤에만 한다. 그래서 이 계획은 `budgetService.js` 파일과 `user_budget` 표를 지우지 않는다. 부르는 줄만 뺀다.
- 주석은 한국어, 이름표는 `BUDGET-OFF-1118`.
- `frontend/index.html` 의 화면 코드는 여러 검사가 글자로 읽는다. 고친 뒤 반드시 전체 검증을 돌린다.
- Windows 에서 heredoc 으로 파일을 고치지 않는다. 편집 도구를 쓴다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 서버 모듈 읽기 | `cd backend` 뒤 `node -e "require('./server')"` | 오류 없이 끝난다(경고 로그는 괜찮다) |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0`. 기준 커밋에서 검사 수는 1,274개다 |

## 범위

**고쳐도 되는 파일**
- `backend/server.js` (567행, 626-639행, 757행)
- `frontend/index.html` (7102-7106행의 분기)
- `backend/test/health-no-budget-1118.test.js` (새로 만든다)
- `plans/README.md` (210 줄의 상태만)

**고치면 안 되는 것**
- `backend/services/budgetService.js` : 파일을 지우거나 고치지 않는다(삭제는 운영자 승인 사항).
- `backend/services/planService.js` : `backend/middleware/dailyLimit.js` 가 쓴다. 건드리지 않는다.
- `backend/jobs/retention.js` 의 `user_budget` 정리와 `backend/test/sec-1030-lifecycle.test.js` : 계정 삭제 때 그 표의 행을 지우는 것은 그대로 둔다.
- `backend/routes/report.js` 의 예산 오류 처리 분기, `backend/services/aiService.js` : 이 계획 범위 밖이다.
- health 응답의 다른 칸.
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/210-health-drop-unused-budget`
- 커밋 제목: `perf(health): 쌓이지 않는 월 예산을 DB 에서 읽지 않음 (Sprint 1118-plan210)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: 값이 정말 쌓이지 않는지 다시 확인한다

`grep -rn "recordUsage" backend api --include=*.js | grep -v "/test/"` 을 돌린다.

**확인**: 결과가 `backend/services/budgetService.js` 의 두 줄(정의와 내보내기)뿐이다. 다른 줄이 있으면 멈춤 조건이다.

### 2단계: health 에서 조회와 응답 칸을 뺀다

`backend/server.js`
1. 626-639행(주석 `// 월 예산 (로그인 사용자 한정)` 부터 닫는 `}` 까지)을 지우고 그 자리에 주석을 남긴다.

```js
  // BUDGET-OFF-1118 (plans/210): 월 예산 조회를 뺐다. 유료 호출이 없어 사용량을 적는 곳(budgetService.recordUsage)을 부르는 코드가 없고,
  //   값이 쌓이지 않는데 로그인한 사람의 health 마다 요금제 확인과 user_budget 조회가 돌았다.
```

2. 757행 `    monthlyBudget,` 을 지운다.
3. 567행 `const budgetService = require('./services/budgetService');` 를 지운다. 지우기 전에 `grep -n "budgetService" backend/server.js` 로 다른 사용처가 없는지 본다(위 1, 2번을 한 뒤에는 567행만 남아야 한다).

**확인**: `grep -n "budgetService\|monthlyBudget" backend/server.js` → 주석 한 줄(`BUDGET-OFF-1118`)만 나온다. `cd backend` 뒤 `node -e "require('./server')"` → 오류 없음.

### 3단계: 화면의 죽은 분기를 뺀다

`frontend/index.html` 에서 아래 다섯 줄(주석 포함)을 지운다. 줄 번호가 달라졌으면 `grep -n "monthlyBudget" frontend/index.html` 로 찾는다.

```js
      // 월 예산 90% 초과 시 선제적 경고 (아직 차단 전)
      if(d.monthlyBudget && !d.monthlyBudget.exceeded && d.monthlyBudget.remainingPct <= 10){
        const pill = document.getElementById('aiPill');
        if(pill) pill.title += `\n⚠ 이번 달 예산을 ${100-d.monthlyBudget.remainingPct}% 썼어요. 다 쓰면 서비스가 제한돼요`;
      }
```

앞뒤 줄(`updateHfRates(d.hfRates); ...` 와 닫는 `}`)은 건드리지 않는다.

**확인**: `grep -n "monthlyBudget" frontend/index.html frontend/js/*.js` → 결과 없음.

### 4단계: 회귀 검사를 쓴다

새 파일 `backend/test/health-no-budget-1118.test.js`. 소스 글자를 읽는 검사 세 개다(이 저장소에 같은 방식의 검사가 많다. 화면 코드는 `backend/testSupport/readFrontend.js` 의 `readFrontend()` 로 읽는다).

```js
/**
 * BUDGET-OFF-1118 (plans/210): health 가 쌓이지 않는 월 예산을 DB 에서 읽지 않는다.
 * 실행: cd backend && TZ=UTC node --test test/health-no-budget-1118.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFrontend } = require('../testSupport/readFrontend');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('health 는 월 예산을 조회하지 않고 응답에도 싣지 않는다', () => {
  assert.ok(!/budgetService\.checkBudget\(/.test(server));
  assert.ok(!/require\('\.\/services\/budgetService'\)/.test(server));
  assert.ok(!/^\s*monthlyBudget,\s*$/m.test(server));
});

test('화면은 월 예산 칸을 읽지 않는다', () => {
  assert.ok(!readFrontend().includes('monthlyBudget'));
});

test('사용량을 적는 함수를 부르는 곳이 생기면 이 조회를 되살릴지 다시 정한다', () => {
  // recordUsage 를 부르는 코드가 생겼다면 값이 다시 쌓인다는 뜻이다. 그때는 이 계획의 전제가 바뀐다.
  const dir = (p) => fs.readdirSync(path.join(__dirname, '..', p)).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, '..', p, f));
  const files = [path.join(__dirname, '../server.js'), ...dir('routes'), ...dir('services'), ...dir('jobs'), ...dir('middleware')];
  const callers = files.filter((f) => !f.endsWith('budgetService.js') && /recordUsage\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(callers.map((f) => path.basename(f)), []);
});
```

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/health-no-budget-1118.test.js` → `ℹ pass 3`, `ℹ fail 0`.

### 5단계: 전체 검증

저장소 루트에서 `npm run verify`. 린트가 `backend/server.js` 나 화면 코드에서 쓰지 않는 변수를 지적하면 그 변수가 이 계획에서 지운 줄 때문에 남은 것인지 보고, 그렇다면 같이 지운다.

**확인**: exit 0, `ℹ fail 0`, 검사 수 1,277개(1,274 + 3).

## 검사 계획

- 새 검사 3개: `backend/test/health-no-budget-1118.test.js`.
- health 처리기를 실제로 실행하는 기존 검사가 있으면(예: `frontend-contracts.test.js` 의 health 관련 검사) 고치지 않고 통과해야 한다.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `grep -rn "monthlyBudget" backend/server.js frontend` 결과 없음
- [ ] `grep -n "checkBudget" backend/server.js` 결과 없음
- [ ] `backend/services/budgetService.js` 가 그대로 있다(`git status --short` 에 없다)
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 210 줄 상태를 고쳤다

## 멈춤 조건

- 1단계에서 `recordUsage` 를 부르는 코드가 나온다(값이 쌓이고 있다는 뜻이다).
- `monthlyBudget` 을 읽는 곳이 `frontend/index.html` 의 그 분기 말고 더 있다(다른 화면 파일, 정적 페이지, 검사).
- health 응답의 `monthlyBudget` 칸이 있어야 통과하는 기존 검사가 있다.
- "지금 상태"의 발췌와 실제 코드의 글자가 다르다.

## 뒤에 맡을 사람에게

- 이 변경 뒤 `budgetService.js` 는 어디서도 부르지 않는 파일이 된다. 지울지는 운영자가 정한다(같은 상태로 삭제 승인을 기다리는 파일: `backend/services/legalService.js`). 지운다면 `backend/routes/report.js` 의 예산 오류 처리 분기와 `backend/services/aiService.js` 의 예산 오류 클래스, `planService.js:85` 의 주석도 같이 본다.
- 유료 호출을 다시 붙이지 않기로 한 방침이 바뀌면(그럴 계획은 없다) 이 조회를 되살리기 전에 사용량 기록부터 붙여야 한다. 4단계의 세 번째 검사가 그 순간을 알려 준다.
- 운영 DB 의 `user_budget` 표에 행이 있는지는 확인하지 않았다. 계정 삭제 때 그 표를 지우는 코드는 그대로 뒀다.
- 줄어드는 DB 조회 수는 재지 않았다. 로그인 사용자의 health 호출 한 번에 최대 두 번이다(요금제 확인이 캐시돼 있으면 한 번).
