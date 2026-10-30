-- ============================================================================
-- 2026-10-30 — Plan 176 C: 지도 영역 마커 좌표를 "최근 거래 많은 단지부터" 고른다 (운영자 승인 "권고대로", 2026-10-30)
--   이전: /api/search/in-bounds 가 apt_geocache 를 정렬 없이 limit(50) — 넓은 영역에서 어떤 단지가 보일지 무작위였다
--   (운영 실측: 공릉·하계 일대 쓸 수 있는 좌표 261건 중 50건만 읽혀 핀 36개, 공릉풍림아이원 누락).
--   신고 이름 좌표(name:)만 거래 수 내림차순으로 돌려준다. KAPT 본체 좌표(kapt:)는 라우트가 별칭으로 찾은 단지만 따로 읽는다.
--   내부 전용: 실행 권한은 service_role 만(공개 키 노출면 Plan 129 원칙).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.geocache_in_bounds(p_south double precision, p_west double precision,
                                                     p_north double precision, p_east double precision, p_limit integer)
RETURNS TABLE (apt_name text, sigungu text, umd_nm text, lat numeric, lng numeric, apt_key text, place_name text, deal_count bigint)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT g.apt_name, g.sigungu, g.umd_nm, g.lat, g.lng, g.apt_key, g.place_name, coalesce(s.dc, 0) AS deal_count
  FROM apt_geocache g
  LEFT JOIN LATERAL (
    SELECT sum(i.deal_count)::bigint AS dc FROM molit_apt_index i
    WHERE i.apt_name = g.apt_name AND i.umd_nm = g.umd_nm AND i.sigungu = g.sigungu
  ) s ON true
  WHERE g.apt_key LIKE 'name:%'
    AND g.source IS DISTINCT FROM 'kakao-x'
    AND g.lat BETWEEN p_south AND p_north
    AND g.lng BETWEEN p_west AND p_east
  ORDER BY coalesce(s.dc, 0) DESC, g.apt_key
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
REVOKE ALL ON FUNCTION public.geocache_in_bounds(double precision, double precision, double precision, double precision, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocache_in_bounds(double precision, double precision, double precision, double precision, integer) TO service_role;
COMMENT ON FUNCTION public.geocache_in_bounds(double precision, double precision, double precision, double precision, integer)
  IS '지도 영역 신고 이름 좌표 — 최근 거래 수 내림차순(Plan 176 C). service_role 전용.';
