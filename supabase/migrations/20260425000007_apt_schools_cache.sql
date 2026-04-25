-- 학군 데이터 캐시 (Phase 2 후속, 2026-04-25)
-- 단지별 반경 1km 내 학교 목록 (카카오맵 keyword API → 무료, 호출 폭증 방지 캐시)
-- 학업성취도는 차후 학교알리미 API 통합 (사용자 키 발급 필요)
-- ※ MCP 로 이미 적용됨 — 본 파일은 git tracking 용
CREATE TABLE IF NOT EXISTS public.apt_schools (
  apt_key TEXT PRIMARY KEY,
  apt_name TEXT,
  sigungu TEXT,
  umd_nm TEXT,
  schools JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{name, type:'초/중/고/유', distance_m, lat, lng, address}]
  source TEXT DEFAULT 'kakao',
  fetched_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apt_schools_fetched ON public.apt_schools(fetched_at);

ALTER TABLE public.apt_schools ENABLE ROW LEVEL SECURITY;

CREATE POLICY apt_schools_public_read ON public.apt_schools
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY apt_schools_service_write ON public.apt_schools
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.apt_schools IS '단지별 반경 1km 학교 목록 (카카오맵 lazy fill 캐시) — Phase 2 후속';
