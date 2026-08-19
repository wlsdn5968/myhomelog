-- Sprint NNNNNNN-16 (2026-08-19): 데이터 오류 신고 인앱 폼 저장소.
-- 실적용: execute_sql 로 2026-08-19 완료(relrowsecurity=true 검증) — 이 파일은 사후 기록.
-- ai_feedback(rating 필수 AI 평가 전용) 재사용 시 스키마 오염이라 전용 테이블.
CREATE TABLE IF NOT EXISTS data_error_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  apt_name text, lawd_cd text, field text, detail text NOT NULL,
  user_id uuid, page text
);
ALTER TABLE data_error_reports ENABLE ROW LEVEL SECURITY; -- 정책 0 = service role 전용
