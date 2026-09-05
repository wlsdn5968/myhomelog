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
    // HH-FLOOR-2026-09-05: 구간은 100세대 이상 단지의 분위수다. 17세대 건물의 2건(11.8%)을 그 구간에 넣으면
    //   만점이 된다(실측: 17세대 건물이 회전율 만점으로 76점 1위). 100세대 미만은 분모를 100으로 올려
    //   보정 범위 안에서 잰다 — 소규모의 우연한 거래를 '활발한 시장'으로 읽지 않는다. 실제 세대수는 그대로 밝힌다.
    const hhEff = Math.max(hh, 100);
    const tr = (d / hhEff) * 100;
    const frac = tr >= 4.11 ? 1 : tr >= 3.02 ? 0.857 : tr >= 2.03 ? 0.643 : tr >= 1.25 ? 0.429 : tr >= 0.70 ? 0.286 : 0.143;
    const why = hhEff === hh
      ? `6개월 회전율 ${tr.toFixed(1)}% (${d}건 / ${hh}세대)`
      : `6개월 회전율 ${tr.toFixed(1)}% (${d}건 / ${hh}세대 — 100세대 기준 환산)`;
    return { score: Math.round(max * frac), turnover: tr, why };
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

/**
 * 장기 검색 관심도 → 점수. **실분포로 보정한 구간**(추측 아님).
 *
 * 근거: 네이버 데이터랩 36개월 지수를 앵커(은마아파트) 중앙값 대비 비율로 정규화해
 *   전국 1,551단지·103시군구를 실측한 분위수 —
 *     p10 0.0001 · p25 0.0003 · p50 0.0062 · p75 0.0224 · p90 0.0563 · p97 0.1296 · 최대 1.304
 *   (초기 구간은 표본 3개로 잡은 값이었고, 그때는 45% 가 최저점을 받았다.)
 *
 * ⚠ **바닥을 0 근처로 두지 않는다.** 비율이 낮은 것은 '인기 없음' 의 증거이기도 하지만
 *   '우리가 쓴 키워드가 사람들이 부르는 이름과 다르다' 는 신호이기도 하다
 *   (실측: "서동탄역파크자이아파트" 0.003 ↔ "서동탄역파크자이" 1.10 — 355배).
 *   증거가 약한 쪽에 큰 벌점을 주지 않는다. 모름(캐시 없음)은 중간값을 받는다.
 *
 * @param {number|null|undefined} ratio 앵커 대비 비율. 없으면 null 을 넘길 것
 * @param {number} max 이 항목의 만점
 * @returns {{score:number, known:boolean, why:string|null}}
 */
function interestScore(ratio, max) {
  // ⚠ Number(null) === 0 이다. null 을 그대로 넘기면 **모름이 최저점으로 둔갑**한다 —
  //   이 저장소가 반복해 겪은 실수라 여기서 명시적으로 먼저 걸러낸다.
  if (ratio === null || ratio === undefined || ratio === '') {
    return { score: Math.round(max * 0.5), known: false, why: null };
  }
  const r = Number(ratio);
  if (!Number.isFinite(r)) {
    // 모름 → 중간값. 조회 실패·미수집을 '무명 단지' 로 만들지 않는다.
    return { score: Math.round(max * 0.5), known: false, why: null };
  }
  const frac = r >= 0.1296 ? 1        // 상위 3%
    : r >= 0.0563 ? 0.857             // 상위 10%
      : r >= 0.0224 ? 0.714           // 상위 25%
        : r >= 0.0062 ? 0.5           // 중앙값
          : r >= 0.0003 ? 0.357       // 하위 25% 경계
            : 0.286;                  // 그 아래 — 바닥이지만 0 이 아니다
  return {
    score: Math.round(max * frac),
    known: true,
    why: `검색 관심도 3년 지수 ${r >= 0.01 ? r.toFixed(2) : r.toFixed(4)} (기준 은마아파트=1)`,
  };
}

module.exports = { turnoverScore, isExcludedAptType, EXCLUDED_APT_TYPES, countNewHighByArea, interestScore };
