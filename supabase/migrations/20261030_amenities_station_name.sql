-- STATION-NAME-2026-10-30 (Plan 157): 최근접 지하철역 이름을 DB 캐시에도 남긴다.
--   [근본 원인] kakaoService.nearestSubway 는 거리(m)를 apt_amenities.count 에 저장하고 이름은 저장하지 않아,
--   DB 캐시 적중 때 역 이름이 사라졌다(비교 창 운영 실측: 공릉풍림아이원·상계주공14 모두 '직선 680m'·'직선 437m' 만).
--   [변경] 비어 있어도 되는 text 칸 하나 추가 — 기본값이 없어 기존 행을 다시 쓰지 않는다(메타데이터 변경).
--   역 거리 행(cache_key 에 ':sw8near:')만 채운다. 다른 행(시설 개수)은 NULL 그대로.
--   [용량] 2026-10-30 실측 역 거리 6,797행 · 테이블 9.6MB · 클러스터 441.8MB — 이름이 다 채워져도 약 0.1MB.
--   [되돌리기] alter table public.apt_amenities drop column if exists name;
alter table public.apt_amenities add column if not exists name text;
