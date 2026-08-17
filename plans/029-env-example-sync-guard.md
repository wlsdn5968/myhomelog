# Plan 029: `.env.example` 드리프트를 CI 가 잡게 한다 (같은 누락이 세 번째다)

> **Executor instructions**: 이 계획을 단계별로 따르라. 각 단계의 검증 명령을 실제로 실행하고
> 기대 결과를 확인한 뒤 다음으로 넘어가라. "STOP conditions" 에 해당하면 **즉시 멈추고 보고**하라 —
> 임의로 판단해서 진행하지 마라. 끝나면 `plans/README.md` 의 이 계획 상태 행을 갱신하라.
>
> **Drift check (가장 먼저 실행)**:
> `git diff --stat 530ca3c..HEAD -- backend/.env.example backend/server.js .github/workflows/ci.yml`
> 위 파일이 바뀌었으면 아래 "Current state" 인용과 실제 코드를 대조하고, 다르면 STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `530ca3c`, 2026-08-17

## Why this matters

`backend/.env.example` 이 코드가 실제로 읽는 환경변수를 따라가지 못하는 사고가 **세 번째**다.
이 저장소는 env 미설정 시 기능이 조용히 꺼지는 graceful-degrade 설계라, 문서 누락이 **부팅 실패로
드러나지 않는다** — 아무 경고 없이 재발하고, 새 환경(신규 기여자·새 배포)에서 해당 기능만 소리 없이
비활성화된 채로 돈다.

계획 005 가 이미 이 재발 구조를 알고 있었고 "grep 대조를 CI 경고 스텝으로 올리는 후속"을 적어뒀지만
그 후속은 만들어지지 않았다. 그래서 또 누락됐다. 이번 계획은 **누락된 변수 1개를 채우는 것이 아니라,
다음 누락을 CI 가 알려주게 만드는 것**이다.

## Current state

### 1) 실제 누락 (2026-08-17 실측)

`backend/server.js:218` 이 환경변수를 읽는다:

```js
const DAILY_CLAUSE_LIMIT = _parseIntSafe(process.env.DAILY_CLAUSE_LIMIT, 3); // 기존 유료 한도 그대로
```

`backend/server.js:239` 에서 실제로 쓰인다:

```js
app.use('/api/clause', optionalAuth, chatLimiter, dailyLimit({ limit: DAILY_CLAUSE_LIMIT, scope: 'clause', loggedInBonus: 10 }), clauseRouter);
```

그런데 `backend/.env.example` 안에 `DAILY_CLAUSE_LIMIT` 문자열이 **0건**이다.
형제 변수인 `DAILY_SEARCH_LIMIT` 는 문서화돼 있다(1건). 즉 같은 계열에서 이것만 빠졌다.

### 2) 이 파일의 기존 규약 (그대로 따라야 한다)

`backend/.env.example` 은 누락분을 추가할 때 **날짜가 박힌 SYNC 헤더 블록**을 만들어 그 아래에 적는
관례가 있다. 실제 예(`backend/.env.example:63` 부근):

```
# ── ENV-EXAMPLE-SYNC-2026-07-17 (Sprint WWWWW): 코드에서 실제 사용하지만 예시에 누락됐던 변수 추가.
#    전부 optional(미설정 시 graceful degrade) — 로컬 구동은 되지만 해당 기능이 조용히 비활성화됨.
```

그리고 `backend/.env.example:87` 부근:

```
# ── ENV-EXAMPLE-SYNC-2026-08-09 (Plan 005): 코드 참조 env 전수 대조로 재발 누락분 추가.
#    전부 optional(미설정 시 graceful degrade). 실키·실값 기재 금지 — 자리표시자만.
```

**규약**: 실제 키·실제 값은 절대 적지 않는다. 자리표시자만 쓴다.

### 3) CI 구조 — 어디에 붙여야 하는가

`.github/workflows/ci.yml` 의 `syntax-check` job 에는 이 저장소가 명시한 설계 결정이 주석으로 박혀 있다:

```
  syntax-check:
    name: Syntax Check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # CI-GATE-DECOUPLE-2026-07-25 (Sprint QQQQQQ, improve 감사 CONFIRMED — 실측으로 발동 확인):
    #   기존 `needs: install-audit` 때문에 **npm audit 실패 하나가 모든 품질 검증을 꺼버렸다**.
    #   ...
    #   코드 품질 게이트는 그와 독립적으로 항상 돌아야 한다.
```

즉 이 저장소는 **"게이트를 서로 죽이지 않게 분리"** 하는 관례를 갖고 있다. 새 스텝도 그 관례를
따라야 한다 — 이 스텝이 실패해서 문법 검사·테스트가 안 도는 일이 있으면 안 된다.

같은 파일에 이미 **비차단 스텝의 선례**가 있다(2026-08-16 추가된 dev 트리 audit 가시성 스텝).
`npm audit --audit-level=critical || true` 형태로, 로그에는 남기되 job 을 실패시키지 않는다.
이번 스텝도 **같은 형태**로 만든다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 백엔드 테스트 | `cd backend && npm test` | exit 0, 72 pass (이 계획은 런타임 코드 무변경이라 그대로여야 함) |
| 보안 가드 | `node scripts/security-regression-check.js` | `위반 0건` |
| 의존성 동기화 | `node scripts/check-deps-sync.js` | `deps-sync OK` |
| 드리프트 재현 | 아래 Step 2 의 스크립트 | 추가 전 1건 이상, 추가 후 0건 |

## Scope

**In scope** (이 파일들만 수정):
- `backend/.env.example`
- `scripts/check-env-example.js` (신규 생성)
- `.github/workflows/ci.yml` (스텝 1개 추가)
- `plans/README.md` (상태 행)

**Out of scope** (관련 있어 보여도 건드리지 마라):
- `backend/server.js` — 이 계획은 **문서/CI 만** 고친다. 런타임 코드는 정상이다.
- `backend/.env` 또는 실제 환경변수 설정 — 존재하더라도 열지도 수정하지도 마라.
- 다른 CI job(`install-audit`, `lint`, `secret-scan`) — 건드리면 게이트 분리 원칙이 깨진다.

## Git workflow

- 브랜치: `advisor/029-env-example-sync-guard`
- 커밋 메시지 스타일(이 저장소 관례, `git log` 실측):
  `fix(dx): <한글 설명>` 형태. 본문에 [근본 원인] [Fix 내용] [회귀 위험] 을 적는다.
- **push 하지 마라. PR 도 열지 마라.** 운영자가 별도로 지시한다.

## Steps

### Step 1: 누락된 변수를 규약대로 추가

`backend/.env.example` **맨 끝**에 새 SYNC 블록을 추가한다. 기존 블록을 수정하지 말고 새로 만든다.

```
# ── ENV-EXAMPLE-SYNC-2026-08-17 (Plan 029): 코드 참조 env 전수 대조로 재발 누락분 추가.
#    전부 optional(미설정 시 graceful degrade). 실키·실값 기재 금지 — 자리표시자만.
# 특약 분석(/api/clause) 일일 한도 — 미설정 시 3. server.js 가 참조.
DAILY_CLAUSE_LIMIT=
```

**Verify**: `grep -c DAILY_CLAUSE_LIMIT backend/.env.example` → `1`

### Step 2: 드리프트 검사 스크립트 작성

`scripts/check-env-example.js` 를 새로 만든다. 하는 일은 하나다 —
**`backend/` 코드가 읽는 `process.env.X` 이름을 모아 `.env.example` 과 대조**하고, 빠진 것을 출력한다.

구현 요구사항:

- `backend/**/*.js` 를 읽어 `process.env.<NAME>` 패턴에서 `NAME` 을 수집한다.
  `node_modules` 는 제외한다.
- `backend/.env.example` 에서 `^\s*([A-Z0-9_]+)\s*=` 로 선언된 이름을 수집한다.
- **코드에 있는데 example 에 없는 것**만 출력한다(그 반대는 무시 — 예시에만 있는 건 해가 없다).
- 아래 이름은 **플랫폼 제공 변수**라 제외한다(이 목록을 코드에 상수로 두고 주석으로 이유를 적어라):
  `NODE_ENV`, `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`, `PORT`, `TZ`, `CI`
- **값은 절대 출력하지 마라.** 변수 **이름만** 출력한다. `.env`(실파일)는 읽지 마라.
- 종료 코드: 누락이 있으면 `1`, 없으면 `0`. 사람이 읽을 요약을 stdout 에 남긴다.

이 저장소의 기존 스크립트 스타일을 따라라 — 예시로 `scripts/check-deps-sync.js` 를 읽고
같은 톤(한글 주석으로 "왜 이 게이트가 존재하는가"를 맨 위에 적는 방식)을 맞춰라.

**Verify (중요 — 두 번 돌린다)**:
1. Step 1 을 **되돌린 상태**를 가정한 검증: `git stash` 로 Step 1 을 잠시 치운 뒤
   `node scripts/check-env-example.js` → **exit 1 이고 출력에 `DAILY_CLAUSE_LIMIT` 이 있어야 한다.**
   (스크립트가 실제로 드리프트를 잡는다는 증거. 확인 후 `git stash pop`)
2. Step 1 을 되살린 상태: `node scripts/check-env-example.js` → **exit 0**

두 결과가 이렇게 나오지 않으면 스크립트가 틀린 것이다. STOP 하고 보고하라.

### Step 3: CI 에 비차단 스텝 추가

`.github/workflows/ci.yml` 의 **`syntax-check` job 안에**, 기존 스텝들 뒤에 스텝 하나를 추가한다.

```yaml
      # ── .env.example 동기화 가시성 (비차단) — Plan 029 ────────────────────────
      # [왜] 코드가 읽는 env 가 .env.example 에 안 적히는 누락이 세 번 재발했다.
      #   graceful-degrade 설계라 부팅이 안 깨져서 조용히 넘어간다.
      # [왜 비차단인가] 이 저장소는 "게이트가 서로를 죽이지 않게 분리"하는 원칙이 있다
      #   (위 CI-GATE-DECOUPLE 주석). 문서 누락으로 문법 검사·테스트를 막지 않는다.
      # ⚠ 이 스텝은 절대 실패하면 안 된다. 차단 게이트로 승격하려면 별도 결정이 필요하다.
      - name: .env.example 동기화 확인 (가시성 전용, 비차단)
        run: node scripts/check-env-example.js || true
```

**들여쓰기 주의**: 같은 job 안의 다른 `- name:` 스텝과 **정확히 같은 열**에 맞춰라(현재 6칸).

**Verify**:
- `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); const i=y.split('\n').findIndex(l=>l.includes('env.example 동기화 확인')); console.log('행:',i+1, '들여쓰기:', y.split('\n')[i].match(/^\s*/)[0].length)"`
  → 들여쓰기가 `6` 이어야 한다.
- 새 스텝이 `syntax-check` job 안에 있는지 육안 확인(다음 job 헤더보다 위여야 한다).

### Step 4: 전체 게이트 재확인

**Verify** (전부 통과해야 한다):
- `cd backend && npm test` → 72 pass, 0 fail
- `node scripts/security-regression-check.js` → 위반 0건
- `node scripts/check-deps-sync.js` → OK
- `node scripts/check-env-example.js` → exit 0

## Test plan

- **새 단위 테스트는 만들지 않는다.** 이 계획의 산출물은 CI 스크립트 자체이고, 그 스크립트의
  검증은 Step 2 의 "되돌린 상태에서 잡히는가 / 고친 상태에서 통과하는가" 2회 실행으로 한다
  (이 저장소가 회귀 주입으로 테스트를 검증하는 방식과 같은 정신이다).
- 기존 테스트(`backend/test/characterization.test.js`, 72개)는 **한 개도 깨지면 안 된다** —
  이 계획은 런타임 코드를 건드리지 않으므로 숫자가 변하면 무언가 잘못된 것이다.

## Done criteria

전부 참이어야 한다:

- [ ] `grep -c DAILY_CLAUSE_LIMIT backend/.env.example` → `1`
- [ ] `scripts/check-env-example.js` 가 존재하고, Step 2 의 2회 검증이 기대대로 나왔다
- [ ] `node scripts/check-env-example.js` → exit 0
- [ ] `.github/workflows/ci.yml` 에 `|| true` 가 붙은 비차단 스텝이 `syntax-check` job 안에 있다
- [ ] `cd backend && npm test` → **72 pass, 0 fail** (증감 없음)
- [ ] `node scripts/security-regression-check.js` → 위반 0건
- [ ] `git status` 상 In scope 외 파일이 변경되지 않았다
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

즉시 멈추고 보고하라:

- `backend/.env.example` 안에 **자리표시자가 아닌 실제 값처럼 보이는 문자열**이 이미 들어 있다.
  → 값을 인용하지 말고 "몇 번째 줄에 실값 의심 항목이 있다" 는 사실만 보고하라(계획 005 와 같은 규칙).
- Step 2 의 검증 1(되돌린 상태)에서 스크립트가 `DAILY_CLAUSE_LIMIT` 을 **못 잡는다**.
  → 스크립트가 무의미하다는 뜻이다. 억지로 통과시키지 마라.
- 검사 스크립트가 **10개를 넘는 누락**을 보고한다. → 이 계획이 가정한 "1건 누락" 과 상황이 다르다.
  전부 채우려 하지 말고 목록만 보고하라(대량 누락은 별도 판단이 필요하다).
- 테스트 수가 72 가 아니다. → 다른 작업과 충돌했을 수 있다.

## Maintenance notes

- 앞으로 `process.env.X` 를 새로 읽는 코드를 추가하면 이 스텝이 CI 로그에서 알려준다.
  **비차단이므로 아무도 안 보면 소용없다** — 리뷰 시 이 스텝 로그를 확인하는 습관이 전제다.
  누락이 계속 반복되면 차단 게이트로 승격하는 것을 검토하라(그건 별도 결정이다).
- 제외 목록(`NODE_ENV` 등)은 플랫폼 변수라 뺀 것이다. 새 플랫폼 변수가 생기면 목록에 추가하되
  **왜 제외하는지 주석으로 남겨라** — 근거 없는 제외가 쌓이면 게이트가 무력해진다.
- 리뷰 포인트: `.env.example` 에 **실값이 들어가지 않았는지**(자리표시자만인지) 항상 확인할 것.
