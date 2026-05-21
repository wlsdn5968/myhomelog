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
const { LAWD_CODES, LAWD_CODE_TO_NAME } = require('../services/transactionService');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Vercel env 가 'service_role' 짧은 이름으로 추가될 수 있어 fallback (D1 ETL 운영 호환)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const MOLIT_API_KEY = process.env.MOLIT_API_KEY;

const MOLIT_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
const MOLIT_OK_CODES = new Set(['00', '000']);

// 동시 API 호출 제한 — MOLIT 무료 키 rate limit 고려 (초당 ~3).
// Phase 4 (2026-04-26): 32 region → 82 region 확대로 worker 늘림 (3). MOLIT 키 한도(초당 ~3) 안에서 안전.
const API_CONCURRENCY = 3;
const CIRCUIT_BREAK_CONSECUTIVE_FAILURES = 3;
const BATCH_INSERT_SIZE = 500;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service_role 미설정 — ETL 불가');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * 최근 N개월 YYYYMM (이번 달 ~ N-1개월 전)
 * Phase 4 (2026-04-26): 파라미터화 — 기본 3개월 (정정거래 + 늦게 등록된 거래 보정).
 *   admin/backfill 시 12개월 등 큰 값 가능. months × region 처리시간 고려.
 *   maxDuration 300s 안에서 안전한 최대치는 약 6개월 × 82 region.
 */
function recentYearMonths(months = 3) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
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
        // MOLIT 응답이 sggNm 빈값인 경우 LAWD_CODE 역매핑으로 채움 (popular/검색 필터 동작 위해)
        sigungu: (item.sggNm || '').trim() || LAWD_CODE_TO_NAME[item.sggCd || lawdCd] || null,
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
    const rawRows = await fetchRegionMonth(lawdCd, dealYm);

    // P0 (D1 후속, 2026-04-25): batch 내 dedup_key 충돌 방지.
    //   dedup_key 가 deal_amount 제외로 변경된 후, MOLIT 한 응답 안에 같은 (apt,면적,일자,층)
    //   조합이 둘 이상 등장 (정정 전/후 두 row). PostgreSQL ON CONFLICT DO UPDATE 는
    //   같은 statement 안의 같은 conflict 키 두 번 처리 불가 (errCode 21000).
    //   해결: JS 에서 미리 dedup. 후행 row 우선 (정정 후 데이터로 추정).
    //   dedup 키는 SQL GENERATED dedup_key 와 동일 컴포넌트 사용 (해시 전 raw key).
    // DEDUP-KEY-EXACT-2026-05-21 (cron 감사: 해운대구 26440 등 ingest 실패 "ON CONFLICT ... second time"):
    //   DB dedup_key(GENERATED md5)는 numeric(7,2)/integer 컬럼을 ::text 캐스팅 →
    //   "84.9700"/"84.9"/"84" 같은 raw 면적이 모두 "84.97"/"84.90"/"84.00" 로 정규화돼 동일 키.
    //   기존 JS 키는 raw 값 사용 → JS 는 distinct 로 보지만 DB dedup_key 는 충돌 → 같은 chunk 안
    //   2 row 가 같은 conflict 키 → DO UPDATE 실패 → 해당 region-month 전체 적재 누락.
    //   해결: DB ::text 캐스팅과 동일하게 정규화(면적 toFixed(2), 정수 Number, apt_seq COALESCE 의미).
    const seen = new Map();
    for (const r of rawRows) {
      const seq = (r.apt_seq == null) ? `${r.apt_name}:${r.umd_nm ?? ''}` : String(r.apt_seq); // COALESCE(apt_seq, ...)
      const area = Number(r.exclu_use_ar).toFixed(2);       // numeric(7,2)::text
      const fl = (r.floor == null) ? 0 : Number(r.floor);   // COALESCE(floor,0)::int
      const k = `${seq}|${area}|${Number(r.deal_year)}-${Number(r.deal_month)}-${Number(r.deal_day)}|${fl}`;
      seen.set(k, r); // 같은 키면 후행(정정 후) 덮어씀
    }
    const rows = Array.from(seen.values());

    let inserted = 0;
    // batch UPSERT … ON CONFLICT (dedup_key) DO UPDATE
    // ignoreDuplicates:false 로 deal_amount 갱신 (정정거래 처리).
    for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
      const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
      const { error, count } = await admin
        .from('molit_transactions')
        .upsert(chunk, { onConflict: 'dedup_key', ignoreDuplicates: false, count: 'exact' });
      if (error) {
        // DEDUP-KEY-EXACT-2026-05-21: 잔여 in-chunk dedup_key 충돌(21000) 시 chunk 전체 실패 방지 →
        //   행 단위 재시도(각 upsert 독립 statement → in-statement 중복 불가). 향후 dedup_key 공식 변경에도 안전망.
        if (error.code === '21000' || /affect row a second time/i.test(error.message || '')) {
          logger.warn({ lawdCd, dealYm, chunkSize: chunk.length }, 'molit-ingest: in-chunk dedup_key 충돌 → 행 단위 재시도');
          for (const row of chunk) {
            const { error: e1 } = await admin
              .from('molit_transactions')
              .upsert([row], { onConflict: 'dedup_key', ignoreDuplicates: false });
            if (!e1) inserted += 1;
          }
          continue;
        }
        throw error;
      }
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
/**
 * @param {Object} opts
 * @param {number} [opts.months=3] - 적재할 개월 수 (이번 달부터 거꾸로)
 * @param {number} [opts.offsetMonths=0] - 시작 offset (예: offset=6, months=6 → 6~12개월 전)
 *   Backfill 분할 호출용 (한 번에 12개월 실행 시 maxDuration 부족 → 6개월씩 2번)
 */
async function runMolitIngest(opts = {}) {
  const monthsCount = Math.max(1, Math.min(parseInt(opts.months) || 3, 24));
  const offsetMonths = Math.max(0, parseInt(opts.offsetMonths) || 0);

  if (!MOLIT_API_KEY || MOLIT_API_KEY === 'your_molit_api_key') {
    logger.warn('MOLIT_API_KEY 미설정 — ETL skip');
    return { skipped: true, reason: 'MOLIT_API_KEY missing' };
  }
  const admin = adminClient();
  // P1 (Agent 3차 audit, 2026-05-04): stale 'running' 정리 — Vercel timeout 시 잔존 row 무한 grow
  //   15분+ 'running' 상태면 timeout 으로 간주하고 정리
  try {
    await admin.from('molit_ingest_runs')
      .update({ status: 'timeout', finished_at: new Date().toISOString() })
      .eq('status', 'running')
      .lt('started_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());
  } catch (e) {
    logger.warn({ err: e.message }, 'molit_ingest_runs stale 정리 실패 (계속 진행)');
  }
  // offset 적용: recentYearMonths(N) 다음 N개 만 사용 (slice)
  const allMonths = recentYearMonths(monthsCount + offsetMonths);
  const months = allMonths.slice(offsetMonths);
  const regions = Object.entries(LAWD_CODES);

  const started = Date.now();
  const results = [];

  // 동시 2 region-month 병렬 — MOLIT rate limit 존중
  const queue = [];
  for (const [name, lawdCd] of regions) {
    for (const ym of months) {
      queue.push({ name, lawdCd, ym });
    }
  }

  // P1-4 (2026-05-04): cron worker race fix — consecutiveFailures shared
  //   기존: 다른 worker 의 성공이 다른 worker 의 실패 카운터 reset → 회로차단 동작 X
  //   변경: worker-local consecutiveFailures (closure 안)
  async function worker() {
    let localFailures = 0;
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      if (localFailures >= CIRCUIT_BREAK_CONSECUTIVE_FAILURES) {
        results.push({ ...job, skipped: true, reason: 'circuit_break' });
        continue;
      }
      const r = await ingestOne(admin, job.lawdCd, job.ym);
      if (r.ok) localFailures = 0;
      else localFailures += 1;
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
    monthsRange: months.length ? `${months[months.length-1]}~${months[0]}` : null,
    ok, err, skipped,
    elapsedMs,
  }, 'MOLIT ETL 완료');
  return { ok, err, skipped, elapsedMs, monthsCount: months.length, monthsRange: months.length ? `${months[months.length-1]}~${months[0]}` : null, results };
}

module.exports = { runMolitIngest };

// CLI: node backend/jobs/molitIngest.js
if (require.main === module) {
  runMolitIngest()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
