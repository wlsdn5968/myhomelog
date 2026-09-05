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
// TXWINDOW-KST-2026-09-05 (감사 G-8): 두 가지를 고쳤다.
//   ① 호스트 TZ 의존 — 로컬(KST)에서 09시 이전에 실행하면 setDate(1) 뒤 toISOString() 이 **전월 말일**
//      (UTC 로 9시간 전)을 돌려줬다. 프로덕션(UTC)은 반대로 매달 1일 00~09시 KST 에 아직 전달을 봤다.
//      같은 코드가 환경·시각마다 다른 답을 내는 것 자체가 사고 유형이다.
//   ② 31일 오버플로 — setMonth 를 먼저 하면 7/31 → "2/31" → 3/3 로 넘친 뒤 setDate(1) 이 **3/1** 을 돌려줬다
//      (6개월 창의 시작이 2월이어야 하는데 3월). 달 경계는 날짜를 1로 만든 **뒤에** 달을 옮겨야 한다.
//   경계는 KST 로 고정한다 — "최근 6개월" 은 한국 달력의 달이다. now 는 테스트 주입용(기본 현재).
function txWindowStart(monthsBack = 6, now = Date.now()) {
  const { KST_OFFSET_MS } = require('./kstTime');
  const k = new Date(now + KST_OFFSET_MS);          // KST 벽시계를 UTC 필드로 다룬다
  k.setUTCDate(1);
  k.setUTCMonth(k.getUTCMonth() - (monthsBack - 1));
  return k.toISOString().slice(0, 10);
}

module.exports = { txWindowStart };
