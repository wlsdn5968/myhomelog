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
const logger = require('../logger');
const { requireSupabaseAdmin } = require('../db/client');

const SEARCH_HISTORY_RETENTION_MONTHS = 12;
const CHAT_RETENTION_MONTHS = 24;
// DB-STABILITY-2026-07-11 (Sprint OOOO): molit_ingest_runs 는 매일 (lawd×월) 재적재로 무한 grow
//   (실측 pair당 ~17배 중복). gap-retry(retryFailedGaps)는 error/timeout(18개월) 기반이라
//   '성공(ok)' 로그만 파기해도 재시도 로직에 무영향 — 테이블을 bound.
// RETAIN-LATEST-OK-2026-09-20 (Plan 106): 90일은 너무 길어 43,455행(9.6MB)까지 불었다. 그런데 단순
//   기간 삭제로 줄이면 getTransactionsFromDb(services/transactionService.js)가 그 (지역,월)의 ok 기록이
//   하나도 없을 때 "안 채워짐"으로 오판해 MOLIT API 로 직접 나간다 — 실측 40지역×3개월이 이미 이 상태.
//   그래서 (지역,월)별 최신 ok 1건은 DB 함수(prune_molit_ingest_runs)가 영구 보존하고, 나머지만
//   기간 기준으로 지운다. 기본 보관일도 90 → 14 로 낮춘다(최신 1건은 어차피 영구 보존되니 나머지는 짧아도 안전).
const INGEST_RUNS_OK_RETENTION_DAYS = parseInt(process.env.INGEST_RUNS_OK_RETENTION_DAYS || '14', 10);

// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
function adminClient() {
  return requireSupabaseAdmin('Retention job');
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
  // Sprint HHHHHH: kakao_notify_tokens 추가 — 카카오 OAuth 토큰은 탈퇴 즉시 파기 (FK CASCADE 도 있으나 명시 삭제 이중 안전망)
  // VERIFY-FIX-2 (Sprint NNNNNNN-17): activity_counters 누락 — 탈퇴 후 잔존은 PIPA 파기 의무 위반 소지(적대 검증 적발)
  // DER-RETENTION-2026-08-20 (전수검증 코드 대조): data_error_reports(user_id + 자유서술 detail, FK CASCADE 없음) 누락 — 같은 패턴 재발
  const tables = ['bookmarks', 'search_history', 'chat_sessions', 'user_billing', 'kakao_notify_tokens', 'activity_counters', 'data_error_reports',
    // SEC-1030-C7: user_budget(user_id 별 월 예산 — migration 20260424000006)이 목록에서 빠져 탈퇴 후에도 잔존했다.
    'user_budget'];
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
    // SEC-1030-C4: 재시도 회차에서는 auth 사용자가 이미 지워져 있다 — '없음'도 삭제 완료로 본다
    //   (아니면 한 번 부분 실패한 요청이 영원히 pending 으로 남아 매일 경보를 낸다).
    //   판정은 auth-js 가 붙이는 code 'user_not_found' 하나만(적대 리뷰 2026-10-30): 메시지·404 만 보면
    //   'Database error ... not found'(500) 나 게이트웨이 404 같은 진짜 실패를 삭제 완료로 삼켜 재시도가 끊긴다.
    if (error && error.code !== 'user_not_found') throw error;
    authDeleted = true;
  } catch (e) {
    errors.auth_users = e.message;
  }

  // 4) account_deletion_requests 상태 전환
  // SEC-1030-C4: 표 삭제 실패(errors 비어있지 않음)나 auth.users 삭제 실패인데도 'hard_deleted' 로 바꾸면
  //   다음 cron 이 pending 만 조회하므로 잔존 데이터가 영영 재시도되지 않는다. 전부 성공했을 때만 전환하고
  //   아니면 pending 유지 → 다음 cron 이 재시도(삭제는 멱등).
  // SEC-1030-C7: 전환 시 CS 연락용 개인정보(이메일·IP·UA·사유)를 함께 비운다 — 유예가 끝났으면 보관 목적이 소멸.
  const failed = Object.keys(errors).length > 0 || !authDeleted;
  if (!failed) {
    try {
      const { error } = await admin
        .from('account_deletion_requests')
        .update({
          status: 'hard_deleted',
          hard_deleted_at: new Date().toISOString(),
          email_at_request: null,
          ip_masked: null,
          user_agent: null,
          reason: null,
        })
        .eq('user_id', userId);
      if (error) throw error;
    } catch (e) {
      errors.adr_update = e.message;
    }
  } else {
    logger.warn({ userId, errors, authDeleted }, 'retention: hard_delete 일부 실패 — pending 유지(다음 cron 재시도)');
    try {
      require('../sentry').captureMessage(`retention hard_delete 일부 실패 (${Object.keys(errors).join(',') || 'auth'})`,
        { level: 'warning', tags: { monitor: 'retention-hard-delete' } });
    } catch (_) { /* Sentry 미구성이어도 무영향 */ }
  }

  await writeAudit(admin, userId, 'account.hard_delete', { counts, errors, authDeleted, failed: failed || Object.keys(errors).length > 0 });

  return { userId, counts, errors, authDeleted, failed: failed || Object.keys(errors).length > 0 };
}

async function runSoftDeleteExpiry(admin) {
  const { data: due, error } = await admin
    .from('account_deletion_requests')
    .select('user_id, requested_at, scheduled_hard_delete_at, hard_delete_attempts')
    .eq('status', 'pending')
    .lte('scheduled_hard_delete_at', new Date().toISOString())
    // 시도 횟수가 적은 요청부터 — 계속 실패하는 요청이 앞자리를 막아 정상 요청이 굶지 않게(보안 점검 후속 2026-10-30,
    //   열은 supabase/migrations/20261030_deletion_attempts.sql)
    .order('hard_delete_attempts', { ascending: true })
    .order('scheduled_hard_delete_at', { ascending: true })
    .limit(100); // 한 번에 100명까지 — Vercel 함수 타임아웃 고려
  if (error) throw error;

  const results = [];
  for (const row of due || []) {
    let failed = false;
    try {
      const r = await hardDeleteUser(admin, row.user_id);
      results.push(r);
      failed = !!r.failed;
      logger.info({ userId: row.user_id, counts: r.counts, errors: r.errors }, 'retention: hard_delete 완료');
    } catch (e) {
      failed = true;
      logger.error({ err: e.message, userId: row.user_id }, 'retention: hard_delete 실패');
      results.push({ userId: row.user_id, error: e.message });
    }
    if (failed) {
      // 실패 횟수 기록 — 다음 회차에서 뒤로 밀린다. 기록 실패는 무시(다음 회차 재시도는 그대로).
      try {
        await admin.from('account_deletion_requests')
          .update({ hard_delete_attempts: (Number(row.hard_delete_attempts) || 0) + 1 })
          .eq('user_id', row.user_id).eq('status', 'pending');
      } catch (_) { /* 무시 */ }
    }
  }
  // SEC-1030-C4: 실패 건수(예외 + 부분 실패)를 요약에 노출 — pending 으로 남아 다음 cron 이 재시도한다.
  const failedCount = results.filter(r => r.error || r.failed).length;
  return { processed: results.length, failed: failedCount, results };
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
    // P2-7 (2026-05-04): 활성 사용자 (last_message_at 최근 30일 이내) 면제
    //   기존: created_at 24개월+ 무조건 삭제 → 활성 사용자 옛 chat 도 파기 (PIPA 위반 가능)
    //   변경: 활성 사용자는 최근 활동 시점 기준 면제 — 비활성 사용자만 24개월 cutoff
    const activeCutoff = new Date();
    activeCutoff.setDate(activeCutoff.getDate() - 30); // 최근 30일 활동 = 활성
    const { error, count } = await admin
      .from('chat_sessions')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString())
      .lt('last_message_at', activeCutoff.toISOString()); // 활성 면제
    if (error) throw error;
    logger.info({
      deleted: count,
      cutoff: cutoff.toISOString(),
      activeExempt: activeCutoff.toISOString(),
    }, 'retention: chat 파기 (활성 사용자 면제)');
    return { deleted: count ?? 0 };
  } catch (e) {
    logger.error({ err: e.message }, 'retention: chat 파기 실패');
    return { error: e.message };
  }
}

/**
 * molit_ingest_runs 운영 로그 정리 (DB-STABILITY-2026-07-11).
 *   1) 고아 'running'(크래시 잔존, 2시간+) → 'timeout' (gap-retry 가 재시도하도록 · runMolitIngest 시작부 15분 정리의 이중 안전망)
 *   2) ok 는 (지역,월)별 최신 1건 영구 보존 + 나머지 14일 — 최신 ok 가 사라지면 그 달 조회가 MOLIT API 로
 *      떨어진다(2026-09-20 실측 40지역×3개월). DB 함수 prune_molit_ingest_runs(Plan 106)가 그 불변식을 지킨다.
 * 전부 PostgREST 단순 필터(자기조인/DDL 불요). 실패해도 다른 retention 작업엔 무영향.
 */
async function runIngestRunsRetention(admin) {
  const out = { staleRunningFixed: 0, okPruned: 0, error: null };
  // STEP-ISOLATION-2026-09-20 (Plan 110): 종전엔 ①이 throw 하면 ②(프루닝 RPC)가 통째로 건너뛰어졌다.
  //   실제로 CHECK 제약이 'timeout' 을 금지해 ①이 90일간 매일 실패했고, 그 사실이 어디에도 안 보였다.
  //   두 단계는 서로 독립이므로 각자 실패하고 각자 기록한다.
  try {
    const staleCut = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { count: sc, error: e1 } = await admin.from('molit_ingest_runs')
      .update({ status: 'timeout', finished_at: new Date().toISOString(), error_message: 'stale running (retention cleanup)' }, { count: 'exact' })
      .eq('status', 'running')
      .lt('started_at', staleCut);
    if (e1) throw e1;
    out.staleRunningFixed = sc ?? 0;
  } catch (e) {
    out.error = `staleRunning: ${e.message}`;
    logger.warn({ err: e.message }, 'retention: 고아 running 정리 실패 (프루닝은 계속 진행)');
  }
  try {
    const { data: pruned, error: e2 } = await admin.rpc('prune_molit_ingest_runs', { p_keep_days: INGEST_RUNS_OK_RETENTION_DAYS });
    if (e2) throw e2;
    out.okPruned = Number(pruned) || 0;
  } catch (e) {
    out.error = out.error ? `${out.error} | prune: ${e.message}` : `prune: ${e.message}`;
    logger.warn({ err: e.message }, 'retention: molit_ingest_runs 프루닝 실패');
  }
  logger.info({ ...out, okRetentionDays: INGEST_RUNS_OK_RETENTION_DAYS }, 'retention: molit_ingest_runs 정리');
  return out;
}

// ATTRIBUTION-RETENTION-2026-08-29 (Sprint NNNNNNN-31): 유입 집계는 개인정보가 아니지만(식별자 미저장)
//   무료 DB 500MB 중 이미 60% 를 쓰고 있어 무한 증식을 두면 안 된다. 채널 비교엔 반년이면 충분하다.
const ATTRIBUTION_RETENTION_DAYS = 180;
async function runAttributionRetention(admin) {
  const out = { pruned: 0, error: null };
  try {
    const cut = new Date(Date.now() - ATTRIBUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await admin.from('visit_attribution')
      .delete({ count: 'exact' })
      .lt('created_at', cut)
      // Plan 184: daily_visit 은 화면의 "2026-10-20 이후 누적" 이 센다 — 지우면 누적이 줄어든다. 브라우저당 하루 1행이라 작다.
      .neq('event', 'daily_visit');
    if (error) throw error;
    out.pruned = count ?? 0;
    logger.info({ ...out, retentionDays: ATTRIBUTION_RETENTION_DAYS }, 'retention: visit_attribution 정리');
  } catch (e) {
    out.error = e.message;
    logger.warn({ err: e.message }, 'retention: visit_attribution 정리 실패 (계속 진행)');
  }
  return out;
}

// AUDIT-CAPS-1111 (보안 점검 anon-append-tables-unbounded-growth): 익명도 쓸 수 있는 추가 전용 표의 총량 상한.
//   visit_attribution 은 위 runAttributionRetention 이 이미 180일 지난 행을 지운다(daily_visit 만 의도적으로 제외, Plan 184).
//   ai_feedback(최대 한 행 약 1KB 안팎 문자열)·data_error_reports(detail 500자)는 정리가 없었다(탈퇴 사용자 행 삭제뿐).
//   운영자가 읽어야 하는 신고·평가라 나이로 지우지 않고, 표별 총 행 수 상한을 넘는 분량만 오래된 것(id 작은 것)부터 지운다.
//   정상 사용량으로는 닿지 않는 크기로 잡았다(무료 DB 500MB 대비 각 표 몇 MB 이내).
const ANON_TABLE_ROW_CAPS = { ai_feedback: 10000, data_error_reports: 5000 };
async function _trimTableToCap(admin, table, cap) {
  const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true });
  if (error) throw error;
  if (!count || count <= cap) return 0;
  // 최신 cap 번째 행의 id 보다 작은 행이 초과분이다
  const { data, error: e2 } = await admin.from(table).select('id').order('id', { ascending: false }).range(cap - 1, cap - 1);
  if (e2) throw e2;
  const edge = data && data[0] && data[0].id;
  if (edge === undefined || edge === null) return 0;
  const { count: del, error: e3 } = await admin.from(table).delete({ count: 'exact' }).lt('id', edge);
  if (e3) throw e3;
  return del ?? 0;
}
// AUDIT4-1114 (push-subscribe-cap-exhaustion-unpruned-fake-subs): 여러 IP 가 없는 단지 이름으로 구독을 만들면 알림 대상이 아니라
//   발송 실패 정리에도 걸리지 않고 5,000건 상한을 영구히 채울 수 있었다. 가짜만 겨냥해 지운다:
//   만든 지 30일 넘고, 항목 중 그 지역의 실거래 단지명(molit_apt_index), 단지 마스터 이름, 별칭(molit_aliases)과 맞는 것이 하나도 없는 구독.
//   이름 비교는 알림 매칭(pushNotify matchItems)과 같은 정규화(normalizeAptName 뒤 공백 제거, 소문자, NFC)를 쓴다.
//   독립 검토(2026-11-14) 반영: last_notified_at 은 알림 작업이 알림을 안 보낸 구독까지 갱신하므로 조건에서 뺐다.
//   안전장치: 조회가 하나라도 실패하면 아무것도 지우지 않는다. 그 지역 단지 목록이 비어 있으면 그 지역 항목은 '맞음'으로 본다.
//   운영 실측 2026-11-14: 구독 2건 모두 실제 단지.
const PUSH_FAKE_MIN_AGE_DAYS = 30;
const _pushNn = (s) => String(require('../utils/aptName').normalizeAptName(String(s || ''))).normalize('NFC').replace(/\s+/g, '').toLowerCase();
async function _lawdNameSet(admin, lawd) {
  const set = new Set();
  for (const [table, cols] of [['molit_apt_index', 'apt_name'], ['apt_master', 'apt_name, molit_aliases']]) {
    for (let from = 0; from <= 9000; from += 1000) {
      const { data, error } = await admin.from(table).select(cols).eq('lawd_cd', lawd).range(from, from + 999);
      if (error) throw error;
      for (const r of (data || [])) {
        set.add(_pushNn(r.apt_name));
        for (const a of (Array.isArray(r.molit_aliases) ? r.molit_aliases : [])) set.add(_pushNn(String(a).split('#')[0]));
      }
      if (!data || data.length < 1000) break;
    }
  }
  return set;
}
async function runFakePushPrune(admin) {
  const out = { fakePushPruned: 0, error: null };
  try {
    const cutoff = new Date(Date.now() - PUSH_FAKE_MIN_AGE_DAYS * 86400000).toISOString();
    const { data: subs, error } = await admin.from('push_subscriptions').select('id, items')
      .lt('created_at', cutoff).limit(5000);
    if (error) throw error;
    if (!subs || !subs.length) return out;
    const lawds = new Set();
    for (const s of subs) for (const it of (Array.isArray(s.items) ? s.items : [])) if (it && it.lawdCd) lawds.add(String(it.lawdCd));
    const namesByLawd = new Map();
    for (const lawd of lawds) namesByLawd.set(lawd, await _lawdNameSet(admin, lawd));
    const itemKnown = (it) => {
      if (!it || !it.lawdCd || !it.aptName) return false;
      const set = namesByLawd.get(String(it.lawdCd));
      if (!set || set.size === 0) return true; // 목록을 못 얻은 지역은 맞음으로 본다(지우지 않음)
      return set.has(_pushNn(it.aptName));
    };
    const fake = subs.filter((s) => !(Array.isArray(s.items) && s.items.some(itemKnown))).map((s) => s.id);
    for (let i = 0; i < fake.length; i += 200) {
      const { count, error: de } = await admin.from('push_subscriptions').delete({ count: 'exact' }).in('id', fake.slice(i, i + 200));
      if (de) throw de;
      out.fakePushPruned += count ?? 0;
    }
    if (out.fakePushPruned) logger.info({ pruned: out.fakePushPruned }, 'retention: 가짜 푸시 구독 정리');
  } catch (e) {
    out.error = `push_subscriptions: ${e.message}`;
    logger.warn({ err: e.message }, 'retention: 가짜 푸시 구독 정리 실패 (계속 진행)');
  }
  return out;
}

async function runAnonTableCaps(admin) {
  const out = { aiFeedbackTrimmed: 0, dataErrorTrimmed: 0, error: null };
  // 표마다 독립 try: 한 표 실패가 다른 표 정리를 막지 않는다
  try { out.aiFeedbackTrimmed = await _trimTableToCap(admin, 'ai_feedback', ANON_TABLE_ROW_CAPS.ai_feedback); }
  catch (e) { out.error = `ai_feedback: ${e.message}`; logger.warn({ err: e.message }, 'retention: ai_feedback 상한 정리 실패 (계속 진행)'); }
  try { out.dataErrorTrimmed = await _trimTableToCap(admin, 'data_error_reports', ANON_TABLE_ROW_CAPS.data_error_reports); }
  catch (e) { out.error = out.error ? `${out.error} | data_error_reports: ${e.message}` : `data_error_reports: ${e.message}`; logger.warn({ err: e.message }, 'retention: data_error_reports 상한 정리 실패 (계속 진행)'); }
  return out;
}
async function run() {
  const started = Date.now();
  const admin = adminClient();
  logger.info('retention job 시작');

  const softDeleteResult = await runSoftDeleteExpiry(admin);
  const searchHistResult = await runSearchHistoryRetention(admin);
  const chatResult = await runChatRetention(admin);
  const ingestRunsResult = await runIngestRunsRetention(admin);
  const attributionResult = await runAttributionRetention(admin);
  const anonCapResult = await runAnonTableCaps(admin); // AUDIT-CAPS-1111
  const fakePushResult = await runFakePushPrune(admin); // AUDIT4-1114

  const summary = {
    durationMs: Date.now() - started,
    softDelete: softDeleteResult,
    searchHistory: searchHistResult,
    chat: chatResult,
    ingestRuns: ingestRunsResult,
    attribution: attributionResult,
    // OBSERV-FLAT-2026-09-20 (Plan 110): cronStats._pick 은 최상위 키만 본다 — 중첩된 ingestRuns 의
    //   성과·실패가 health.crons['retention'] 에 90일간 한 번도 안 보였다. 평탄화 키를 함께 싣는다.
    okPruned: ingestRunsResult && ingestRunsResult.okPruned,
    staleRunningFixed: ingestRunsResult && ingestRunsResult.staleRunningFixed,
    // AUDIT-CAPS-1111: 익명 추가 전용 표 상한 정리 결과(평탄 키, cronStats NUM 등록)
    aiFeedbackTrimmed: anonCapResult.aiFeedbackTrimmed,
    dataErrorTrimmed: anonCapResult.dataErrorTrimmed,
    fakePushPruned: fakePushResult.fakePushPruned, // AUDIT4-1114: 가짜 푸시 구독 정리 수(0 이 정상)
    ...(ingestRunsResult && ingestRunsResult.error ? { error: ingestRunsResult.error }
      : (anonCapResult.error ? { error: anonCapResult.error }
        : (fakePushResult.error ? { error: fakePushResult.error } : {}))),
  };
  logger.info(summary, 'retention job 완료');
  return summary;
}

module.exports = { run, runAnonTableCaps, runFakePushPrune, ANON_TABLE_ROW_CAPS, hardDeleteUser, runAttributionRetention, runSoftDeleteExpiry, runSearchHistoryRetention, runChatRetention, runIngestRunsRetention };

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
