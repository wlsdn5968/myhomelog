-- Sprint FFFFFF (2026-07-18): 카카오톡 "나에게 보내기" 알림용 사용자별 OAuth 토큰
-- ⚠ 운영자 승인 후 수동 실행 (절대 룰 ③)
--
-- 출처 패턴: 운영자 portai 저장소 user_settings.kakao_* 4컬럼 (실동작 검증) —
--   myhomelog 는 user_settings 테이블이 없어 전용 테이블로 신설.
-- items = 관심단지 스냅샷 (웹푸시 push_subscriptions.items 와 동일 semantics — 로그인 유저의
--   북마크 서버 스키마엔 lawd_cd 가 없어 프론트 스냅샷 방식이 파싱 리스크 0)
-- RLS: 정책 없음 = service_role(백엔드)만 접근. 토큰은 유저 브라우저에 노출되지 않음.

CREATE TABLE IF NOT EXISTS public.kakao_notify_tokens (
  user_id UUID PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  fail_count INT NOT NULL DEFAULT 0
);

ALTER TABLE public.kakao_notify_tokens ENABLE ROW LEVEL SECURITY;
-- 정책 의도적 부재 (audit_log·push_subscriptions 패턴)
