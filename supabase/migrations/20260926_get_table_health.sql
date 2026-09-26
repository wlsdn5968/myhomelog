-- ============================================================================
-- 2026-09-26 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례). plans/111-db-capacity-observability.md
--   2단계(Step 2-1) 기반.
-- ============================================================================
-- [무엇인가]
--   테이블별 크기·죽은 튜플 비율·마지막 vacuum 경과일을 돌려주는 조회 함수. retention cron
--   (backend/routes/cron.js checkDbCapacity())이 매일 읽어 "특정 테이블만 급증" 과
--   "autovacuum 정지" 를 Sentry 로 알린다(plans/104 §8.4: apt_geocache 가 29일째 autovacuum
--   미실행이었는데 어떤 신호로도 안 보였다).
-- [⚠ 분모 주의]
--   dead_pct 의 분모는 n_dead_tup / (n_live_tup + n_dead_tup) 다 — 2026-09-20 감사에서
--   에이전트 2개가 분모를 n_live_tup 만으로 잡아 14.04%를 16.33%로 과대 보고했다.
-- [⚠ SECURITY DEFINER 를 쓰지 않는다]
--   pg_stat_user_tables·pg_class 는 호출자(service_role) 권한으로 읽힌다(최소 권한) —
--   적용본은 prosecdef=false.
-- [실측값 — 적용 직후 `select * from get_table_health() limit 3`]
--   molit_transactions 221.9 / 0.00 / 0 · molit_transactions_hist 83.4 / 0.01 / 6 ·
--   apt_master 28.1 / 2.05 / 11
-- [되돌리기 SQL]
--   drop function public.get_table_health();
-- ============================================================================

-- Plan 111 2단계 (운영자 승인 2026-09-26) — 테이블별 크기·죽은 튜플 비율·마지막 vacuum 경과일.
--   retention cron 이 매일 읽어 "특정 테이블만 급증" 과 "autovacuum 정지" 를 Sentry 로 알린다(plans/104 §8.4:
--   apt_geocache 가 29일째 autovacuum 미실행이었는데 어떤 신호로도 안 보였다).
-- ⚠ 분모는 n_dead_tup / (n_live_tup + n_dead_tup) — 2026-09-20 감사에서 분모를 live 만으로 잡아 과대 보고한 오류가 2건 있었다.
-- ⚠ SECURITY DEFINER 를 쓰지 않는다: pg_stat_user_tables·pg_class 는 호출자(service_role) 권한으로 읽힌다(최소 권한).
-- 되돌리기: drop function public.get_table_health();
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
   where n.nspname = 'public' and c.relkind = 'r'
     and pg_total_relation_size(c.oid) > 1048576
   order by pg_total_relation_size(c.oid) desc
$function$;
