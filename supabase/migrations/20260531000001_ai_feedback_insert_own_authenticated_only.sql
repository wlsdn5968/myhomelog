-- ai_feedback_insert_own 을 authenticated 한정으로 재생성 (2026-05-31)
--
-- 배경 (Supabase performance advisor 0006 multiple_permissive_policies WARN):
--   20260504000003_security_perf_advisor_fixes.sql 가 ai_feedback_insert_own 을
--   `FOR INSERT WITH CHECK (...)` (TO 절 없음 → roles=public) 로 재생성함.
--   public 은 anon 을 포함하므로, anon INSERT 시 ai_feedback_insert_anon 과
--   ai_feedback_insert_own 두 permissive 정책이 모두 평가됨 (RLS 이중 평가).
--
-- 수정:
--   insert_own 을 TO authenticated 로 한정 → anon 은 insert_anon(user_id IS NULL) 만 평가.
--   동작 불변(behavior-preserving): 로그인 사용자는 본인 user_id, 비로그인은 user_id NULL.
--
-- ※ Supabase MCP apply_migration 으로 이미 적용됨 — 본 파일은 git tracking 용 (SSOT 정합).

DROP POLICY IF EXISTS ai_feedback_insert_own ON public.ai_feedback;
CREATE POLICY ai_feedback_insert_own ON public.ai_feedback
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
