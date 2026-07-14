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
  // HH-HOCNT-FALLBACK-2026-07-14 (Sprint IIIII): kaptdaCnt(관리세대수)=0 인 단지 346곳 실측 —
  //   KAPT 원천이 0 을 반환(당일 재조회도 0)하지만 hoCnt(호수)에는 실값 존재. 위례래미안이편한세상
  //   kaptdaCnt=0·hoCnt=1540 = AptInfo MCP 실호출 세대수 1540 과 정확 일치 [VERIFIED].
  //   330/346 이 hoCnt 로 해소(SQL 실측), 잔여 16 만 진짜 미상. 재조회 self-heal 로는 못 고침 → fallback 이 정답.
  const _posInt = v => { const n = parseInt(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const totalHouseholds = _posInt(info.kaptdaCnt) || _posInt(info.hoCnt);
  // PARK-FIELD-FIX-2026-05-13 (Sprint X — 운영자 발견 + Chrome MCP 으로 진짜 필드명 [VERIFIED]):
  //   KAPT V4 detail (getAphusDtlInfoV4) raw 필드:
  //     - kaptdPcnt  = 지상 주차 (풍림 473, 헬리오 0)
  //     - kaptdPcntu = 지하 주차 (풍림 1540, 헬리오 12096)   ← 핵심
  //     - kaptdEcnt  = 승강기 (detail 이 BasisInfo 의 kaptdEcntp 보다 정확)
  //     - kaptdCccnt = CCTV
  //     - kaptdScnt  = 보안 인원
  //     - kaptdDcnt  = 청소 인원
  //   풍림아파트 검증: 473 + 1540 = 2013 대 (네이버 1992 와 거의 일치).
  let parkingTotal = 0;
  if (detail) {
    const surfaceP = parseInt(detail.kaptdPcnt);  // 지상
    const underP   = parseInt(detail.kaptdPcntu); // 지하
    if (Number.isFinite(surfaceP) || Number.isFinite(underP)) {
      parkingTotal = (Number.isFinite(surfaceP) ? surfaceP : 0) + (Number.isFinite(underP) ? underP : 0);
    }
  }
  // BasisInfo 가 kaptdPcnt 가졌으면 fallback (구버전 호환)
  if (!parkingTotal && info.kaptdPcnt) parkingTotal = parseInt(info.kaptdPcnt) || 0;
  const parkingRatio = totalHouseholds > 0 && parkingTotal > 0
    ? parseFloat((parkingTotal / totalHouseholds).toFixed(2))
    : null;
  // 승강기 / CCTV — detail 우선, BasisInfo fallback
  const elevatorCount = parseInt(detail?.kaptdEcnt) || parseInt(info.kaptdEcntp) || null;
  const cctvCount = parseInt(detail?.kaptdCccnt) || null;
  // RICH-DETAIL-2026-05-13 (Sprint CC): KAPT V4 detail 풍부 필드 활용
  //   [VERIFIED via Chrome MCP raw — 풍림아파트/헬리오시티]
  //   지하철/버스 도보 / 편의시설 / 교육시설 / 전기차 충전기 / 관리회사
  const subwayLine = detail?.subwayLine || null;
  const subwayStation = detail?.subwayStation || null;
  const walkBusMin = detail?.kaptdWtimebus || null;
  const walkSubwayMin = detail?.kaptdWtimesub || null;
  const convenientFacility = detail?.convenientFacility || null;
  const welfareFacility = detail?.welfareFacility || null;
  const educationFacility = detail?.educationFacility || null;
  const evChargerGround = parseInt(detail?.groundElChargerCnt);
  const evChargerUnder  = parseInt(detail?.undergroundElChargerCnt);
  const evChargerTotal = (Number.isFinite(evChargerGround) || Number.isFinite(evChargerUnder))
    ? ((Number.isFinite(evChargerGround) ? evChargerGround : 0) + (Number.isFinite(evChargerUnder) ? evChargerUnder : 0))
    : null;
  const mgrCompany = detail?.kaptCcompany || null;
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
    // SALE-TYPE-2026-07-12 (Sprint TTTT): 분양/임대/혼합 구분 (codeSaleNm). "임대세대 없는 단지" 필터용.
    saleType: (info.codeSaleNm || '').trim() || null,
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
    // Sprint CC — detail 풍부 필드 (frontend t6 에 추가 노출)
    subwayLine,
    subwayStation,
    walkBusMin,
    walkSubwayMin,
    convenientFacility,
    welfareFacility,
    educationFacility,
    evChargerTotal,
    mgrCompany,
    areaDistribution: areaDistribution.sum > 0 ? areaDistribution : null,
    rawKapt: info,
    rawDetail: detail || null,
  };
}

module.exports = { buildFacility };
