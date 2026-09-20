-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 실행). 이 파일은 적용 기록이다.
--   VACUUM FULL·REINDEX 등 유지보수 작업 7개를 실행 순서대로 기록한다.
--   실측 기준: 리뷰어 실행(2026-09-20 11:4x~12:0x UTC), 라이브 스모크 재확인 완료.

-- 1. ALTER TABLE — autovacuum 파라미터 조정(발동 기준: 기본 20% ≈ 94,510 → 2%)
--    → 결과: 발동 기준 94,510 → 9,496 죽은 튜플
ALTER TABLE public.molit_transactions SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- 2. VACUUM — 죽은 튜플 정리 및 가시성 맵 최신화
--    → 결과: 죽은 튜플 35,379 → 0 · get_price_records(7,3,6) 9.3초 → 1.34초(index-only scan Heap Fetches 29,233 → 0)
VACUUM public.molit_transactions;

-- 3. VACUUM FULL — apt_master 테이블 압축 정리
--    → 결과: 49.9 MB → 27.9 MB · 14,678행·facility 14,678·별칭 10,668 전부 보존
VACUUM FULL public.apt_master;

-- 4. REINDEX INDEX CONCURRENTLY — uq_molit_dedup 인덱스 재구성
--    → 결과: 34.8 MB → 26.6 MB
REINDEX INDEX CONCURRENTLY public.uq_molit_dedup;

-- 5. REINDEX INDEX CONCURRENTLY — molit_transactions_pkey 인덱스 재구성
--    → 결과: 16.7 MB → 10.1 MB (무효 인덱스 0 · _ccnew 잔여 0)
REINDEX INDEX CONCURRENTLY public.molit_transactions_pkey;

-- 6. SELECT prune_molit_ingest_runs(14) — 오래된 ingest 기록 프루닝(Plan 109 문서 참고)
--    → 결과: 36,274행 삭제 · 43,455 → 7,181행 · ok 기록을 가진 (지역,월) 쌍 1,948 → 1,948(불변) · ok 아닌 358행 전부 보존
SELECT public.prune_molit_ingest_runs(14);

-- 7. VACUUM FULL — molit_ingest_runs 테이블 압축 정리
--    → 결과: 9.6 MB → ≈ 1.2 MB
VACUUM FULL public.molit_ingest_runs;

-- ============================================================================
-- ⚠ VACUUM FULL·REINDEX 는 재실행해도 무해하지만 일시적으로 대상 크기만큼 여유 공간이 더 필요하다.
--    실행 전 SELECT round(sum(pg_database_size(datname))/1048576.0,1) FROM pg_database; 로 여유를 확인하고,
--    적재 창(17:00~19:00 UTC)과 apt-master-sync(월 20:00 UTC) 를 피한다.
-- ⚠ autovacuum 파라미터는 ALTER TABLE 로 테이블에 영속 저장된다 — 아래 schema.sql 항목과 함께 유지할 것.
-- ============================================================================
