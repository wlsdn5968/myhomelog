-- Plan 105: DB 용량을 Supabase 측정식(전 DB 합계)으로 — 이미 프로덕션에 적용됨, 적용 기록
-- 2026-09-20 실사고: health 의 warn 플래그만 있고 경보가 없어 96%(482MB)가 될 때까지 아무도 몰랐다
-- 고정 메시지(이슈 그룹 유지) + 가변값은 extra. 실패는 삼킨다(감시가 retention 을 죽이면 안 된다).

CREATE OR REPLACE FUNCTION public.get_db_size_bytes() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select sum(pg_database_size(datname))::bigint from pg_database $function$;

CREATE OR REPLACE FUNCTION public.db_size_mb() RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select round(sum(pg_database_size(datname)) / 1048576.0, 1) from pg_database $function$;

-- 확인: select public.get_db_size_bytes(), public.db_size_mb();   → 합계 쿼리와 같은 값. 권한(EXECUTE)은 CREATE OR REPLACE 로 바뀌지 않는다.
