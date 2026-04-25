/**
 * MOLIT 실거래가 ETL 잡
 *
 * 설계:
 *   - 매일 17:00 KST (Vercel Cron) 실행 → 최근 2개월 (이번 달 + 지난 달) 갱신.
 *   - 지역은 LAWD_CODES 25개 서울 구 + 수도권 7개 시/구 (총 32개).
 *   - Serverless 10s 제한 대응 — 한 번에 한 region-month 만 처리 후 다음 cron 에서 이어감.
 *     (대안: 페이징 큐) — 지금은 32 × 2 = 64 job 을 단일 cron 에서 순차 처리 (~6s 예상, 안전 여유).
 *   - idempotency: UNIQUE(dedup_key) 로 중복 INSERT 차단. 재실행해도 안전.
 *   - 회로차단: 연속 3 region 실패 시 전체 중단 — MOLIT 전체 장애 보호.
 *
 * 왜 이렇게:
 *   - "한 번에 한 region-month" 는 단순하지만 실패 지점 명확 — 운영 관측 편함 (molit_ingest_runs).
 *   - 단일 UPSERT 대신 batch INSERT … ON CONFLICT DO NOTHING — dedup_key 충돌 무시.
 *   - 최근 2개월만 → 과거 데이터는 따로 backfill 스크립트 (미구현, 향후).
 */
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const { LAWD_CODES } = require('../services/transactionService');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Vercel env 가 'service_role' 짧은 이름으로 추가될 수 있어 fallback (D1 ETL 운영 호환)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const MOLIT_API_KEY = process.env.MOLIT_API_KEY;

const MOLIT_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const MOLIT_OK_CODES = new Set(['00', '000']);

// 동시 API 호출 제한 — MOLIT 무료 키 rate limit 고려 (초당 ~3)
const API_CONCURRENCY = 2;
const CIRCUIT_BREAK_CONSECUTIVE_FAILURES = 3;
const BATCH_INSERT_SIZE = 500;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // 진단 로그 (length 만 — 값 노출 없음)
    logger.error({
      hasUrl: !!SUPABASE_URL,
      urlLen: SUPABASE_URL ? SUPABASE_URL.length : 0,
      hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
      keyLen: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.length : 0,
      keyEnvVarPresent: 'SUPABASE_SERVICE_ROLE_KEY' in process.env,
      shortNamePresent: 'service_role' in process.env,
    }, 'adminClient: env 진단');
    throw new Error('Supabase service_role 미설정 — ETL 불가');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 최근 2개월 YYYYMM (이번 달 + 지난 달) */
function recentYearMonths() {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * 1개 region-month 만큼 MOLIT fetch + parse.
 *   - 페이지별 재시도 (3회, 지수백오프 300/600/1200ms) — 5xx/timeout 방어
 *   - 페이징 완전 구현 (최대 10페이지, totalCount 기반 조기 종료)
 *     → 강남·송파 등 월 1000+건 구의 최근 거래 누락 문제 해결 (Bug #3)
 *   - 해제 거래 필터 (cdealType NOT NULL 행 제외) — Naver 와 시세 불일치 원인 제거
 */
async function fetchRegionMonth(lawdCd, dealYm) {
  const MAX_RETRY = 3;
  const MAX_PAGES = 10;
  const NUM_ROWS = 1000;

  async function fetchPage(pageNo) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const r = await axios.get(MOLIT_URL, {
          params: {
            serviceKey: MOLIT_API_KEY,
            LAWD_CD: lawdCd,
            DEAL_YMD: dealYm,
            pageNo,
            numOfRows: NUM_ROWS,
            _type: 'json',
          },
          timeout: 8000,
          headers: { Accept: 'application/json' },
        });
        const header = r.data?.response?.header;
        const body = r.data?.response?.body;
        if (header?.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
          throw new Error(`MOLIT resultCode=${header.resultCode} msg=${header.resultMsg}`);
        }
        const items = body?.items?.item;
        const list = Array.isArray(items) ? items : items ? [items] : [];
        const total = body?.totalCount != null ? parseInt(body.totalCount, 10) : null;
        return { list, total };
      } catch (e) {
        lastErr = e;
        // 진단: 마지막 retry 직전에 axios 에러 raw 응답 한번만 로그 (값 노출 최소화)
        if (attempt === MAX_RETRY) {
          const rd = e?.response?.data;
          let bodyPreview = null;
          if (typeof rd === 'string') bodyPreview = rd.slice(0, 300);
          else if (rd) {
            try { bodyPreview = JSON.stringify(rd).slice(0, 300); } catch (_) { bodyPreview = '[unserializable]'; }
          }
          logger.error({
            molitErrMsg: e.message,
            status: e?.response?.status,
            bodyPreview,
            keyLen: MOLIT_API_KEY ? MOLIT_API_KEY.length : 0,
            keyHasPlus: MOLIT_API_KEY ? MOLIT_API_KEY.includes('+') : false,
            keyHasPercent: MOLIT_API_KEY ? MOLIT_API_KEY.includes('%') : false,
            keyHasEqual: MOLIT_API_KEY ? MOLIT_API_KEY.includes('=') : false,
          }, 'MOLIT axios fail (진단)');
        }
        if (attempt < MAX_RETRY) {
          const delay = 300 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  const all = [];
  let totalCount = null;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const { list, total } = await fetchPage(pageNo);
    if (total != null) totalCount = total;
    all.push(...list);
    if (list.length < NUM_ROWS) break;
    if (totalCount != null && all.length >= totalCount) break;
  }

  return all
    .filter(item => !String(item.cdealType || '').trim()) // 해제 거래 제외
    .map(item => {
      const dy = parseInt(item.dealYear) || 0;
      const dm = parseInt(item.dealMonth) || 0;
      const dd = parseInt(item.dealDay) || 0;
      return {
        lawd_cd: item.regionCode || lawdCd,
        apt_seq: item.aptSeq || null,
        apt_name: (item.aptNm || '').trim(),
        sigungu: (item.sggNm || '').trim() || null,
        umd_nm: (item.umdNm || '').trim() || null,
        exclu_use_ar: parseFloat(item.excluUseAr) || 0,
        build_year: parseInt(item.buildYear) || null,
        floor: parseInt(item.floor) || null,
        deal_year: dy,
        deal_month: dm,
        deal_day: dd,
        deal_date: (dy && dm && dd)
          ? `${dy}-${String(dm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`
          : null,
        deal_amount: parseInt((item.dealAmount || '0').replace(/,/g, '')) || 0,
      };
    })
    .filter(t => t.apt_name && t.deal_date && t.deal_amount > 0);
}

/**
 * 단일 region-month 처리 — 이력 기록 + UPSERT
 */
async function ingestOne(admin, lawdCd, dealYm) {
  // 이력 INSERT
  const runRes = await admin.from('molit_ingest_runs').insert({
    lawd_cd: lawdCd,
    deal_ym: dealYm,
    status: 'running',
  }).select('id').single();

  const runId = runRes.data?.id;

  try {
    const rows = await fetchRegionMonth(lawdCd, dealYm);
    let inserted = 0;

    // batch UPSERT … ON CONFLICT (dedup_key) DO UPDATE
    // P0 (D1, 2026-04-25 감사 1-1): 정정거래 처리 — dedup_key 가 deal_amount 제외로 변경되어
    // 같은 거래가 정정되면 동일 dedup_key 로 들어옴 → ignoreDuplicates:false 로 deal_amount 갱신.
    // 사용자에게 동일 단지·일자에 거래 2건 노출되던 문제 해결.
    for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
      const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
      const { error, count } = await admin
        .from('molit_transactions')
        .upsert(chunk, { onConflict: 'dedup_key', ignoreDuplicates: false, count: 'exact' });
      if (error) throw error;
      inserted += (count ?? chunk.length);
    }

    await admin.from('molit_ingest_runs')
      .update({
        status: 'ok',
        rows_fetched: rows.length,
        rows_inserted: inserted,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    return { ok: true, lawdCd, dealYm, fetched: rows.length, inserted };
  } catch (e) {
    // 진단: error origin 정확히 파악 (값 노출 없음)
    logger.error({
      lawdCd, dealYm,
      errMsg: e?.message,
      errName: e?.constructor?.name,
      errCode: e?.code,
      errStatus: e?.status || e?.statusCode,
      errDetails: e?.details,
      errHint: e?.hint,
      stackTop: e?.stack ? String(e.stack).split('\n')[1] : null,
    }, 'ingestOne 실패 (진단)');
    await admin.from('molit_ingest_runs')
      .update({
        status: 'error',
        error_message: String(e.message || e).slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    return { ok: false, lawdCd, dealYm, error: e.message };
  }
}

/** 전체 실행 — Vercel Cron entrypoint 에서 호출 */
async function runMolitIngest() {
  if (!MOLIT_API_KEY || MOLIT_API_KEY === 'your_molit_api_key') {
    logger.warn('MOLIT_API_KEY 미설정 — ETL skip');
    return { skipped: true, reason: 'MOLIT_API_KEY missing' };
  }
  const admin = adminClient();
  const months = recentYearMonths();
  const regions = Object.entries(LAWD_CODES);

  const started = Date.now();
  const results = [];
  let consecutiveFailures = 0;

  // 동시 2 region-month 병렬 — MOLIT rate limit 존중
  const queue = [];
  for (const [name, lawdCd] of regions) {
    for (const ym of months) {
      queue.push({ name, lawdCd, ym });
    }
  }

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      if (consecutiveFailures >= CIRCUIT_BREAK_CONSECUTIVE_FAILURES) {
        results.push({ ...job, skipped: true, reason: 'circuit_break' });
        continue;
      }
      const r = await ingestOne(admin, job.lawdCd, job.ym);
      if (r.ok) consecutiveFailures = 0;
      else consecutiveFailures += 1;
      results.push({ region: job.name, ...r });
    }
  }

  await Promise.all(Array.from({ length: API_CONCURRENCY }, () => worker()));

  const ok = results.filter(r => r.ok).length;
  const err = results.filter(r => !r.ok && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const elapsedMs = Date.now() - started;
  logger.info({
    source: 'molit-ingest',
    regions: regions.length,
    months: months.length,
    ok, err, skipped,
    elapsedMs,
  }, 'MOLIT ETL 완료');
  return { ok, err, skipped, elapsedMs, results };
}

module.exports = { runMolitIngest };

// CLI: node backend/jobs/molitIngest.js
if (require.main === module) {
  runMolitIngest()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
