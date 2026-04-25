/**
 * Retention Job — 주기 실행으로 법·정책상 보관 기한 경과 데이터 정리
 *
 * 실행 주체: Vercel Cron → POST /api/cron/retention (별도 라우터에서 이 모듈 호출)
 *           또는 직접 `node backend/jobs/retention.js` 로 운영자 수동 실행 가능
 *
 * 범위 (Phase 5.2 / 5.5):
 *   1) 계정 소프트 삭제 30일 경과 → hard delete
 *      - bookmarks / search_history / chat_sessions(→ chat_messages CASCADE) / user_billing 삭제
 *      - payments 는 전자상거래법 5년 보관 → raw_response 만 익명화 (이미 요청 시점 처리되었어도 재확인)
 *      - auth.users 본체 admin.deleteUser
 *      - account_deletion_requests.status='hard_deleted' 전환
 *   2) search_history 12개월 경과 파기 (PIPA 최소수집·목적외 보관 금지)
 *   3) chat_messages 24개월 경과 파기 (chat_sessions 함께)
 *
 * 멱등성:
 *   - 모든 작업은 WHERE status='pending' AND scheduled_hard_delete_at <= now() 같은 조건으로
 *     중복 실행해도 안전 (이미 처리된 행은 status 변경으로 자동 제외).
 *
 * 실패 처리:
 *   - 사용자 1명 실패해도 전체 job 중단 X (try/catch 개별 격리)
 *   - 감사 로그에 실패 사유 기록 — 운영자가 수동 조치 가능
 *
 * 보안:
 *   - service_role 키 필수 — 환경변수 미설정 시 즉시 에러 throw
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

const SEARCH_HISTORY_RETENTION_MONTHS = 12;
const CHAT_RETENTION_MONTHS = 24;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Retention job: SUPABASE_URL / SERVICE_ROLE_KEY 미설정');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const { writeSystemAudit } = require('../middleware/auditLog');
// writeAudit (retention 용 — admin 인자 무시하고 공용 writeSystemAudit 래핑)
async function writeAudit(_admin, userId, action, meta) {
  return writeSystemAudit(action, 'user', userId, { ...(meta || {}), userId });
}

/** 단일 사용자 hard delete — 멱등 */
async function hardDeleteUser(admin, userId) {
  const counts = {};
  const errors = {};

  // 1) 결제 익명화 (이미 적용되었더라도 재확인)
  try {
    const { error } = await admin.from('payments')
      .update({ raw_response: null })
      .eq('user_id', userId);
    if (error) throw error;
  } catch (e) {
    errors.payments_anonymize = e.message;
  }

  // 2) 데이터 cascade 삭제 (chat_sessions → chat_messages ON DELETE CASCADE)
  const tables = ['bookmarks', 'search_history', 'chat_sessions', 'user_billing'];
  for (const tbl of tables) {
    try {
      const { error, count } = await admin
        .from(tbl)
        .delete({ count: 'exact' })
        .eq('user_id', userId);
      if (error) throw error;
      counts[tbl] = count ?? 0;
    } catch (e) {
      errors[tbl] = e.message;
    }
  }

  // 3) auth.users 본체 삭제
  let authDeleted = false;
  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    authDeleted = true;
  } catch (e) {
    errors.auth_users = e.message;
  }

  // 4) account_deletion_requests 상태 전환
  try {
    const { error } = await admin
      .from('account_deletion_requests')
      .update({
        status: 'hard_deleted',
        hard_deleted_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    if (error) throw error;
  } catch (e) {
    errors.adr_update = e.message;
  }

  await writeAudit(admin, userId, 'account.hard_delete', { counts, errors, authDeleted });

  return { userId, counts, errors, authDeleted };
}

async function runSoftDeleteExpiry(admin) {
  const { data: due, error } = await admin
    .from('account_deletion_requests')
    .select('user_id, requested_at, scheduled_hard_delete_at')
    .eq('status', 'pending')
    .lte('scheduled_hard_delete_at', new Date().toISOString())
    .limit(100); // 한 번에 100명까지 — Vercel 함수 타임아웃 고려
  if (error) throw error;

  const results = [];
  for (const row of due || []) {
    try {
      const r = await hardDeleteUser(admin, row.user_id);
      results.push(r);
      logger.info({ userId: row.user_id, counts: r.counts, errors: r.errors }, 'retention: hard_delete 완료');
    } catch (e) {
      logger.error({ err: e.message, userId: row.user_id }, 'retention: hard_delete 실패');
      results.push({ userId: row.user_id, error: e.message });
    }
  }
  return { processed: results.length, results };
}

async function runSearchHistoryRetention(admin) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - SEARCH_HISTORY_RETENTION_MONTHS);
  try {
    const { error, count } = await admin
      .from('search_history')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());
    if (error) throw error;
    logger.info({ deleted: count, cutoff: cutoff.toISOString() }, 'retention: search_history 파기');
    return { deleted: count ?? 0 };
  } catch (e) {
    logger.error({ err: e.message }, 'retention: search_history 파기 실패');
    return { error: e.message };
  }
}

async function runChatRetention(admin) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CHAT_RETENTION_MONTHS);
  try {
    // chat_sessions 삭제 → chat_messages ON DELETE CASCADE 로 함께 삭제
    const { error, count } = await admin
      .from('chat_sessions')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());
    if (error) throw error;
    logger.info({ deleted: count, cutoff: cutoff.toISOString() }, 'retention: chat 파기');
    return { deleted: count ?? 0 };
  } catch (e) {
    logger.error({ err: e.message }, 'retention: chat 파기 실패');
    return { error: e.message };
  }
}

async function run() {
  const started = Date.now();
  const admin = adminClient();
  logger.info('retention job 시작');

  const softDeleteResult = await runSoftDeleteExpiry(admin);
  const searchHistResult = await runSearchHistoryRetention(admin);
  const chatResult = await runChatRetention(admin);

  const summary = {
    durationMs: Date.now() - started,
    softDelete: softDeleteResult,
    searchHistory: searchHistResult,
    chat: chatResult,
  };
  logger.info(summary, 'retention job 완료');
  return summary;
}

module.exports = { run, hardDeleteUser, runSoftDeleteExpiry, runSearchHistoryRetention, runChatRetention };

// CLI 실행 지원
if (require.main === module) {
  run()
    .then((s) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(s, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      logger.error({ err: e.message }, 'retention job 치명적 오류');
      process.exit(1);
    });
}
