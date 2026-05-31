/**
 * apt_geocache 점진 백필 — STAB-AUDIT-2026-05-06 (운영자 발견 후속)
 *
 * 배경:
 *   - molit_transactions 16,044 distinct 단지 vs apt_geocache 172 row (1.07% coverage)
 *   - 사용자 검색 시 99% 단지가 마커 미표시 (lazy fill 의존만으로는 영원히 안 채워짐)
 *   - 운영자 ASSERT: "172 row 밖에 안되는거야"
 *
 * 전략:
 *   - 매일 1회 cron (vercel.json "0 4 * * *") + budgetMs 안 multi-chunk (50건/chunk default)
 *   - 거래 활발 단지 우선 (최근 60일 거래량 desc)
 *   - 정확 매칭 (sigungu+umd_nm+aptName) 만 INSERT — PR #44 환각 차단 검증 강제
 *   - 외부 geocoding quota 무료 한도 내 운용 목표 (월 사용량은 런타임 가변 — 고정 산정 불가)
 *
 * 안전:
 *   - NOT EXISTS apt_geocache 에만 처리 (덮어쓰기 X)
 *   - sigungu 검증 실패 시 INSERT 안 함 (환각 차단)
 *   - serverless maxDuration 안 — budgetMs(기본 240s)-15s 마진에서 chunk loop 종료 (run 함수)
 *   - resolveCoord 자체가 saveToDb 진행 → INSERT 자동
 */
const { createClient } = require('@supabase/supabase-js');
const { resolveCoordBatch } = require('../services/geocodeCacheService');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

const DEFAULT_CHUNK = 50;
const MAX_CHUNK = 100;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 백필 multi-chunk 실행 (budget time 안에 반복)
 * @param {Object} opts
 * @param {number} [opts.chunk=50]   — 1 chunk 처리 단지 수
 * @param {number} [opts.daysBack=180] — 거래 lookback 일수
 * @param {number} [opts.budgetMs=240000] — 총 실행 budget (Vercel maxDuration 300s 안전 마진)
 */
async function run({ chunk = DEFAULT_CHUNK, daysBack = 180, budgetMs = 240000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) {
    return { ok: false, error: 'Supabase 미설정', processed: 0 };
  }

  const limit = Math.min(Math.max(parseInt(chunk) || DEFAULT_CHUNK, 1), MAX_CHUNK);
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // budget 안 multi-chunk loop
  let totalProcessed = 0, totalInserted = 0, totalFailed = 0, chunks = 0;
  while ((Date.now() - started) < budgetMs - 15000) {  // 15s 마진 (마지막 chunk 안전 종료)
    const tickResult = await runOneChunk(admin, limit, since);
    if (tickResult.processed === 0) break; // 더 처리할 단지 X
    totalProcessed += tickResult.processed;
    totalInserted += tickResult.inserted;
    totalFailed += tickResult.failed;
    chunks++;
  }
  const elapsed = Date.now() - started;
  logger.info({
    source: 'geocache-backfill',
    chunks, totalProcessed, totalInserted, totalFailed, elapsedMs: elapsed,
  }, `geocache backfill: ${chunks} chunks, ${totalInserted}/${totalProcessed} 백필 (${elapsed}ms)`);
  return { ok: true, chunks, processed: totalProcessed, inserted: totalInserted, failed: totalFailed, elapsedMs: elapsed };
}

async function runOneChunk(admin, limit, since) {
  const tickStart = Date.now();

  // 거래 활발 단지 (apt_name, sigungu, umd_nm) distinct + 거래수 desc — RPC 또는 raw SQL
  // RPC 미정의 시 fallback: 일반 query (DISTINCT + 거래량 그룹)
  let candidates = [];
  try {
    const { data, error } = await admin.rpc('geocache_backfill_candidates', {
      p_limit: limit,
      p_since: since,
    });
    if (error) throw error;
    candidates = data || [];
  } catch (rpcErr) {
    logger.debug({ err: rpcErr.message }, 'geocache_backfill_candidates RPC 미정의 — fallback');
    // Fallback: 단순 fetch (서울 25구 우선)
    const { data, error } = await admin
      .from('molit_transactions')
      .select('apt_name, sigungu, umd_nm')
      .gte('deal_date', since)
      .limit(limit * 20); // 중복 많아 over-fetch
    if (error) {
      logger.error({ err: error.message }, 'geocache backfill 후보 조회 실패');
      return { ok: false, error: error.message, processed: 0 };
    }
    // distinct + 거래수 집계
    const groups = {};
    for (const r of (data || [])) {
      const k = `${r.apt_name}|${r.sigungu}|${r.umd_nm}`;
      groups[k] = (groups[k] || 0) + 1;
    }
    candidates = Object.entries(groups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 5)
      .map(([k]) => {
        const [apt_name, sigungu, umd_nm] = k.split('|');
        return { apt_name, sigungu, umd_nm };
      });
  }

  if (!candidates.length) {
    return { processed: 0, inserted: 0, failed: 0, message: '후보 없음' };
  }

  // apt_geocache 미보유 단지만 필터
  const keys = candidates.map(c => `${c.apt_name}|${c.sigungu}|${c.umd_nm}`);
  const { data: existing } = await admin
    .from('apt_geocache')
    .select('apt_name, sigungu, umd_nm')
    .in('apt_name', candidates.map(c => c.apt_name).slice(0, 200));

  const existingSet = new Set((existing || []).map(e => `${e.apt_name}|${e.sigungu||''}|${e.umd_nm||''}`));
  const todo = candidates.filter(c => !existingSet.has(`${c.apt_name}|${c.sigungu}|${c.umd_nm}`)).slice(0, limit);

  if (!todo.length) {
    return { processed: 0, inserted: 0, failed: 0, message: '모두 이미 보유' };
  }

  // resolveCoordBatch — sigungu 검증 강제 (PR #44 fix), saveToDb 자동 INSERT
  const items = todo.map(t => ({
    aptName: t.apt_name,
    sigungu: t.sigungu,
    umdNm: t.umd_nm,
  }));

  const results = await resolveCoordBatch(items, 4);
  const inserted = results.filter(r => r && r.lat && r.lng).length;
  const failed = results.length - inserted;

  return { processed: todo.length, inserted, failed, elapsedMs: Date.now() - tickStart };
}

module.exports = { run };
