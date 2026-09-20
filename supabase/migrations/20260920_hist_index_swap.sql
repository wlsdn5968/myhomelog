-- ============================================================================
-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례).
-- ============================================================================
-- [무엇인가]
--   Plan 101 — 이력 인덱스 교체: idx_scan 7,000 = backfill 삭제-후-삽입 횟수와 일치해
--   다른 사용처 0 · 같은 서버 idx_molit_apt_seq 12.7 B/행 → 단일 키는 B-tree 중복 제거로
--   9.3 MB · 전체 DB 482.2 → 442.9 MB로 감소.
-- [되돌리기 SQL]
--   CREATE INDEX idx_molit_hist_seq_date ON public.molit_transactions_hist (apt_seq text_pattern_ops, deal_date);
--   DROP INDEX public.idx_molit_hist_seq;
-- ============================================================================

CREATE INDEX idx_molit_hist_seq ON public.molit_transactions_hist (apt_seq);
DROP INDEX public.idx_molit_hist_seq_date;
