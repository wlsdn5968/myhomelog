# 078 — `check-deps-sync` 가 npm `overrides` 도 루트/백엔드 동일성을 검사하게 한다

**작성 기준 커밋**: `148545b` (2026-09-16) · 우선순위 P3 · 작업량 XS · 의존: 075 (반영됨)

## 전제 확인 (계획자가 실제로 확인한 것)
- `scripts/check-deps-sync.js`(124줄) 는 `api/**`·`backend/**` 가 require 하는 패키지가 루트 `dependencies` 에 있는지, 루트·백엔드 공통 패키지의 버전 레인지가 같은지만 본다(`main()` `:71~122`). Plan 075 가 두 package.json 에 넣은 `overrides`(`satori → fflate 0.7.5`)는 **비교 대상이 아니다** — 한쪽만 바뀌면 Vercel(루트)과 로컬(backend)이 다른 트리를 설치하는데 이 스크립트는 초록이다.
- 호출처: `package.json:34` `verify` 체인, `.github/workflows/ci.yml:89`. `backend/test/frontend-contracts.test.js:1726` 은 verify 체인에 이 스크립트 이름이 있는지만 본다(동작 테스트 없음).
- 현재 두 파일의 `overrides` 는 동일(`{"satori":{"fflate":"0.7.5"}}`).

## 범위
- 수정: `scripts/check-deps-sync.js` 만. 신규 테스트 파일 없음(스크립트는 고정 경로를 읽어 단위 테스트가 어렵다 — 회귀 주입으로 대신 검증).
- 금지: package.json 들, 다른 스크립트.

## Step 1 — 비교 추가 (`main()` 안, `versionMismatch` 루프 바로 뒤·`if (missingInRoot.length === 0 && …)` 앞)
```js
  // OVERRIDES-SYNC-2026-09-16 (Plan 078): npm `overrides` 는 dependencies 비교에 안 잡힌다.
  //   한쪽에만 있으면 Vercel(루트)과 로컬(backend)이 서로 다른 트리를 설치한다(075: satori→fflate 0.7.5).
  //   키 순서와 무관하게 깊은 동일성으로 비교한다.
  const canon = (o) => JSON.stringify(o, (k, v) =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).sort()) : v);
  const overridesMismatch = canon(rootPkg.overrides || {}) !== canon(backendPkg.overrides || {});
```
성공 조건을 `if (missingInRoot.length === 0 && versionMismatch.length === 0 && !overridesMismatch) {` 로 바꾸고, 성공 메시지 끝에 `, overrides 동일` 을 덧붙인다. `versionMismatch` 출력 블록 뒤(`process.exit(1)` 앞)에:
```js
  if (overridesMismatch) {
    console.error('\n✗ 루트와 backend/package.json 의 `overrides` 가 다름:');
    console.error(`    root:    ${JSON.stringify(rootPkg.overrides || {})}`);
    console.error(`    backend: ${JSON.stringify(backendPkg.overrides || {})}`);
    console.error('  → 두 파일의 overrides 를 동일하게 맞추고 양쪽에서 `npm install` 실행.');
  }
```
파일 머리 주석의 "실패 조건" 목록에 `- 루트·백엔드 overrides 가 다름` 한 줄 추가.

## 검증·완료 기준
- `node scripts/check-deps-sync.js` → exit 0, 메시지에 `overrides 동일` 포함.
- 회귀 주입(수행 후 원복): `backend/package.json` 의 `"fflate": "0.7.5"` 를 임시로 `"0.7.4"` 로 바꾸면 exit 1 + 위 `overrides 가 다름` 메시지. 원복 후 `git status --short` 에 package.json 변경이 없어야 한다.
- `npm run verify` → `fail 0`(382).
- 커밋 1개: `chore(검증): check-deps-sync 가 npm overrides 동일성도 검사 (Plan 078)`.

## STOP 조건
- `main()` 의 구조가 위 설명과 다르다(줄 번호 ±5 이상) → 실제 구조를 보고하고 멈춘다.
