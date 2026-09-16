'use strict';
// HIST-BACKFILL-2026-09-16 (Plan 091): 과거 실거래를 협폭 테이블에 최신월부터 거꾸로 적재. 용량 임계에서 자동 정지.
//
// [설계 근거 — 계획서 실측(2026-09-16)]
//   - DB 342/500 MB. molit_transactions 는 행당 0.5 KB(힙 191B + 인덱스 8개) — 이력 조회엔
//     apt_name·umd_nm·jibun·build_year 가 불필요해 절반 이상이 낭비다. 협폭 테이블(행당 ≈65B)로
//     여유 128MB(30MB 안전분 제외) ≈ 1.9M 행을 확보한다. apt_seq 로 molit_apt_index/apt_master 와
//     조인해 이름 등을 구하므로 이력 행에 중복 저장하지 않는다. apt_seq 가 없는 원천 행은
//     이력에서 단지 식별이 안 되므로 버린다(toHistRow).
//   - START_YM(2025-04) 은 기존 molit_transactions(2025-05~)와 겹치지 않는 첫 달.
//   - 매 실행 db_size_mb() RPC(DDL 로 함께 생성, service_role 전용)로 실측 용량을 읽어
//     DB_STOP_MB(470 = 500 무료 티어 - 30 안전여유)를 넘으면 그 달을 완료로 남기지 않고 정지한다.
//   - molit_hist_runs 에 완료한 (lawd_cd, deal_ym) 을 PRIMARY KEY 로 기록해 재실행 시 건너뛴다
//     (유니크 인덱스 없이 PK 만으로 멱등 확보).
//   - Vercel Hobby 플랜은 cron 이 하루 1회만(매시 표현식은 배포 자체가 거부됨 — 2026-09-16 실사례). 그래서 vercel.json 에 같은 경로를 ?slot=0~9 로 10개(2시간 간격, ±59분 지터에도 겹치지 않음) 등록하고, 한 실행은 TIME_BUDGET_MS 까지 순차 처리한다.
const logger = require('../logger');
const { fetchRegionMonth } = require('./molitIngest');
const { LAWD_CODES } = require('../services/transactionService');
const { requireSupabaseAdmin } = require('../db/client'); // molitIngest 와 같은 헬퍼

const START_YM = '202504';                 // 현재 테이블(2025-05~)과 겹치지 않는 첫 달
const FLOOR_YM = '201901';                 // 이론상 하한(용량이 먼저 멈춘다)
const DB_STOP_MB = 470;                    // 무료 티어 500 MB — 30 MB 안전 여유
const REGION_MONTHS_PER_RUN = 200;         // 실행당 상한 — 실제 종료는 아래 TIME_BUDGET_MS 가 결정
const TIME_BUDGET_MS = 235_000;            // maxDuration 300s − 여유 65s(마지막 region-month 최대 ~10s + 응답)
const MAX_CONSEC_ERR = 3;                  // 연속 실패(쿼터 소진·API 장애)면 남은 대상을 두들기지 않고 이번 회차를 끝낸다
const CHUNK = 1000;

function prevYm(ym) { const y = +ym.slice(0, 4), m = +ym.slice(4); return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, '0')}`; }

function toHistRow(r) {
  if (!r.apt_seq || !r.deal_date || !(r.deal_amount > 0)) return null;
  const ar = Math.round((parseFloat(r.exclu_use_ar) || 0) * 100);
  return {
    apt_seq: String(r.apt_seq),
    deal_date: r.deal_date,
    exclu_use_ar: Math.min(32767, Math.max(0, ar)),
    deal_amount: Math.min(2147483647, Math.round(r.deal_amount)),
    floor: r.floor == null ? null : Math.max(-32768, Math.min(32767, r.floor)),
  };
}

async function dbSizeMb(admin) {
  const { data, error } = await admin.rpc('db_size_mb');
  if (error) throw error;
  return Number(data);
}

// YYYYMM 문자열의 그 달 [1일, 말일](YYYY-MM-DD) — DELETE 범위 계산용.
//   UTC 기준(Date.UTC) — 서버 런타임(TZ=UTC)과 동일, 호스트 TZ 에 좌우되지 않는다.
function monthRange(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(4);
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 다음달 0일 = 이번달 말일
  return { first: `${y}-${mm}-01`, last: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

// 다음 처리 대상 (lawd, ym) 목록 — runs 에 없는 쌍을 START_YM 부터 거꾸로, LAWD_CODES 를 순회하며 limit 개.
//   REST-CAP-FIX 관례(molitIngest.js retryFailedGaps 주석 참고): PostgREST 응답은 기본 1000행에서
//   잘린다 — runs 를 페이지 없이 한 번에 읽으면 완료분이 1000쌍을 넘는 시점부터 "이미 끝난 쌍"을
//   갭으로 오판해 중복 재작업하게 된다. 정렬을 명시해 페이지 경계 누락도 막는다.
async function nextTargets(admin, limit) {
  const done = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('molit_hist_runs')
      .select('lawd_cd, deal_ym')
      .order('lawd_cd', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    for (const r of data) done.add(`${r.lawd_cd}|${r.deal_ym}`);
    if (data.length < PAGE) break;
  }
  // LAWD_CODES 는 이름→코드 매핑이라 값이 중복될 수 있다 — cron.js checkRegionIngestFreshness 와
  // 동일하게 dedup 해 같은 지역을 두 번 처리하지 않는다.
  const regions = [...new Set(Object.values(LAWD_CODES))];
  const out = [];
  for (let ym = START_YM; ym >= FLOOR_YM; ym = prevYm(ym)) {
    for (const lawdCd of regions) {
      if (done.has(`${lawdCd}|${ym}`)) continue;
      out.push([lawdCd, ym]);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function runHistBackfill(opts = {}) {
  const admin = requireSupabaseAdmin('hist backfill 불가');
  const limit = Math.max(1, Math.min(parseInt(opts.limit) || REGION_MONTHS_PER_RUN, 200));
  const t0 = Date.now();
  const budgetMs = opts.timeBudgetMs != null ? Number(opts.timeBudgetMs) : TIME_BUDGET_MS;
  const mb0 = await dbSizeMb(admin);
  if (mb0 >= DB_STOP_MB) return { stopped: true, reason: 'db-size', dbMb: mb0, done: 0 };
  const targets = await nextTargets(admin, limit);
  let done = 0, rows = 0, err = 0, lastYm = null, budgetHit = false, consec = 0;
  for (const [lawdCd, ym] of targets) {
    try {
      const raw = await fetchRegionMonth(lawdCd, ym);
      const hist = raw.map(toHistRow).filter(Boolean);
      // GUARD-2026-09-16 (Plan 091): 실패한 region-month 는 아래 catch 로 빠져 runs 에 안 남고
      //   다음 실행이 재시도한다 — 그때 부분 삽입분 위에 또 insert 하면 중복이 생긴다. 삽입 전에
      //   그 region-month 를 비운다(apt_seq LIKE '<lawd>-%' 는 idx_molit_hist_seq_date 의
      //   text_pattern_ops 인덱스로 빠르게 처리된다).
      const { first, last } = monthRange(ym);
      const { error: eDel } = await admin.from('molit_transactions_hist')
        .delete()
        .like('apt_seq', `${lawdCd}-%`)
        .gte('deal_date', first)
        .lte('deal_date', last);
      if (eDel) throw eDel;
      for (let i = 0; i < hist.length; i += CHUNK) {
        const { error } = await admin.from('molit_transactions_hist').insert(hist.slice(i, i + CHUNK));
        if (error) throw error;
      }
      const { error: e2 } = await admin.from('molit_hist_runs').upsert({ lawd_cd: lawdCd, deal_ym: ym, rows: hist.length });
      if (e2) throw e2;
      done++; rows += hist.length; lastYm = ym; consec = 0;
    } catch (e) {
      err++;
      consec++;
      logger.warn({ err: e.message, lawdCd, ym }, 'molit-hist-backfill: region-month 실패(다음 실행에서 재시도)');
    }
    if ((done + err) % 10 === 0) {
      const mb = await dbSizeMb(admin);
      if (mb >= DB_STOP_MB) return { stopped: true, reason: 'db-size', dbMb: mb, done, rows, err, lastYm, budgetHit, elapsedMs: Date.now() - t0 };
    }
    if (consec >= MAX_CONSEC_ERR) {
      logger.warn({ consec, lawdCd, ym }, 'molit-hist-backfill: 연속 실패 — 이번 회차 종료(다음 슬롯이 재시도)');
      return { stopped: false, reason: 'errors', dbMb: await dbSizeMb(admin), done, rows, err, lastYm, budgetHit, elapsedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 >= budgetMs) { budgetHit = true; break; }
  }
  return {
    stopped: targets.length === 0,
    reason: targets.length === 0 ? 'complete' : null,
    dbMb: await dbSizeMb(admin),
    done, rows, err, lastYm, budgetHit, elapsedMs: Date.now() - t0,
  };
}

module.exports = { runHistBackfill, toHistRow, prevYm, START_YM, DB_STOP_MB, TIME_BUDGET_MS, REGION_MONTHS_PER_RUN };

// CLI: node backend/jobs/molitHistBackfill.js [limit]
if (require.main === module) {
  runHistBackfill({ limit: parseInt(process.argv[2]) || undefined })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
