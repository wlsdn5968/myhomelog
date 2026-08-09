/**
 * MOLIT(data.go.kr RTMS 계열) 응답 item 공통 파싱 헬퍼 — Plan 006 (2026-08-09)
 *
 * 대상: RTMSDataSvcAptTradeDev(매매)·RTMSDataSvcAptRent(전월세)·건축HUB(getBrTitleInfo) 등
 *       `response.body.items.item` envelope 을 쓰는 RTMS 계열 전용.
 * ⚠ KAPT/AptInfo 계열(AptListService3 등)은 body.items 가 직접 배열이라 이 헬퍼 대상이 아님
 *   — 1af72ac(송파·양천 apt_master 0건 실장애)의 교훈: envelope 이 다른 API 에 강제 적용 금지.
 */

/** body?.items?.item → 항상 배열 (단일 객체·undefined 정규화) */
function itemArray(items) {
  return Array.isArray(items) ? items : items ? [items] : [];
}

/**
 * 금액(만원 단위 콤마 문자열 또는 숫자) → 정수.
 * RENT-TYPE-FIX-2026-06-14 (88e9303): MOLIT 이 금액을 숫자로 반환하는 경우가 실재
 * (monthlyRent=390) — 문자열 전제 .replace 는 TypeError 로 전량 유실을 냈다.
 * String() 래핑으로 숫자·문자열 양쪽 안전.
 */
function parseAmountManwon(v) {
  return parseInt(String(v ?? '0').replace(/,/g, ''), 10) || 0;
}

/** 해제(취소) 거래 여부 — cdealType 이 비어있지 않으면 해제 (Bug #3, 2026-04-25) */
function isCanceled(item) {
  return !!String((item && item.cdealType) || '').trim();
}

module.exports = { itemArray, parseAmountManwon, isCanceled };
