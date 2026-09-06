# Plan 073: express 4.22.2 → 5.2.1 — `npm audit` moderate 5건 중 4건의 원인, 코드 영향 2종 확정

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **전제**: Plan 071·072 가 **먼저 머지**돼 있어야 한다(lockfile). `git log --oneline -8` 로 확인.

## Status
- **Priority**: **P1** · **Effort**: M · **Risk**: **MED-HIGH**(프레임워크 메이저, 공개 API 전부) · **Depends on**: 071·072
- **Planned at**: 2026-09-06 · **근거**: 조사+반증 워크플로(스크래치패드에 express@5.2.1 설치해 **실행 재현**)

## 왜 지금
Plan 042 는 "express 4 유지"를 기록했지만 사유는 *"보이지 않는 기본값을 결정으로"* 였고, 운영자가 최신화를 지시했다. `npm audit --omit=dev` moderate 5건 중 **4건**(qs 2·body-parser·express)이 express 4 연쇄이며 4.x 계열엔 fix 가 없다. **5.2.1 정확히** — 5.2.0 은 잘못된 파괴적 변경(CVE-2024-51999 대응)을 넣었다가 5.2.1 에서 전면 되돌렸다.

## 이 저장소에 실제로 영향 있는 변경 (전부 실행 재현됨)
**A. `req.query` 가 매 접근 재파싱되는 getter** → 미들웨어가 `req.query.x = 정제값` 으로 넣은 값이 **다음 접근에서 원문으로 되돌아간다.**
- `backend/middleware/validation.js:69` `req.query.aptName = sanitizeString(aptName, 50)` → `backend/routes/transactions.js:31` 이 **정제되지 않은 원문**을 읽는다. 재현: 'SANITIZED' 대입 → 핸들러에서 `<script>` 원문. **정제 우회 = 보안 회귀.**
- 반증자 추가 발견: `validation.js:77` `validatePropertySearch` GET 분기 `src = req.query || {}` 뒤 `src.query = sanitizeString(...)` 도 같은 패턴.
- ⚠ 성능: 핸들러 안에서 `req.query` 를 반복 접근하는 곳(admin.js:156/235 spread 등)은 매번 재파싱된다 — 상단에서 한 번 `const q = req.query` 로 받아 쓰는 게 안전하다.

**B. `req.body` 가 파싱되지 않으면 `undefined`**(body-parser 2.x) → content-type 없는 POST 에서 구조분해가 **500**(v4 는 `{}` 라 400 검증 응답).
- 가드 없는 곳: `validation.js:37`, `routes/chat.js:71`, `routes/clause.js:32`, `routes/geocode.js:122`·`:161`, `routes/properties.js:18`·`:84`.
- 반증자 추가: `routes/billing.js:424` `const p = data && data.paymentKey ? data : req.body` — 위에서 `req.body || {}` 로 뽑은 뒤에도 `p` 가 raw `req.body` 를 다시 쓴다.
- 이미 가드된 곳(참고): `kakaoWebhook.js:90`, `bookmarks.js:157`, `validation.js:73`.

**C. 영향 없음(전수 grep·재현으로 확인, 손대지 마라)**: 라우트 문법(83개 경로 전부 `/literal`·`/:param`) · 삭제 API(`res.redirect(302, url)` 신문법 4곳) · 쿼리 파서 simple(중첩 접근 0건) · `res.status(변수)`(전부 `|| 기본값`) · `urlencoded extended`(이미 `false`) · Sentry(`@sentry/node ^10.73` ≥ 9.2.0 Express 5 지원) · express-rate-limit peer `>= 4.11`.

**D. 주의**: 테스트가 `router.stack.find(l => l.route …)`·`layer.route.stack[n].handle` 로 핸들러를 뽑는 곳이 **8곳**(925·5366·6965·7952·8076·8679·9078 등) — `router@2.2.0` 실측으로 구조 유지 확인됐으나 **실제 통과를 실측**하라. Plan 066 이 파일을 분할했으면 위치가 바뀌었을 수 있다 — `grep -rn "route.stack\|\.stack.find" backend/test/`.

**E. 부수 효과(의도됨)**: async 핸들러의 rejected Promise 가 자동으로 에러 핸들러(`server.js:757` Sentry → `:761` 전역)로 간다. v4 에서 조용히 묻히던 예외가 500 JSON + Sentry 이벤트로 드러난다. **배포 후 Sentry 신규 이슈를 반드시 확인**하고, 늘어난 게 있으면 그건 **원래 있던 결함이 드러난 것**이다.

## 단계
1. `npm install express@5.2.1` 루트·backend. `npm ls express router body-parser qs` → 5.2.1 / 2.2.0 / ≥2.2.1 / ≥6.14.
2. **A 수정**: 정제값을 `req.query` 에 쓰지 말고 `res.locals.sanitized`(또는 `req.sanitized`) 에 싣고, `transactions.js:31`·`validatePropertySearch` 소비자가 그걸 읽게. **정제가 실제로 적용되는 실행 테스트** 필수(원문 `<script>` 를 넣어 핸들러가 정제값을 봤는지).
3. **B 수정**: 8곳 `req.body || {}`. `billing.js:424` 는 `p` 가 `undefined` 가 되지 않도록.
4. `briefing.js:99` `redirect(302, url)` 의 `url` 이 undefined 가 될 수 있으면 가드(5.2.0 부터 deprecation 경고).
5. `npm run verify`. D 의 8곳 확인. `npm audit --omit=dev` → **moderate 5 → 1**(satori/fflate 만 남아야 한다) 보고.
6. 테스트: 신규 `backend/test/express5-migration.test.js` — A(정제 적용 실행), B(content-type 없는 POST → 400 유지, 500 아님), D(핸들러 추출 8곳 동작).

## 범위
**In**: `package.json`×2·lockfile×2 · `validation.js` · `transactions.js` · `chat.js`·`clause.js`·`geocode.js`·`properties.js`·`billing.js`(B 가드만) · `briefing.js:99` · 신규 테스트
**Out**: 라우트 경로 문자열 · `server.js` 미들웨어 순서·CSP · 다른 의존성 · `frontend/`

## 회귀 주입 (커밋 후)
① A 수정을 되돌려 `req.query` 에 다시 쓴다 → 정제 테스트 fail · ② B 가드 1곳 제거 → 400 테스트 fail

## 완료 기준
- [ ] express 5.2.1 정확히 · `check-deps-sync` OK
- [ ] A: 정제값이 소비자에 실제로 도달(실행 테스트) · B: 8곳 가드 · `briefing.js:99` 가드
- [ ] `npm audit --omit=dev` moderate **1건**(fflate)만
- [ ] `npm run verify` exit 0 · 주입 2건 fail
- [ ] 보고에 **배포 후 확인 목록**: POST `/api/chat`·`/api/clause`·`/api/geocode`·`/api/properties/recommend` 200 · GET `/api/transactions?aptName=<'<' 포함>` 정제 적용 · `/api/kakao/unlink-callback` 200 · `/share`·`/briefing`·`/region`·`/apt` 리다이렉트 · Sentry 신규 이슈

## STOP 조건
- 라우트 등록 시점에 throw(path-to-regexp) → 그 경로 문자열을 보고하고 멈춰라(조사는 0건이었다).
- D 의 핸들러 추출이 깨진다 → `router@2` 구조를 찍어 보고.
- A 를 고치려면 `validation.js` 의 다른 검증기 시그니처를 바꿔야 한다 → 보고하고 멈춰라.
