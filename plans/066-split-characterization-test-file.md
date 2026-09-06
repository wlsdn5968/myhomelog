# Plan 066: 10,056줄 단일 테스트 파일을 도메인별로 분할한다 — 이번 라운드 머지 14회 중 14회 충돌의 원인

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **드리프트 점검**: `git diff --stat f29a612..HEAD -- backend/test/`

## Status
- **Priority**: **P1** · **Effort**: M · **Risk**: LOW(테스트만, 프로덕션 코드 무변경) · **Depends on**: 없음
- **Category**: DX/process · **Planned at**: `f29a612`, 2026-09-06

## 왜 (실측)
`backend/test/characterization.test.js` — **10,056줄 · 327개 `test()`** · 단일 파일.
`node --test`(backend/package.json) 는 `test/*.test.js` 를 **자동 탐색**하므로 파일을 나눠도 실행 방식은 그대로다.
2026-09-06 라운드에서 실행자 14명이 전부 이 파일 끝에 추가했고 **머지 14회 중 14회 충돌**(꼬리 `});` 공유).
해소는 기계적이었지만 매번 리뷰어 시간이 들었고, 한 번은 기존 테스트 41줄 삭제를 포함한 커밋(060)이라 해소가 수정을 되돌릴 위험이 실제로 있었다.

## 요구사항
1. **테스트 수·이름·동작이 하나도 바뀌지 않는다** — 분할 전 `327 pass` 와 분할 후 합계가 같아야 하고, 각 `test()` 의 이름이 전부 보존돼야 한다.
2. **공용 헬퍼를 모듈로 뽑는다** — `backend/test/_helpers.js` (밑줄 접두 → `node --test` 가 테스트로 잡지 않는다; **실제로 그런지 확인**하라). 예: `_shareHandler`, `_shareMockRes`, `_withMockedDate`, `_mockAptAdmin`, `_requireRouterWithAdmin`, `_withRecStubs`, 줄 주석 제거 전처리 등. 파일 상단의 `require` 도 각 파일이 필요한 것만 갖게 한다.
3. **분할 단위는 도메인** — 파일의 `// ── … ──` 섹션 헤더가 이미 힌트다. 권장(강제 아님): `billing`, `regulation-tax`, `search-chat`, `transactions-window`, `cron-observability`, `frontend-contracts`, `recommend`, `share-ssr`, `misc`. 한 파일이 3,000줄을 넘지 않게 하라.
4. **테스트 간 숨은 순서 의존**을 찾아라 — 060 이 고친 `auditLog` 스텁 오염처럼 "앞 테스트가 `require.cache` 를 바꿔 뒤 테스트가 통과하던" 케이스가 있으면 **분할 후 실패로 드러난다.** 그건 결함이 드러난 것이지 분할이 틀린 게 아니다 — 각 테스트가 스스로 준비·복원하도록 고쳐라. 고친 것은 **전부 보고**하라.
5. **각 파일을 단독으로 실행해도 통과**해야 한다: `node --test test/<파일>.test.js` 하나씩.
6. 기존 파일은 **삭제**한다(빈 껍데기 금지). 다른 세션이 여전히 그 파일 끝에 추가하려 할 수 있으니, `backend/test/README.md` 를 만들어 **"새 테스트는 도메인 파일에, 없으면 `<topic>.test.js` 신규"** 규칙을 적어라.

## 범위
**In**: `backend/test/**` · `backend/test/README.md`(신규)
**Out**: 프로덕션 코드 전부 · `package.json` · `scripts/run-backend-tests-utc.js`(TZ=UTC 래퍼 — 그대로 동작해야 한다)

## 단계
1. **분할 전 기준 고정**: `cd backend && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` 와 `grep -oE "^test\('[^']+'" characterization.test.js | sort` 를 파일로 저장(스크래치패드).
2. 헬퍼 추출 → `_helpers.js`. 실행 시 테스트로 잡히지 않음을 확인.
3. 섹션별로 잘라 파일 생성. 스크립트는 **Write 도구**로 만들어라(CRLF/LF 혼재 — 이 파일은 CRLF).
4. 전체 실행 + 파일별 단독 실행. 실패가 있으면 요구사항 4 로 판단해 고친다.
5. 테스트 이름 목록을 분할 전과 **diff** — 누락·중복 0.
6. `npm run verify` exit 0.

## 완료 기준
- [ ] 총 pass 수 = 분할 전 (327 + 이후 머지분 — **실측**)
- [ ] 테스트 이름 목록 diff 가 비어 있다
- [ ] 각 파일 단독 실행 통과
- [ ] `git diff --stat` 에 `backend/test/` 만
- [ ] 순서 의존을 고친 항목 목록(없으면 "없음")

## STOP 조건
- 프로덕션 코드를 고쳐야 통과할 것 같다 → 보고하고 멈춰라(그건 별개 결함이다).
- 이름 목록 diff 가 비지 않는다.
- `run-backend-tests-utc.js` 가 분할 후 파일을 못 찾는다 → 그 스크립트를 읽고 **원인만 보고**하라.

## 보고에 반드시
분할 전/후 pass 수 · 파일별 줄수·테스트 수 표 · 순서 의존 발견·수정 목록 · `_helpers.js` 가 테스트로 안 잡히는 증거.
