-- apt_geocache: 단지 좌표 영구 캐시
--
-- 왜 필요한가:
--   - 기존 프론트엔드 `getLat/getLng` 은 구명(區名) 키워드 + 랜덤 jitter 로
--     "은평구 단지가 강남에 찍히는" 버그 유발 (Bug #2).
--   - `batchGeocode` 가 매 요청마다 Kakao API 재호출 → rate limit + latency.
--   - in-process cache 는 serverless 재시작 시 소실.
--   - 단지 좌표는 거의 영구 불변 → DB 한 번 캐시하면 끝.
--
-- 사용 흐름:
--   1) propertyService 가 추천 단지 확정 후 coord resolve
--   2) geocodeCacheService.getCoord(aptKey) — DB 우선 조회
--   3) DB 없으면 Kakao API 호출 → UPSERT DB
--   4) 응답에 lat/lng 포함 → 프론트는 fallback 없이 그대로 사용
--
-- Key 설계:
--   - apt_key = 우선순위 (kaptCode) → (apt_name|sigungu|umd_nm)
--   - kaptCode 가 있으면 UNIQUE + 안정 키, 없으면 이름·동으로 fallback
--   - 동일 단지명이 다른 구에 있는 경우(예: 래미안) 구·동 조합으로 구분

CREATE TABLE IF NOT EXISTS apt_geocache (
  id            BIGSERIAL PRIMARY KEY,
  -- 정규화된 키 — "kapt:A10020255" 또는 "name:래미안|은평구|응암동"
  apt_key       TEXT NOT NULL UNIQUE,
  -- 원본 표기 (감사·디버깅용)
  apt_name      TEXT NOT NULL,
  sigungu       TEXT,
  umd_nm        TEXT,
  address       TEXT,            -- Kakao 가 돌려준 전체 주소
  place_name    TEXT,            -- Kakao place_name (단지 공식명)
  -- 좌표 (소수점 7자리 ≈ 1cm 해상도, DECIMAL 로 float 오차 원천 차단)
  lat           DECIMAL(10,7) NOT NULL,
  lng           DECIMAL(10,7) NOT NULL,
  -- 출처 — kakao|molit|manual (미래에 여러 소스 지원)
  source        TEXT NOT NULL DEFAULT 'kakao',
  cached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 한반도 범위 밖 좌표 차단 (동명 외국 지명·0,0 반환 방어)
  CONSTRAINT apt_geocache_lat_range CHECK (lat BETWEEN 33 AND 39),
  CONSTRAINT apt_geocache_lng_range CHECK (lng BETWEEN 124 AND 132)
);

-- 단지명 조회용 (kaptCode 없는 단지의 fallback 조회)
CREATE INDEX IF NOT EXISTS idx_apt_geocache_name
  ON apt_geocache (apt_name);

-- 구+동 필터 조회 (동명이 같은 경우 구로 구분)
CREATE INDEX IF NOT EXISTS idx_apt_geocache_region
  ON apt_geocache (sigungu, umd_nm);

-- RLS: 좌표는 공공성 높음 → 공개 읽기, 쓰기는 service_role
ALTER TABLE apt_geocache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "apt_geocache_public_read" ON apt_geocache;
CREATE POLICY "apt_geocache_public_read"
  ON apt_geocache FOR SELECT
  USING (true);
