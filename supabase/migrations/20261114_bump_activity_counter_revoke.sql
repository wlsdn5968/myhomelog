-- AUDIT4-1114 (supabase/bump_activity_counter-secdef-no-revoke): 기록 정렬용 마이그레이션.
-- 20260819_activity_counters.sql 은 SECURITY DEFINER 함수 bump_activity_counter 를 만들면서 실행 권한 회수 문장을 남기지 않았다.
-- 운영 DB 는 이미 회수된 상태다(2026-11-14 읽기 전용 확인):
--   has_function_privilege('anon', ..., 'EXECUTE') = false, ('authenticated', ...) = false,
--   proacl = {postgres=X/postgres, service_role=X/postgres}
-- 그래서 이 파일은 운영에 다시 실행할 필요가 없고, 새 환경(로컬, 복구)에서도 같은 권한이 되도록 기록만 맞춘다. 다시 실행해도 결과가 같다.
-- 백엔드는 이 함수를 service_role 로만 부른다(backend/routes/account.js).

revoke execute on function public.bump_activity_counter(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.bump_activity_counter(uuid, integer, text) to service_role;
