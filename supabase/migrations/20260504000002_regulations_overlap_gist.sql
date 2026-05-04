-- Phase 34 #8 (2026-05-04, Agent 3차):
-- regulations_snapshot 의 valid_from/valid_to 범위 overlap 차단 (GIST 제약)
--
-- 배경:
--   regulationsService.getSnapshot() 가 ORDER BY valid_from DESC LIMIT 1 로 조회.
--   같은 key 에 valid 범위 겹친 두 row insert 시 임의 1개 선택 → 비결정.
--   AI 답변/LTV 계산이 다른 정책으로 답변할 risk.
--
--   현재 데이터 (2 row, housing_loan_2025·acquisition_tax_2025) overlap X — risk 0.
--   그러나 운영자가 새 row insert 시 옛 row valid_to 갱신 누락하면 즉시 발생 가능.
--
-- 해결:
--   PostgreSQL GIST 제약 — 같은 key 의 시간 범위 overlap 시 INSERT 실패.
--   btree_gist 확장 필요 (= 와 && 함께 GIST 인덱스).
--
-- 실행 (운영자 직접):
--   Supabase Dashboard → SQL Editor → 복붙 → Run
--   주의: 기존 데이터 overlap 있으면 ALTER TABLE 실패 — 검증 query 먼저 실행 권장

-- ── 1. 기존 overlap 검증 (실행 전 필수) ──
-- SELECT key, valid_from, valid_to,
--   tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz)) AS range
-- FROM regulations_snapshot
-- WHERE EXISTS (
--   SELECT 1 FROM regulations_snapshot r2
--   WHERE r2.key = regulations_snapshot.key
--     AND r2.id <> regulations_snapshot.id
--     AND tstzrange(regulations_snapshot.valid_from, COALESCE(regulations_snapshot.valid_to, 'infinity'::timestamptz))
--      && tstzrange(r2.valid_from, COALESCE(r2.valid_to, 'infinity'::timestamptz))
-- );
-- → 결과 0 row 이면 안전. 1+ row 면 운영자 valid_to 수동 갱신 후 재시도.

-- ── 2. btree_gist 확장 활성 ──
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 3. GIST 제약 추가 ──
-- 같은 key 의 시간 범위가 겹치면 INSERT 거부.
ALTER TABLE regulations_snapshot
  ADD CONSTRAINT regulations_snapshot_no_overlap
  EXCLUDE USING gist (
    key WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz)) WITH &&
  );

-- ── 4. 검증 ──
-- 의도적 overlap insert 시도 → 실패해야 정상:
-- INSERT INTO regulations_snapshot (key, valid_from, valid_to, data, source_effective_date)
-- VALUES ('housing_loan_2025', '2025-10-15', NULL, '{}'::jsonb, '2025-10-15');
-- → ERROR: conflicting key value violates exclusion constraint "regulations_snapshot_no_overlap"
