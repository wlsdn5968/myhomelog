-- molit_transactions: 국토교통부 실거래가 ETL 저장소
--
-- 왜 DB 로 옮기나:
--   1) 외부 API 레이턴시 (평균 400ms·초과시 7s timeout) → 사용자 응답 지연의 주 원인.
--   2) MOLIT 무료 키 일일 한도 — 동시 사용자 증가 시 rate limit 위험.
--   3) 단지명 부분일치 검색(`ILIKE %...%`) 이 API 로는 불가 → 클라이언트측 필터만 가능.
--   4) 통계·스코어 계산을 SQL 로 → AI 프롬프트 및 propertyService 의 in-memory 연산 감축.
--
-- Read path:
--   SELECT * FROM molit_transactions
--   WHERE lawd_cd = $1 AND deal_date >= now() - INTERVAL '6 months'
--   ORDER BY deal_date DESC;
--
-- Write path (ETL):
--   backend/jobs/molitIngest.js 가 매일 17:00 (Vercel Cron) 에 최근 2개월 갱신.
--   idempotency 는 dedup_key UNIQUE 로 보장 (같은 거래 재삽입 방지).

CREATE TABLE IF NOT EXISTS molit_transactions (
  id              BIGSERIAL PRIMARY KEY,
  -- 지역 코드 (법정동 앞 5자리) — 조회 주 키
  lawd_cd         CHAR(5) NOT NULL,
  -- MOLIT 단지 식별자 (일부 없는 row 있음 — NULLABLE)
  apt_seq         TEXT,
  apt_name        TEXT NOT NULL,
  sigungu         TEXT,
  umd_nm          TEXT,
  -- 전용면적 (㎡). 소수점 둘째 자리까지 보존.
  exclu_use_ar    NUMERIC(7,2) NOT NULL,
  build_year      INTEGER,
  floor           INTEGER,
  deal_year       INTEGER NOT NULL,
  deal_month      INTEGER NOT NULL,
  deal_day        INTEGER NOT NULL,
  -- 계산된 date — 인덱스·쿼리 편의
  deal_date       DATE NOT NULL,
  -- 거래금액 (만원 단위 정수 — MOLIT 원문 보존)
  deal_amount     BIGINT NOT NULL,
  -- ETL 메타
  source          TEXT NOT NULL DEFAULT 'molit',
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 중복 방지 해시 — 같은 거래 여러 번 INSERT 방지.
  -- MOLIT 는 row-id 가 없어 (aptSeq + 면적 + 일자 + 층 + 금액) 조합으로 dedup.
  dedup_key       TEXT GENERATED ALWAYS AS (
    md5(
      COALESCE(apt_seq, apt_name || ':' || COALESCE(umd_nm, '')) || '|' ||
      exclu_use_ar::text || '|' ||
      deal_year::text || '-' || deal_month::text || '-' || deal_day::text || '|' ||
      COALESCE(floor, 0)::text || '|' ||
      deal_amount::text
    )
  ) STORED
);

-- 같은 거래 중복 INSERT 차단
CREATE UNIQUE INDEX IF NOT EXISTS uq_molit_dedup
  ON molit_transactions (dedup_key);

-- 지역 + 최근일자 조회용 (가장 빈번)
CREATE INDEX IF NOT EXISTS idx_molit_lawd_date
  ON molit_transactions (lawd_cd, deal_date DESC);

-- 단지명 trigram 검색 — ILIKE %...% 고속화 (pg_trgm)
-- pg_trgm 은 Supabase 기본 지원. extension 없을 경우 수동 추가 필요.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_molit_aptname_trgm
  ON molit_transactions USING GIN (apt_name gin_trgm_ops);

-- aptSeq 조인용 (단지 상세 → 시세 집계)
CREATE INDEX IF NOT EXISTS idx_molit_apt_seq
  ON molit_transactions (apt_seq)
  WHERE apt_seq IS NOT NULL;

-- ── ETL 런 이력 테이블 — 실패 감지·재시도·관측 ───────────────
CREATE TABLE IF NOT EXISTS molit_ingest_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  lawd_cd         CHAR(5) NOT NULL,
  deal_ym         CHAR(6) NOT NULL,  -- YYYYMM
  rows_fetched    INTEGER,
  rows_inserted   INTEGER,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  error_message   TEXT,
  CONSTRAINT molit_ingest_runs_status_chk
    CHECK (status IN ('running','ok','error','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_molit_runs_status
  ON molit_ingest_runs (status, started_at DESC);

-- RLS: 실거래가는 공공데이터 → 공개 읽기. 쓰기는 service_role 전용.
ALTER TABLE molit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE molit_ingest_runs  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "molit_tx_public_read" ON molit_transactions;
CREATE POLICY "molit_tx_public_read"
  ON molit_transactions FOR SELECT
  USING (true);

-- ingest_runs 는 운영자만 (service_role) — 일반 사용자에게 노출 불필요
DROP POLICY IF EXISTS "molit_runs_no_read" ON molit_ingest_runs;
CREATE POLICY "molit_runs_no_read"
  ON molit_ingest_runs FOR SELECT
  USING (false);
