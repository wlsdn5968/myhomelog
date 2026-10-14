-- ============================================================================
-- 2026-10-14 — 이미 프로덕션에 적용됨(계획자 apply_migration 20261014_computed_snapshots, 성공).
--   이 파일은 적용 기록이다(Plan 142).
-- ============================================================================
-- [무엇인가] 하루 1회 계산하는 공용 결과(신고가 경신 전국·지역 블롭)의 DB 사본. 키당 1행 덮어쓰기.
-- [왜] Upstash Redis 무료 한도 초과(2026-10-05~ 쓰기 실패)로 공유 캐시가 비자, 콜드 인스턴스마다
--   get_price_records_by_region 을 다시 계산했다(실측 첫 호출 4,571ms · 두 번째 408ms — DB 버퍼가 식은 상태의 비용).
-- [권한] RLS on + 정책 0 = 서비스 키 전용(molit_hist_peaks 패턴). anon·authenticated 권한 회수.
-- [실측 — 적용 직후] relrowsecurity true · anon SELECT false · service_role INSERT true · 정책 0.
-- [되돌리기] drop table public.computed_snapshots;  (코드는 테이블이 없어도 Redis·RPC 경로로 동작한다)
-- ============================================================================
create table if not exists public.computed_snapshots (
  key text primary key,
  payload jsonb not null,
  computed_at timestamptz not null default now()
);
alter table public.computed_snapshots enable row level security;
revoke all on public.computed_snapshots from anon, authenticated;
