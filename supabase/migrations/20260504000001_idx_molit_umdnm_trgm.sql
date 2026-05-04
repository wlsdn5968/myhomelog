-- Phase 34 #15 (2026-05-04, Agent 3차 권장):
-- molit_transactions.umd_nm 에 GIN trigram 인덱스 추가
--
-- 배경:
--   현재 검색 endpoint /api/search/apt 는 OR (apt_name ILIKE OR umd_nm ILIKE) 사용 가능.
--   apt_name 은 idx_molit_aptname_trgm 활용 → ~328ms (Phase 21).
--   umd_nm 인덱스 없음 → OR 조건 시 Postgres planner Seq Scan 선택 → 2.3초.
--   Phase 21 에서 apt_name 만 검색으로 우회 (umd_nm 검색은 apt_master 가 보강).
--
-- 본 인덱스 추가 효과:
--   검색 endpoint OR 패턴 복원 가능 (apt_master 매칭 없는 동명 검색 보강)
--   추가 ~2x 향상 가능 (이미 빠르나 더 정확한 결과)
--
-- 안전성:
--   - GIN 인덱스 추가는 read-only 영향 (write 약간 느림)
--   - 244k row → 인덱스 생성 ~30~60초
--   - CONCURRENTLY 사용 시 락 X (운영 중 안전)
--
-- 실행:
--   Supabase Dashboard → SQL Editor → 본 SQL 복붙 → Run
--   또는 Supabase CLI: supabase db push (자동 migration)

-- pg_trgm 확장 활성 (이미 활성됐을 가능성 높음 — IF NOT EXISTS)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram 인덱스 (CONCURRENTLY 가 transaction 안 가능 X — Dashboard 에서 별도 실행 권장)
-- Dashboard 에서 실행 시:
CREATE INDEX IF NOT EXISTS idx_molit_umdnm_trgm
  ON molit_transactions USING gin (umd_nm gin_trgm_ops);

-- 검증: 인덱스 사용 EXPLAIN
-- EXPLAIN ANALYZE SELECT * FROM molit_transactions WHERE umd_nm ILIKE '%공덕%' LIMIT 100;
-- → "Bitmap Index Scan on idx_molit_umdnm_trgm" 가 나오면 성공
