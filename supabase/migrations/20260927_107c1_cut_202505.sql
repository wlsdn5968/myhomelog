-- ============================================================================
-- 2026-09-27 03:09~03:10 UTC — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 실행).
--   이 파일은 **적용 기록**이다(Plan 107c-1 — 설계 §2 절차 a~h 의 실행 기록, 요약 표는 설계 §5).
--   설계 plans/107b-107c-window-cut-design.md 참조.
-- ============================================================================
-- [무엇인가]
--   Plan 107c-1: 원본 molit_transactions 를 협폭 이력으로 월별 이동(16개월 창 밖 데이터). b 단계에서
--   upsert_hist_peaks_for_month('202505') 호출로 2025-05 peaks 경신(81,462→81,918). c 단계 마이그레이션
--   20260927_107c1_copy_202505_to_hist(03:09:26Z) 로 원본 31,299행 복사. d 단계 검증(31,299=31,299,
--   양방향 차집합 0, 금액 합 동일) 통과 뒤 e+f 단계 마이그레이션 20260927_107c1_delete_202505_from_live(03:10:01Z)
--   로 삭제(원본 476,719→445,420, 이력 1,290,112→1,321,411). molit_ingest_runs 의 202505 행 archived 표시.
--   g 단계에서 refresh_molit_apt_index() 5.1s 실행 후 molit_transactions VACUUM(ANALYZE).
--   h 측정: MV 27,780행 · comparedCount 2,684/206/64 변화 0 · /apt/43114-58 75건 유지 ·
--   원본 파일 222.02MB 그대로 · DB 합계 413.1MB(peaks·dim·ingest_runs 갱신 churn +5.1).
-- [⚠ 파일 크기는 줄지 않는다]
--   설계 §0 예측대로 molit_transactions 파일은 222.02MB 그대로다. DELETE 뒤 VACUUM 은 지운 자리를 "재사용 가능" 으로
--   표시할 뿐 OS 에 돌려주지 않는다(파일 끝의 빈 페이지만 잘린다). 돌려주려면 VACUUM FULL/pg_repack 이 필요한데 새 테이블
--   크기(≈190MB)만큼 여유가 없어 불가. 효과는 "성장 정지"(+16 → +3~4MB/월). 인덱스는 3개월 이상 옮긴 뒤 REINDEX CONCURRENTLY 로 회수.
-- [실측값 — 적용 직후]
--   사전 검증: 원본 2025-05 행 31,299(전부 apt_seq 보유) · 이력 2025-05 행 0(hist max 2025-04-30,
--   live min 2025-05-01) · dim 누락 0 · b 단계 경신 합산 완료.
--   b 단계(03:09Z 이전, 함수 호출): upsert_hist_peaks_for_month('202505') 반환 17,993 ·
--   molit_hist_peaks 81,462→81,918(별도 문장 재측정).
--   c 단계: 마이그레이션 20260927_107c1_copy_202505_to_hist(버전 20260927030926, 03:09:26Z) 복사 31,299행.
--   d 단계 검증: 31,299=31,299 · 양방향 차집합 0 · 금액 합 동일.
--   e+f 단계: 마이그레이션 20260927_107c1_delete_202505_from_live(버전 20260927031001, 03:10:01Z) 삭제 31,299 →
--   원본 476,719→445,420 · 이력 1,290,112→1,321,411. molit_ingest_runs 202505 행 archived.
--   g 단계: refresh_molit_apt_index() 5.1s · VACUUM(ANALYZE) molit_transactions.
--   h 측정: MV 27,780행 · comparedCount 2,684/206/64 변화 0 · /apt/43114-58 75건 유지 ·
--   molit_transactions 파일 222.02MB 그대로 · DB 합계 408.0→413.1MB(+5.1 peaks·dim·ingest_runs churn).
-- [되돌리기 SQL]
--   이력 삭제: delete from public.molit_transactions_hist where deal_date >= '2025-05-01' and deal_date < '2025-06-01';
--   원본 재적재: 원본은 재생성 불가 → 적재기 fetchRegionMonth(lawd_cd, '202505') 로 MOLIT API 재적재(무료).
--   협폭 이력에는 2025-05 가 남아 있다.
-- ============================================================================

-- b 단계 (함수 호출, 03:09Z 이전) — 반환 17,993 · peaks 81,462 → 81,918
select public.upsert_hist_peaks_for_month('202505');

-- c 단계 — 마이그레이션 20260927_107c1_copy_202505_to_hist (03:09:26Z) — 31,299행
-- Plan 107c-1 c 단계 (운영자 승인 2026-09-27) — 2025-05 원본 행을 협폭 이력으로 복사(삭제는 d 단계 건수 검증 뒤 별도).
--   사전 검증: 원본 5월 31,299행(전부 apt_seq 보유) · 이력 5월 0행(hist max 2025-04-30, live min 2025-05-01) ·
--   dim 누락 0 · 경신 요약 b 단계 완료(81,462→81,918). exclu_use_ar 는 ㎡×100 smallint(이력 규약).
-- 되돌리기: delete from public.molit_transactions_hist where deal_date >= '2025-05-01' and deal_date < '2025-06-01';
insert into public.molit_transactions_hist (apt_seq, deal_date, exclu_use_ar, deal_amount, floor)
select t.apt_seq, t.deal_date,
       least(round(t.exclu_use_ar * 100), 32767)::smallint,
       t.deal_amount,
       least(greatest(coalesce(t.floor, 0), -32768), 32767)::smallint
  from public.molit_transactions t
 where t.deal_date >= '2025-05-01' and t.deal_date < '2025-06-01' and t.apt_seq is not null;

-- d 단계 검증(삭제 전): 31,299 = 31,299 · 양방향 차집합 0 · 금액 합 동일

-- e+f 단계 — 마이그레이션 20260927_107c1_delete_202505_from_live (03:10:01Z) — 삭제 31,299
-- Plan 107c-1 e+f 단계 (운영자 승인 2026-09-27) — d 단계 검증(31,299=31,299, 양방향 차집합 0, 금액 합 동일) 통과 후 삭제.
--   되돌리기: 원본 적재기(fetchRegionMonth)로 (lawd_cd, 202505) 를 재적재(MOLIT API, 무료) — 협폭 이력에는 5월이 남아 있다.
delete from public.molit_transactions
 where deal_date >= '2025-05-01' and deal_date < '2025-06-01';

update public.molit_ingest_runs
   set status = 'archived'
 where deal_ym = '202505' and status in ('ok','error','skipped','timeout');

-- g 단계 — 단독 문장 · 5.1s / VACUUM 은 트랜잭션 밖
select public.refresh_molit_apt_index();
vacuum (analyze) public.molit_transactions;
