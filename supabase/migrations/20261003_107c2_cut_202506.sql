-- ============================================================================
-- 2026-10-03 UTC(VACUUM 완료 03:27:42Z) — 이미 프로덕션에 적용됨(운영자 승인 2026-10-02·10-03).
--   이 파일은 **적용 기록**이다(Plan 107c-2 — plans/107c-2-cut-202506.md §3 절차 b~h 의 실행 기록,
--   요약 표는 plans/107b-107c-window-cut-design.md §5).
-- ============================================================================
-- [무엇인가]
--   Plan 107c-2: 원본 molit_transactions 의 2025-06 한 달을 협폭 이력 molit_transactions_hist 로 이동.
--   b·c·g 는 계획자가 실행, e+f 는 Supabase 확인 단계가 apply_migration 을 declined 로 돌려보내
--   운영자가 SQL Editor 에서 직접 실행했다(그래서 schema_migrations 에는 c 단계 이름만 있다).
-- [사전 점검 — 2026-10-03 01:53Z 실측]
--   P1 now >= 2026-10-01 true · P2 원본 최소 2025-06-01 / 이력 최대 2025-05-31 · P3 이력 6월 0 ·
--   P4 6월 apt_seq null 0 · dim 누락 0 · P5 적재 구멍 0(Plan 130 이 202506 의 신설 코드 7쌍을
--   2026-10-02 17:20Z 에 채움) · 원본 6월 40,527행 · 금액 합 3,087,764,464.
-- [실측값]
--   b 단계(함수 호출): upsert_hist_peaks_for_month('202506') 반환 20,859 ·
--   molit_hist_peaks 81,921 → 82,464(별도 문장 재측정).
--   c 단계: 마이그레이션 20261003_107c2_copy_202506_to_hist 복사 40,527행.
--   d 단계 대조: 40,527 = 40,527 · 금액 합 3,087,764,464 동일 · 양방향 차집합(except all) 0 / 0.
--   e+f 단계(운영자 SQL Editor): 원본 481,475 → 440,948(−40,527) · 이력 1,321,856 → 1,362,383 ·
--   molit_ingest_runs 202506 → archived 137행(ok 125 + error 12).
--   g 단계: refresh_molit_apt_index() 완료(MV 28,086행) · VACUUM(ANALYZE) molit_transactions(dead 0).
--   h 측정(03:2xZ): 원본 최소 2025-07-01 · 이력 최대 2025-06-30 · peaks ≡ 이력 집계
--   (82,464키, 양쪽 누락 0 · 값 불일치 0) · molit_transactions 230.75MB(파일은 줄지 않는다 — 107c-1 과 같음) ·
--   DB 합계 415.1MB.
--   h 라이브(2026-10-14 재측정): /apt/43114-58 200 · 거래 78건 = 원본 60 + 이력 18(2024-11-01 이후 —
--   6월분 이력 3건 포함) · 검색 "시티팰리스9차" dealCount 0 / dealCountAll 146 · /region/41111 200 ·
--   11일 뒤에도 원본 최소 2025-07-01 · 이력 6월 40,527행·금액 합 동일 · 202506 runs 전부 archived.
--   미측정: get_price_records comparedCount(107c-1 때의 입력값이 기록에 없어 같은 입력으로 재호출 불가).
-- [되돌리기 SQL]
--   이력 삭제: delete from public.molit_transactions_hist where deal_date >= '2025-06-01' and deal_date < '2025-07-01';
--   원본 재적재: 원본은 재생성 불가 → 적재기 fetchRegionMonth(lawd_cd, '202506') 로 MOLIT API 재적재(무료).
--   협폭 이력에는 2025-06 이 남아 있다.
-- ============================================================================

-- b 단계 (함수 호출) — 반환 20,859 · peaks 81,921 → 82,464
select public.upsert_hist_peaks_for_month('202506');

-- c 단계 — 마이그레이션 20261003_107c2_copy_202506_to_hist — 40,527행
insert into public.molit_transactions_hist (apt_seq, deal_date, exclu_use_ar, deal_amount, floor)
select t.apt_seq, t.deal_date,
       least(round(t.exclu_use_ar * 100), 32767)::smallint,
       t.deal_amount,
       least(greatest(coalesce(t.floor, 0), -32768), 32767)::smallint
  from public.molit_transactions t
 where t.deal_date >= '2025-06-01' and t.deal_date < '2025-07-01' and t.apt_seq is not null;

-- d 단계 대조(삭제 전): 40,527 = 40,527 · 금액 합 동일 · 양방향 차집합 0 / 0

-- e+f 단계 — 운영자 SQL Editor 실행(apply_migration 20261003_107c2_delete_202506_from_live 는 declined)
delete from public.molit_transactions
 where deal_date >= '2025-06-01' and deal_date < '2025-07-01';

update public.molit_ingest_runs
   set status = 'archived'
 where deal_ym = '202506' and status in ('ok','error','skipped','timeout');

-- g 단계 — 각각 단독 문장 / VACUUM 은 트랜잭션 밖
select public.refresh_molit_apt_index();
vacuum (analyze) public.molit_transactions;
