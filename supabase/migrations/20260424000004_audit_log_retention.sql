-- ============================================================================
-- Phase 5 보너스 — audit_log retention (PIPA 제29조 + 비용 관리)
--
-- 정책:
--   - PIPA 제29조: 접근기록 1년 보관 (운영자 침해 추적)
--   - 우리 정책: 90일 hot 보관 → 그 이후 cold(별도 archive 테이블) 이관
--   - 단, payments/account.delete 같은 법적 보관 의무 행위는 영구 보존
--
-- 구현:
--   - prune_audit_log() 함수: 90일 이전 + 보존 의무 없는 행 DELETE
--   - pg_cron 으로 매일 03:00 실행 (Supabase 는 pg_cron 확장 제공)
--   - retain_actions 화이트리스트는 운영 정책 변경 시 함수만 수정
--
-- 적용:
--   1) Supabase Dashboard → Database → Extensions → pg_cron 활성화
--   2) 본 파일 실행
--   3) SELECT * FROM cron.job; 로 스케줄 확인
-- ============================================================================

-- pg_cron 확장 활성화 (이미 있으면 no-op)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 보존 의무 액션 — 영구 보관 (전자상거래법·PIPA 침해사고 대응)
-- 그 외는 90일 후 삭제 — 비용 관리 + 최소 수집 원칙
CREATE OR REPLACE FUNCTION public.prune_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
  retain_actions text[] := ARRAY[
    'account.delete.start',
    'account.delete.complete',
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

COMMENT ON FUNCTION public.prune_audit_log() IS
  '90일 이전 audit_log 정리 — 단 결제/탈퇴/동의 등 법적 보존 의무 행위는 영구 보관';

-- 매일 KST 03:00 (UTC 18:00) 실행 — 트래픽 최저 시간대
-- 같은 이름 작업 이미 있으면 unschedule 후 재등록 (멱등)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit_log_daily_prune') THEN
    PERFORM cron.unschedule('audit_log_daily_prune');
  END IF;
  PERFORM cron.schedule(
    'audit_log_daily_prune',
    '0 18 * * *',  -- UTC 18:00 = KST 03:00
    $cron$SELECT public.prune_audit_log();$cron$
  );
END
$$;
