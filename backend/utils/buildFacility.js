/**
 * KAPT raw 응답 → 표준 facility 객체 변환 — FACILITY-HELPER-2026-05-12
 *
 * 배경 (운영자 발견, 2026-05-11):
 *   - propertyService.js (추천 path) 에서만 facility 가 채워짐.
 *   - 검색 → 단지 클릭 path (frontend goSearchResult) 에선 facility 빈 객체 → 단지정보 탭 빈 메시지.
 *   - 운영자 직접 확인: "KAPT 단지 기본정보를 조회할 수 없어요" — search path 에서 facility 누락.
 *
 * 해결:
 *   - 두 path 모두 같은 schema 의 facility 객체 사용하도록 helper 로 추출.
 *   - propertyService.js / routes/search.js 양쪽에서 buildFacility(info, kaptCode) 호출.
 *
 * 입력: KAPT V4 BasisInfo (getAphusBassInfoV4) 의 raw item.
 * 출력: 표준 facility 객체 (frontend t6 단지정보 탭이 사용).
 */

/**
 * @param {object|null} info     — KAPT raw response (kaptdaCnt, kaptUsedate 등 포함)
 * @param {string|null} kaptCode — KAPT 단지 코드 (정확 매칭 ID)
 * @returns {object|null}
 */
function buildFacility(info, kaptCode) {
  if (!info && !kaptCode) return null;
  // KAPT info 없으면 kaptCode 만 노출 (부분 facility — 단지정보 탭이 '미상' 표기)
  if (!info) {
    return {
      kaptCode,
      totalHouseholds: 0,
      dongCount: 0,
      parkingTotal: 0,
      parkingRatio: null,
      builtDate: null,
      heatType: null,
      mgrType: null,
      address: null,
      floorAreaRatio: null,
      topFloor: null,
      bottomFloor: null,
      builder: null,
      developer: null,
      rawKapt: null,
      _partial: true,
    };
  }
  const totalHouseholds = parseInt(info.kaptdaCnt) || 0;
  const parkingTotal = parseInt(info.kaptdPcnt) || 0;
  const parkingRatio = totalHouseholds > 0 && parkingTotal > 0
    ? parseFloat((parkingTotal / totalHouseholds).toFixed(2))
    : null;
  return {
    kaptCode: kaptCode || null,
    totalHouseholds,
    dongCount: parseInt(info.kaptDongCnt) || 0,
    parkingTotal,
    parkingRatio,
    builtDate: info.kaptUsedate || null,
    heatType: info.codeHeatNm || null,
    mgrType: info.codeMgrNm || null,
    address: info.doroJuso || info.codeAptNm || null,
    floorAreaRatio: info.kaptTarea || null,
    topFloor: parseInt(info.kaptTopFloor) || null,
    bottomFloor: parseInt(info.kaptBottomFloor) || null,
    builder: (info.kaptBcompany || '').trim() || null,
    developer: (info.kaptAcompany || '').trim() || null,
    rawKapt: info,
  };
}

module.exports = { buildFacility };
