# 134 — 건축물대장 백필: 후보 조회 시간 초과를 "함수 미생성" 으로 오분류하던 결함

**작성 기준 커밋**: `e59f588` (2026-10-14) · **발견**: 2026-10-14 postgres 로그 점검
**성격**: `backend/jobs/buildingRegisterBackfill.js` 후보 조회 블록 교체 + `run()` 옵션 1개 + 신규 테스트 1. DB·프런트·의존성·환경변수 변경 0.
**계획자 사전 검증**(저장소 밖 사본): 신규 테스트 5/5 · **원래 코드에서는 시간 초과 2건 실패**(음성 대조) · `npm run verify` 전체 통과(618/618, Plan 133 포함) · ESLint 0.

## 1. 사실 (계획자 실측 2026-10-14)
- postgres 로그의 `canceling statement due to statement timeout` 중 `get_br_backfill_candidates`: 확인한 6일(10-04·07·09·12·13·14) 모두 06:15Z 전후 1건씩 — `building-register-backfill` cron 회차.
- 같은 함수 `get_br_backfill_candidates(300)` 실측 소요: 9,077ms → 1,990ms → 317ms(같은 날 연속 측정). 함수 본문을 직접 실행하면 293ms. 계획 자체보다 그 시각의 DB 부하·캐시 상태 영향이 큼 — 원인은 단정하지 않는다.
- 결함: `buildingRegisterBackfill.js:276-282` 는 RPC `error` 가 오면 **종류와 무관하게** `{ ok: true, gated: true, note: 'get_br_backfill_candidates 미생성' }` 를 돌려준다. 그래서 시간 초과로 수집이 0건인 날도 health 에는 "함수 미생성" 으로만 보였다.
- 함수 미존재 시 PostgREST 응답 코드 = `PGRST202`(2026-10-14 존재하지 않는 RPC 호출로 실측). Postgres 자체 코드는 `42883`.
- 이 잡의 `ok:false` 를 읽는 곳은 `services/cronStats.js:91`(기록) 뿐 — 경보 연쇄 없음.

## 2. 변경 (실행자)
`node <scratchpad>/p134_apply.js <워크트리 루트>` (앵커 불일치 시 아무것도 쓰지 않고 중단):
1. `run()` 옵션 줄에 `candidateRetryDelayMs = 2000` 추가(테스트는 0 을 넘긴다).
2. 후보 조회 블록: `PGRST202`·`42883` 만 게이트(기존 반환값 그대로). 그 밖의 오류는 `candidateRetryDelayMs` 뒤 **1회 재시도**, 그래도 실패하면 `{ ok: false, processed: 0, brScanned, brWritten, dens, error: 'get_br_backfill_candidates: <메시지>'(120자 이하) }`. 재시도가 성공하면 기존 흐름 그대로.
3. 신규 테스트 `backend/test/br-candidates-retry.test.js` = `<scratchpad>/p134/br-candidates-retry.test.js` 바이트 그대로 복사.

기대 해시(SHA-256): `backend/jobs/buildingRegisterBackfill.js` = `71358cae3a73e9e59391c3176963e7b4cc659b9dd01f148871b1a0a87ea54c76` · 테스트 = `421f05f1470a4eb42eacb740727d1f4c65cbc8edb9d45d2031a489b7bddc2ed3`.

## 3. 테스트가 고정하는 것
PGRST202 → 게이트·호출 1회 / 42883 → 게이트·호출 1회 / 57014 두 번 → `ok:false`·error 접두어·호출 2회·건축물대장 API 0회 / 57014 뒤 성공(후보 0) → `ok:true`·호출 2회 / 첫 성공 → 호출 1회.

## 4. 하지 않는 것
- 함수 SQL 변경(원인 미확정 — 재시도 결과를 health 로 본 뒤 판단) · cron 시각 변경 · 되쓰기·밀도 단계 변경.

## 5. 배포 뒤 확인
- 다음 06:xxZ 회차 postgres 로그에 시간 초과가 1건이면 재시도가 성공한 것(2건이면 둘 다 실패 → `ok:false`). Redis 가 복구되면 `/api/health` `crons['building-register-backfill']` 에 `error` 가 보인다(지금은 Redis 한도 초과로 crons 자체가 null).
