-- 임장노트 클라우드 동기화 (Phase 4, 2026-04-26)
-- 기존: localStorage only → 기기 변경 시 분실
-- 신규: 로그인 사용자는 DB 자동 sync, 비로그인은 localStorage 그대로
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용
CREATE TABLE IF NOT EXISTS public.field_notes (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  apt_name TEXT NOT NULL,
  checks JSONB DEFAULT '[]'::jsonb,
  rating SMALLINT CHECK (rating BETWEEN 0 AND 5),
  memo TEXT,
  visit_date DATE,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, apt_name)
);

CREATE INDEX idx_field_notes_user_updated ON public.field_notes(user_id, updated_at DESC);

ALTER TABLE public.field_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_notes_select_own ON public.field_notes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY field_notes_insert_own ON public.field_notes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY field_notes_update_own ON public.field_notes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY field_notes_delete_own ON public.field_notes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

COMMENT ON TABLE public.field_notes IS '임장노트 클라우드 동기화 (Phase 4)';
