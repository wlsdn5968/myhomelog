-- SECURITY-ADVISOR-2026-08-16 (Plan 019, improve 감사 후속)
--
-- 배경: plans/README 의 "미감사" 항목이었던 **"마이그레이션이 프로덕션에 실제 적용됐는가"** 를
--   information_schema / pg_catalog 로 전수 대조한 결과 나온 조치들이다.
--
-- 대조 결과 요약 (2026-08-16 실측):
--   ✅ 적용됨: prune_audit_log·increment_user_budget·tg_set_updated_at 전부 SECURITY DEFINER +
--             search_path 고정 + EXECUTE 는 postgres/service_role 만
--             (tg_set_updated_at 은 마이그레이션 파일에 CREATE 이력이 없어 '미확인'이었는데,
--              실측 결과 정상 존재·하드닝 완료 상태였다)
--   ✅ 적용됨: pg_trgm → extensions 스키마 / molit_transactions.dedup_key 는 금액 제외(v2) 버전 /
--             uq_molit_dedup·idx_molit_umdnm_trgm·uq_apt_master_name_lawd_umd 인덱스 전부 존재 /
--             pg_cron job 'audit_log_daily_prune'(0 18 * * *) active
--   ✅ 오탐 정정: 마이그레이션 20260425000008 이 billing_plans_select_all 을 DROP 만 하고
--             재생성하지 않아 "정책 0개 회귀" 로 의심됐으나, 실제 프로덕션에는
--             **billing_plans_public_read (USING active = true)** 가 존재한다. 문제 없음.
--   ❌ 미적용: 20260504000002_regulations_overlap_gist.sql — btree_gist 확장도, EXCLUDE 제약도
--             프로덕션에 없었다. 그 파일 헤더가 "실행(운영자 직접): Dashboard → SQL Editor" 라
--             **작성 후 3개월 넘게 실행되지 않은 채 남아 있었다.**
--
-- ── 1. 20260504000002 를 실제로 적용 (2026-08-16) ──────────────────────────────
--   선검증: 그 파일이 요구하는 overlap 조회 → 0 건 확인 후 적용.
--   적용 후 검증: 같은 key·겹치는 범위로 의도적 INSERT → exclusion_violation 으로 차단됨을
--                 DO 블록(롤백)으로 실증. 데이터 2행 그대로.
--   ⚠ CREATE EXTENSION 은 기본적으로 public 에 설치되어 advisor 의 extension_in_public(WARN)이
--     떴다. pg_trgm 과 동일하게 extensions 로 옮긴다(아래). 제약은 opclass OID 를 참조하므로
--     스키마 이동 후에도 유지된다 — 이동 후 제약 존재를 실제로 재확인했다.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER EXTENSION btree_gist SET SCHEMA extensions;

-- (참고) 제약 본체는 20260504000002 에 있다. 이미 적용됐으므로 여기서 재실행하지 않는다.
--   ALTER TABLE regulations_snapshot ADD CONSTRAINT regulations_snapshot_no_overlap
--     EXCLUDE USING gist (key WITH =, tstzrange(valid_from, COALESCE(valid_to,'infinity')) WITH &&);

-- ── 2. SECURITY DEFINER RPC 2종의 anon/authenticated 실행 권한 회수 ─────────────
--   advisor: 0028/0029 — 두 함수가 /rest/v1/rpc/… 로 **로그인 없이 호출 가능**했다.
--   호출부 실측: 둘 다 getSupabaseAdmin()(service_role)로만 부른다
--     · get_br_backfill_candidates → backend/jobs/buildingRegisterBackfill.js:54
--     · get_db_size_bytes          → backend/server.js:473
--   따라서 회수해도 앱 동작에 영향이 없다. 20260504000003 이 다른 함수 3종에 쓴 것과 같은 패턴.
REVOKE EXECUTE ON FUNCTION public.get_br_backfill_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_br_backfill_candidates(integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_db_size_bytes()                 FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_db_size_bytes()                 TO service_role;

-- ── 남긴 것 (의도적 / 운영자 결정) ─────────────────────────────────────────────
-- · rls_enabled_no_policy (INFO) — push_subscriptions·kakao_notify_tokens 는 정책 0개가 **의도**다.
--     service_role 만 접근해야 하는 테이블이라 정책을 만들면 오히려 열린다.
-- · materialized_view_in_api (WARN) — molit_apt_index 는 검색이 공개 키로 읽어야 하므로 anon
--     SELECT 가 **의도**다. 담긴 값은 molit_transactions(공개 read 정책 보유)의 집계라 노출 증가가 없고,
--     MV 는 구조적으로 쓰기가 불가능하다(2026-08-16 실증). 권한을 회수하면 검색이 깨진다.
-- · field_notes_* 4개 + ai_feedback_select_own — 정책의 role 이 authenticated 가 아니라 PUBLIC 으로
--     드리프트해 있다(20260504000003 이 DROP+CREATE 하며 TO 절을 빠뜨림, 20260531000001 이
--     insert_own 만 복원). 다만 USING/WITH CHECK 가 `(SELECT auth.uid()) = user_id` 라
--     anon 은 auth.uid() 가 NULL 이어서 **실제로 통과하지 못한다**(실측). 기능 영향 0 이라
--     이번엔 건드리지 않고 보고만 한다 — 심층방어 관점의 정리는 운영자 판단.
-- · auth_leaked_password_protection (WARN) — SQL 이 아니라 **Supabase Dashboard Auth 설정**이라
--     여기서 적용 불가. 운영자 조치 필요(HaveIBeenPwned 대조 활성화).
