-- apt_master.molit_aliases 컬럼 (Phase 4, 2026-04-26)
-- MOLIT 면적군별 분리 신고 단지 ↔ AptInfo 통합 단지 매핑 다리.
-- 자동 휴리스틱은 false positive 위험 큼 → 수동 등록 또는 사용자 안내 우선.
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용
ALTER TABLE public.apt_master
  ADD COLUMN IF NOT EXISTS molit_aliases JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_apt_master_aliases_gin
  ON public.apt_master USING gin (molit_aliases);

COMMENT ON COLUMN public.apt_master.molit_aliases IS
  'MOLIT 신고서에 등장한 동일 단지 별칭 (면적군별/차수별 분리 신고 통합) — Phase 4';
