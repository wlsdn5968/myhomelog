'use strict';
// DIM-RECOVERY-2026-09-26 (Plan 117): 협폭 이력(molit_transactions_hist)에만 있고 원본
//   (molit_transactions)에는 없는 단지 5,444개는 이름이 없어 /apt/:seq 가 404 다 — 협폭 backfill
//   (molitHistBackfill.toHistRow)이 apt_seq 만 남기고 apt_name 을 버리기 때문이다(설계 자체가
//   그렇다 — 저장공간 절약, 위 파일 상단 주석 참고). 이름은 MOLIT API 자체에만 있으므로, 각
//   단지가 마지막으로 거래된 (지역,월)을 다시 불러 이름만 떠서 molit_apt_dim 에 채운다.
//
// [왜 큐(apt_dim_recovery_queue)인가] hist backfill 과 같은 이유다 — 이 잡은 hist backfill 의
//   cron 슬롯이 할 일이 없어지는 순간(reason:'complete')에만 빈 슬롯을 빌려 쓴다(cron.js 배선).
//   슬롯은 하루 10번, 한 번에 최대 235s 안에서 끊겨 돈다 — "어디까지 했나"를 함수 호출 사이에
//   기억할 곳이 DB 말고 없다. 큐 행 하나 = (lawd_cd, deal_ym) 조합 하나(그 달에 마지막으로
//   거래된 미복구 단지들이 몰린 곳) — 처리하면 ok/error 로 갱신해 재실행 시 건너뛴다.
//
// [왜 on conflict do nothing 인가] molit_apt_dim 의 기존 22,672행은 원본(molit_transactions)에서
//   이미 정확하게 채워졌다 — 이 잡이 다시 쓰는 이름은 그보다 못할 이유는 없지만 덮어쓸 이유도
//   없다. 이 잡의 유일한 임무는 "이름이 아예 없는 행을 새로 만드는 것"이지 "있는 값을 고치는
//   것"이 아니다. do nothing 이면 실수로 같은 apt_seq 를 두 번 upsert 해도(같은 응답 안에 없어야
//   정상이지만) 안전하고, 이 잡에 버그가 있어도 기존 22,672행은 원리적으로 불변이다.
const logger = require('../logger');
const { fetchRegionMonth, molitErrReason } = require('./molitIngest');
const { requireSupabaseAdmin } = require('../db/client');

const QUEUE_TABLE = 'apt_dim_recovery_queue';
const DIM_TABLE = 'molit_apt_dim';
const HIST_TABLE = 'molit_transactions_hist';
const BATCH_LIMIT = 300;            // 한 회차에 큐에서 뽑아올 (lawd_cd,deal_ym) 최대 개수
const MAX_CONSEC_ERR = 5;           // 연속 실패(쿼터 소진·API 장애) — 남은 큐를 두들기지 않고 이번 회차 종료
const DEFAULT_TIME_BUDGET_MS = 200_000;
const HIST_PAGE = 1000;             // REST-CAP-FIX 관례(molitIngest.retryFailedGaps·molitHistBackfill.nextTargets 와 동일):
                                     //   PostgREST 응답은 기본 1000행에서 자른다 — 페이지 루프 없이 읽으면
                                     //   인기 단지의 이력 건수가 조용히 잘려 deal_count/first_deal_date 가 틀어진다.

/**
 * fetchRegionMonth() 응답(molitIngest.js:157 정규화 그대로 — aptSeq/aptNm 등 필드명을 여기서
 * 다시 만들지 않는다)에서 apt_seq 별 1행만 남긴다. 같은 (lawd_cd,deal_ym) 응답 안에 같은 단지가
 * 여러 건(다른 동·층) 있을 수 있어 **가장 최근 거래일**의 값을 채택한다(정정거래 등으로 이름
 * 표기가 갈리면 최신 쪽을 신뢰 — molitIngest 의 dedup 정책과 같은 방향).
 * @returns {Map<string, object>} apt_seq(string) → raw row
 */
function pickLatestPerAptSeq(rawRows) {
  const bySeq = new Map();
  for (const r of rawRows || []) {
    if (!r || !r.apt_seq) continue; // 이력 조인 키가 없으면 단지 식별 불가(toHistRow 와 동일 규칙)
    const seq = String(r.apt_seq);
    const prev = bySeq.get(seq);
    if (!prev || (r.deal_date && (!prev.deal_date || r.deal_date > prev.deal_date))) {
      bySeq.set(seq, r);
    }
  }
  return bySeq;
}

/** 이미 molit_apt_dim 에 있는 apt_seq 를 걸러낸다 — do-nothing 으로도 안전하지만, 미리 빼면
 *  이미 채워진(대개 원본에서 온) 단지의 이력 전체를 아래 fetchHistStats 로 긁는 낭비를 막는다
 *  (인기 단지는 이력이 수백 건일 수 있어 이 필터가 없으면 배치당 REST 조회량이 커진다). */
async function filterMissingFromDim(admin, seqs) {
  if (!seqs.length) return [];
  const { data, error } = await admin.from(DIM_TABLE).select('apt_seq').in('apt_seq', seqs);
  if (error) throw error;
  const existing = new Set((data || []).map((r) => String(r.apt_seq)));
  return seqs.filter((s) => !existing.has(s));
}

/** apt_seq 목록의 molit_transactions_hist min(deal_date)/max(deal_date)/count(*) — 집계 RPC 없이
 *  aptHistoryService.js 와 같은 방식(원행을 읽어 JS 에서 reduce)으로 계산한다. */
async function fetchHistStats(admin, seqs) {
  const stats = new Map();
  if (!seqs.length) return stats;
  for (let from = 0; ; from += HIST_PAGE) {
    const { data, error } = await admin.from(HIST_TABLE)
      .select('apt_seq, deal_date')
      .in('apt_seq', seqs)
      .order('apt_seq', { ascending: true })
      .order('deal_date', { ascending: true })
      .range(from, from + HIST_PAGE - 1);
    if (error) throw error;
    for (const row of data || []) {
      const seq = String(row.apt_seq);
      const c = stats.get(seq) || { first: row.deal_date, last: row.deal_date, count: 0 };
      if (row.deal_date < c.first) c.first = row.deal_date;
      if (row.deal_date > c.last) c.last = row.deal_date;
      c.count += 1;
      stats.set(seq, c);
    }
    if (!data || data.length < HIST_PAGE) break;
  }
  return stats;
}

/** 큐 행 하나 처리 — fetchRegionMonth 재호출 → 미복구 apt_seq 만 추려 dim payload 생성 → upsert.
 *  @returns {{ namesFound: number }}
 */
async function processQueueItem(admin, item) {
  const raw = await fetchRegionMonth(item.lawd_cd, item.deal_ym);
  const bySeq = pickLatestPerAptSeq(raw);
  const allSeqs = [...bySeq.keys()];
  const missingSeqs = await filterMissingFromDim(admin, allSeqs);
  if (!missingSeqs.length) return { namesFound: 0 };

  const histStats = await fetchHistStats(admin, missingSeqs);
  const dimRows = missingSeqs
    .map((seq) => {
      const r = bySeq.get(seq);
      const h = histStats.get(seq);
      if (!h || !(h.count > 0)) return null; // 이력에 근거가 없는 apt_seq 는 dim 을 만들 근거가 없다(방어적 — 큐는 이력 기준으로 만들어졌으므로 정상 경로에선 발생하지 않는다)
      return {
        apt_seq: seq,
        apt_name: r.apt_name,
        lawd_cd: r.lawd_cd,
        sigungu: r.sigungu,
        umd_nm: r.umd_nm,
        build_year: r.build_year,
        jibun: r.jibun,
        first_deal_date: h.first,
        last_deal_date: h.last,
        deal_count: h.count,
      };
    })
    .filter(Boolean);
  if (!dimRows.length) return { namesFound: 0 };

  // DIM-RECOVERY-2026-09-26: ignoreDuplicates:true = on conflict (apt_seq) do nothing — 기존
  //   행을 절대 덮지 않는다는 계약(이 파일 상단 설계 근거 참고). count:'exact' 로 실제 신규
  //   삽입 수를 받되, supabase-js 가 null 을 돌려주는 경우(버전 차)엔 후보 수로 대체한다
  //   (관측값이 다소 과대해질 수 있으나 0 으로 지어내지 않는다 — cronStats._pick 과 같은 원칙).
  const { error: upErr, count } = await admin.from(DIM_TABLE)
    .upsert(dimRows, { onConflict: 'apt_seq', ignoreDuplicates: true, count: 'exact' });
  if (upErr) throw upErr;
  const namesFound = (typeof count === 'number' && Number.isFinite(count)) ? count : dimRows.length;
  return { namesFound };
}

/**
 * hist backfill 이 완료(reason:'complete')됐을 때만 cron.js 가 호출한다 — 빈 슬롯 재사용.
 * @param {Object} opts
 * @param {number} [opts.timeBudgetMs=200000] 이번 회차 시간 예산(ms)
 * @returns {Promise<{processed:number, ok:number, err:number, namesInserted:number, remaining:number|null, budgetHit:boolean, elapsedMs:number}>}
 */
async function runAptDimNameRecovery(opts = {}) {
  const timeBudgetMs = opts.timeBudgetMs != null ? Number(opts.timeBudgetMs) : DEFAULT_TIME_BUDGET_MS;
  const admin = requireSupabaseAdmin('apt-dim-name-recovery 불가');
  const t0 = Date.now();

  const { data: items, error: qErr } = await admin.from(QUEUE_TABLE)
    .select('lawd_cd, deal_ym, apt_seqs')
    .eq('status', 'pending')
    .order('apt_seqs', { ascending: false })
    .limit(BATCH_LIMIT);
  if (qErr) throw qErr;

  let processed = 0, ok = 0, err = 0, namesInserted = 0, consec = 0, budgetHit = false;
  for (const item of items || []) {
    processed++;
    try {
      const { namesFound } = await processQueueItem(admin, item);
      namesInserted += namesFound;
      ok++; consec = 0;
      await admin.from(QUEUE_TABLE).update({
        status: 'ok', tried_at: new Date().toISOString(), names_found: namesFound,
      }).eq('lawd_cd', item.lawd_cd).eq('deal_ym', item.deal_ym);
    } catch (e) {
      err++; consec++;
      const reason = molitErrReason(e) || String((e && e.message) || e);
      logger.warn({ err: reason, lawdCd: item.lawd_cd, dealYm: item.deal_ym },
        'apt-dim-name-recovery: region-month 실패(다음 회차에서 재시도)');
      try {
        await admin.from(QUEUE_TABLE).update({
          status: 'error', tried_at: new Date().toISOString(), error_message: String(reason).slice(0, 500),
        }).eq('lawd_cd', item.lawd_cd).eq('deal_ym', item.deal_ym);
      } catch (_) { /* 큐 기록 실패가 본 작업을 막으면 안 된다 */ }
      if (consec >= MAX_CONSEC_ERR) {
        logger.warn({ consec }, 'apt-dim-name-recovery: 연속 실패 — 이번 회차 종료(다음 슬롯이 재시도)');
        break;
      }
    }
    if (Date.now() - t0 >= timeBudgetMs) { budgetHit = true; break; }
  }

  // remaining — 이번 회차가 처리한 300개가 아니라 큐 **전체**의 남은 pending 수(health 관측용).
  let remaining = null;
  try {
    const { count: remCount, error: remErr } = await admin.from(QUEUE_TABLE)
      .select('*', { count: 'exact', head: true }).eq('status', 'pending');
    if (!remErr) remaining = remCount;
  } catch (_) { /* 관측 실패는 본 작업 결과에 영향 없음 */ }

  return { processed, ok, err, namesInserted, remaining, budgetHit, elapsedMs: Date.now() - t0 };
}

module.exports = { runAptDimNameRecovery, pickLatestPerAptSeq };

// CLI: node backend/jobs/aptDimNameRecovery.js
if (require.main === module) {
  runAptDimNameRecovery()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
