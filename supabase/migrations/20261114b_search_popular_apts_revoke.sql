-- AUDIT5-1114 (보안 점검 run-5 보강 메모): search_popular_apts(integer) 는 마이그레이션 기록에 실행 권한 회수 문장이 없었다.
-- 운영 DB 는 이미 회수된 상태다(2026-11-14 읽기 전용 확인): proacl = {postgres=X/postgres, service_role=X/postgres}.
-- 또 public 스키마 함수 중 anon, authenticated 가 실행할 수 있는 함수는 0개였다(같은 날 has_function_privilege 전수 조회).
-- 이 파일은 새 환경(로컬, 복구)에서도 같은 권한이 되도록 기록만 맞춘다. 다시 실행해도 결과가 같다.

revoke execute on function public.search_popular_apts(integer) from public, anon, authenticated;
grant execute on function public.search_popular_apts(integer) to service_role;
