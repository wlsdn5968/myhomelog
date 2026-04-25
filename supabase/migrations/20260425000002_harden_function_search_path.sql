-- ============================================================================
-- 보안 advisor 후속 처리 — SECURITY DEFINER 함수 search_path 고정
--
-- 배경:
--   - Supabase database-linter 가 0011_function_search_path_mutable 경고
--   - SECURITY DEFINER 함수는 호출자 search_path 영향을 받으면
--     공격자가 동일 schema 에 위장 함수/테이블 심어 권한 탈취 가능.
--
-- 조치:
--   - 명시적으로 search_path = public, pg_catalog 만 허용
--   - 다른 schema 의 동명 함수/테이블 차단
--
-- 참고: https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable
-- ============================================================================

ALTER FUNCTION public.increment_user_budget(uuid, date, bigint, bigint, bigint)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.prune_audit_log()
  SET search_path = public, pg_catalog;
