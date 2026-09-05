/**
 * KST-TIME-2026-09-05 (감사 G-8): '하루' 경계 계산을 한 곳에.
 *
 * 서버 런타임은 UTC 다(실사고: 일일 한도 리셋이 KST 09시에 일어나 안내와 9시간 어긋났다).
 * 로컬(Windows, KST)에서는 통과하고 프로덕션에서만 어긋나는 종류의 버그라, 호스트 TZ 에 의존하는
 * setHours/getDate/setMonth 를 쓰지 않고 +9h 를 **명시**한 뒤 UTC 필드로만 다룬다.
 */
'use strict';

const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;

/** ts(epoch ms) 가 속한 KST 날짜의 **다음** 자정 — epoch ms. */
function nextKstMidnight(ts = Date.now()) {
  return (Math.floor((ts + KST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS;
}

/** ts 의 KST 날짜 'YYYY-MM-DD'. */
function kstDate(ts = Date.now()) {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { KST_OFFSET_MS, nextKstMidnight, kstDate };
