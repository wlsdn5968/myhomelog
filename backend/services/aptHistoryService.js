'use strict';
// APT-HISTORY-2026-09-20 (Plan 102): 단지(apt_seq) 장기 월별 집계 — 협폭 이력(molit_transactions_hist, ~2025-04) + 원본(molit_transactions, 2025-05~).
//   응답은 (월, 반올림 전용㎡)별 합계·건수 — 프론트가 기존 칩 규칙(±2㎡)으로 평균을 낸다(buildPriceTrend 와 같은 의미).
const { getSupabaseAdmin } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');
const SEQ_RE = /^\d{5}-\d+$/;
const PAGE = 1000, MAX_PAGES = 5; // 단지 최대 1,230행 실측 — 5,000 에 닿으면 경고

function parseSeqs(raw) {
  const list = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || list.length > 3 || !list.every(s => SEQ_RE.test(s))) return null;
  return [...new Set(list)].sort();
}
async function pageAll(build) {
  const out = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return { rows: out, capped: false };
  }
  return { rows: out, capped: true };
}
// 순수 함수. hist.exclu_use_ar = ㎡×100(정수), recent.exclu_use_ar = ㎡(numeric — 문자열로 올 수 있다).
function aggregateMonthly(histRows, recentRows) {
  const ymOf = d => String(d || '').slice(0, 7);
  const rec = (recentRows || []).filter(r => /^\d{4}-\d{2}/.test(String(r.deal_date || '')) && Number(r.deal_amount) > 0);
  const recentMinYm = rec.length ? rec.map(r => ymOf(r.deal_date)).sort()[0] : null;
  // 겹침 방지: 원본이 있는 달부터는 원본만 쓴다(앞으로 원본의 오래된 달을 이력으로 옮길 때 같은 달이 양쪽에 있어도 두 번 세지 않게).
  const hist = (histRows || []).filter(r => /^\d{4}-\d{2}/.test(String(r.deal_date || '')) && Number(r.deal_amount) > 0
    && (!recentMinYm || ymOf(r.deal_date) < recentMinYm));
  const b = new Map();
  const add = (ym, sqm, amt) => { if (!(sqm > 0)) return; const k = `${ym}|${sqm}`; const c = b.get(k) || { ym, sqm, sum: 0, n: 0 }; c.sum += amt; c.n += 1; b.set(k, c); };
  for (const r of hist) add(ymOf(r.deal_date), Math.round(Number(r.exclu_use_ar) / 100), Number(r.deal_amount));
  for (const r of rec) add(ymOf(r.deal_date), Math.round(Number(r.exclu_use_ar)), Number(r.deal_amount));
  const rows = [...b.values()].sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : x.sqm - y.sqm));
  return { rows, since: rows.length ? rows[0].ym : null, until: rows.length ? rows[rows.length - 1].ym : null, counts: { hist: hist.length, recent: rec.length } };
}
async function getAptHistoryMonthly(seqs) {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const ck = `txhist:v1:${seqs.join(',')}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  try {
    const h = await pageAll((from, to) => admin.from('molit_transactions_hist').select('deal_date, exclu_use_ar, deal_amount')
      .in('apt_seq', seqs).order('deal_date', { ascending: true }).order('exclu_use_ar', { ascending: true })
      .order('deal_amount', { ascending: true }).order('floor', { ascending: true }).range(from, to));
    const w = await pageAll((from, to) => admin.from('molit_transactions').select('deal_date, exclu_use_ar, deal_amount')
      .in('apt_seq', seqs).order('deal_date', { ascending: true }).order('id', { ascending: true }).range(from, to));
    if (h.capped || w.capped) logger.warn({ seqs, hist: h.rows.length, recent: w.rows.length }, 'apt history 페이지 상한 도달 — 일부 거래 미집계');
    const out = { aptSeqs: seqs, ...aggregateMonthly(h.rows, w.rows), capped: h.capped || w.capped };
    cache.set(ck, out, 21600);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, seqs }, 'apt history 조회 실패');
    return null; // 실패는 캐시하지 않는다
  }
}
module.exports = { parseSeqs, aggregateMonthly, getAptHistoryMonthly };
