-- ============================================================================
-- 2026-09-16 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례 — supabase/migrations/20260906_aliases_fn_and_mv_timeout.sql
--   과 같은 형식). Plan 091(plans/091-molit-history-backfill-free-tier.md)의 DDL 초안과 한 가지
--   차이가 있다 — idx_molit_hist_seq_date 인덱스가 apt_seq 에 text_pattern_ops 를 추가로 쓴다
--   (백필 잡의 삭제-후-삽입 멱등 경로가 쓰는 `apt_seq LIKE '<lawd>-%'` 접두 검색을 인덱스로 태우기 위함).
--   아래는 실제로 적용된 DDL 원문 그대로다.
-- ============================================================================
--
-- [무엇인가]
--   molit_transactions_hist — 과거 실거래 이력 전용 협폭 테이블. molit_transactions(2025-05~)와
--     겹치지 않는 2025-04 이전을 최신월부터 거꾸로 적재한다(backend/jobs/molitHistBackfill.js).
--     apt_name·umd_nm·jibun·build_year 는 저장하지 않는다 — apt_seq 로 molit_apt_index/apt_master 와
--     조인해서 구한다(협폭 설계 목적 — 무료 티어 500MB 안에서 최대한 많은 이력을 담기 위함).
--   molit_hist_runs — 완료한 (lawd_cd, deal_ym) 기록. PRIMARY KEY 자체가 유니크 인덱스 역할을 하므로
--     별도 유니크 인덱스를 추가하지 않는다(인덱스 1개만 = 용량 절약).
--   db_size_mb() — pg_database_size 를 MB 로 환산해 반환하는 SECURITY DEFINER 함수. service_role 전용
--     (anon·authenticated 실행 권한 회수). 백필 잡이 매 실행 이 값을 읽어 470MB 에서 정지한다.
-- ============================================================================
CREATE TABLE public.molit_transactions_hist (
  apt_seq      text     NOT NULL,           -- '11500-10189' (molit_apt_index 와 조인 키)
  deal_date    date     NOT NULL,
  exclu_use_ar smallint NOT NULL,           -- ㎡ × 100 (예: 84.99 → 8499). 655㎡ 초과는 32767 로 캡
  deal_amount  integer  NOT NULL,           -- 만원
  floor        smallint
);
CREATE INDEX idx_molit_hist_seq_date ON public.molit_transactions_hist (apt_seq text_pattern_ops, deal_date);
CREATE TABLE public.molit_hist_runs (
  lawd_cd text NOT NULL, deal_ym text NOT NULL, rows integer NOT NULL, finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lawd_cd, deal_ym)
);
ALTER TABLE public.molit_transactions_hist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.molit_hist_runs ENABLE ROW LEVEL SECURITY;
-- 읽기: anon/authenticated 는 hist 만 SELECT 허용(공개 실거래 통계), runs 는 service_role 전용
CREATE POLICY hist_read ON public.molit_transactions_hist FOR SELECT TO anon, authenticated USING (true);
CREATE OR REPLACE FUNCTION public.db_size_mb() RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT round(pg_database_size(current_database()) / 1048576.0, 1) $$;
REVOKE EXECUTE ON FUNCTION public.db_size_mb() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.db_size_mb() TO service_role;
