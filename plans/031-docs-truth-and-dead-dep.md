# Plan 031: 사실과 다른 문서 3곳을 고치고, 아무도 안 쓰는 의존성 1개를 뺀다

> **Executor instructions**: 단계별로 따르라. 각 단계의 검증 명령을 실행하고 기대 결과를 확인한 뒤
> 다음으로 넘어가라. "STOP conditions" 에 해당하면 **즉시 멈추고 보고**하라.
> 끝나면 `plans/README.md` 의 상태 행을 갱신하라.
>
> **Drift check (가장 먼저)**:
> `git diff --stat 530ca3c..HEAD -- README.md CLAUDE.md package.json`
> 바뀌었으면 아래 "Current state" 인용과 대조하고, 다르면 STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `530ca3c`, 2026-08-17

## Why this matters

문서가 **없는 것보다 틀린 것이 나쁘다.** 지금 세 가지가 사실과 다르다:

1. README 의 로컬 실행 절차를 그대로 따르면 **모든 API 호출이 조용히 404 된다.** 에러 메시지도
   CORS 경고도 안 뜬다 — 그냥 빈 화면이라 원인 파악이 어렵다. 신규 기여자나 이 저장소를 처음 받는
   에이전트가 첫 30분을 여기서 잃는다.
2. `CLAUDE.md` 의 "작업 종료 시 검증 체크리스트" 에 **백엔드 회귀 테스트가 빠져 있다.** 이 저장소는
   취득세·중개보수·LTV 같은 **돈 계산**을 72개 테스트로 지키는데, 체크리스트를 문자 그대로 따르면
   그걸 한 번도 안 돌리고 "검증 완료" 라고 보고할 수 있다.
3. `CLAUDE.md` 의 "마지막 갱신" 날짜가 본문 안의 더 최신 갱신일보다 **앞서 있다** — 파일이 스스로
   모순돼 있어 최신성을 판단할 수 없다.

그리고 `package.json` 에 **아무도 `require` 하지 않는 패키지**가 하나 남아 Vercel 번들에 실린다.

## Current state

### 1) README 로컬 절차가 실제로 동작하지 않는다

`README.md:48-62` 근처:

```
cd backend
npm install
node server.js
# → http://localhost:3001
```

### 4. 프론트엔드 실행

```
cd frontend
python3 -m http.server 3000
# → http://localhost:3000
```

또는 VS Code Live Server / npx serve 사용
```

왜 안 되는가 — 세 가지를 코드로 확인했다:

- `frontend/index.html:2991`: `const DEFAULT_API = '/api';`
  → 프론트는 **상대경로**로만 API 를 부른다. 즉 `:3000` 에서 열면 `:3000/api/...` 로 간다.
- `backend/server.js` 안에 `express.static` / `sendFile` 호출이 **0건**
  → 백엔드는 정적 파일을 서빙하지 않으므로 `:3001` 로 직접 열어도 화면이 안 나온다.
- 저장소 전체에 `vercel dev` 같은 **단일 오리진 로컬 실행법 언급도 0건**.

결과: `:3000` 의 프론트가 `:3000/api/...` 를 호출 → 그 포트에는 API 가 없으니 **404**.
같은 오리진이라 CORS 에러조차 안 뜬다.

### 2) `CLAUDE.md` 체크리스트에 테스트가 없다

`CLAUDE.md:77-83`:

```
### 검증 체크리스트
- backend syntax: `node -c <file>`
- frontend syntax: inline `<script>` 블록 `new Function()` validate
- vercel.json: `JSON.parse()`
- deploy verify: `/api/health` deploy id 매치
- Sentry: `is:unresolved firstSeen:-30m`
- Chrome MCP (UI): 핵심 flow screenshot
```

`cd backend && npm test` 가 없다. 반면 `backend/package.json` 에는 `"test": "node --test"` 가
정의돼 있고, CI 는 이걸 게이트로 돌린다(현재 72개 통과).

### 3) `CLAUDE.md` 날짜 자기모순

- `CLAUDE.md:111` 근처: `## 📊 진행 중 / 운영자 결정 대기 (2026-07-15 갱신)`
- 파일 맨 끝: `마지막 갱신: 2026-05-19 (Sprint RR 후 운영자 프로세스 룰 명시)`

본문 섹션이 2026-07-15 에 갱신됐다고 적혀 있는데 파일 전체의 "마지막 갱신" 은 2026-05-19 다.

### 4) 죽은 의존성

`package.json:19`:

```json
    "postgres": "^3.4.9",
```

- `backend/package.json` 에는 **없다**(루트에만 있다).
- 저장소 전체에서 `require('postgres')` / `from 'postgres'` 호출 **0건**.
- `backend/db/client.js:8-11` 주석이 이미 "Drizzle ORM 인스턴스는 현재 어떤 라우터도 사용하지 않음
  … `drizzle-orm` 패키지 자체는 SSOT 정의용으로만 사용" 이라는 설계 결정을 남겼는데,
  `postgres`(런타임 드라이버) 정리가 누락됐다.

## Commands you will need

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| 백엔드 테스트 | `cd backend && npm test` | 72 pass, 0 fail |
| 의존성 동기화 | `node scripts/check-deps-sync.js` | `deps-sync OK` |
| 보안 가드 | `node scripts/security-regression-check.js` | 위반 0건 |
| 미사용 확인 | `grep -rn "require('postgres')" --include="*.js" . --exclude-dir=node_modules` | 0건 |

## Scope

**In scope**:
- `README.md`
- `CLAUDE.md`
- `package.json`, `package-lock.json` (Step 4 의 `npm install` 결과)
- `plans/README.md` (상태 행)

**Out of scope** (건드리지 마라):
- `frontend/index.html` 의 `DEFAULT_API` — **API 베이스 오버라이드 기능을 새로 만들지 마라.**
  그건 런타임 코드 변경이고 이 계획의 범위가 아니다. 이번엔 **문서가 사실을 말하게** 하는 것까지다.
- `backend/server.js` 에 정적 서빙 추가 — 같은 이유로 금지.
- `backend/package.json` — `postgres` 는 루트에만 있다. 백엔드 매니페스트는 손대지 마라.
- `.env.example` — 다른 계획(029)이 다룬다.

## Git workflow

- 브랜치: `advisor/031-docs-truth-and-dead-dep`
- 커밋 메시지: `docs: <한글 설명>` / 의존성 제거는 `chore(deps): <한글 설명>`
- **push·PR 금지.**

## Steps

### Step 1: README 로컬 절차에 사실을 적는다

`README.md` 의 "### 4. 프론트엔드 실행" 절을 고친다. **절차를 지우지 말고**, 왜 그대로는 안 되는지와
대안을 함께 적어라. 예시 형태(문구는 저장소 톤에 맞게 다듬어도 된다):

```markdown
### 4. 프론트엔드 실행

⚠ **먼저 알아야 할 것**: 프론트는 API 를 상대경로(`/api`)로만 호출하고(`frontend/index.html`),
백엔드는 정적 파일을 서빙하지 않는다(`backend/server.js` 에 `express.static` 없음).
그래서 아래처럼 **다른 포트로 프론트만 띄우면 모든 API 호출이 404 된다** — 같은 오리진이라
CORS 에러조차 뜨지 않고 화면만 비어 보인다.

정적 화면(레이아웃·스타일)만 확인할 때:

```bash
cd frontend
python3 -m http.server 3000
# → http://localhost:3000  (API 연동 기능은 동작하지 않음)
```

API 까지 붙여서 확인하려면 **프론트와 API 가 같은 오리진**이어야 한다.
프로덕션은 Vercel 이 그 역할을 하므로, 로컬에서 전체 동작을 보려면 Vercel 로컬 실행
(`vercel dev`)을 쓰거나, 배포된 프리뷰 URL 에서 확인하는 것이 현재로선 가장 확실하다.
```

**정직성 규칙**: `vercel dev` 가 이 저장소에서 실제로 검증된 적은 없다.
"이 방법이 된다" 고 단정하지 말고 위 예시처럼 **선택지로** 제시하라. 직접 돌려보고 되면 그 사실을
적고, 안 되면 안 된다고 적어라 — **추측을 문서에 넣지 마라.**

**Verify**: `grep -n "404" README.md` → 새로 넣은 경고가 잡힌다.

### Step 2: `CLAUDE.md` 체크리스트에 테스트 추가

`CLAUDE.md:77-83` 의 "검증 체크리스트" 목록에 한 줄 추가한다. **맨 위**에 두는 것을 권한다 —
돈 계산 회귀가 가장 비싼 실패다.

```markdown
- **backend test: `cd backend && npm test`** (돈 계산·규제 판정 회귀 안전망 — 현재 72 pass)
```

**Verify**: `grep -c "npm test" CLAUDE.md` → 1 이상

### Step 3: `CLAUDE.md` 마지막 갱신 날짜 정정

파일 맨 끝의 `마지막 갱신: 2026-05-19 (...)` 를 **실제 최신 갱신일**로 고친다.
이 계획을 실행하는 날짜를 쓰되, 무엇이 갱신됐는지 한 줄로 남겨라. 예:

```
마지막 갱신: 2026-08-17 (검증 체크리스트에 backend test 추가 — Plan 031)
```

**Verify**: `tail -3 CLAUDE.md` → 2026-05-19 가 아닌 최신 날짜

### Step 4: 죽은 의존성 제거

먼저 **미사용을 다시 확인**하라(계획을 믿지 말고 직접):

```bash
grep -rn "require('postgres')\|require(\"postgres\")\|from 'postgres'" --include="*.js" . --exclude-dir=node_modules
```

→ **0건이어야 한다.** 1건이라도 나오면 STOP.

0건이면 `package.json:19` 의 `"postgres": "^3.4.9",` 줄을 지우고:

```bash
npm install
```

**Verify**:
- `grep -c '"postgres"' package.json` → `0`
- `node scripts/check-deps-sync.js` → OK
- `cd backend && npm test` → 72 pass

### Step 5: 전체 게이트

- `cd backend && npm test` → 72 pass, 0 fail
- `node scripts/security-regression-check.js` → 위반 0건
- `node scripts/check-deps-sync.js` → OK

## Test plan

- 새 테스트 없음. 이 계획은 문서 3곳과 매니페스트 1줄이다.
- `postgres` 제거의 회귀 검증은 **기존 72개 테스트 + `check-deps-sync`** 로 한다.
  이 패키지를 실제로 쓰는 코드가 있었다면 테스트나 게이트에서 드러난다.

## Done criteria

- [ ] README 에 "다른 포트로 띄우면 API 가 404 된다" 는 사실이 명시돼 있다
- [ ] README 가 검증되지 않은 방법을 **단정하지 않는다**(선택지로만 제시)
- [ ] `grep -c "npm test" CLAUDE.md` → 1 이상
- [ ] `CLAUDE.md` 마지막 갱신 날짜가 본문 최신 갱신일보다 뒤다
- [ ] `grep -c '"postgres"' package.json` → `0`
- [ ] `require('postgres')` 호출 0건 (재확인)
- [ ] `cd backend && npm test` → **72 pass, 0 fail**
- [ ] `node scripts/check-deps-sync.js` → OK
- [ ] In scope 외 파일 무변경
- [ ] `plans/README.md` 상태 행 갱신

## STOP conditions

- `require('postgres')` 가 **1건이라도** 나온다 → 제거하면 안 된다. 어디서 쓰는지 보고하라.
- `npm install` 후 `package-lock.json` 에 **postgres 외의 패키지가 대량으로 바뀐다**
  → 의도치 않은 업그레이드다. 되돌리고 보고하라.
- `check-deps-sync.js` 가 실패한다 → 이 게이트는 "코드가 쓰는데 루트에 없음" 을 잡는다.
  실패했다면 실제로 쓰이는 패키지를 지운 것이다. 되돌려라.
- README 를 고치다가 "`vercel dev` 로 하면 된다" 를 **확인 없이** 쓰고 싶어진다 → 쓰지 마라.
  돌려보고 되면 적고, 안 해봤으면 "확인되지 않음" 이라고 적어라.

## Maintenance notes

- README 의 로컬 절차는 **프론트가 상대경로를 쓰는 한** 계속 이 제약을 갖는다. 근본 해결은
  프론트에 API 베이스 오버라이드를 넣거나 백엔드가 정적 파일을 서빙하는 것인데, 둘 다 런타임
  변경이라 별도 판단이 필요하다(이 계획은 의도적으로 문서까지만 다뤘다).
- `CLAUDE.md` 는 이 저장소의 **최우선 참조 문서**다. 여기 적힌 체크리스트가 곧 에이전트의 행동이
  되므로, 게이트가 늘면 여기도 같이 갱신해야 한다. 리뷰 포인트: 새 CI 게이트를 추가한 PR 이
  `CLAUDE.md` 도 같이 고쳤는가.
- 리뷰 포인트: 매니페스트에서 패키지를 뺄 때는 `require` grep 0건을 **PR 설명에 붙일 것.**
