-- ============================================================================
-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례).
-- ============================================================================
-- [무엇인가]
--   Plan 110 — molit_ingest_runs_status_chk 가 'timeout' 을 금지하고 있었다. 그런데
--   backend/jobs/molitIngest.js:377 과 backend/jobs/retention.js 는 2시간 넘게 남은
--   'running' 행을 status: 'timeout' 으로 UPDATE 한다 → CHECK 위반으로 90일간 매일
--   조용히 실패했다. 실측 증거: status='timeout' 행 0건(한 번도 성공한 적 없음), 멈춘
--   'running' 행 21건(전부 lawd_cd=41173/deal_ym=202510, 최고령 2026-06-22). 부수 피해로
--   gap-retry 의 .in('status', ['error', 'timeout']) 중 'timeout' 분기가 사문화돼 중간에
--   죽은 적재가 영영 재시도되지 않았다. 기존 값이 전부 새 목록의 부분집합이라 검증(validate)은
--   즉시 통과했다(convalidated = true 확인).
-- [되돌리기 SQL]
--   ALTER TABLE public.molit_ingest_runs DROP CONSTRAINT molit_ingest_runs_status_chk;
--   ALTER TABLE public.molit_ingest_runs ADD CONSTRAINT molit_ingest_runs_status_chk
--     CHECK (status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'skipped'::text]));
-- ============================================================================

ALTER TABLE public.molit_ingest_runs DROP CONSTRAINT molit_ingest_runs_status_chk;
ALTER TABLE public.molit_ingest_runs ADD CONSTRAINT molit_ingest_runs_status_chk
  CHECK (status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'skipped'::text, 'timeout'::text]));
