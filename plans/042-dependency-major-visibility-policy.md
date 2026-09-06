# Plan 042: 메이저 업그레이드가 "보이지 않는 기본값" 이 되지 않게 한다 (express 4 / qs moderate 5건)

> **실행자 안내**: 이 계획을 처음부터 끝까지 읽고, 각 단계의 검증 명령을 실제로 돌려
> 기대 결과를 확인한 뒤 다음 단계로 가라. "STOP 조건" 에 해당하면 멈추고 보고하라.
> 완료하면 `plans/README.md` 의 이 계획 행 Status 를 갱신하라.
>
> ⚠ **이 계획은 express 4 → 5 마이그레이션이 아니다.** 코드는 한 줄도 바꾸지 않는다.
> 설정과 문서만 바꾼다. 마이그레이션을 시작하면 그것은 STOP 조건이다.
>
> **드리프트 점검(가장 먼저)**:
> `git diff --stat e7dc1c6..HEAD -- .github/dependabot.yml .github/workflows/ci.yml package.json backend/package.json`
> 비어 있지 않으면 아래 "현재 상태" 와 대조하라.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 없음
- **Category**: migration (정책 결정 · 코드 무변경)
- **Planned at**: commit `e7dc1c6`, 2026-09-06
- **운영자 판정**: 2026-09-06 감사에서 "express 정책을 결정한다" 로 선택됨

## 왜 중요한가

`npm audit --omit=dev` 실측(2026-09-06, 루트·backend 동일):

```
qs  2.2.5 - 6.15.3
  qs array-limit bypass via bracket-key comma parsing
  qs: Denial of Service via Attacker Controlled isBuffer
express  4.22.2
  Depends on vulnerable versions of body-parser
  Depends on vulnerable versions of qs
5 moderate severity vulnerabilities
```

심각도는 **moderate** 이고 npm 이 제시하는 유일한 해결은 `express@5.2.1`(breaking) 이다.
`qs` 는 모든 쿼리스트링을, `body-parser` 는 모든 `express.json()` 요청을 파싱하므로
도달 경로는 전면적이다.

문제는 취약점 자체가 아니라 **아무도 통보받지 않는 구조**다:

1. `.github/workflows/ci.yml:35`·`:43` 이 `--audit-level=high` 라 moderate 는 CI 를 붉히지 않는다.
   (이것은 **의도된 정책**이다 — CI 주석이 근거를 적어 뒀다. 바꾸자는 게 아니다.)
2. `.github/dependabot.yml` 의 `ignore: dependency-name "*" / update-types
   ["version-update:semver-major"]` 때문에 **express 5 PR 이 영구히 생성되지 않는다.**

즉 "지금은 안 올린다" 가 **결정**이 아니라 **보이지 않는 기본값**이다. 이 저장소는
같은 실패 모드를 이미 겪었다 — `gitleaks-action@v2` 에 SHA 를 고정했다가, v2 가 한 달 뒤
Node 20 제거로 죽는다는 사실을 **나중에** 발견했다(`plans/README.md` 의
"v2 를 SHA 로 고정한 것이 왜 위험했나" 절). 교훈은 그대로 적혀 있다:
**"고정 대상은 '지금 도는 것' 이 아니라 '앞으로도 도는 것' 이다."**

이 계획은 마이그레이션을 하지 않는다. **결정을 보이게** 만든다.

## 현재 상태

### `.github/dependabot.yml` (npm 블록)

```yaml
  - package-ecosystem: "npm"
    directories:
      - "/"
      - "/backend"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "Asia/Seoul"
    open-pull-requests-limit: 5
    commit-message:
      prefix: "chore(deps)"
      include: "scope"
    groups:
      # minor/patch 는 한 PR 로 묶어 리뷰 부담 최소화
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
    ignore:
      # 메이저 업그레이드는 따로 PR 받아 수동 검토
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
```

⚠ 주석은 "따로 PR 받아 수동 검토" 라고 적혀 있는데, `ignore` 는 **PR 을 아예 만들지 않는다.**
주석과 동작이 어긋난다 — 이것도 함께 고칠 대상이다.

### `.github/workflows/ci.yml:33-45` (요지)

```yaml
      - name: npm audit (high+ only, production)
        # 개발 의존성 취약점은 별도 정책 — 프로덕션 빌드 반영분만 게이트
        run: npm audit --omit=dev --audit-level=high
```

### express 5 의 실제 blast radius (참고 수치)

`backend/routes/` 32개 파일 + `backend/server.js` + `api/` 진입점.
express 5 는 라우터 경로 문법·`res.redirect`·`req.query` 동작이 바뀐다.
**이 계획은 그 마이그레이션을 하지 않는다** — 수치는 "왜 지금 안 하는가" 의 근거로만 쓴다.

### 이 저장소의 관례

- 결정과 그 근거를 **주석·문서에 남긴다.** `ci.yml` 의 `CI-GATE-DECOUPLE-2026-07-25`,
  `ENV-GATE-2026-09-05` 처럼 마커 + 근거 + 실측을 함께 적는다.
- ⚠ `master` 에 merge commit 을 만들지 않는다. dependabot PR 은 cherry-pick 으로 처리한다.
- ⚠ `minor-and-patch` 그룹이 **0.x 의 큰 점프를 minor 로 묶는다**(satori 0.10 → 0.33 실제 사례).

## 필요한 명령

| 목적 | 명령 | 성공 시 기대 |
|---|---|---|
| dependabot YAML 검증 | `node -e "require('js-yaml')"` 대신 → 아래 Step 1 참조 | — |
| audit 재실측 | `npm audit --omit=dev` | moderate 5 (현재값) |
| CI YAML 문법 | GitHub 이 검증한다 — 로컬에서는 들여쓰기 육안 확인 | — |
| 테스트 | `cd backend && npm test` | `pass 223` 이상, `fail 0` |

⚠ 이 레포에는 YAML 파서 의존성이 없다. **새로 설치하지 마라**(`check-deps-sync.js` 게이트가
있고, 이 계획은 의존성을 추가할 이유가 없다). YAML 은 육안 + GitHub 검증으로 확인한다.

## 범위

**In scope**:
- `.github/dependabot.yml` — express 만 major 예외로 열기 + 주석 정정
- `plans/README.md` — 결정과 재검토 시점 기록
- (선택) `README.md` 또는 `CLAUDE.md` — 의존성 정책 한 줄

**Out of scope** (강하게):
- **express 4 → 5 마이그레이션.** 코드·package.json 을 바꾸지 마라.
- `npm audit fix` / `npm audit fix --force` **실행 금지** — lockfile 을 바꾸고 breaking 을 끌어온다.
- `ci.yml` 의 `--audit-level=high` 를 `moderate` 로 낮추는 것 — **의도된 정책**이고,
  낮추면 실익 없이 릴리스가 멈춘다(CI 주석이 그 근거를 적어 뒀다).
- 다른 패키지의 major 예외 — express 하나만 연다. 전부 열면 dependabot PR 이 폭주해
  `open-pull-requests-limit: 5` 를 먹고 minor/patch 그룹이 밀린다.
- `drizzle-orm` 관련 어떤 변경도 — 별건이고 이미 기각됐다.

## Git 작업 방식

- 브랜치: `chore/dependabot-express-major-visibility`
- 커밋: `chore(deps): express major 를 dependabot 예외로 열어 결정이 보이게 한다 (마이그레이션 아님)`
  body 에 audit 실측값과 "왜 지금 올리지 않는가" 를 적어라.
- ⚠ push·PR 은 운영자 승인 후에만.

## 단계

### Step 1: dependabot 에 express major 예외를 연다

`.github/dependabot.yml` 의 npm 블록에서 `ignore` 를 수정한다.
`ignore` 는 "이 조합을 무시" 이므로, express 만 제외하려면 와일드카드에서 express 를 빼야 한다.
dependabot 은 `dependency-name` 에 정확한 이름을 쓰면 **더 구체적인 규칙이 우선**하지 않으므로,
**와일드카드를 유지한 채 express 만 허용할 수는 없다.** 두 가지 방법 중 하나를 고르라:

- **(a) 권장** — `allow` 를 쓰지 말고, `ignore` 목록을 "express 를 제외한 나머지" 로 만들 수는
  없으므로, `ignore` 의 와일드카드를 그대로 두고 **`groups` 에 express major 를 별도 그룹으로
  두는 방식은 동작하지 않는다.** 실제로 동작하는 방법은 아래 (b) 다.
- **(b) 채택** — npm 블록을 **하나 더** 추가한다. 같은 `directories` 를 대상으로 하되
  `allow: [{ dependency-name: "express" }]` 만 두고 `ignore` 를 두지 않는다.
  그러면 express 의 major PR 만 별도로 올라온다.

⚠ **이 조합이 실제로 동작하는지는 확신할 수 없다.** dependabot 이 같은 ecosystem·같은
directory 에 대해 블록 2개를 허용하는지, 그리고 두 블록이 중복 PR 을 만들지 않는지는
**공식 문서로 확인한 뒤** 진행하라. 이 저장소는 같은 종류의 불확실성을 실험 커밋으로
관찰한 이력이 있다(`.github/dependabot.yml` 상단 `DEPENDABOT-EXP-2026-05-10` 주석 — 목적·관찰
방법·revert 계획을 함께 적었다). **그 형식을 그대로 따라 쓰라.**

블록에 반드시 남길 주석:

```yaml
    # DEPS-MAJOR-VISIBILITY-2026-09-06:
    # [왜] 위 블록의 ignore("*" major)가 express 5 PR 을 **영구히** 만들지 않는다. 그런데
    #   npm audit --omit=dev 실측(2026-09-06)에서 qs/body-parser moderate 5건의 유일한 해결이
    #   express@5(breaking) 다. CI 게이트는 high 부터라(의도된 정책) 이 항목은 아무 신호도 남기지 않는다.
    #   즉 "지금은 안 올린다" 가 결정이 아니라 **보이지 않는 기본값**이었다.
    # [무엇을 하는가] 마이그레이션이 아니다. express major PR 이 **보이게만** 한다.
    #   PR 은 머지하지 않고, 리뷰 시점에 blast radius(routes 32파일 + server.js)를 다시 판단한다.
    # [관찰] 다음 weekly tick(월 09:00 KST) 에 express PR 이 1개만 생성되는지 확인.
    #   중복 PR 이 생기거나 minor-and-patch 그룹이 밀리면 이 블록을 revert 한다(yml 1파일이라 안전).
```

그리고 기존 `ignore` 주석의 거짓말을 고친다:

```yaml
    ignore:
      # ⚠ ignore 는 PR 을 **아예 만들지 않는다**(종전 주석의 "따로 PR 받아 수동 검토"는 사실이 아니었다).
      #   메이저가 필요해지면 위 DEPS-MAJOR-VISIBILITY 블록처럼 그 패키지만 예외로 연다.
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
```

**검증**: YAML 들여쓰기를 육안으로 확인하고, GitHub 에 push 한 뒤
Insights → Dependency graph → Dependabot 에서 설정 파싱 오류가 없는지 본다.
⚠ push 는 **운영자 승인 후**다.

### Step 2: 결정을 문서에 남긴다

`plans/README.md` 의 "Findings considered and rejected" 아래(또는 새 절)에 다음을 적는다:

- **결정**: express 4 를 유지한다. 근거 — moderate 5건, 유일한 해결이 breaking major,
  blast radius `backend/routes/` 32파일 + `server.js`, 사용자 0 상태에서 전면 마이그레이션의
  기대 이득이 위험보다 작다.
- **수용한 위험**: `qs` array-limit bypass · `qs` isBuffer DoS(둘 다 moderate).
- **재검토 시점**: (a) 심각도가 high 이상으로 상향되거나 (b) express 4 가 EOL 을 공지하거나
  (c) 결제를 오픈해 실사용자가 생겼을 때 — **셋 중 먼저 오는 것.**
- **관측 방법**: `npm audit --omit=dev` 를 릴리스 전에 육안 확인. CI 의 dev-트리 가시성
  스텝(`ci.yml` 의 비차단 audit)과 같은 성격이다.

⚠ 이 문서 항목이 이 계획의 **실제 산출물**이다. 설정 변경이 실패하더라도 이 기록은 남겨라.

**검증**: `grep -c "express" plans/README.md` ≥ `1`

### Step 3: 아무것도 깨지지 않았는지 확인한다

```
cd backend && npm test
npm run lint
node scripts/check-deps-sync.js
node scripts/check-env-example.js
node scripts/security-regression-check.js
npm audit --omit=dev --audit-level=high
```

**검증**: 앞의 다섯은 exit 0. 마지막 `npm audit --omit=dev --audit-level=high` 도 exit 0
(high 가 없으므로) — 이 값이 **변하지 않았다는 것**이 이 계획이 아무것도 깨지 않았다는 증거다.

## 테스트 계획

- 코드 변경이 없으므로 새 테스트는 필요 없다.
- 다만 `.github/dependabot.yml` 이 유효한 YAML 인지 계약 테스트로 묶고 싶다면,
  `backend/test/characterization.test.js` 에 "npm 블록의 `ignore` 에 `*` major 가 있고,
  express 예외 블록이 존재한다" 를 **문자열로** 확인하는 테스트 1개를 추가해도 좋다.
  ⚠ 이 저장소에는 YAML 파서가 없다. **새 의존성을 추가하지 마라** — 문자열 검사로 충분하다.
  (설정·배선 계약은 정규식이 옳은 도구인 경우다.)

## 완료 기준

- [ ] `.github/dependabot.yml` 에 `DEPS-MAJOR-VISIBILITY-2026-09-06` 마커가 있다
- [ ] 기존 `ignore` 주석의 "따로 PR 받아 수동 검토" 문장이 정정됐다
- [ ] `plans/README.md` 에 결정·수용 위험·재검토 시점·관측 방법 4가지가 적혀 있다
- [ ] `git status --short` 에 `package.json`·`package-lock.json`·`backend/` 변경이 **없다**
      (= 마이그레이션을 하지 않았다는 증거)
- [ ] `cd backend && npm test` exit 0, `npm run lint` exit 0
- [ ] `npm audit --omit=dev --audit-level=high` exit 0 (변화 없음)
- [ ] `plans/README.md` 의 042 행 Status 갱신

## STOP 조건

- **`package.json` 의 express 버전을 바꾸고 싶어진다** — 이 계획의 범위가 아니다. 멈춰라.
- `npm audit fix` 를 실행하고 싶어진다 — 실행하지 마라. lockfile 이 바뀐다.
- dependabot 이 같은 ecosystem·directory 에 블록 2개를 허용하지 않는다는 것을
  공식 문서에서 확인했다 — 그러면 **설정 변경을 포기하고 Step 2(문서 기록)만 수행**한 뒤
  보고하라. 기록만으로도 이 계획의 목적(결정을 보이게)은 절반 달성된다.
- `npm audit` 결과가 계획서의 실측값(moderate 5)과 다르다 — 상황이 바뀌었으니 보고하라.
  high 이상이 나왔다면 그것은 **다른 계획**이 필요한 상황이다.

## 유지보수 메모

- **이 저장소의 선례**: `gitleaks-action@v2` 를 SHA 로 고정했다가 v2 가 Node 20 제거로
  한 달 뒤 죽는다는 것을 나중에 알았다. 교훈은 `plans/README.md` 에 있다 —
  **고정·유지의 대상은 "지금 도는 것" 이 아니라 "앞으로도 도는 것" 이다.**
  express 4 도 같은 질문을 정기적으로 받아야 한다. Step 2 의 재검토 시점이 그 장치다.
- **리뷰에서 볼 것**: `package-lock.json` 이 안 바뀌었는지. 바뀌었다면 누군가
  `npm audit fix` 를 돌린 것이다.
- **express PR 이 실제로 올라오면**: 머지하지 말고 `gh pr diff` 로 내용을 확인한 뒤,
  이 저장소가 dependabot PR 을 처리해 온 방식(cherry-pick, master 에 merge commit 금지)을 따르라.
  express 5 는 **major 이고 breaking** 이므로 자동 머지 대상이 아니다.
- **의도적으로 미뤄둔 것**: `minor-and-patch` 그룹이 0.x 의 큰 점프를 minor 로 묶는 문제
  (satori 0.10 → 0.33 실제 사례). 지금은 OG 렌더 계약 테스트가 blast radius 를 막고 있어
  긴급하지 않다 — 백로그에 근거와 함께 남아 있다.
