/**
 * audit_log 자동 정리 cron — Phase 33 #5 (2026-05-04)
 *
 * 배경:
 *   migration `20260424000004_audit_log_retention.sql` 가 pg_cron 으로
 *   prune_audit_log() 매일 04:00 KST 실행 — 90일 초과 row 삭제.
 *   그러나 pg_cron extension 은 Supabase Dashboard 에서 manual enable 필요.
 *   미활성 시 prune 안 됨 → audit_log 무한 grow → 디스크 폭주.
 *
 * 본 cron:
 *   pg_cron 의존성 없는 Vercel cron fallback.
 *   매일 03:00 UTC (KST 12:00) — pg_cron schedule (KST 04:00) 보다 먼저.
 *
 * 멱등:
 *   같은 cutoff 재실행해도 0 row 삭제 (이미 삭제됨).
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);

function client() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * audit_log 의 RETENTION_DAYS 초과 row 삭제.
 *
 * @returns {{
 *   deleted: number,
 *   cutoff: string,        // ISO
 *   skipped: boolean,      // service_role 미설정 시 true
 *   error: string|null,
 * }}
 */
async function run() {
  const sb = client();
  if (!sb) {
    logger.warn('audit-prune: SUPABASE_SERVICE_ROLE_KEY 미설정 — skip');
    return { deleted: 0, cutoff: null, skipped: true, error: null };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString();

  try {
    const { error, count } = await sb
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoffIso);
    if (error) throw error;
    logger.info({
      deleted: count ?? 0,
      cutoff: cutoffIso,
      retention_days: RETENTION_DAYS,
    }, 'audit-prune: 완료');
    return { deleted: count ?? 0, cutoff: cutoffIso, skipped: false, error: null };
  } catch (e) {
    logger.error({ err: e.message }, 'audit-prune: 실패');
    return { deleted: 0, cutoff: cutoffIso, skipped: false, error: e.message };
  }
}

module.exports = { run };
