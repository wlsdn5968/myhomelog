-- Phase B-6 (2026-05-01): 카카오 amenities 카운트 DB 캐시
-- 좌표·카테고리·반경 별 카운트를 영구 저장 → Vercel scale-out 시 fresh 호출 -90%.
-- 좌표 4자리(~11m) 정규화로 인접 단지가 같은 cache 공유.
-- 만료: 90일 (학교 위치는 거의 안 변함, 마트·병원도 분기 단위)
CREATE TABLE IF NOT EXISTS public.apt_amenities (
  cache_key TEXT PRIMARY KEY,         -- 형식: "lat4,lng4:category:radius" (예: "37.5012,127.0398:SC4:1200")
  lat NUMERIC NOT NULL,                -- 정규화된 위도 (소수점 4자리)
  lng NUMERIC NOT NULL,                -- 정규화된 경도
  category TEXT NOT NULL,              -- SC4, MT1, HP8, SW8, CS2 (group code) 또는 keyword (종합병원, 공원 등)
  radius INTEGER NOT NULL,             -- 검색 반경 (m)
  count INTEGER NOT NULL,              -- 카카오 응답 meta.total_count
  fetched_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apt_amenities_fetched ON public.apt_amenities (fetched_at);

ALTER TABLE public.apt_amenities ENABLE ROW LEVEL SECURITY;

CREATE POLICY apt_amenities_public_read ON public.apt_amenities
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY apt_amenities_service_write ON public.apt_amenities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.apt_amenities IS 'Kakao Local API 카운트 캐시 — Vercel scale-out 시 fresh 호출 방지 (Phase B-6)';
