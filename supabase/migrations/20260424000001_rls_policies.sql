-- ============================================================================
-- Phase 4.1 — Row Level Security 정책 (Supabase)
--
-- 목적:
--   - 로그인 사용자는 자기 데이터만 SELECT/INSERT/UPDATE/DELETE 가능
--   - 백엔드가 service_role 키로 접근할 때만 cross-user 작업 허용
--   - JWT 미적용 시 0건 (페일클로즈 — 권한 누락이 곧 정보 유출이 되지 않도록)
--
-- 적용 방법:
--   1) Supabase Dashboard → SQL Editor 에서 본 파일 실행
--   2) 또는 Supabase MCP: apply_migration name="rls_policies"
--   3) 적용 후: SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public';
--      → 모든 사용자 데이터 테이블이 t (true) 여야 함
--
-- 참고:
--   - service_role 은 RLS 우회 — 백엔드가 어드민 작업 시 사용
--   - anon role 은 RLS 적용 — 로그인 안 한 사용자
--   - authenticated role 은 RLS 적용 + auth.uid() 가 JWT sub 로 채워짐
-- ============================================================================

-- ── bookmarks ─────────────────────────────────────────────────────────────
ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bookmarks_select_own ON public.bookmarks;
CREATE POLICY bookmarks_select_own ON public.bookmarks
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS bookmarks_insert_own ON public.bookmarks;
CREATE POLICY bookmarks_insert_own ON public.bookmarks
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS bookmarks_update_own ON public.bookmarks;
CREATE POLICY bookmarks_update_own ON public.bookmarks
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS bookmarks_delete_own ON public.bookmarks;
CREATE POLICY bookmarks_delete_own ON public.bookmarks
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ── search_history ────────────────────────────────────────────────────────
ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_history_select_own ON public.search_history;
CREATE POLICY search_history_select_own ON public.search_history
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS search_history_insert_own ON public.search_history;
CREATE POLICY search_history_insert_own ON public.search_history
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS search_history_delete_own ON public.search_history;
CREATE POLICY search_history_delete_own ON public.search_history
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ── chat_sessions ─────────────────────────────────────────────────────────
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_sessions_select_own ON public.chat_sessions;
CREATE POLICY chat_sessions_select_own ON public.chat_sessions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS chat_sessions_insert_own ON public.chat_sessions;
CREATE POLICY chat_sessions_insert_own ON public.chat_sessions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS chat_sessions_update_own ON public.chat_sessions;
CREATE POLICY chat_sessions_update_own ON public.chat_sessions
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS chat_sessions_delete_own ON public.chat_sessions;
CREATE POLICY chat_sessions_delete_own ON public.chat_sessions
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ── chat_messages — session 소유자만 접근 (간접) ────────────────────────
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_messages_select_own ON public.chat_messages;
CREATE POLICY chat_messages_select_own ON public.chat_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id
      AND s.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS chat_messages_insert_own ON public.chat_messages;
CREATE POLICY chat_messages_insert_own ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id
      AND s.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS chat_messages_delete_own ON public.chat_messages;
CREATE POLICY chat_messages_delete_own ON public.chat_messages
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.chat_sessions s
    WHERE s.id = chat_messages.session_id
      AND s.user_id = (SELECT auth.uid())
  ));

-- ── user_billing — 본인만 SELECT, 쓰기는 service_role 전용 ──────────────
ALTER TABLE public.user_billing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_billing_select_own ON public.user_billing;
CREATE POLICY user_billing_select_own ON public.user_billing
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
-- INSERT/UPDATE/DELETE 정책 의도적 미생성 → service_role 만 가능 (RLS 우회)

-- ── payments — 본인만 SELECT, 쓰기는 service_role 전용 ─────────────────
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select_own ON public.payments;
CREATE POLICY payments_select_own ON public.payments
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
-- INSERT/UPDATE/DELETE 미생성 → service_role 만 결제 기록 변경 가능

-- ── billing_plans — 모두 읽기 가능, 쓰기는 service_role 전용 ───────────
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_plans_select_all ON public.billing_plans;
CREATE POLICY billing_plans_select_all ON public.billing_plans
  FOR SELECT TO anon, authenticated
  USING (active = true);  -- 실제 schema 는 boolean (이전 phase3 migration 기준)

-- ── 검증 쿼리 (적용 후 실행 권장) ──────────────────────────────────────
-- SELECT schemaname, tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' ORDER BY tablename;
-- SELECT * FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
