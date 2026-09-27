# 119 — 적재 기록이 아예 없는 (지역, 월) "조용한 구멍" 감지·자동 재적재

**작성 기준 커밋**: `d90c861` (2026-09-27) · **발견**: 107c-2 사전 점검 중 계획자 실측 · **운영자 결정 대기**(과거분 채우기는 운영자 결정 사항 — memory `region-ingest-onboarding-gap`)
**성격**: 코드 S(한 함수 확장 + cron 요약 1키) + 신규 테스트 1파일. DDL 0. 병합되면 기존 적재 경로(`ingestOne`, dedup_key 멱등 upsert)가 원본에 행을 **추가**한다.

## 1. 사실 (계획자 실측 2026-09-27, 전부 SQL/라이브)
- 16개월 창(2025-06~2026-09)에서 `molit_ingest_runs` 에 **ok 도 error 도 없는** (지역, 월) 조합:
  | 종류 | 조합 | 지역 | 달 |
  |---|---|---|---|
  | **실제 구멍** | **113** | 41 | 2025-11·2025-12·2026-01(경기 36곳 × 3 = 108) + 2026-05(청주 43111~43114 4곳 + 41310 1달 = 5) |
  | 신설 코드의 생성 전 달(정상) | 57 | 7 | 인천 28125·28155·28275·28290(~2026-05), 화성 41591·41593·41595(~2026-01) |
- 경기 36곳의 월별 원본 행수: 2025-10 **9,657** → 11·12·1월 **0** → 2026-02 **8,864**. 청주 4구: 2026-04 1,063 → 05 **0** → 06 963.
- **사용자 노출(라이브)**: `GET /api/transactions/history?aptSeq=41131-1652`(성남 수정구 산성역포레스티아, 4,089세대) 월별 = `2025-10:38 → 2026-02:16` — 11·12·1월이 **통째로 없다**(안내 없음). 장기 추세 차트·지역 대시보드·보고서 트렌드·지도 평균가·챗 시세가 같은 DB-only 경로다(memory `region-ingest-onboarding-gap` 목록).
- **원인(기록으로 확정)**:
  1. 2026-08-16 경기 과거분 백필(운영자 승인, `months=3&offsetMonths={4,7,10,13}`)의 offset 7 회차(2025-11~2026-01)가 02:53~02:54Z 에 `statement timeout` error 15건을 내고 멈췄다 — `runMolitIngest` 작업자 2개가 **연속 3실패 차단**(`CIRCUIT_BREAK_CONSECUTIVE_FAILURES = 3`)에 걸려 남은 약 94개 작업을 `skipped: circuit_break` 로 넘겼고, **skipped 작업은 `molit_ingest_runs` 에 행을 남기지 않는다**(`ingestOne` 을 부르지 않음). 당시 검증은 "최소 날짜가 2025-05 까지 내려왔는가" 만 봐서 중간 구멍을 못 봤다.
  2. 청주 4구(2026-08-10 편입, 첫 창 2026-06~08)는 offset 4·7·10·13 이 **3개월 전(2026-05)을 건너뛰는** 경계 오류.
- **재시도가 못 잡는 이유**: `retryFailedGaps`(`backend/jobs/molitIngest.js:288`)는 후보를 `status in ('error','timeout')` 행에서만 뽑는다(`:313`). 기록이 아예 없는 조합은 후보가 될 수 없다 — 영구 구멍.
- 조회 부담: 4~16개월 전 달의 `ok`+`archived` 행은 달마다 지역당 ≈1행(보존 정리 뒤) → 13개월 ≈ **1,455행**(페이지 2장).

## 2. 변경 (실행자)
### 2-1. `backend/jobs/molitIngest.js` — `retryFailedGaps` 확장 (기존 동작 보존)
- 기존 `failPairs`·`okSet`·`gaps` 계산은 **그대로** 둔다(테스트 `window-safe-ddl.test.js` 가 상태 필터 `['error','timeout']` 를 고정).
- 추가: 구멍 후보 계산
  - `windowYms = recentYearMonths(lookbackMonths)`(최신→과거). `holeYms = windowYms.slice(3)` — 최신 3개월은 본 적재가 매일 다시 받으므로 제외(주석으로 이유).
  - `covered` = `molit_ingest_runs` 에서 `status in ('ok','archived')` 이고 `deal_ym` 이 `holeYms` 범위(`gte(가장 오래된)`, `lte(가장 최근)`)인 행의 `lawd_cd|deal_ym` 집합 — **기존 `pageAll` 로 페이지 루프**(1000행 캡 함정).
  - `expected` = `Object.values(LAWD_CODES)`(현재 125개) × `holeYms`.
  - `holes = expected − covered − (이미 gaps 에 든 조합)`.
  - 정렬: ① 그 지역의 covered 최소 월 ≤ ym ≤ 최대 월인 **내부 구멍** 먼저 ② 나머지(신설 코드·늦은 편입). 각 묶음 안에서는 **최신 달 먼저**.
  - 재시도 목록 = `gaps`(기존, 우선) + `holes` 를 합쳐 **총 `maxGaps`(15) 개까지**. 같은 루프(`ingestOne`·연속 실패 차단·deadline)로 처리.
  - covered 조회가 실패하면 **구멍 처리만 건너뛴다**(기존 갭 처리는 계속) — 부분 목록으로 오판 재적재하지 않는다(기존 `oks` 실패 처리와 같은 원칙).
  - 반환값에 `holes: <구멍 후보 총수(자르기 전)>` 추가: `{ gaps, retried, filled, holes }`. `gaps` 는 기존 의미(오류 기반 후보 중 고른 수) 유지.
- 주석 태그 `SILENT-HOLE-2026-09-27 (Plan 119):` — 원인 2개(차단기 skipped 무기록, 오프셋 경계)와 "신설 코드의 생성 전 달은 한 번 받아 rows 0 → ok 로 자연 소멸" 을 2~4줄로.
### 2-2. `backend/routes/cron.js` — health 에 남은 구멍 수
- `recordCronRun('molit-ingest', {...})` 에 `gapHoles: summary.gapBackfill && summary.gapBackfill.holes` 추가(`retried`/`filled` 옆).
- `backend/services/cronStats.js` 의 `NUM` 배열에 `'gapHoles'` 추가(`_pick` 은 NUM 의 숫자만 통과 — Plan 110 교훈).
### 2-3. 테스트 export
- `molitIngest.js` 끝에 `module.exports._retryFailedGaps = retryFailedGaps; // TEST-EXPORT-2026-09-27 (Plan 119): 구멍 감지 고정용` (저장소 관례: `backend/routes/cron.js:828`).
### 2-4. 신규 테스트 `backend/test/ingest-silent-holes.test.js`
패턴: `require.cache` 스텁(`backend/test/_helpers.js` 와 기존 cron 테스트 참고). `fetchRegionMonth` 가 네트워크를 타지 않게 `molitIngest` 가 쓰는 fetch 계층을 스텁하거나, `ingestOne` 이 부르는 `admin.from('molit_ingest_runs').insert/update` 와 `molit_transactions.upsert` 를 기록만 하는 가짜 admin 으로 대체. `LAWD_CODES` 는 transactionService 스텁으로 3개 코드만.
단언:
1. 기록이 **아예 없는** (지역, 월)(최신 3개월 밖)이 재시도된다.
2. `archived` 만 있는 조합은 구멍이 아니다.
3. 최신 3개월은 기록이 없어도 구멍 후보가 아니다.
4. 기존 오류 기반 갭이 구멍보다 **먼저** 뽑히고, 합계가 `maxGaps` 를 넘지 않는다.
5. 내부 구멍이 신설(앞쪽) 구멍보다 먼저, 같은 묶음에서는 최신 달이 먼저.
6. covered 조회가 error 를 돌려주면 구멍 재시도 0, 기존 갭 처리는 그대로.
7. 반환값 `holes` 가 자르기 전 후보 총수.
8. `cron.js` 소스에 `gapHoles:` 1회, `cronStats.js` NUM 에 `'gapHoles'` 1회.
(날짜는 고정 시계로 — `recentYearMonths` 는 `new Date()` 를 쓰므로 테스트에서 `Date` 를 고정하거나 기대값을 `recentYearMonths` 로 계산. **절대 날짜 하드코드 금지**(memory `test-absolute-date-rot`).)

## 3. 하지 말 것 / STOP
- `retryFailedGaps` 의 기존 상태 필터·`maxGaps` 기본값·호출부 시간 가드(`< 200000`, deadline `+270000`) 변경 금지. `runMolitIngest` 본 적재 루프·차단기 변경 금지.
- DDL·DB 직접 실행 금지. `vercel.json` 변경 금지.
- 기존 테스트 파일 수정 금지(스텁 키 추가가 꼭 필요하면 STOP 보고 — 107b-1 교훈).

## 4. 병합 뒤 예상 (식)
- 조합 170(113 + 57) · 슬롯 3개 × `maxGaps` 15 = 하루 최대 45 → **약 4일**(본 적재가 200s 안에 끝나 재시도 단계가 돌 때. 실측 slot 0 elapsedMs 18.7s).
- 추가 행: 경기 3개월 × 8,864~9,657 = 26.6K~29.0K + 청주 ≈1.0K = **≈27.6K~30.0K행** · 원본 행당 ≈0.466KB(222.02MB / 476,719행) → **≈12.9~14.0MB**. 107c-1 로 원본 파일 안에 생긴 빈 공간(31,299행 ≈14.6MB)을 먼저 재사용하므로 파일 성장은 즉시가 아니라 **약 한 달 앞당겨진다**(425MB 경보가 그만큼 빨라짐). 107c-2(2025-06, 39,978행 ≈18.6MB 빈 공간)를 **10-05 전후**로 당기면 상쇄된다(15개월 하한: 10-01 이후 가능).
- 신설 코드 57조합은 MOLIT 이 0행을 돌려줘 `ok(rows 0)` 로 기록되고 다시 후보가 되지 않는다(`ingestOne` 기존 동작).
- MOLIT API 호출: 조합당 1~수 회 · 무료(data.go.kr).

## 5. 완료 기준
- `npm run verify` 전부 통과, backend test **517 + 신규**.
- 병합 후(리뷰어): 다음 17:00Z 회차부터 `/api/health` `crons['molit-ingest'].gapHoles` 숫자가 보이고 날마다 줄어 0 에 도달(신설 57 포함 약 4일). SQL: 경기 36곳 2025-11~2026-01 원본 행 > 0, 청주 2026-05 > 0, §1 구멍 SQL 0행. 라이브: 산성역포레스티아 월별에 2025-11·12·2026-01 존재.

## 6. 유지보수 메모
- 과거분 백필(`admin/run-molit-ingest?offsetMonths=`)은 이제 중간이 끊겨도 이 감지가 메운다. 그래도 백필 뒤에는 **월별 지역 수 연속성**(§1 SQL)으로 검증한다 — 최소 날짜만 보면 중간 구멍을 못 본다.
- 107c 로 달을 자르기 전 P5(그 달 구멍 0)를 반드시 본다(`plans/107c-2-cut-202506.md` §2).
