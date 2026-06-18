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

/** 한 chunk 처리 — facility 미적재 + kapt_code 보유 단지 limit 개를 동시성 내 backfill. */
async function runOneChunk(admin, limit) {
  const { data: rows, error } = await admin
    .from('apt_master')
    .select('kapt_code, apt_name')
    .not('kapt_code', 'is', null)
    .is('facility', null)
    .limit(limit);
  if (error) {
    logger.error({ err: error.message }, 'facility backfill 후보 조회 실패');
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
  while ((Date.now() - started) < budgetMs - 15000) {
    const t = await runOneChunk(admin, limit);
    if (!t.processed) break; // 더 처리할 단지 X
    totalProcessed += t.processed;
    totalInserted += t.inserted;
    totalFailed += t.failed;
    totalParking += (t.withParking || 0);
    chunks++;
  }
  const elapsed = Date.now() - started;
  logger.info({
    source: 'facility-backfill',
    chunks, totalProcessed, totalInserted, totalFailed, totalParking, elapsedMs: elapsed,
  }, `facility backfill: ${chunks} chunks, ${totalInserted}/${totalProcessed} 적재 (주차 ${totalParking}건) (${elapsed}ms)`);
  return { ok: true, chunks, processed: totalProcessed, inserted: totalInserted, failed: totalFailed, withParking: totalParking, elapsedMs: elapsed };
}

module.exports = { run };
