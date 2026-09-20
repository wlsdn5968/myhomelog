# 107 — 원본 실거래 순환 보관(설계): 원본은 최근 16개월, 그보다 오래된 달은 협폭 이력으로 — DB 증가를 월 +14 MB → +3 MB 로

**작성 기준 커밋**: `3501c49` (2026-09-20) · 성격: **설계 + 0단계(전수 목록) 실행 계획** · 우선순위 P1 · 작업량 L(하위 계획 4개로 분할) · 의존: 101·103·105·106 · 기한: **2027-01 전**(106 까지 적용한 ≈ 413 MB 에서 월 +15 MB 면 2027-03 경 한도, 여유 2개월)

## 전제 확인 (계획자가 프로덕션·코드로 확인 — 2026-09-20)
- 원본 `molit_transactions`: 17개월(2025-05~2026-09) 472,302행 235.6 MB → **월 ≈ 13.9 MB**. 협폭 이력은 같은 달이 ≈ 1.5~2.2 MB(원본 1개월 = 이력 6~9개월분). 원본은 삭제해도 파일이 줄지 않지만 **빈 공간이 새 행에 재사용**되므로, 매달 가장 오래된 달을 옮기면 파일 크기가 고정된다(재작성 불필요).
- **창을 16개월로 잡는 이유**: 이름으로 거래를 찾는 조회가 최대 15개월을 읽는다 — `backend/routes/transactions.js:44` 가 `monthsBack` 12·15 를 허용(공유 카드·비교), `getTransactionsByApt` → `getTransactions(lawd, ym)` → `getTransactionsFromDb` 는 **ok 실행 기록이 있으면 원본만 읽고 0건이어도 `[]` 를 돌려준다**(`transactionService.js:34~`). 이력에는 `apt_name` 이 없어 이름 매칭을 대신할 수 없다 → 15개월 + 진행 중인 달 = 16. 지금은 옮길 달이 없고 **2026-10-01 부터 매달 1개월**(첫 대상 2025-05).
- 원본 **전체 기간**을 읽는 곳(옮기기 전에 고쳐야 함):
  | 읽는 곳 | 지금 | 옮긴 뒤 문제 | 방향 |
  |---|---|---|---|
  | MV `molit_apt_index`(`GROUP BY apt_name, lawd_cd, sigungu, umd_nm, build_year` → `recent_deal_date`, `deal_count`, 최신 `apt_seq`) | 검색·자동완성·챗·공개 페이지의 단지 목록 | 마지막 거래가 창 밖인 단지가 검색에서 사라진다(13개월 창이면 23,017 중 977개 — 16개월 창은 0단계에서 실측) | 옮기는 달의 단지 속성을 작은 보존 테이블에 upsert 하고 MV 가 `원본 집계 ∪ 보존분` 을 읽게 |
  | `get_price_records*` 의 직전 최고·최저 | 원본 전체 | 기준선이 짧아진다 | **103 의 `molit_hist_peaks` 에 옮기는 달을 증분 upsert** |
  | `getTransactionsByAptSeq(seq, 24)`(공개 단지 페이지) | 24개월 요청(실제 17) | 16개월로 준다 | 표시 문구를 실제 창에 맞추거나 `aptHistoryService`(102)로 장기 요약 |
  | `/api/health` `dataCounts.tx`·브리핑 "실거래 누적 N건" | 원본 `count(*)` | 옮길 때마다 숫자가 준다 | 원본 + 이력 합계로 |
  | `refresh_molit_aliases` 의 지번 최빈값(`mj`) | 원본 전체 | 표본이 16개월로 — 영향 미미(0단계에서 확인) | 필요 시 보존 테이블의 지번 사용 |
  | `active_lawd_codes`(since 미지정 시)·지역 신선도 감시 | 최신 거래일만 봄 | 영향 없음 | — |
- 이력 물리 배치: 최신월이 힙 앞, 가장 오래된 달이 끝(2020-09 = 블록 9164~9476). 옮겨 온 새 달은 빈 공간(없으면 끝)에 들어간다 → 상한 삭제(가장 오래된 달)의 꼬리 절단 효과는 첫 몇 달 뒤 줄어든다 — **상한은 "파일 축소" 가 아니라 "증가 정지" 수단**으로 본다.

## 0단계 — 전수 목록 (실행자: haiku Explore, 읽기 전용 · 산출물 = 이 파일 부록 A)
`grep -rn "molit_transactions" backend --include=*.js`(test·testSupport 제외, `molit_transactions_hist` 제외) 결과 **전 파일**(2026-09-20 기준 12개: jobs/geocacheBackfill·molitIngest·pushNotify, routes/cron·news·regionPage·report·search, server.js, services/aptFacilityService·aptHistoryService·buildingRegisterService + transactionService·chatDataRouter·popularService)과 `supabase/schema.sql` 의 함수·뷰 전부에 대해: 위치, 기능, **날짜 하한 식**, 이름 매칭 여부, 16개월 창에서의 영향(없음/문구/로직)을 표로. 12개월 넘게 읽는 곳은 코드 인용 필수. 추측 금지 — 확인 못 한 것은 "미확인".

## 하위 계획(0단계 뒤 작성 — 각자 DDL 승인)
1. **107a 보존 테이블 + MV**: `molit_apt_keep(apt_name, lawd_cd, sigungu, umd_nm, build_year, apt_seq, recent_deal_date, deal_count)`(≈ 단지 수 × 120 B) + MV 재정의(원본 집계와 `FULL JOIN`, 건수 합산·최신일 `greatest`). `refresh_molit_apt_index` 의 120초 타임아웃 설정 유지.
2. **107b 옮기기 함수** `archive_molit_month(p_ym text) returns jsonb`(SECURITY DEFINER, service_role 전용, 한 트랜잭션): ① 이력에 그 달이 이미 있으면 중단 ② `INSERT INTO molit_transactions_hist SELECT apt_seq, deal_date, least(round(exclu_use_ar*100),32767)::smallint, deal_amount::int, floor::smallint …`(원본은 `apt_seq IS NULL` 0건 실측) ③ 건수 대조 ④ `molit_hist_peaks`·`molit_apt_keep` 증분 upsert ⑤ 원본 삭제 ⑥ `molit_hist_runs` 에 기록. 실패 시 전부 롤백.
3. **107c cron**: backfill 슬롯 10개를 1개(`/api/cron/molit-archive`, 하루 1회)로 교체 — 옮길 달이 없으면 아무것도 안 한다. `vercel.json`·`cronStats` 계약 테스트 동시 갱신. 원본·이력에 `autovacuum_vacuum_scale_factor = 0.02`(삭제 뒤 빈 공간이 바로 재사용 목록에 오르게).
4. **107d 상한**: `db_size_mb()`(105 뒤엔 Supabase 측정식) ≥ 460 이면 가장 오래된 이력 달을 삭제하고 그 달이 최고·최저였던 쌍의 `molit_hist_peaks` 를 남은 이력으로 재계산. 화면의 "○○ 이후 적재분" 은 이미 `sinceDate` 를 그대로 보여 주므로 자동 반영(장기 추세 캡션은 API 의 `since`).

## 완료 기준(전체)
- 2개월 연속 `sum(pg_database_size)` 증가가 월 +5 MB 이하. 검색 색인 단지 수가 옮기기 전후 동일. `/api/transactions/history` 의 단지별 합계 건수가 옮기기 전후 동일(겹침 방지 로직은 102 에 이미 있음). 경신 카드 건수가 옮기기 전후 동일(±당일 변동).

## STOP 조건
- 0단계에서 표에 없는 "전체 기간" 독자가 나오면 하위 계획을 쓰기 전에 설계를 다시 본다.

## 부록 A — 0단계 결과: 원본 독자 전수 목록 (2026-09-20, 조사 에이전트 수집 → 계획자가 "미확인" 항목을 코드로 재확인)
| 위치 | 기능 | 날짜 하한 | 이름 매칭 | 16개월 창의 영향 |
|---|---|---|---|---|
| `services/transactionService.js` `getTransactionsFromDb`(월 단위) ← `getTransactionsByApt`(기본 6, 화이트리스트 12·15) | 상세·공유 카드·비교 | 요청 월 | 예(JS 매칭) | **15개월까지 읽음 → 창 16 의 근거**. 창 밖 달은 ok 기록을 지워 API 폴백으로 두거나 요청 자체를 막는다 |
| 같은 파일 `getRegionRecentTransactions`(6개월)·`getTransactionsByAptSeq`(24개월, 공개 단지 페이지) | 추천·`/apt` | 6 / **24** | 아니오(apt_seq) | 24개월 요청은 16개월치만 나온다 → 문구 조정 또는 `aptHistoryService` 사용 |
| `services/chatDataRouter.js`(6개월·60일) · `services/popularService.js`(60일) · `routes/report.js`(6개월) · `jobs/pushNotify.js`(최근 알림 이후) · `routes/search.js:801`(180일) · `jobs/geocacheBackfill.js:403`(365일)·`:534`(기본 180일) · `routes/regionPage.js:169`(최근 7일 `ingested_at`) | 각종 최근 조회 | ≤ 12개월 | 일부 | 없음 |
| `services/aptFacilityService.js:127`(최신 60행) · `services/geocodeCacheService.js:395`(최신 40행) · `jobs/geocacheBackfill.js:244`(60행) · `services/buildingRegisterService.js:68`(1행) · `routes/search.js:577`(동별 최신 200행)·`:1043`(동별 500행) | 이름으로 지번·준공연도·동명 단지 찾기 | **하한 없음**(행 수 제한만) | 예 | 창 안에 거래가 있는 단지는 그대로. **16개월간 거래가 없는 단지는 지번·연도 조회가 빈다** → 보존 테이블(107a)에 `jibun`(최빈값)·`build_year` 를 함께 남기고 이 조회들이 폴백으로 읽게 |
| `server.js:502`(`count(*)`)·`routes/news.js:206`·`routes/cron.js:92,147,369` | 누적 건수·최신일·신선도 감시 | 최신 1건 / 전체 count | 아니오 | 누적 건수만 원본+이력 합계로 |
| `services/aptHistoryService.js`(102) | 장기 추세 | 전체 | 아니오 | 없음(겹침 방지 포함) |
| SQL: MV `molit_apt_index` · `refresh_molit_aliases`(`mj` 지번 최빈값) · `active_lawd_codes`(since 없을 때) | 검색 색인·별칭·활성 지역 | **전체 기간** | 예 | 107a 에서 보존 테이블과 합쳐 읽게 |
| SQL: `get_price_records*` | 경신 기준선 | 전체 기간 | 아니오 | 103 적용으로 이력 요약을 이미 읽는다 → 옮길 때 `molit_hist_peaks` 증분 upsert 만 |
| SQL: `search_popular_apts`(60일)·`get_br_backfill_candidates`(180일)·`geocache_backfill_candidates`(호출부 180일) | 최근 집계 | ≤ 6개월 | 일부 | 없음 |
- 쓰기: `jobs/molitIngest.js`(upsert, 최근 3개월)·`jobs/molitHistBackfill.js`(동결).
- 결론: 설계 방향 유지. 보존 테이블 컬럼에 `jibun` 추가가 필요하다는 것이 0단계의 새 발견.
