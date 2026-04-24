-- ============================================================================
-- Phase 4.2 — 감사 로그 (audit_log)
--
-- 목적:
--   - PIPA 제29조 "접근 기록 1년 이상 보관" 준수
--   - 결제/환불/계정삭제 등 민감 작업은 무엇이/언제/누가 했는지 영구 추적
--   - service_role 만 INSERT 가능 — 사용자가 자신의 로그 위·변조 불가
--   - 본인 행위 SELECT 만 허용 — 운영자 감사 시 service_role 로 별도 조회
--
-- 운영:
--   - 백엔드에서 결제 confirm/cancel/refund, 동의 시각, 계정 삭제 등에 INSERT
--   - 90일 이전 로그는 별도 retention cron 으로 cold storage 이관 (Phase 5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,                                  -- nullable (anonymous 행위도 기록)
  actor TEXT NOT NULL DEFAULT 'system',          -- 'user' | 'system' | 'admin' | 'webhook'
  action TEXT NOT NULL,                          -- 'payment.confirm' | 'consent.accept' | 'account.delete' …
  target_type TEXT,                              -- 'payment' | 'session' | 'bookmark'
  target_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,       -- 자유 추가 데이터 (PII 최소화)
  ip_masked TEXT,                                -- /24 마스킹된 IP
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_created
  ON public.audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
  ON public.audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target
  ON public.audit_log (target_type, target_id);

-- ── RLS — 본인 SELECT 만, INSERT/UPDATE/DELETE 는 service_role 전용 ─────
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select_own ON public.audit_log;
CREATE POLICY audit_log_select_own ON public.audit_log
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- INSERT/UPDATE/DELETE 정책 의도적 미생성 → service_role 만 가능
-- (사용자가 자신의 audit log 를 위·변조하면 무결성이 깨짐)

COMMENT ON TABLE public.audit_log IS 'PIPA 제29조 접근기록 보존 — 90일 이상 보관 (운영 정책)';
