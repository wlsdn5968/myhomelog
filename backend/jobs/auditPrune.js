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

// CONSENT-AUDIT-2026-05-10: 영구 보존 화이트리스트
//   migration `20260424000005_account_soft_delete.sql` 의 prune_audit_log() retain_actions
//   배열과 정확히 동일 9개 (...000004 의 6개에서 ...000005 가 account.* 3개를 추가했음).
//   pg_cron prune 이 동일 화이트리스트를 적용하지만, 본 Vercel cron 이 KST 12:00 으로 먼저
//   tick 하므로 JS 측에도 예외 필수 (그렇지 않으면 다음 날 새벽 pg_cron 실행 전에 삭제됨).
//   전자상거래법 / PIPA 침해사고 대응 / GDPR Art.30 — 결제·탈퇴·동의 영구 보관.
const RETAIN_ACTIONS = [
  'account.delete.request',   // routes/account.js:196 에서 실제 발행 — 삭제 요청 시각/사유 영구 보관
  'account.delete.start',     // 미래 확장 (DB 함수와 동기 — 현재 코드 미사용)
  'account.delete.complete',  // 미래 확장 (DB 함수와 동기 — 현재 코드 미사용)
  'account.restore',          // routes/account.js:265 에서 실제 발행 — 복구 시각 영구 보관
  'account.hard_delete',      // jobs/retention.js:105 에서 실제 발행 — 영구 삭제 실행 기록
  'payment.confirm',
  'payment.cancel',
  'payment.refund',
  'consent.accept',           // routes/account.js (본 sprint 신규) — 4 flag 동의 시각 영구 보관
];

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
    // CONSENT-AUDIT-2026-05-10: RETAIN_ACTIONS 는 영구 보존 — `.notIn()` 으로 제외.
    //   supabase-js v2 의 .notIn(column, array) 는 PostgREST `not.in.(...)` 으로 변환 (소스 검증).
    const { error, count } = await sb
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoffIso)
      .notIn('action', RETAIN_ACTIONS);
    if (error) throw error;
    logger.info({
      deleted: count ?? 0,
      cutoff: cutoffIso,
      retention_days: RETENTION_DAYS,
      retained_actions: RETAIN_ACTIONS,
    }, 'audit-prune: 완료');
    return { deleted: count ?? 0, cutoff: cutoffIso, skipped: false, error: null };
  } catch (e) {
    logger.error({ err: e.message }, 'audit-prune: 실패');
    return { deleted: 0, cutoff: cutoffIso, skipped: false, error: e.message };
  }
}

module.exports = { run };
