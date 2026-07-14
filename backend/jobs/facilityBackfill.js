/**
 * apt_master.facility 점진 백필 — FACILITY-BACKFILL-2026-06-18
 *   (운영자 "단지 비교 토대 = facility + 세대당주차 전수 적재")
 *
 * 배경 (DB 실측 2026-06-18):
 *   - apt_master 10,107개 중 facility 적재 단지 140개(1.39%) + 주차(DTL) 0개.
 *   - facility 는 그간 단지 상세 열람(report/detail) 시에만 온디맨드 저장 → 거의 안 채워짐(주 10개꼴).
 *   - 단지 비교(세대수·세대당주차·시공사 등)는 facility 일괄 보유가 전제 → 이 backfill 이 토대.
 *
 * 전략:
 *   - 매일 1회 cron — budget 안 multi-chunk. kapt_code 보유 + facility 미적재(NULL) 단지를 chunk 씩.
 *   - aptFacilityService.backfillFacilityByKaptCode 로 KAPT BasisInfo + DTL(주차)을 facility._dtl 병합 저장.
 *   - 외부(KAPT data.go.kr)는 무료 키(MOLIT 와 다른 service 라 quota 독립). 보수적 chunk/concurrency.
 *
 * 안전:
 *   - facility IS NULL 단지만 처리(덮어쓰기 X). kapt_code 기반이라 이름매칭 오염 없음.
 *   - 실패 단지는 backfillFacilityByKaptCode 가 {_empty} sentinel 처리 → 다음 chunk 후보에서 제외(무한재시도 차단).
 *   - budgetMs(기본 240s)-15s 마진에서 chunk loop 종료(Vercel maxDuration 300s 안전).
 */
const { createClient } = require('@supabase/supabase-js');
const { backfillFacilityByKaptCode } = require('../services/aptFacilityService');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

const DEFAULT_CHUNK = 40;
const MAX_CHUNK = 80;
const CONCURRENCY = 6;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 한 chunk 처리 — kapt_code 보유 단지 limit 개를 동시성 내 backfill.
 *  mode='null'      : facility 미적재(최초 적재) — 기존 동작.
 *  mode='incomplete': facility 있으나 _dtl(주차) 누락 레코드 self-heal (Sprint YYYY). */
async function runOneChunk(admin, limit, mode = 'null') {
  let q = admin.from('apt_master').select('kapt_code, apt_name').not('kapt_code', 'is', null);
  if (mode === 'incomplete') {
    // FACILITY-SELFHEAL-2026-07-12 (Sprint YYYY, 운영자 "공릉풍림아이원 주차 못잡음 + 세대수0 에러"):
    //   근본원인 = 백필이 facility IS NULL 만 처리 → 이미 레코드 있는데 _dtl(주차) 없는 단지(전국 2,588개·
    //   24%)를 영구 방치. backfillFacilityByKaptCode 가 BasisInfo+DTL 재조회 후 overwrite 하므로 재처리만
    //   시키면 _dtl 채워짐 → 주차 필터가 잡게 됨. stale(14일↑)만 재시도(매일 재fetch·quota 낭비 방지),
    //   _empty(실패 sentinel) 제외. 재fetch 후 fetched_at 갱신 → 다음 chunk 에서 자동 제외(진행 보장).
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    q = q.not('facility', 'is', null)
         .is('facility->_empty', null)
         .is('facility->_dtl', null)
         .lt('facility_fetched_at', cutoff);
  } else {
    q = q.is('facility', null);
  }
  const { data: rows, error } = await q.limit(limit);
  if (error) {
    logger.error({ err: error.message, mode }, 'facility backfill 후보 조회 실패');
    return { processed: 0, inserted: 0, failed: 0, error: error.message };
  }
  if (!rows || !rows.length) return { processed: 0, inserted: 0, failed: 0, message: '후보 없음' };

  let inserted = 0, failed = 0, withParking = 0;
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        const res = await backfillFacilityByKaptCode(r.kapt_code);
        if (res && res.ok) { inserted++; if (res.hasParking) withParking++; }
        else failed++;
      } catch (_) { failed++; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { processed: rows.length, inserted, failed, withParking };
}

/**
 * 백필 multi-chunk 실행 (budget time 안 반복)
 * @param {Object} opts
 * @param {number} [opts.chunk=40]      — 1 chunk 처리 단지 수
 * @param {number} [opts.budgetMs=240000] — 총 실행 budget (Vercel maxDuration 300s 안전 마진)
 */
async function run({ chunk = DEFAULT_CHUNK, budgetMs = 240000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) return { ok: false, error: 'Supabase 미설정', processed: 0 };

  const limit = Math.min(Math.max(parseInt(chunk) || DEFAULT_CHUNK, 1), MAX_CHUNK);
  let totalProcessed = 0, totalInserted = 0, totalFailed = 0, totalParking = 0, chunks = 0;
  // Phase A(null): 최초 적재 우선. Phase B(incomplete): _dtl(주차) 누락 self-heal (Sprint YYYY).
  //   각 chunk 후 fetched_at 갱신되어 stale 조건에서 빠지므로 같은 후보 재조회 없이 진행.
  for (const mode of ['null', 'incomplete']) {
    while ((Date.now() - started) < budgetMs - 15000) {
      const t = await runOneChunk(admin, limit, mode);
      if (!t.processed) break; // 이 mode 후보 소진 → 다음 mode
      totalProcessed += t.processed;
      totalInserted += t.inserted;
      totalFailed += t.failed;
      totalParking += (t.withParking || 0);
      chunks++;
    }
  }
  const elapsed = Date.now() - started;
  logger.info({
    source: 'facility-backfill',
    chunks, totalProcessed, totalInserted, totalFailed, totalParking, elapsedMs: elapsed,
  }, `facility backfill: ${chunks} chunks, ${totalInserted}/${totalProcessed} 적재 (주차 ${totalParking}건) (${elapsed}ms)`);
  // ALERT-DEDUP-FIX-2026-07-14 (Sprint HHHHH-3): 품질 경보를 health 핫패스(인스턴스별 스팸, Sentry NODE-4
  //   107 events)에서 본 cron 종료 시 1일 1회로 이동. cron 은 단일 실행이라 dedup 보장.
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const a2 = getSupabaseAdmin();
    if (a2) {
      const H = () => ['*', { count: 'exact', head: true }];
      const [total, facNull, dtlMissing] = await Promise.all([
        a2.from('apt_master').select(...H()),
        a2.from('apt_master').select(...H()).is('facility', null),
        a2.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null).is('facility->_dtl', null),
      ]);
      const t = total.count || 0, fn = facNull.count || 0, dm = dtlMissing.count || 0;
      const dtlPct = t > 0 ? Math.round((dm / t) * 100) : 0;
      const fnPct = t > 0 ? Math.round((fn / t) * 100) : 0;
      // 임계: 비율 기반(신규 단지 대량 유입 시에도 절대수 아닌 비율로 판단) — 주차누락 ≥15% OR 미적재 ≥10%
      if (dtlPct >= 15 || fnPct >= 10) {
        const Sentry = require('@sentry/node');
        Sentry.captureMessage(
          `facility 품질 (daily): 주차누락 ${dm}(${dtlPct}%)·미적재 ${fn}(${fnPct}%) — 백필 진행 중`,
          { level: 'warning', tags: { monitor: 'facility-quality-daily' } }
        );
      }
      logger.info({ source: 'facility-quality-daily', total: t, facilityNull: fn, dtlMissing: dm, dtlPct, fnPct }, 'facility 품질 일일 요약');
    }
  } catch (_) { /* 품질 요약 실패는 backfill 결과에 무영향 */ }
  return { ok: true, chunks, processed: totalProcessed, inserted: totalInserted, failed: totalFailed, withParking: totalParking, elapsedMs: elapsed };
}

module.exports = { run };
