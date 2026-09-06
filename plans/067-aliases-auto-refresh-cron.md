# Plan 067: `molit_aliases` 를 cron 이 자동으로 채운다 — 1회 backfill 은 새 단지에서 다시 비어 간다

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **드리프트 점검**: `git diff --stat f29a612..HEAD -- backend/jobs/aptMasterSync.js backend/routes/cron.js`

## Status
- **Priority**: **P1** · **Effort**: S · **Risk**: LOW(cron 1단계 추가) · **Depends on**: DB 함수 `refresh_molit_aliases()` — **리뷰어가 운영자 승인 하에 생성**(아래)
- **Category**: data freshness · **Planned at**: `f29a612`, 2026-09-06

## 왜
2026-09-06 에 `molit_aliases` 를 1 → 10,505행으로 채웠다(Plan 053). 그러나 `aptMasterSync`(월요일 cron)가 **새 단지를 upsert 할 때 `molit_aliases` 는 컬럼에 없어 빈 채로 들어온다**(`aptMasterSync.js:17,174` 주석이 명시). 시간이 갈수록 챗 도달률(72.8%)과 공개 페이지 단지정보 커버리지(47.1%)가 **조용히 떨어진다.**

## DB 쪽 (리뷰어가 한다 — 실행자는 호출만)
`public.refresh_molit_aliases()` — SECURITY DEFINER, `statement_timeout=300s`, Plan 053 부록 A-5 의 UPDATE 를 그대로 담고 **갱신 행수를 반환**한다. `anon`·`authenticated` EXECUTE 회수, `service_role` 만 허용. 실행자는 **이 함수가 존재한다고 가정**하되, 로컬 테스트는 스텁으로 한다.

## 요구사항
1. `aptMasterSync` 의 upsert 가 끝난 **직후** `admin.rpc('refresh_molit_aliases')` 를 호출한다. 실패해도 sync 결과는 `ok` 다(기존 MV 갱신과 같은 규약 — `cron.js` 의 `mvRefreshError` 패턴을 그대로 따르라).
2. 결과를 `recordCronRun('apt-master-sync', { aliasRefreshed: <행수>, aliasRefreshError: <사유> })` 로 남긴다. ⚠ `cronStats._pick` 화이트리스트에 두 키를 추가해야 health 에 보인다(058 이 같은 이유로 추가한 선례).
3. **모름을 0 으로 만들지 마라** — rpc 가 실패하면 `aliasRefreshed` 필드를 **생략**한다.
4. 실패 시 Sentry `captureMessage`(warning, 고정 메시지, 가변값은 `extra`) — `cron.js` 의 MV 경보 블록이 본보기다.
5. ⚠ 동시 실행 주의 — 다른 실행자가 `cronStats.js` 화이트리스트를 건드릴 수 있다. **네가 추가하는 두 줄만** 넣고 다른 줄은 손대지 마라.

## 범위
**In**: `backend/jobs/aptMasterSync.js` · `backend/routes/cron.js`(apt-master-sync 핸들러의 경보만) · `backend/services/cronStats.js`(화이트리스트 2줄) · `backend/test/aliases-cron.test.js`(**신규 파일** — 단일 테스트 파일에 추가하지 마라)
**Out**: DB(함수 생성은 리뷰어) · Plan 053 의 SQL 자체 · `molitIngest.js` · MV 갱신 로직

## 테스트 (신규 파일, 실행 테스트)
1. rpc 성공 시 `aliasRefreshed` 가 숫자로 기록된다
2. rpc 실패 시 sync 결과가 여전히 `ok` 이고 `aliasRefreshed` 키가 **없다**
3. 실패 시 경보 메시지에 가변값이 없다
스텁은 `require.cache` 치환 — 기존 테스트 파일에서 `getSupabaseAdmin` 스텁 예를 찾아 **방식만** 따르라(헬퍼를 import 하지 말고 자기 파일 안에 최소로 둬라 — 다른 실행자가 그 파일을 분할 중이다).

## 회귀 주입 (커밋 후, `git status --short` 비어 있을 때)
① rpc 호출 제거 → fail · ② 실패 시 `aliasRefreshed = 0` 넣게 → fail

## 완료 기준
- [ ] 위 테스트 3건 통과 · 주입 2건 각각 fail
- [ ] `npm run verify` exit 0
- [ ] `git diff --stat` 에 In 범위 파일만

## STOP 조건
- DB 함수 시그니처(반환값)를 확신할 수 없다 → **`refresh_molit_aliases()` 가 `integer`(갱신 행수)를 반환한다**고 가정하고 진행하되, 그 가정을 보고에 명시하라.
- `aptMasterSync` 의 upsert 흐름을 바꿔야 할 것 같다 → 보고하고 멈춰라.
