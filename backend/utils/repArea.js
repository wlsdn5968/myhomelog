'use strict';
/**
 * REP-AREA-ONE-2026-11-06 (기능별 불일치 전수조사 후속, 운영 실측: 공릉풍림아이원 상세 8.12억, 지도 7.91억).
 * 단지 가격을 한 숫자로 보여 줄 때 쓰는 규칙을 한 곳에 둔다. 프런트 _repAreaOf 와 같은 규칙이다.
 *   최근 30건 중 거래가 가장 많은 평형(㎡ 반올림)만으로 평균을 낸다. 동률이면 가장 최근 거래의 평형.
 * rows 는 최신순이어야 한다. 값이 없으면 null(지어내지 않는다).
 */
const { toPyeong } = require('./pyeong');

const REP_AREA_RECENT = 30;

function repAreaStats(rows) {
  const by = new Map();
  for (const t of (rows || []).slice(0, REP_AREA_RECENT)) {
    const sqm = Math.round(Number(t && t.exclu_use_ar) || 0);
    const amt = Number(t && t.deal_amount) || 0;
    if (!sqm || !amt) continue;
    if (!by.has(sqm)) by.set(sqm, { sqm, n: 0, sum: 0 });
    const g = by.get(sqm);
    g.n += 1;
    g.sum += amt;
  }
  const best = [...by.values()].sort((a, b) => b.n - a.n)[0]; // 안정 정렬: 동률이면 먼저(최근에) 나온 평형
  if (!best) return null;
  return { sqm: best.sqm, py: Math.round(toPyeong(best.sqm)), n: best.n, avg: best.sum / best.n };
}

/** 여러 신고 이름의 거래를 합친 뒤 최신순으로 — 같은 날은 들어온 순서 유지 */
function sortRecentFirst(rows) {
  return (rows || []).slice().sort((a, b) => String(b.deal_date || '').localeCompare(String(a.deal_date || '')));
}

module.exports = { repAreaStats, sortRecentFirst, REP_AREA_RECENT };
