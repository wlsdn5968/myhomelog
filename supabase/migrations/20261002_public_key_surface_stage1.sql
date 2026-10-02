-- ============================================================================
-- 2026-10-02 12:4xZ — 이미 프로덕션에 적용됨(운영자가 Supabase SQL Editor 에서 직접 실행).
--   이 파일은 **적용 기록**이다(Plan 129 1단계 — plans/129-public-key-surface-reduction.md §3).
--   계획자의 apply_migration 은 자동 모드 안전장치 차단 1회 + 확인 단계 declined 2회 → 운영자 직접 실행. 그래서
--   supabase_migrations 이력에는 이 이름의 항목이 없다(SQL Editor 실행은 이력에 남지 않는다).
-- ============================================================================
-- [무엇인가]
--   공개 키(publishable, frontend/index.html 메타 태그)만으로 직접 부를 수 있던 것 가운데
--   공개 키 사용처가 0 인 대상을 닫았다. 코드 변경 0.
--   (a) 백엔드 전용 SECURITY INVOKER 함수 5개의 공개 실행 권한 회수.
--   (b) 대형 테이블 4개(이력 85MB·편의시설·학교·건축물대장)의 공개 읽기 정책 제거 + anon/authenticated 권한 회수.
--       RLS 는 켜 둔다(정책 0 = service_role 만 통과 — molit_hist_peaks 와 같은 내부 전용 패턴).
-- [왜]
--   위험은 기밀이 아니라 가용성 — 무료 전송량(월 5GB) 소진 시 Fair Use 로 전 API 가 402.
--   정책만 지우면 공개 키 요청이 빈 배열로 "조용히" 성공하므로 권한까지 회수해 42501 로 실패하게 했다.
-- [적용 전 실측 — 2026-10-02 12:1xZ]
--   대상 9경로(테이블 4·RPC 5)의 최근 24시간 게이트웨이 요청: 전부 백엔드(User-Agent node),
--   공개 키 접두어(sb_publishable_) 0건 — 이력 630·학교 453·편의시설 223·건축물대장 90·RPC 8.
--   service_role: 함수 5개 EXECUTE true · 테이블 4개 SELECT true.
-- [적용 후 실측 — 2026-10-02 12:48Z]
--   pg_catalog: 함수 5개 anon/authenticated EXECUTE false, ACL = {postgres=X, service_role=X} ·
--     테이블 4개 anon/authenticated SELECT false · 정책: 이력 (none) · 건축물대장 (none) ·
--     편의시설·학교는 *_service_write 만.
--   공개 키 REST: 테이블 4개 401 "permission denied for table …"(42501) ·
--     rpc/get_table_health·rpc/refresh_molit_apt_dim 401 "permission denied for function …".
--   대조(공개 유지): regulations_snapshot 200 · molit_apt_index 200(2단계 대상).
--   백엔드: /api/health ok · dataCounts.txHist 1,321,411 · /apt/41131-1652 200 ·
--     /api/transactions/history?aptSeq=41131-1652 2020-09 부터 반환(이력 = service_role 경로).
--   get_advisors(security): 새 경고 0 — "RLS 켜짐·정책 없음" INFO 10 → 12(이력·건축물대장 추가, 의도).
-- [되돌리기 SQL — 적용 전 운영 정의 그대로]
--   grant execute on function public.active_lawd_codes(date) to public;
--   grant execute on function public.geocache_backfill_candidates(integer, text) to anon, authenticated;
--   grant execute on function public.get_table_health() to public, anon, authenticated;
--   grant execute on function public.refresh_molit_apt_dim() to public, anon, authenticated;
--   grant execute on function public.upsert_hist_peaks_for_month(text) to public, anon, authenticated;
--   grant all on public.molit_transactions_hist, public.apt_amenities, public.apt_schools, public.building_register to anon, authenticated;
--   create policy hist_read on public.molit_transactions_hist for select to anon, authenticated using (true);
--   create policy apt_amenities_public_read on public.apt_amenities for select to anon, authenticated using (true);
--   create policy apt_schools_public_read on public.apt_schools for select to anon, authenticated using (true);
--   create policy br_read on public.building_register for select to public using (true);
-- ============================================================================

-- (a) 백엔드 전용 invoker 함수 5개: 공개 실행 권한 회수 (service_role 은 명시 권한 유지)
revoke execute on function public.active_lawd_codes(date) from public, anon, authenticated;
revoke execute on function public.geocache_backfill_candidates(integer, text) from public, anon, authenticated;
revoke execute on function public.get_table_health() from public, anon, authenticated;
revoke execute on function public.refresh_molit_apt_dim() from public, anon, authenticated;
revoke execute on function public.upsert_hist_peaks_for_month(text) from public, anon, authenticated;

-- (b) 공개 키 사용처가 0 인 대형 테이블 4개: 공개 읽기 정책 제거 + anon/authenticated 권한 회수
drop policy if exists hist_read on public.molit_transactions_hist;
drop policy if exists apt_amenities_public_read on public.apt_amenities;
drop policy if exists apt_schools_public_read on public.apt_schools;
drop policy if exists br_read on public.building_register;
revoke all on public.molit_transactions_hist, public.apt_amenities, public.apt_schools, public.building_register from anon, authenticated;
