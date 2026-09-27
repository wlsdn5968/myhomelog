-- ============================================================================
-- 2026-09-27 03:19 UTC — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 apply_migration 로 실행).
--   이 파일은 **적용 기록**이다(Plan 111 2단계 보정). 근본 원인: 2026-09-20 DB 감사의 함정 1번
--   (relkind='r' 만 보면 MV 누락)이 Plan 111 2단계 함수에 그대로 들어가 molit_apt_index(6.4MB)가
--   테이블 감시에서 빠졌다.
-- ============================================================================
-- [무엇인가]
--   public.get_table_health() 함수의 WHERE 절을 c.relkind = 'r' 에서
--   c.relkind in ('r', 'm') 으로 변경. 이제 매터리얼라이즈드 뷰(MV)도 테이블 감시에 포함된다.
--   pg_stat_user_tables 는 relkind r(일반 테이블)/t(TOAST 테이블)/m(매터리얼라이즈드 뷰) 을
--   모두 담으므로 조인은 그대로.
-- [실측값 — 적용 직후 `select * from public.get_table_health() limit 6`]
--   molit_transactions 222.0 / 0.00 / 0 · molit_transactions_hist 85.4 / 0.01 / 7 ·
--   apt_master 28.1 / 2.05 / 12 · apt_geocache 10.3 / 0.00 / 0 · molit_hist_peaks 9.0 / 0.00 / 0 ·
--   molit_apt_index 6.4 / 0.00 / 0 (MV, 신규 포함). 전체 DB 413.1MB.
-- [되돌리기 SQL]
--   create or replace function public.get_table_health()
--   returns table(relname text, total_mb numeric, dead_pct numeric, days_since_vacuum integer)
--   language sql set search_path to 'public' as $function$
--     select c.relname::text,
--            round(pg_total_relation_size(c.oid) / 1048576.0, 1),
--            round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 2),
--            extract(day from now() - greatest(s.last_autovacuum, s.last_vacuum))::integer
--       from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--       join pg_stat_user_tables s on s.relid = c.oid
--      where n.nspname = 'public' and c.relkind = 'r'
--        and pg_total_relation_size(c.oid) > 1048576
--      order by pg_total_relation_size(c.oid) desc
--   $function$;
-- ============================================================================

create or replace function public.get_table_health()
returns table(relname text, total_mb numeric, dead_pct numeric, days_since_vacuum integer)
language sql set search_path to 'public' as $function$
  select c.relname::text,
         round(pg_total_relation_size(c.oid) / 1048576.0, 1),
         round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 2),
         extract(day from now() - greatest(s.last_autovacuum, s.last_vacuum))::integer
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_stat_user_tables s on s.relid = c.oid
   where n.nspname = 'public' and c.relkind in ('r', 'm')
     and pg_total_relation_size(c.oid) > 1048576
   order by pg_total_relation_size(c.oid) desc
$function$;
