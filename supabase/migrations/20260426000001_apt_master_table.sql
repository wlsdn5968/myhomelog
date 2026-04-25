-- 단지 마스터 (Phase 4, 2026-04-26)
-- 목적: 거래 0건 단지도 검색 노출 + AptInfo kapt_code 매핑 다리 + facility 풍부화 캐시
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용

CREATE TABLE IF NOT EXISTS public.apt_master (
  kapt_code TEXT PRIMARY KEY,
  apt_name TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  sigungu TEXT,
  umd_nm TEXT,
  facility JSONB,
  facility_fetched_at TIMESTAMPTZ,
  source TEXT DEFAULT 'aptinfo',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apt_master_name_trgm
  ON public.apt_master USING gin (apt_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_apt_master_umd_trgm
  ON public.apt_master USING gin (umd_nm extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_apt_master_lawd ON public.apt_master(lawd_cd);

CREATE UNIQUE INDEX IF NOT EXISTS uq_apt_master_name_lawd_umd
  ON public.apt_master(apt_name, lawd_cd, COALESCE(umd_nm, ''));

ALTER TABLE public.apt_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY apt_master_public_read ON public.apt_master
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY apt_master_service_write ON public.apt_master
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.apt_master IS '전국 단지 마스터 (AptInfo) — 검색·풍부화 (Phase 4)';
