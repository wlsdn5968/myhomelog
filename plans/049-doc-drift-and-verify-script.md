# Plan 049: 사실과 다른 문서를 고치고, 게이트를 한 명령으로 돌 수 있게 한다

> **실행자 안내**: 끝까지 읽고 각 단계의 검증 명령을 실제로 돌려라. "STOP 조건" 이면 멈추고 보고하라.
>
> **드리프트 점검(먼저)**: `git diff --stat 3d30ee2..HEAD -- README.md CLAUDE.md package.json scripts/check-env-example.js`

## Status

- **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Depends on**: 없음
- **Category**: docs / dx · **Planned at**: commit `3d30ee2`, 2026-09-06

## 왜 중요한가

이 저장소는 **에이전트가 문서를 읽고 작업한다.** 문서가 틀리면 실행자가 없는 파일을 찾고,
삭제된 엔드포인트를 되살리려 하고, 게이트를 통과했다고 착각한다.
실제로 이 저장소에는 **부활 방지 테스트 3개**가 심겨 있는데, `CLAUDE.md` 는 그 삭제된 모듈들을
"핵심 파일 위치" 로 안내하고 있다 — **문서와 테스트가 정반대를 말한다.**

그리고 `CLAUDE.md` 의 검증 체크리스트는 **실제 차단 게이트 5개 중 1개**만 담고 있으며,
루트에는 전체를 한 번에 도는 명령이 없다(`npm test` 는 루트에서 실패한다).

## 현재 상태 (전부 2026-09-06 실측)

### README.md

| 위치 | 적힌 것 | 사실 |
|---|---|---|
| `:129` | "cron **10개**(라우트 기준)" + 10개 나열 | `vercel.json` **14항목 / 12 distinct 라우트**. 누락: `warm-interest` · `warm-rent` |
| `:210` | 같은 10개 나열 + "10개 라우트" | 위와 동일 |
| `:169` | `GET /api/properties/info` | **삭제됨** |
| `:177` | `GET /api/regulations/ltv` | **삭제됨** |
| `:180` | `POST /api/analysis/total-cost` | **삭제됨** |
| `:148` | "출처는 `backend/server.js` (line 177~216)" | 줄번호가 낡았다 — **직접 세어 확인하라** |
| 전체 | 공개 SSR 표면 언급 **0건** | `/apt` · `/region` · `/briefing` · `/sitemap.xml` · `/api/og` 가 지금 제품의 정면이다 |
| 배포 env 절 | 12개 나열 | `backend/.env.example` 선언 **59개**. 빠진 것이 결제·Sentry·웹푸시·카카오 |

### CLAUDE.md

| 위치 | 적힌 것 | 사실 |
|---|---|---|
| `:78` | "2026-08-29 실측 **112 pass**" | **241 pass**(오늘 실측). 112 → 190 → 223 → 241 로 **세 번 낡았다** |
| `:97` | 데이터 출처 표에 `schoolClusters static` | `schoolClusterService.js`·`data/schoolClusters.js` **삭제됨**(부활 방지 테스트 존재) |
| `:99` | **볼드로 강조**된 `/api/legal/` | 라우터·서비스 **삭제됨** |
| `:138` | "backend services: … `schoolClusterService` / `legalCorpusService` 등" | **둘 다 없다** |
| `:112` | "진행 중 / 운영자 결정 대기 (2026-07-15 갱신)" | 그 사이 수백 커밋 |
| `:154` | "마지막 갱신: 2026-08-28" | 그 사이 이번 라운드 |
| `:77-85` | 검증 체크리스트 | 실제 차단 게이트 5개 중 **1개만** 담고 있다(아래) |

### 실제 CI 차단 게이트 5개 (`.github/workflows/ci.yml`)

`node --check` 문법 · `scripts/check-deps-sync.js` · `scripts/check-env-example.js`(**차단**) ·
`backend npm test` · `npm run lint` · `scripts/security-regression-check.js` · clause XSS raw-pattern.
⚠ `ci.yml` 주석은 **린트가 매달린 참조를 잡는 유일한 게이트**라고 명시한다 — 그것이 체크리스트에서 빠져 있다.

### `scripts/check-env-example.js:19-21` — 스크립트가 자기 동작을 반대로 설명한다

```
 * ⚠ 현재 CI 에서는 `|| true` 로 **비차단** 실행한다 — …
 *   차단 게이트로의 승격은 별도 결정 사항이다.
```

`.github/workflows/ci.yml` 에는 `ENV-GATE-2026-09-05` 로 **차단 승격**돼 있고 `|| true` 가 없다.

### 루트 `package.json` scripts (실측)

```json
{"lint":"node scripts/extract-inline-js.js && eslint backend scripts api .lint-tmp","lint:be":"eslint backend scripts api"}
```
`test` 도 `verify` 도 없다.

## 필요한 명령

| 목적 | 명령 | 기대 |
|---|---|---|
| 테스트 | `cd backend && npm test` | `fail 0` (기준 **241 pass**) |
| 린트 | `npm run lint` | exit 0 |
| JSON | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` | 출력 없음 |

## 범위

**In scope**: `README.md` · `CLAUDE.md` · `scripts/check-env-example.js`(주석만) ·
`package.json`(루트, scripts 추가만) · `backend/test/characterization.test.js`

**Out of scope**:
- `.github/workflows/ci.yml` — CI 는 옳다. 문서를 CI 에 맞추는 것이지 반대가 아니다.
- `backend/.env.example` — 선언은 옳다.
- 코드 로직 일체.
- `package.json` 의 `dependencies`·`devDependencies` — **건드리지 마라**(`check-deps-sync.js` 게이트가 있다).
- CLAUDE.md 의 **절대 룰 3개**(`:9-22`) — 운영자가 정한 것이다. 손대지 마라.

## 단계

### Step 1: 루트에 `verify` 스크립트를 추가한다

`package.json` 의 `scripts` 에 게이트 5종을 한 번에 도는 명령을 추가한다.
⚠ **셸 호환**: 이 저장소는 Windows 에서 개발하고 CI 는 ubuntu 다. `cd backend && npm test` 를
포함해야 하는데 `&&` 는 npm scripts 에서 이식성이 있다(npm 이 sh 를 쓴다). 그래도
**실제로 실행해 확인하라** — 안 되면 `npm --prefix backend test` 형태를 쓰라.

권장 형태(정확한 내용은 실행 확인 후 확정):
```
"verify": "npm run lint && node scripts/check-deps-sync.js && node scripts/check-env-example.js && node scripts/security-regression-check.js && npm --prefix backend test"
```

**검증**: `npm run verify` → exit 0, 다섯 게이트가 **전부** 출력에 보인다.
⚠ 하나라도 건너뛰면 안 된다. 출력 원문을 보고에 넣어라.

### Step 2: `CLAUDE.md` 검증 체크리스트를 그 명령 하나로 바꾼다

`:77-85` 의 체크리스트를 다음 구조로 재작성한다:
- **로컬**: `npm run verify` 한 줄 (개별 게이트를 나열하지 말 것 — 게이트가 늘면 두 곳을 고쳐야 한다)
- **배포 후**: `/api/health` deploy id 대조 · Sentry 신규 확인 (이건 verify 로 못 한다)

⚠ **테스트 개수를 적지 마라.** "112 pass" 가 세 번 낡았다. 숫자를 적는 한 반드시 다시 낡는다.

### Step 3: `CLAUDE.md` 의 사실과 다른 곳 4군데를 고친다

`:97`(schoolClusters) · `:99`(`/api/legal`) · `:138`(삭제된 서비스 2개) · `:112`·`:154`(날짜).
삭제된 것은 **지우거나, 지웠다는 사실을 적어라**(부활 방지 테스트가 있다는 점을 함께 적으면
다음 실행자가 되살리려 하지 않는다).

**검증**: `grep -c "schoolClusterService\|legalCorpusService\|/api/legal/" CLAUDE.md` → 삭제됨을
설명하는 맥락 외에는 0

### Step 4: `README.md` 를 고친다

1. 죽은 엔드포인트 3행 삭제(`:169`·`:177`·`:180`)
2. cron 개수·목록 갱신 — **직접 `vercel.json` 을 파싱해 세어라**(실측 14항목/12라우트).
   ⚠ 숫자를 적을 거면 계약 테스트로 묶어라(Step 6). 아니면 "목록은 `vercel.json` 이 원본" 이라고만 적어라.
3. `:148` 의 줄번호 — **범위 숫자를 쓰지 말고** `backend/server.js` 의 마운트 구역을 가리키는
   방식으로 바꿔라(줄번호는 반드시 다시 낡는다).
4. **공개 페이지 절 신설** — `/apt/:seq` · `/region/:lawdCd` · `/region` · `/briefing` ·
   `/sitemap.xml` · `/api/og/*` · `/share`. 각각 한 줄 설명.
   ⚠ 실제 마운트를 `backend/server.js` 에서 **읽고** 적어라. 추측 금지.
5. 배포 env 목록 — 12개 나열을 지우고 "`backend/.env.example` 이 유일한 목록" 으로 바꾸되
   카테고리 요약(필수 / 결제 / 관측 / 알림 / 선택)만 남겨라. **사본을 고치지 말고 없애라.**

### Step 5: `check-env-example.js` 주석 정정

`:19-21` 의 "비차단" 서술을 **차단 게이트**(2026-09-05 승격, `ci.yml` 의 `ENV-GATE-2026-09-05`)로 정정.
스크립트 로직은 건드리지 마라.

**검증**: `grep -c "비차단" scripts/check-env-example.js` → `0`

### Step 6: 계약 테스트

`backend/test/characterization.test.js` 끝에 테스트 1개를 추가한다. **문서가 다시 낡는 것을 막는다**:
1. `README.md` 에 삭제된 엔드포인트 3개가 **없다**
2. README 가 cron 개수를 숫자로 적었다면 그 수가 `vercel.json` 의 distinct 라우트 수와 **같다**
   (숫자를 안 적기로 했으면 이 단언은 생략하고 그 이유를 주석에 남겨라)
3. `CLAUDE.md` 에 삭제된 서비스·라우터 이름이 **살아 있는 것처럼** 나오지 않는다
4. 루트 `package.json` 에 `verify` 스크립트가 있고, 그 안에 게이트 5종이 **전부** 들어 있다

⚠ 검사 전 줄 주석을 제거하라 — 이 저장소는 소스 문자열 검사가 자기 주석을 잡는 자충수를 6회 겪었다.
⚠ 테스트 자신이 금지 문자열을 담게 되므로, 필요하면 문자 조립으로 회피하라.

**검증**: `cd backend && npm test` → `fail 0`, `pass` ≥ 242

### Step 7: 회귀 주입

⚠ 주입 전 `git status --short` 가 비어 있어야 한다.
`README.md` 에 죽은 엔드포인트 한 줄을 되살린 뒤 `npm test` 가 **fail** 하는지 확인 → 원복 → `fail 0`.
안 잡히면 **STOP 조건**.

### Step 8: 전체 게이트 — 이번엔 `npm run verify` 한 번으로

## 완료 기준

- [ ] `npm run verify` exit 0, 다섯 게이트가 전부 출력에 보인다
- [ ] `grep -c "properties/info\|regulations/ltv\|analysis/total-cost" README.md` → `0`
- [ ] README 에 공개 페이지 절이 있고 `/apt`·`/region`·`/briefing`·`/sitemap.xml`·`/api/og` 가 나온다
- [ ] `grep -c "비차단" scripts/check-env-example.js` → `0`
- [ ] `CLAUDE.md` 에 테스트 **개수 숫자**가 없다
- [ ] `cd backend && npm test` `fail 0`, `pass` ≥ 242
- [ ] Step 7 의 주입에서 fail 확인
- [ ] `git status --short` 에 In scope 밖 파일이 없다(특히 `ci.yml`·`.env.example`)

## STOP 조건

- `npm run verify` 가 셸 이식성 문제로 안 돈다 — 어떤 형태를 시도했고 어떤 오류가 났는지 보고하라.
- README 의 마운트 목록을 `server.js` 에서 읽었는데 이 계획의 서술과 크게 다르다.
- `CLAUDE.md` 의 절대 룰 3개를 건드려야 할 것 같다 — 절대 금지.
- Step 7 의 주입이 잡히지 않는다.
- `package.json` 의 의존성을 건드려야 할 것 같다.

## 유지보수 메모

- **숫자를 문서에 적지 않는 것이 이 계획의 핵심 교훈이다.** "112 pass" 는 세 번 낡았다.
  꼭 적어야 한다면 계약 테스트로 묶어라 — 그러면 낡는 순간 CI 가 알려준다.
- **게이트가 추가되면 `package.json` 의 `verify` 만 고치면 된다** — `CLAUDE.md` 는 그 명령을
  가리키기만 하므로 두 곳을 고칠 필요가 없다. 이 구조를 깨지 마라.
- **리뷰에서 볼 것**: `ci.yml` 이 안 바뀌었는지(문서를 CI 에 맞추는 것이지 반대가 아니다).
