-- Sprint EEEEEE (2026-07-18): 관심단지 신규 실거래 웹푸시 구독 저장소
-- ⚠ 운영자 승인 후 수동 실행 (절대 룰 ③ — production DB 직접 수정 금지)
--
-- 설계:
--   - 익명 사용자도 알림을 받아야 하므로 구독은 user 가 아니라 브라우저 endpoint 단위
--   - items = 구독 시점 관심단지 스냅샷 [{aptName, lawdCd, sigungu, umdNm}] (북마크 변경 시 재업서트)
--   - last_notified_at = 발송 워터마크 (cron 이 이 시각 이후 ingested_at 거래만 알림)
--   - RLS: 정책 없음 = anon/authenticated 접근 완전 차단, service_role(백엔드)만 접근 (audit_log 패턴)

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_id UUID,                              -- 선택 (v1 미사용 — 향후 로그인 연동 대비)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  fail_count INT NOT NULL DEFAULT 0
);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- 정책 의도적 부재: PostgREST anon/authenticated 는 접근 불가, service_role 은 RLS bypass.

CREATE INDEX IF NOT EXISTS idx_push_subs_updated ON public.push_subscriptions (updated_at DESC);
