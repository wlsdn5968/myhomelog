/**
 * 정책 stale 자동 검증 cron (Phase 18, 2026-05-04)
 *
 * 목적:
 *   regulations_snapshot 의 source_effective_date 가 180일 초과 시
 *   자동으로 운영자 알림 (Sentry capture).
 *
 *   기존: regulationsService.getSnapshot() 호출 시점에만 stale 감지
 *        (사용자 호출 누적 후에야 운영자 인지 — late detection).
 *
 *   변경: cron 이 매주 1회 직접 검증 — 사용자 호출 0이어도 운영자 알림.
 *
 * 호출 빈도:
 *   주 1회 (월요일 04:00 KST) — apt-master-sync 직후
 *
 * 멱등:
 *   읽기만 — DB 변경 X. 재실행 안전.
 *
 * 호출:
 *   POST /api/cron/regulations-check (Vercel Cron 또는 외부 스케줄러)
 *   GET  도 동일 (수동 trigger 용)
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
                  || process.env.SUPABASE_ANON_KEY
                  || process.env.SUPABASE_SERVICE_ROLE_KEY
                  || process.env.service_role;

const STALE_THRESHOLD_DAYS = parseInt(process.env.REGULATIONS_STALE_DAYS || '180', 10);

function client() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * regulations_snapshot 활성 row 의 stale 여부 검증.
 *
 * @returns {{
 *   checked: number,         // 검사한 row 수
 *   stale: Array<{           // stale 항목
 *     key: string,
 *     daysSince: number,
 *     effectiveDate: string,
 *     sourceUrl: string|null,
 *   }>,
 *   fresh: number,           // 정상 row 수
 *   skipped: boolean,        // DB 미설정 시 true
 * }}
 */
async function run() {
  const sb = client();
  if (!sb) {
    logger.warn('regulations-check: Supabase 미설정 — skip');
    return { checked: 0, stale: [], fresh: 0, skipped: true };
  }

  // 활성 row (valid_to IS NULL or 미래)
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('regulations_snapshot')
    .select('key, source_effective_date, source_url, note, valid_from, valid_to')
    .or(`valid_to.is.null,valid_to.gt.${nowIso}`)
    .lte('valid_from', nowIso);

  if (error) {
    logger.error({ err: error.message }, 'regulations-check: 조회 실패');
    throw error;
  }

  const stale = [];
  let fresh = 0;
  for (const row of (data || [])) {
    if (!row.source_effective_date) continue; // 발효일 없으면 검증 불가
    const eff = new Date(row.source_effective_date);
    if (isNaN(eff)) continue;
    const daysSince = Math.floor((Date.now() - eff.getTime()) / 86400000);
    if (daysSince > STALE_THRESHOLD_DAYS) {
      stale.push({
        key: row.key,
        daysSince,
        effectiveDate: row.source_effective_date,
        sourceUrl: row.source_url || null,
      });
      // 항목별 logger.warn — Sentry route tag
      logger.warn({
        key: row.key,
        daysSince,
        effectiveDate: row.source_effective_date,
        threshold: STALE_THRESHOLD_DAYS,
      }, 'regulations-check: stale 감지 — 운영자 갱신 필요');
    } else {
      fresh++;
    }
  }

  // 요약 로그 (Sentry breadcrumb 으로도 잡힘)
  logger.info({
    checked: (data || []).length,
    stale_count: stale.length,
    fresh_count: fresh,
    threshold_days: STALE_THRESHOLD_DAYS,
  }, 'regulations-check: 완료');

  return {
    checked: (data || []).length,
    stale,
    fresh,
    skipped: false,
  };
}

module.exports = { run };
