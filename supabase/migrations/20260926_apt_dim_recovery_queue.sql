-- ============================================================================
-- 2026-09-26 06:59 UTC — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 apply_migration 으로 실행, version 20260926065942).
--   이 파일은 **적용 기록**이다(Plan 117 계획서 요구). 근본 원인: Plan 117 에서
--   apt_dim_recovery_queue DDL과 적용 SQL 을 운영에 적용했으나 schema.sql 과
--   migrations 기록 파일을 남기지 않았다.
-- ============================================================================
-- [무엇인가]
--   public.apt_dim_recovery_queue 테이블 생성 + 초기 데이터 삽입.
--   이력 전용 단지 이름 복구 작업 큐.
-- [실측값]
--   적용 직후(2026-09-26): 2,748 조합 · 5,444 단지 · 전부 pending.
--   소진(마지막 처리 2026-09-27 06:18Z): 2,748 조합 전부 ok · names_found 합 5,405 — 39 단지는 MOLIT 응답에 없어 미복구.
-- [되돌리기 SQL]
--   drop table public.apt_dim_recovery_queue;
-- ============================================================================

-- Plan 117 Step 0 (운영자 승인 2026-09-26) — 이력 전용 단지 이름 복구 작업 큐.
--   각 미복구 단지의 최근 거래월 하나 → (지역,월) 조합 2,748개(실측). 하루 10슬롯(hist backfill 의 빈 슬롯)이
--   MOLIT API 를 다시 불러 apt_seq→이름·지번을 molit_apt_dim 에 채운다(on conflict do nothing — 기존 22,672행 불변).
-- 되돌리기: drop table public.apt_dim_recovery_queue;
create table if not exists public.apt_dim_recovery_queue (
  lawd_cd       text not null,
  deal_ym       text not null,
  apt_seqs      integer not null,
  status        text not null default 'pending' check (status in ('pending','ok','error')),
  tried_at      timestamptz,
  names_found   integer,
  error_message text,
  primary key (lawd_cd, deal_ym)
);
alter table public.apt_dim_recovery_queue enable row level security;

insert into public.apt_dim_recovery_queue (lawd_cd, deal_ym, apt_seqs)
with live as (select distinct apt_seq from public.molit_transactions where apt_seq is not null),
     dim  as (select apt_seq from public.molit_apt_dim),
     miss as (
       select h.apt_seq, max(h.deal_date) as last_deal
         from public.molit_transactions_hist h
        where h.apt_seq is not null
          and not exists (select 1 from live l where l.apt_seq = h.apt_seq)
          and not exists (select 1 from dim  d where d.apt_seq = h.apt_seq)
        group by h.apt_seq)
select split_part(apt_seq,'-',1), to_char(last_deal,'YYYYMM'), count(*)
  from miss group by 1,2
on conflict do nothing;
