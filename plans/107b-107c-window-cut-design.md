# 107b · 107c — 원본 16개월 창 자르기: 소비자 정비(107b) → 실제 자르기(107c) 설계

**작성 기준 커밋**: `376a546` (2026-09-26) · 부모: `plans/107-molit-rolling-archive.md`(부록 A·A-2) · `plans/104` §4·§8.3 · 선행: 107a(DONE, `molit_apt_dim` 배선) · **운영자 승인 2026-09-26**(후속표 5번 "107b/c 설계")
**목표**: `molit_transactions`(원본) 를 **최근 16개월**만 유지하고 그보다 오래된 달은 협폭 이력(`molit_transactions_hist`, 행당 ≈66B)으로 옮겨 **월 증가를 ≈16MB → ≈3~4MB 로** 낮춘다. 425MB 경보 예상일은 **2026-10-21 전후**(104 §8.3).

---

## 0. 먼저 정직하게: 자르기가 **크기를 당장 줄이지 않는다**
- `DELETE` + 일반 `VACUUM` 은 공간을 OS 로 돌려주지 않는다 — **테이블 안에서 재사용 가능**하게만 만든다(2026-09-20 `apt_geocache` 실측: 죽은 튜플 3,243→0 인데 파일 10.29MB 불변). 오래된 달은 힙의 **앞쪽**에 있어 VACUUM 의 꼬리 절단으로도 안 줄어든다.
- `VACUUM FULL`/`pg_repack` 은 새 힙+새 인덱스를 다 만든 뒤 옛것을 버리므로 **≈ 새 테이블 크기만큼 여유**(≈190MB)가 필요하다 — 현재 여유 ≈93MB 로 **불가능**. 이건 여유가 생길 때까지 선택지가 아니다.
- **그래서 이 설계의 효과는 "회수" 가 아니라 "성장 정지"** 다: 창 밖 달을 지우면 매일 적재되는 새 행이 **비워진 페이지를 재사용**하므로 원본 파일이 더 이상 자라지 않는다. 이력은 월 ≈2MB 만 자란다. 즉 총 증가 ≈16 → ≈3~4MB/월. **104 §4 의 "G 적용 후 월 +3~4" 는 이 뜻이다.**
- 그럼에도 **실제로 줄일 수 있는 것**: 인덱스. `REINDEX INDEX CONCURRENTLY` 는 **그 인덱스 하나 크기**만큼만 여유가 필요하고(최대 26.6MB), 창 자른 뒤 다시 만들면 살아 있는 행 수에 비례해 작아진다. 원본 인덱스 8개 116MB → 16/16.6 창이면 지금은 거의 안 줄지만, **매달 한 달씩 옮긴 뒤엔 그 비율만큼** 준다. 추가로 `molit_transactions_pkey`(10.1MB, `idx_scan=0`, FK 0)는 주머니 항목(104 §8.2).
- 결론: **107c 를 하지 않으면 2027-03 에 읽기 전용이 된다. 하면 성장이 멈추고 인덱스 재구성으로 조금씩 준다.** 425MB 경보(10-21 전후)는 **107c 를 해도 울릴 수 있다** — 경보는 고장이 아니라 예고(104 §8.3).

---

## 1. 107b — 창 자르기 **전에** 고쳐야 하는 소비자 (코드 + DDL, 데이터 삭제 0)
부록 A·A-2 의 "원본 전 기간을 전제한 독자" 를 창에 안전하게 만든다. **107c 는 아래 전부가 배포·검증된 뒤에만 시작한다.**

| # | 대상 | 지금 | 107b 조치 | 검증 |
|---|---|---|---|---|
| B1 | **MV `molit_apt_index`**(검색·자동완성·지도·`/apt`·`/region`·사이트맵·챗·워밍의 단지 식별) | `FROM molit_transactions` 만 집계(`schema.sql:456-466`) → 창 밖 단지가 **사라진다** | MV 의 **기반을 `molit_apt_dim`**(apt_seq 전수, 107a 가 보존)으로 바꾸고 원본 집계는 LEFT JOIN: `deal_count` = **창 안 건수**(0 가능) · `recent_deal_date` = `greatest(원본 max, dim.last_deal_date)` · **새 컬럼 `deal_count_all`** = `dim.deal_count`(과거 최대치 보존). 그룹 키(apt_name·lawd_cd·sigungu·umd_nm·build_year)와 `apt_seq` 선택 규칙(최근 거래 우선)은 유지 | 재정의 후 행수 ≥ 지금 23,017 · 창 밖 단지 apt_seq 가 MV 에 있음 · `refresh_molit_apt_index()` 시간(현재 ≈13초) 재측정 |
| B2 | **검색 랭킹 가중치** `search.js:273,282` `_w = deal_count` · 화면 "거래 N건"(`index.html:5750`) · `regionPage.js:107`·`aptPage.js:199`·`interestWarm.js:31` 정렬 | 전 기간 건수 | **의도적 결정**: 랭킹·정렬은 **창 안 건수(`deal_count`)** 유지 — "최근 활동" 이 관련성 신호로 더 옳다. 화면 "거래 N건" 은 **"최근 16개월 N건"** 으로 라벨을 바꾼다(숫자가 줄어드는 게 아니라 뜻이 정확해지는 것). `deal_count_all` 은 `/apt` 페이지 "누적 N건" 에만 | 라벨 변경 후 라이브 문구 확인 |
| B3 | **`refresh_molit_apt_dim()` 미스케줄** — 09-20 최초 채움 뒤 **한 번도 안 돌았다**(`dim_last_refresh = 2026-09-20`, 실측) | 신규 단지가 dim 에 안 들어감 | `molit-ingest` cron 의 MV 갱신(`mvRefreshMs`) 직후에 `admin.rpc('refresh_molit_apt_dim')` 호출(바뀐 행만 쓰는 upsert라 매일 돌려도 싸다) + `cronStats.NUM` 에 `dimRefreshed` | `health.crons['molit-ingest'].dimRefreshed` 가 숫자 · `max(refreshed_at)` 갱신 |
| B4 | **`dataCounts.tx`**(`server.js:getDataCounts`) → 랜딩·브리핑·OG 이미지 "실거래 누적" | 원본 `count(*)` 만 | `tx` = 원본 + 이력 합계(이력 count 는 인덱스 없는 129만 행 `count(*)` 가 느릴 수 있다 → `molit_hist_runs.rows_inserted` 합계나 별도 캐시 24h). 내부용 `txLive` 유지 | 브리핑 "실거래 누적" 이 1,76x,xxx 대로 |
| B5 | **경신 기준선** `get_price_records*` + `molit_hist_peaks`(2020-09~2025-04 1회성) | 옮겨진 달이 기준선에서 **빠진다** | 달을 옮길 때마다 `molit_hist_peaks` 를 **그 달 범위로 증분 upsert** 하는 함수 `upsert_hist_peaks(from_ym, to_ym)` 를 만든다(103 의 1회성 채움 SQL 을 파라미터화). 107c 절차의 **삭제 전 단계**에 고정 | 옮긴 뒤 `get_price_records` 의 `comparable` 건수가 줄지 않음 |
| B6 | **이름 매칭 보조 조회 6곳**(`aptFacilityService.js:127`·`geocodeCacheService.js:395`·`geocacheBackfill.js:244`·`buildingRegisterService.js:68`·`search.js:577`·`:1043`) — 날짜 하한 없이 원본에서 지번·준공연도 | 창 밖 단지는 빈 결과 | 공용 `aptDimService.findByName({ aptName, umdNm, lawdCd })`(dim 은 apt_seq 당 1행·`jibun`·`build_year` 보유) 를 만들고 6곳이 **원본이 비었을 때 폴백**으로 부른다. 원본 우선 유지(현재 동작 불변) | 창 밖 단지 이름으로 각 경로 호출 시 지번·연도 반환 |
| B7 | **`/apt/:seq` 요약 24개월**(`getTransactionsByAptSeq(seq, 24)`) | 창 16 < 24 | 요약을 `aptHistoryService`(원본+이력 병합, Plan 102) 로 만들어 **24개월 그대로** 유지 — 이력 행에도 `exclu_use_ar·deal_amount·floor·deal_date` 가 있어 평형별 중앙값·범위 계산이 가능하다 | 창 밖 8개월이 포함된 단지의 요약 건수가 자르기 전후 동일 |
| B8 | **적재 재시도 창** `molitIngest.retryFailedGaps(lookbackMonths=18)` | 창 밖 달의 error/timeout 기록을 **재적재**해 원본에 옛 달이 다시 들어올 수 있다 | `lookbackMonths` 를 창(16) 이하로. 그리고 107c 가 옮긴 달의 `molit_ingest_runs` 를 **`status='archived'`** 로 바꾼다 → **CHECK 확장 필요**(`'archived'` 추가 — 110 의 교훈: 코드가 쓰는 값이 CHECK 에 없으면 조용히 실패) | 옮긴 달의 runs 가 archived · 재시도 대상 0 |
| B9 | **사이트맵** `sitemap.js:118`(MV 기준, "거래 3+·최근 1년") | B1 로 MV 소속은 유지 | 필터는 **유지**(SEO 품질) — 1년 넘게 거래 없는 단지는 사이트맵에서 빠지지만 **페이지는 200** | 사이트맵 URL 수가 자르기 전후 ±5% 안 |
| B10 | 분석 비교 `analysisService` `dealMonths ≤ 24` | 창 밖 달은 MOLIT 라이브 API 폴백(느림) | 상한을 16 으로 클램프하거나 그대로(폴백이 있으니 저위험) — **그대로 두고 문서화** | — |

**107b 의 DDL(운영자 승인분)**: MV 재정의(B1) · `upsert_hist_peaks(from,to)`(B5) · `molit_ingest_runs_status_chk` 에 `'archived'` 추가(B8). 셋 다 **되돌리기 가능**(옛 정의로 재생성). 실행 순서: B3(코드) → B6·B7·B4·B2(코드) → B1·B5·B8(DDL+코드) → 라이브 검증 → 107c.

---

## 2. 107c — 실제 자르기 (달 단위 · 되돌리기 어려움 · 운영자 최종 승인 뒤)
**원칙**: 한 번에 **한 달**. 적재 창(17:00~19:00 UTC)·apt-master-sync(월 20:00 UTC) 밖. 각 단계 전후 `sum(pg_database_size)` 와 행수를 잰다. **첫 달은 2025-05**(가장 오래된 달, 이력 2025-04 와 정확히 이어진다).

절차(달 M):
```
a. refresh_molit_apt_dim()                             -- 이름·지번 보존 확인: dim 에 M 의 모든 apt_seq 존재
b. select upsert_hist_peaks(M, M)                      -- 경신 기준선에 M 반영 (B5)
c. insert into molit_transactions_hist (apt_seq, deal_date, exclu_use_ar, deal_amount, floor)
     select apt_seq, deal_date, exclu_use_ar::smallint, deal_amount, floor::smallint
       from molit_transactions where deal_date >= M-01 and deal_date < (M+1)-01 and apt_seq is not null;
   -- ⚠ hist 에는 유일 제약이 없다(인덱스 apt_seq 뿐). 같은 달을 두 번 넣으면 중복이 된다 →
   --   실행 전 `select count(*) from hist where deal_date in M` 이 0 인지 반드시 확인(첫 달은 0 이어야 정상).
d. 검증: 원본 M 행수(apt_seq not null) == 방금 hist 에 들어간 행수. 다르면 STOP(삭제 금지).
e. delete from molit_transactions where deal_date >= M-01 and deal_date < (M+1)-01;
f. update molit_ingest_runs set status='archived' where deal_ym = M;   -- B8
g. refresh_molit_apt_index();  vacuum (analyze) molit_transactions;   -- 파일은 안 줄어든다(§0) — 재사용 공간 확보
h. 측정: 원본 행수·hist 행수·get_price_records comparable·MV 행수·DB 합계 → 기록
```
- 첫 달 뒤 **라이브 전수**: 검색·자동완성·`/apt`(창 밖 단지 포함)·`/region`·브리핑 경신·챗 시세·사이트맵 건수·`dataCounts.tx`. 문제가 있으면 **다음 달을 옮기지 않는다**(원본은 아직 15.6개월치라 시간이 있다).
- 이후 **매달 1회** 같은 절차(수동 또는 cron). cron 화는 첫 3개월을 손으로 옮겨 절차가 안정된 뒤.
- 인덱스 회수(선택): 3개월 이상 옮긴 뒤 `REINDEX INDEX CONCURRENTLY` 를 큰 것부터 하나씩(`uq_molit_dedup` → trgm 2개 → 복합) — 각각 그 인덱스 크기만큼 여유 필요, 적재 창 밖.

**되돌리기**: hist 에 들어간 M 의 행을 원본으로 되돌리려면 이름·지번 등은 dim 에서, 나머지 컬럼(`dedup_key`·`sigungu` 등)은 **재생성 불가**(원본 적재기로 M 을 다시 적재하는 게 유일한 복구 — MOLIT API 재조회). 그래서 **d 단계의 건수 검증을 통과하지 못하면 절대 지우지 않는다.**

---

## 3. 이 설계가 하지 않는 것
- `VACUUM FULL`·`pg_repack`(여유 부족, §0) · `dedup_key` 타입 변경(재작성 필요) · 이력에 컬럼 추가(협폭 유지) · 창을 16 미만으로(A2-3 의 24개월 비교 API 와 `getTransactionsByApt` 15개월 화이트리스트가 하한).

## 4. 실행 계획으로 쪼개기 (다음 단계, 계획자)
- **107b-1**(코드, 실행자 1명): B3·B4·B6·B7·B2 라벨 — DB 변경 0. 테스트 각 1건.
- **107b-2**(DDL+코드): B1 MV 재정의 + B5 함수 + B8 CHECK/lookback — 리뷰어 DDL, 실행자 코드.
- **107c-1**(리뷰어, 운영자 최종 승인): 2025-05 한 달 절차 a~h + 라이브 전수.
- 시점: 107b-1 은 지금 착수 가능 · 107b-2 는 107b-1 검증 뒤 · 107c-1 은 둘 다 배포 뒤. **10-21 경보 전에 107b 까지** 끝내는 것이 목표.
