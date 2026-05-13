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

// BUILDER-TYPO-2026-05-12 (Sprint I — 운영자 발견):
//   KAPT raw 응답의 kaptBcompany / kaptAcompany 필드에 흔한 오타.
//   Chrome MCP audit 으로 [VERIFIED]: 상계주공9 builder = "대힌주택공사" (정부 공시 raw 오타).
//   사용자 UI 에 그대로 표시되어 혼란 → backend 정규화.
//   추가 typo 발견 시 본 table 에 누적.
const _BUILDER_TYPO_FIX = {
  '대힌주택공사': '대한주택공사', // [VERIFIED 상계주공9] — LH 공사 전신
  // 향후 audit 으로 발견 시 추가:
  //   '대힌건설': '대한건설'
  //   '주식회사대힌': '주식회사대한'
};

function normalizeBuilder(name) {
  if (name == null) return null;
  const s = String(name).trim();
  if (!s) return null;
  return _BUILDER_TYPO_FIX[s] || s;
}

/**
 * @param {object|null} info     — KAPT raw response (kaptdaCnt, kaptUsedate 등 포함)
 * @param {string|null} kaptCode — KAPT 단지 코드 (정확 매칭 ID)
 * @param {object|null} detail   — KAPT V4 DtlInfo (주차/승강기/CCTV 등) [optional, Sprint X 추가]
 * @returns {object|null}
 */
function buildFacility(info, kaptCode, detail) {
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
  // PARK-FIELD-FIX-2026-05-13 (Sprint X — 운영자 발견):
  //   KAPT BasisInfo V4 raw 응답에는 주차 필드 부재 [VERIFIED via 풍림아파트 rawKapt all keys].
  //   주차/승강기/CCTV 는 KAPT V4 의 별도 endpoint (getAphusDtlInfoV4) 에서 fetch.
  //   detail.kaptdPcnt (지상+지하 합) 또는 detail.kaptdPcntzs (지상) + .kaptdPcntha (지하).
  //   detail 부재 시 0 — frontend 가 '미상' 표기.
  let parkingTotal = 0;
  if (detail) {
    const surfacE = parseInt(detail.kaptdPcntzs);
    const underG = parseInt(detail.kaptdPcntha);
    if (Number.isFinite(surfacE) || Number.isFinite(underG)) {
      parkingTotal = (Number.isFinite(surfacE) ? surfacE : 0) + (Number.isFinite(underG) ? underG : 0);
    } else if (Number.isFinite(parseInt(detail.kaptdPcnt))) {
      parkingTotal = parseInt(detail.kaptdPcnt);
    }
  }
  // BasisInfo 가 kaptdPcnt 가졌으면 fallback (구버전 호환)
  if (!parkingTotal && info.kaptdPcnt) parkingTotal = parseInt(info.kaptdPcnt) || 0;
  const parkingRatio = totalHouseholds > 0 && parkingTotal > 0
    ? parseFloat((parkingTotal / totalHouseholds).toFixed(2))
    : null;
  // 승강기 / CCTV (detail 에 있으면, info.kaptdEcntp 도 BasisInfo 에 있음)
  const elevatorCount = parseInt(info.kaptdEcntp) || parseInt(detail?.kaptdEcntp) || null;
  const cctvCount = parseInt(detail?.kaptdCccnt) || null;
  // AREA-DIST-2026-05-12 (운영자 발견 — KAPT raw 의 평형 구간 필드 [VERIFIED]):
  //   KAPT API V4 응답에 평형 구간별 세대수 4개 필드 존재.
  //   상계주공9 검증: kaptMparea60=1990 + kaptMparea85=840 + kaptMparea135=0 + kaptMparea136=0
  //                = 2830 = kaptdaCnt 정확 일치 [VERIFIED].
  //   각 필드 의미 (정부 분류):
  //     kaptMparea60: 전용 60㎡ 미만        (~18평 이하)
  //     kaptMparea85: 전용 60~85㎡          (18~25평, 국민주택 규모)
  //     kaptMparea135: 전용 85~135㎡        (25~40평, 중대형)
  //     kaptMparea136: 전용 135㎡ 이상      (40평 이상, 대형)
  const _toInt = v => {
    const n = parseInt(v);
    return Number.isFinite(n) ? n : 0;
  };
  const areaDistribution = {
    under60: _toInt(info.kaptMparea60),
    range60_85: _toInt(info.kaptMparea85),
    range85_135: _toInt(info.kaptMparea135),
    over135: _toInt(info.kaptMparea136),
  };
  areaDistribution.sum = areaDistribution.under60 + areaDistribution.range60_85
                       + areaDistribution.range85_135 + areaDistribution.over135;
  // sum 이 0 이면 데이터 부재 (KAPT 미등록 단지) — frontend 가 표시 X
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
    // BOTTOM-FLOOR-FIX-2026-05-13 (Sprint X — 운영자 발견):
    //   raw 필드명은 kaptBaseFloor (BasisInfo) 가 아닌 detail.kaptdScnt 같이 다른 위치 가능.
    //   현재 사용 가능한 BasisInfo 필드: kaptBaseFloor (지하층 수 의미) — 표시 안전.
    bottomFloor: parseInt(info.kaptBaseFloor) || parseInt(info.kaptBottomFloor) || null,
    builder: normalizeBuilder(info.kaptBcompany),     // BUILDER-TYPO-2026-05-12
    developer: normalizeBuilder(info.kaptAcompany),   // BUILDER-TYPO-2026-05-12
    elevatorCount,
    cctvCount,
    areaDistribution: areaDistribution.sum > 0 ? areaDistribution : null,
    rawKapt: info,
    rawDetail: detail || null,
  };
}

module.exports = { buildFacility };
