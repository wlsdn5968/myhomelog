-- Sprint NNNNNNN-17 (2026-08-19): 연말결산 B트랙 활동 카운터 — 로그인 사용자·집계 숫자만(무엇을 봤는지 저장 안 함).
-- 실적용: execute_sql 로 2026-08-19 완료(원자 증가 실검증) — 이 파일은 사후 기록.
-- privacy.html 은 이미 검색·단지 조회 이력 수집을 고지 — 카운트는 고지 범위 이하.
CREATE TABLE IF NOT EXISTS activity_counters (
  user_id uuid NOT NULL,
  year int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('detail_view','search')),
  cnt bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, year, kind)
);
ALTER TABLE activity_counters ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION bump_activity_counter(p_user uuid, p_year int, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO activity_counters(user_id, year, kind, cnt) VALUES (p_user, p_year, p_kind, 1)
  ON CONFLICT (user_id, year, kind) DO UPDATE SET cnt = activity_counters.cnt + 1, updated_at = now();
$$;
