-- RLS 중복 정책 정리 (Phase 2 후속, 2026-04-25)
--
-- 문제:
--   bookmarks/chat_messages/chat_sessions/search_history/billing_plans 5개 테이블에
--   같은 동작에 대해 정책이 2개씩 등록됨 (다른 마이그레이션에서 다른 이름으로).
--   매 쿼리 두 정책 모두 평가 → RLS overhead 2배.
--   Supabase advisor: Multiple Permissive Policies WARN 13건.
--
-- 해결:
--   짧고 명료한 이름(*_own / *_public_read) 유지, 중복(*_owner_*) DROP.
--   동작은 100% 동일 (auth.uid() = user_id 기준)이므로 사용자 영향 없음.
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용

-- bookmarks
DROP POLICY IF EXISTS bookmarks_owner_select ON public.bookmarks;
DROP POLICY IF EXISTS bookmarks_owner_insert ON public.bookmarks;
DROP POLICY IF EXISTS bookmarks_owner_update ON public.bookmarks;
DROP POLICY IF EXISTS bookmarks_owner_delete ON public.bookmarks;

-- chat_messages
DROP POLICY IF EXISTS chat_messages_owner_select ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_owner_insert ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_owner_delete ON public.chat_messages;

-- chat_sessions
DROP POLICY IF EXISTS chat_sessions_owner_select ON public.chat_sessions;
DROP POLICY IF EXISTS chat_sessions_owner_insert ON public.chat_sessions;
DROP POLICY IF EXISTS chat_sessions_owner_update ON public.chat_sessions;
DROP POLICY IF EXISTS chat_sessions_owner_delete ON public.chat_sessions;

-- search_history
DROP POLICY IF EXISTS search_history_owner_select ON public.search_history;
DROP POLICY IF EXISTS search_history_owner_insert ON public.search_history;
DROP POLICY IF EXISTS search_history_owner_delete ON public.search_history;

-- billing_plans
DROP POLICY IF EXISTS billing_plans_select_all ON public.billing_plans;
