/**
 * TX-WINDOW-2026-08-31 (Sprint PPPPPPP): "최근 N개월" 의 **시작일을 한 곳에서만 정한다**.
 *
 * [발견] 같은 단지가 추천과 보고서에서 다른 건수·가격을 보였다.
 *   · 추천(getRegionRecentTransactions): `setMonth(-5) → setDate(1)` = **달 경계**(예 2026-03-01)
 *   · 보고서: `Date.now() - 180일` = **롤링 180일**(예 2026-03-04)
 *   [실측] 자연앤데시앙 전용 85㎡ 고층 구간 — 보고서 11건·중위 6.10억 ↔ 달 경계 기준 12건·5.98억.
 *   며칠 차이가 중위값을 0.12억 움직였다. 사용자는 같은 단지의 두 화면에서 다른 숫자를 본다.
 *
 * [선택] **달 경계**로 통일한다.
 *   · "최근 6개월" 이라는 말과 더 잘 맞는다(3월부터 8월까지).
 *   · 롤링 창은 매일 바뀌어 어제 본 숫자와 오늘 숫자가 달라진다 — 캐시와도 어긋난다.
 * @param {number} monthsBack 개월 수(기본 6)
 * @returns {string} 'YYYY-MM-DD'
 */
function txWindowStart(monthsBack = 6) {
  const since = new Date();
  since.setMonth(since.getMonth() - (monthsBack - 1));
  since.setDate(1);
  return since.toISOString().slice(0, 10);
}

module.exports = { txWindowStart };
