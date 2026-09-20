-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어 실행). 적용 기록.
--   [왜] Supabase 무료 한도 500MB 의 기준은 **클러스터 전 DB 합계**(공식 문서 "Understanding Database and Disk Size")인데
--   두 함수는 current_database() 만 재서 14.4MB 작게 나왔다(template0 7.2 + template1 7.2).
--   [검증] 적용 후 get_db_size_bytes()·db_size_mb() 가 sum(pg_database_size(datname)) 와 같은 값을 돌려주고,
--          EXECUTE 권한은 둘 다 service_role 뿐으로 유지됨을 확인했다.
--   [되돌리기] 두 함수 본문을 각각 `select pg_database_size(current_database())` /
--              `select round(pg_database_size(current_database()) / 1048576.0, 1)` 로 되돌린다.

CREATE OR REPLACE FUNCTION public.get_db_size_bytes() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select sum(pg_database_size(datname))::bigint from pg_database $function$;

CREATE OR REPLACE FUNCTION public.db_size_mb() RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select round(sum(pg_database_size(datname)) / 1048576.0, 1) from pg_database $function$;

-- 확인: select public.get_db_size_bytes(), public.db_size_mb();   → 합계 쿼리와 같은 값. 권한(EXECUTE)은 CREATE OR REPLACE 로 바뀌지 않는다.
