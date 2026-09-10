# 075 — satori 가 고정한 취약 fflate 0.7.3 을 override 로 0.7.5 에 맞춘다 (audit moderate 2 → 0)

**작성 기준 커밋**: `75f39ad` (2026-09-10) · 우선순위 P2 · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 실제로 확인한 것)
- `npm audit --omit=dev --json`: `fflate` moderate, 취약 범위 **0.7.0 – 0.7.4**, 권고(GHSA-px8p-9vwx-vf98: unzipSync 무한 루프). `satori` 는 그 의존자로 같이 표시된다. npm 이 제안하는 fix 는 satori **0.32.0 다운그레이드** — 채택 불가.
- `npm explain fflate`(root·backend 동일): 최상위 `node_modules/fflate@0.7.5`(`@shuding/opentype.js` 가 `^0.7.3` 요구) + **중첩 `node_modules/satori/node_modules/fflate@0.7.3`**(satori 가 정확히 `0.7.3` 으로 고정). 취약본은 이 중첩본뿐.
- `npm view satori version dependencies.fflate` → 최신 0.33.4 도 `0.7.3` 고정 → 상위 갱신으로는 해결되지 않는다.
- satori 가 fflate 에서 쓰는 것은 `inflateSync` **하나**(`node_modules/satori/dist/*.js` grep: `import{inflateSync as …}from"fflate"` 2곳). 0.7.5 는 같은 0.7 계열 패치판이라 API 동일.
- `satori` 실사용처: `backend/services/ogImageService.js`, `backend/routes/ogImage.js`. `backend/test/og-image.test.js:84~` 가 **실제로 `renderCard` 를 렌더**(resvg 포함)한다 — 이 테스트가 곧 런타임 스모크다.
- `package.json`·`backend/package.json` 둘 다 `"satori": "^0.33.4"` 를 선언하고 각자 lockfile 을 가진다. `overrides` 키는 둘 다 없음.

## 범위
- 수정: `package.json`, `backend/package.json`(각각 `overrides` 추가), `package-lock.json`, `backend/package-lock.json`.
- 금지: 다른 의존성 버전 변경, 소스 코드 변경.

## Step 1 — overrides 추가 (두 파일 동일)
`"dependencies"` 블록 **바로 앞**(최상위 키)에 추가:
```json
  "overrides": {
    "satori": {
      "fflate": "0.7.5"
    }
  },
```
(JSON 유효성은 `npm run verify` 의 check-json-config 가 본다.)

## Step 2 — 설치·확인
워크트리 root 와 `backend/` 에서 각각 `npm install --no-audit --no-fund` (⚠ 워크트리의 node_modules 정션이 실디렉터리로 바뀌는 것은 정상 — 리뷰어가 머지 후 원본에서 다시 `npm install` 한다).
확인(둘 다에서):
- `npm explain fflate` → **0.7.5 만** 나오고 `satori/node_modules/fflate` 항목이 사라진다.
- `npm audit --omit=dev` → `found 0 vulnerabilities`.
- `grep -c '"fflate": "0.7.3"' package-lock.json` → 0 (backend 도).
- `node -e "const f=require('fflate');console.log(typeof f.inflateSync, require('fflate/package.json').version)"` → `function 0.7.5`.

## Step 3 — 검증·커밋
- `npm run verify` → `fail 0`(og-image 렌더 테스트 포함, 테스트 수 380 그대로). `check-deps-sync` OK.
- 커밋 1개(4 파일): `chore(deps): satori 중첩 fflate 0.7.3 → 0.7.5 override — audit moderate 2 → 0 (Plan 075)` + body 에 [근본 원인][Fix][회귀 위험].
- 보고에 `npm explain fflate` 전/후와 `npm audit --omit=dev` 결과 줄을 그대로 붙인다.

## STOP 조건
- `npm install` 후에도 `satori/node_modules/fflate` 가 남는다(override 가 안 먹는다) → package-lock 의 해당 항목을 보고하고 멈춘다.
- og-image 테스트가 fail 한다 → 원복하지 말고 출력 그대로 보고.
