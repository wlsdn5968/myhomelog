-- ============================================================================
-- Phase 5.2 — 계정 소프트 삭제 + 30일 유예 (Safety Regression Fix)
--
-- 배경:
--   - 초기 구현은 /api/account/delete 가 즉시 hard delete (비가역).
--   - 탈취·피싱·오클릭 시 복구 불가 → 운영 사고 위험.
--   - 업계 표준 (Google/Apple/Meta) 은 30일 유예 기간 후 실삭제.
--
-- 구현:
--   1) account_deletion_requests: 삭제 요청 기록 + 실행 스케줄 + 상태 추적
--   2) 요청 시점엔 데이터 **유지** — 세션만 만료, 로그인 차단
--   3) 유예기간 내 /restore 호출 시 상태만 변경 → 즉시 복구
--   4) 30일 후 backend/jobs/retention.js 가 실제 익명화 + auth.users 삭제
--
-- 법적 근거:
--   - PIPA 제36조 (삭제권) — "지체없이" 의 해석상 유예기간 고지 후 삭제 허용
--   - GDPR Art.17 — "without undue delay" (EDPB Guideline: grace period 인정)
--   - 전자상거래법 5년 payments 보관 의무 → status='hard_deleted' 이후에도 익명화 유지
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  user_id                  UUID PRIMARY KEY,
  requested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_hard_delete_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  status                   TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'restored', 'hard_deleted')),
  restored_at              TIMESTAMPTZ,
  hard_deleted_at          TIMESTAMPTZ,
  reason                   TEXT,
  email_at_request         TEXT,        -- 유예기간 동안 CS 연락용 (익명화 대상 아님)
  ip_masked                TEXT,
  user_agent               TEXT
);

CREATE INDEX IF NOT EXISTS idx_adr_status_scheduled
  ON public.account_deletion_requests (status, scheduled_hard_delete_at)
  WHERE status = 'pending';

COMMENT ON TABLE public.account_deletion_requests IS
  '계정 삭제 요청 기록 — 30일 유예기간 추적. status=pending 은 로그인 차단 + 유예 중.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

-- 본인 요청만 SELECT (복구 UI 에서 "언제까지 복구 가능" 표시용)
DROP POLICY IF EXISTS adr_select_own ON public.account_deletion_requests;
CREATE POLICY adr_select_own ON public.account_deletion_requests
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- INSERT/UPDATE/DELETE 정책 의도적 미생성 → service_role 만 가능
-- (사용자가 scheduled_hard_delete_at 을 미래로 연장하는 위조 차단)

-- ── retention 확장: 신규 action 보존 의무 ──────────────────────────────────
-- prune_audit_log() 의 retain_actions 는 함수 내부 배열이므로 재생성 필요.
-- (account.delete.request / account.restore / account.hard_delete 추가)
CREATE OR REPLACE FUNCTION public.prune_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
  retain_actions text[] := ARRAY[
    'account.delete.request',
    'account.delete.start',
    'account.delete.complete',
    'account.restore',
    'account.hard_delete',
    'payment.confirm',
    'payment.cancel',
    'payment.refund',
    'consent.accept'
  ];
BEGIN
  DELETE FROM public.audit_log
  WHERE created_at < (now() - INTERVAL '90 days')
    AND action <> ALL(retain_actions);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
