-- 20261018_audit_log_retain_1y.sql
-- plans/164 (운영자 "권고대로" 승인 2026-10-18): 이용 기록(audit_log) 일반 행 보관 90일 → 365일.
-- 근거: frontend/privacy.html "로그 관리: 개인정보 처리 시스템 접근 기록 1년 이상 보관" — 종전 90일 삭제는 이 문구와 어긋났다.
-- pg_cron jobid 1 (0 18 * * *) 이 이 함수를 부른다(2026-10-18 cron.job 조회). JS 쪽 backend/jobs/auditPrune.js 도 같은 날 365일로 바꿨다.
-- 영구 보관 목록(retain_actions)은 그대로 — backend/jobs/auditPrune.js RETAIN_ACTIONS 와 정확히 같아야 한다.
-- 2026-10-18 현재 audit_log 9행(가장 오래된 행 2026-06-17) — 늘려도 용량 영향 없음.

CREATE OR REPLACE FUNCTION public.prune_audit_log()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  WHERE created_at < (now() - INTERVAL '365 days')
    AND action <> ALL(retain_actions);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;

-- [확인] select pg_get_functiondef('public.prune_audit_log'::regproc) ~ '365 days';  → true
