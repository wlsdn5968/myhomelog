/**
 * SCORE-BANDS-2026-08-30 (Sprint PPPPPPP): **두 화면이 같은 기준을 쓰게 하는 단일 출처**.
 *
 * 왜 파일을 따로 두나 — 추천(propertyService)과 보고서(report.js)는 서로 다른 경로이고,
 * 지금까지 **점수표가 두 벌**이었다(보고서는 상한 없는 '매칭 148점', 추천은 100점).
 * 그래서 오늘 고친 교통 실측이 보고서에는 반영되지 않았고, 운영자는 보고서를 보고
 * "왜 이런 걸 1등으로 해놨냐" 고 물었다. 이 저장소는 사본이 갈려 사고가 난 전력이 있다
 * ([[tax-law-crosscheck-2026-06-24]]: 취득세 tier 가 프론트·백엔드 두 벌이라 3주간 과다 표기).
 * → **구간 판정은 여기서만 정의한다.**
 */

/**
 * 거래 활발도 — ⚠ 절대 건수가 아니라 **세대수 대비 회전율**.
 * 건수로 재면 대단지가 자동으로 이긴다(실측: 43건/1,226세대 = 3.51% 가 건수 1위로 표시됐다).
 * 구간은 전국 실측 분위수(6개월·100세대 이상 2,981단지):
 *   p10 0.70 · p25 1.25 · p50 2.03 · p75 3.02 · p90 4.11 · p99 7.41
 * @param {number} deals 6개월 거래 건수
 * @param {number} households 세대수 (0/null 이면 '모름')
 * @param {number} max 이 항목의 만점
 * @returns {{score:number, turnover:number|null, why:string}}
 */
function turnoverScore(deals, households, max) {
  const d = Number(deals) || 0;
  const hh = Number(households) || 0;
  // ⚠ 거래 0건은 **모름이 아니라 측정된 값**이다. 아래 '세대수 미확인' 폴백에 태우면
  //   거래가 아예 없는 단지가 중간값을 받는다([[unknown-treated-as-value]] 의 반대 방향 실수).
  if (d <= 0) return { score: 0, turnover: hh > 0 ? 0 : null, why: '최근 6개월 거래 없음' };
  if (hh > 0) {
    const tr = (d / hh) * 100;
    const frac = tr >= 4.11 ? 1 : tr >= 3.02 ? 0.857 : tr >= 2.03 ? 0.643 : tr >= 1.25 ? 0.429 : tr >= 0.70 ? 0.286 : 0.143;
    return { score: Math.round(max * frac), turnover: tr, why: `6개월 회전율 ${tr.toFixed(1)}% (${d}건 / ${hh}세대)` };
  }
  // ⚠ 세대수를 모르면 회전율을 만들 수 없다. 중간값 부근만 주고 0 으로 떨어뜨리지 않는다
  //   ([[unknown-treated-as-value]]).
  const frac = d >= 20 ? 0.643 : d >= 8 ? 0.5 : 0.357;
  return { score: Math.round(max * frac), turnover: null, why: `6개월 거래 ${d}건 (세대수 미확인 — 회전율 산출 불가)` };
}

/**
 * 아파트가 아닌 유형 — 추천·보고서 순위에서 뺀다(검색·상세는 그대로).
 * KAPT `codeAptNm` 실측: 아파트 12,730 · 주상복합 1,261 · 연립주택 185 · 도시형생활주택 144 · 다세대 9 · 미상 331.
 * ⚠ 주상복합은 빼지 않는다 — 오피스텔과 동의어가 아니고, 근거 없이 자르면 멀쩡한 단지를 지운다.
 * ⚠ 유형 미상도 빼지 않는다 — 모름은 배제 사유가 아니다.
 */
const EXCLUDED_APT_TYPES = ['도시형 생활주택', '연립주택', '다세대'];

function isExcludedAptType(typeName) {
  const t = String(typeName || '').trim();
  if (!t) return false;
  return EXCLUDED_APT_TYPES.some(x => t.includes(x));
}

/**
 * 평형별 신고가 갱신 횟수.
 * ⚠ 예전 구현은 **평형을 섞어** 누적 최대값을 봤다. 큰 평형이 한 번 최고가를 찍으면
 *   그 뒤 소형의 신고가는 영영 세지지 않는다 — 과대가 아니라 **과소**다.
 *   [실측] 푸른마을포스코더샵2차(전용 76~117㎡): 혼합 방식 4회 ↔ 평형별 18회.
 * @param {Array<{date:string, amount:number, area:number|string}>} deals
 */
function countNewHighByArea(deals) {
  const byArea = new Map();
  for (const d of deals || []) {
    const key = d.area == null ? '?' : String(Math.round(Number(d.area) * 10) / 10);
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(d);
  }
  let count = 0;
  for (const arr of byArea.values()) {
    const sorted = [...arr].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let runningMax = 0;
    for (const d of sorted) {
      const amt = Number(d.amount) || 0;
      if (amt > runningMax) {
        if (runningMax > 0) count++; // 첫 거래는 갱신으로 안 친다
        runningMax = amt;
      }
    }
  }
  return count;
}

module.exports = { turnoverScore, isExcludedAptType, EXCLUDED_APT_TYPES, countNewHighByArea };
