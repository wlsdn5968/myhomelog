-- BRIEFING-ARCHIVE-2026-08-19 (Sprint NNNNNNN-6): 날짜별 브리핑 스냅샷 (영구 아카이브 원본).
-- ⚠ 이 파일은 사후 기록이다 — 실제 적용은 2026-08-19 execute_sql 로 완료·검증됨
--   (relrowsecurity=true 확인). 파일 존재 ≠ 적용 증거, 적용 확인은 pg_catalog 로.
-- 접근: 서버(service_role)만 읽고 쓴다. RLS enable + 정책 0 = anon/authenticated 전면 차단.
CREATE TABLE IF NOT EXISTS briefing_snapshots (
  day date PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE briefing_snapshots ENABLE ROW LEVEL SECURITY;
