# Plan 072: 메이저 4종 갱신 — helmet 8 · express-rate-limit 8 · pino 10 · dotenv 17 (코드 변경은 dotenv 1줄뿐)

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **전제**: Plan 071(minor/patch)이 **먼저 머지**돼 있어야 한다 — lockfile 충돌 방지. `git log --oneline -5` 에 071 커밋이 있는지 확인.

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: LOW(조사 5 + 반증 5 워크플로로 확인) · **Depends on**: 071
- **Planned at**: 2026-09-06

## 근거 (조사 + 반증 결과 — 공식 changelog·저장소 grep·스크래치패드 실행 재현)
| 패키지 | 판정 | 파괴적 변경 중 이 저장소 영향 | 조치 |
|---|---|---|---|
| **helmet 7.2.0 → 8.3.0** | update_now | 없음. HSTS `max-age` 180일→365일(무해), CSP 지시어 **직렬화 순서** 변경(무해 — 헤더 원문을 단언하는 테스트·스크립트 0건 확인) | 없음 |
| **express-rate-limit 7.5.1 → 8.7.0** | update_now | 없음. 유일한 breaking(IPv6 /56 마스킹)은 **기본 keyGenerator 에만** 적용되는데 이 저장소는 커스텀 `getRateLimitIdentity` 를 쓴다. ⚠ 조사자가 든 "ERR_ERL_KEY_GEN_IPV6 경고 1회" 는 **반증됨(허구)** — 경고 제거 코드를 넣지 마라 | 없음 |
| **pino 9.14.0 → 10.3.1** | update_now | 없음. `thread-stream` 4.2.0 이 `engines >=20` 을 새로 선언하나 런타임은 Node 24. `logger.child(` 실호출 0건 | 없음 |
| **dotenv 16.6.1 → 17.4.2** | update_with_care | **1건**: `quiet` 기본값 true→false. 17.4.2 는 `.env` 가 **없어도**(프로덕션 Vercel) `◇ injected env (0) from .env` + **랜덤 팁(외부 링크 포함)** 을 stdout 에 찍는다 → 콜드스타트마다 Vercel 로그 + Sentry console breadcrumb 오염 | `config({ quiet: true })` |

Node 24 지원: 4종 모두 공식 engines/CI 매트릭스로 확인됨(Node 24 EOL 2028-04-30).

## 요구사항
1. **루트·backend 둘 다** 같은 버전으로(`check-deps-sync` 게이트). `npm install <pkg>@<ver>` 4종. `npm audit fix --force` **금지**. 전체 재설치(`rm -rf node_modules`·`npm ci`) **금지**.
2. dotenv: `require('dotenv').config(` 호출부를 **전수 grep** 해 각각 `{ quiet: true }` 를 준다(호출부가 여러 개면 전부). 다른 옵션(`override` 등)은 건드리지 마라.
3. **갱신 후 헤더 실측**: 로컬로 서버를 띄우기 어려우면 `helmet()` 을 직접 호출하는 스크래치 스크립트로 `Content-Security-Policy`·`Strict-Transport-Security` 값을 찍어 **전/후 비교표**를 보고에 넣어라. 순서만 다르고 지시어 집합이 같아야 한다.
4. `npm run verify` exit 0. 실패하면 **패키지 하나씩 되돌려** 원인을 좁혀라.
5. `npm audit --omit=dev` 전/후 — moderate 5건은 **그대로**여야 정상(전부 express 4·satori 연쇄).

## 범위
**In**: `package.json`×2 · lockfile×2 · dotenv `config()` 호출부(각 1줄)
**Out**: express(Plan 073) · helmet CSP 구성 자체(`server.js` 의 지시어 내용) · rate-limit 옵션 · logger redact 설정

## 완료 기준
- [ ] 4종 루트·backend 동일 버전 · `check-deps-sync` OK
- [ ] dotenv 호출부 전부 `quiet: true`
- [ ] CSP/HSTS 전·후 비교표(지시어 집합 동일)
- [ ] `npm run verify` exit 0 · audit 전/후 보고

## STOP 조건
- 테스트가 실패하고 원인 패키지를 좁혔는데 코드 변경이 필요하다 → 그 패키지만 제외하고 보고.
- CSP 지시어 **집합**이 달라졌다(순서가 아니라) → 멈추고 전/후를 보고하라.

## 참고(업그레이드와 무관, 백로그)
pino 반증자 발견: `logger.js` 의 redact 경로 `*.apiKey` 류는 **한 단계 와일드카드**라 `nested.deep.apiKey`·`arr[0].apiKey` 는 두 버전 모두 그대로 노출된다. 이 계획에서 고치지 마라 — 별건.
