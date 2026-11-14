/**
 * AUDIT6-1114 (보안 점검 run-6, search.facility.geocache-free-text-breaks-in-bounds-in-list):
 *   공개 입력의 시군구와 동 이름이 길이만 검사된 채 좌표 표에 저장됐고, 지도 조회가 그 값을 PostgREST in 목록에 그대로 넣었다.
 *   따옴표, 쉼표, 괄호가 든 값은 목록 구문을 깰 수 있다. 실제 법정동과 시군구 이름은 한글, 숫자, 공백과 점 정도만 쓴다
 *   (예: "구지읍 창리", "종로1가", "성수동1가"). 그 밖의 글자가 있으면 지역 이름으로 받지 않는다.
 */
'use strict';
const SAFE_REGION_RE = /^[가-힣A-Za-z0-9 .·-]{1,40}$/;
function isSafeRegionText(v) {
  return typeof v === 'string' && SAFE_REGION_RE.test(v);
}
module.exports = { isSafeRegionText, SAFE_REGION_RE };
