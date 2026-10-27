-- ============================================================================
-- 107c-3 — 원본 창 자르기 2025-07 (plans/107c-3-cut-202507.md). 아직 실행 안 됨 — **2026-11-01 이후에만**.
-- 순서: P1~P5 재실측 → b → c → d(셋 다 일치) → e+f(운영자 SQL Editor) → g → h 측정 → i 인덱스 회수.
-- 각 단계는 **별도 문장**으로 실행한다(쓰기와 측정을 한 문장에 넣으면 스냅샷 때문에 변화 0 으로 보인다).
-- ============================================================================

-- [b] 경신 기준선 합산 — 반환값 기록. 전후 행수는 별도 문장.
select public.upsert_hist_peaks_for_month('202507');
select count(*) from public.molit_hist_peaks;   -- 82,464(10-27) → 증가 확인

-- [c] 이력 복사
insert into public.molit_transactions_hist (apt_seq, deal_date, exclu_use_ar, deal_amount, floor)
select t.apt_seq, t.deal_date,
       least(round(t.exclu_use_ar * 100), 32767)::smallint,
       t.deal_amount,
       least(greatest(coalesce(t.floor, 0), -32768), 32767)::smallint
  from public.molit_transactions t
 where t.deal_date >= '2025-07-01' and t.deal_date < '2025-08-01' and t.apt_seq is not null;

-- [d] 대조 — live_rows = hist_rows, live_sum = hist_sum, 양방향 차집합 0/0 이어야 e 로 간다. 다르면 STOP(§5 되돌리기).
select (select count(*) from public.molit_transactions where deal_date >= '2025-07-01' and deal_date < '2025-08-01') as live_rows,
       (select count(*) from public.molit_transactions_hist where deal_date >= '2025-07-01' and deal_date < '2025-08-01') as hist_rows,
       (select sum(deal_amount) from public.molit_transactions where deal_date >= '2025-07-01' and deal_date < '2025-08-01') as live_sum,
       (select sum(deal_amount) from public.molit_transactions_hist where deal_date >= '2025-07-01' and deal_date < '2025-08-01') as hist_sum;
select count(*) from (
  select apt_seq, deal_date, least(round(exclu_use_ar*100),32767)::smallint a, deal_amount from public.molit_transactions
   where deal_date >= '2025-07-01' and deal_date < '2025-08-01'
  except all
  select apt_seq, deal_date, exclu_use_ar, deal_amount from public.molit_transactions_hist
   where deal_date >= '2025-07-01' and deal_date < '2025-08-01') x;   -- 0
select count(*) from (
  select apt_seq, deal_date, exclu_use_ar, deal_amount from public.molit_transactions_hist
   where deal_date >= '2025-07-01' and deal_date < '2025-08-01'
  except all
  select apt_seq, deal_date, least(round(exclu_use_ar*100),32767)::smallint a, deal_amount from public.molit_transactions
   where deal_date >= '2025-07-01' and deal_date < '2025-08-01') x;   -- 0

-- [e+f] ★ 운영자 SQL Editor — d 가 전부 일치한 뒤에만. 두 문장을 함께 붙여 넣고 Run.
-- delete from public.molit_transactions where deal_date >= '2025-07-01' and deal_date < '2025-08-01';
-- update public.molit_ingest_runs set status = 'archived'
--  where deal_ym = '202507' and status in ('ok','error','skipped','timeout');

-- [g] 단독 문장 · VACUUM 은 트랜잭션 밖
select public.refresh_molit_apt_index();
-- vacuum (analyze) public.molit_transactions;

-- [i] 인덱스 회수(세 달 이동 뒤 처음) — 실행 당일 대상·크기를 먼저 잰다
-- select indexrelid::regclass, pg_size_pretty(pg_relation_size(indexrelid)) from pg_index where indrelid = 'public.molit_transactions'::regclass order by pg_relation_size(indexrelid) desc;
-- reindex index concurrently <위 결과의 큰 인덱스>;   -- 한 번에 하나, 전후 크기 측정
