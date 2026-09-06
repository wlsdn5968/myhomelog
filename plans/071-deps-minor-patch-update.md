# Plan 071: minor/patch 의존성 4종 갱신 (메이저 5종은 조사 후 별도 계획)

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **드리프트 점검**: `git diff --stat f29a612..HEAD -- package.json package-lock.json backend/package.json backend/package-lock.json`

## Status
- **Priority**: P2 · **Effort**: XS · **Risk**: LOW · **Depends on**: 없음
- **Category**: dependencies · **Planned at**: `f29a612`, 2026-09-06

## 실측 (`npm outdated`, 2026-09-06, Node 24.14.0 / npm 11.9.0)
| 패키지 | 현재 | Wanted(semver 내) | 비고 |
|---|---|---|---|
| `@anthropic-ai/sdk` | 0.123.0 | 0.123.0 → **0.124.0** 은 Latest | 0.x 라 minor 가 breaking 일 수 있다 — CHANGELOG 확인 후 진행, 의심되면 제외 |
| `@supabase/supabase-js` | 2.112.4 | **2.115.0** | |
| `@upstash/redis` | 1.38.3 | **1.38.4** | |
| `eslint` | 10.9.1 | **10.10.0** | devDependency |

**메이저(별도 계획, 조사 워크플로 진행 중)**: express 4→5 · helmet 7→8 · express-rate-limit 7→8 · pino 9→10 · dotenv 16→17. **이 계획에서 건드리지 마라.**

## 요구사항
1. **루트와 backend 둘 다** 같은 버전으로 올린다 — `scripts/check-deps-sync.js` 가 불일치를 CI 에서 차단한다(실사고 이력).
2. `npm install <pkg>@<ver>` 로 올리고 lockfile 을 함께 커밋한다. `npm audit fix --force` 는 **절대 금지**(express 5 로 강제 승격된다).
3. `@anthropic-ai/sdk` 0.124.0 은 CHANGELOG(GitHub releases)를 읽어 breaking 이 없을 때만. 이 저장소의 사용처: `grep -rn "@anthropic-ai/sdk" backend/ --include=*.js` 로 전수 확인.
4. 갱신 후 `npm audit --omit=dev` 를 다시 돌려 **moderate 5건이 그대로인지**(줄면 어느 것이 왜) 보고하라. 이 5건은 express 4(qs·body-parser)와 satori→fflate 연쇄라 **이 계획으로는 줄지 않는 게 정상**이다 — 줄었다면 원인을 확인하라.
5. `node_modules` 는 이 워크트리에서 **정션**이다 — `npm install` 이 정션 너머 **원본**을 수정한다. 그게 의도다(다음 세션도 같은 버전을 써야 한다). 다만 **`rm -rf node_modules` 류는 절대 금지.**

## 범위
**In**: `package.json` · `package-lock.json` · `backend/package.json` · `backend/package-lock.json`
**Out**: 메이저 5종 · 코드 변경(필요하면 STOP) · `.github/dependabot.yml`

## 완료 기준
- [ ] 4종(또는 sdk 제외 3종) 루트·backend 동일 버전
- [ ] `node scripts/check-deps-sync.js` OK
- [ ] `npm run verify` exit 0 (테스트 전부 통과)
- [ ] `npm audit --omit=dev` 결과 전/후 보고
- [ ] `git diff --stat` 에 In 범위 파일만

## STOP 조건
- 갱신 후 테스트가 실패한다 → 어느 패키지가 원인인지 이분법으로 좁혀 보고하고 멈춰라.
- `@anthropic-ai/sdk` CHANGELOG 에 breaking 이 있다 → 그 패키지만 제외하고 진행, 보고에 명시.
- 코드를 고쳐야 통과한다 → 보고하고 멈춰라.
