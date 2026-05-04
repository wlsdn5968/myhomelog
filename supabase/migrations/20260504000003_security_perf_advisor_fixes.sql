-- Phase 36 (2026-05-04): Supabase advisor 보안 + 성능 fix
--
-- 발견 (Claude 외부 컨설턴트, Supabase MCP read-only 직접 검증):
--   보안 advisor 3건 WARN — SECURITY DEFINER 함수 anon/authenticated 노출
--   성능 advisor 6건 WARN — RLS auth.uid() row 마다 재평가
--
-- 안전성:
--   - 보안 fix: REVOKE EXECUTE only — 백엔드는 service_role 사용 → 영향 X
--   - 성능 fix: RLS 정책 재정의 — 의미 동일, 평가 횟수만 1회로 → 사용자 영향 X
--   - 트랜잭션 안에서 실행 — 부분 실패 시 자동 rollback
--
-- 실행 (운영자 직접):
--   Supabase Dashboard → SQL Editor → New query → 본 파일 복붙 → Run
--
-- 검증:
--   - Database → Advisors → "Public Can Execute SECURITY DEFINER Function" 3건 사라짐
--   - Database → Advisors → "Auth RLS Initialization Plan" 6건 사라짐
--   - 별도: Authentication → Providers → Email → "Leaked password protection" 토글 ON

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. 보안: SECURITY DEFINER 함수 anon/authenticated 권한 회수
-- ═══════════════════════════════════════════════════════════════
-- prune_audit_log: pg_cron 만 호출해야 함 (anon 호출 시 audit_log 임의 삭제 risk)
REVOKE EXECUTE ON FUNCTION public.prune_audit_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_audit_log() TO service_role;

-- increment_user_budget: 백엔드만 호출해야 함 (anon 호출 시 사용자 예산 조작 risk)
REVOKE EXECUTE ON FUNCTION public.increment_user_budget(uuid, date, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_budget(uuid, date, bigint, bigint, bigint) TO service_role;

-- tg_set_updated_at: trigger 함수 — RPC 노출 자체 잘못
REVOKE EXECUTE ON FUNCTION public.tg_set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_set_updated_at() TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- 2. 성능: RLS auth.uid() row 마다 재평가 → 1회 평가
-- ═══════════════════════════════════════════════════════════════
-- field_notes 4개 정책
DROP POLICY IF EXISTS field_notes_select_own ON public.field_notes;
CREATE POLICY field_notes_select_own ON public.field_notes
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS field_notes_insert_own ON public.field_notes;
CREATE POLICY field_notes_insert_own ON public.field_notes
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS field_notes_update_own ON public.field_notes;
CREATE POLICY field_notes_update_own ON public.field_notes
  FOR UPDATE USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS field_notes_delete_own ON public.field_notes;
CREATE POLICY field_notes_delete_own ON public.field_notes
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- ai_feedback 2개 정책
DROP POLICY IF EXISTS ai_feedback_select_own ON public.ai_feedback;
CREATE POLICY ai_feedback_select_own ON public.ai_feedback
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS ai_feedback_insert_own ON public.ai_feedback;
CREATE POLICY ai_feedback_insert_own ON public.ai_feedback
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

COMMIT;

-- ═══════════════════════════════════════════════════════════════
-- 3. 검증 (별도 query 실행 — COMMIT 이후)
-- ═══════════════════════════════════════════════════════════════
-- (a) SECURITY DEFINER 권한 회수 확인
--     anon/authenticated 가 결과에 없어야 정상
-- SELECT routine_name, grantee, privilege_type
-- FROM information_schema.role_routine_grants
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('prune_audit_log', 'increment_user_budget', 'tg_set_updated_at')
-- ORDER BY routine_name, grantee;

-- (b) RLS 정책 (SELECT auth.uid()) 적용 확인
-- SELECT tablename, policyname, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('field_notes', 'ai_feedback')
-- ORDER BY tablename, policyname;
-- → qual 에 "(SELECT auth.uid())" 보이면 성공
