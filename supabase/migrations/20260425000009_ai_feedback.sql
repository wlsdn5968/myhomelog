-- AI 답변 사용자 피드백 (Phase 3 결정사항, 2026-04-25)
-- 정합성 측정 0건 문제 해결 — 👍/👎 + 선택적 코멘트 수집 → 주간 수동 리뷰
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용
CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id UUID REFERENCES public.chat_sessions(id) ON DELETE SET NULL,
  message_hash TEXT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  comment TEXT,
  reply_preview TEXT,
  source TEXT DEFAULT 'chat',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ai_feedback_created ON public.ai_feedback(created_at DESC);
CREATE INDEX idx_ai_feedback_user ON public.ai_feedback(user_id, created_at DESC);
CREATE INDEX idx_ai_feedback_rating ON public.ai_feedback(rating, created_at DESC);

ALTER TABLE public.ai_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_feedback_select_own ON public.ai_feedback
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY ai_feedback_insert_own ON public.ai_feedback
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY ai_feedback_insert_anon ON public.ai_feedback
  FOR INSERT TO anon WITH CHECK (user_id IS NULL);

CREATE POLICY ai_feedback_service_all ON public.ai_feedback
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_feedback IS 'AI 응답 사용자 피드백 — 주간 수동 리뷰용 (Phase 3)';
