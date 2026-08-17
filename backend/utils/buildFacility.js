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

// HH-CONFLICT-2026-08-17 (Sprint MMMMMMM — 서울 전수조사 4회차 실측):
//   KAPT 의 세대수 원천은 두 개다 — kaptdaCnt(관리세대수)·hoCnt(호수). 둘 다 0이 아니면서
//   서로 다른 단지가 서울에만 207곳이고, 어느 쪽도 일괄 신뢰할 수 없다:
//     · kaptdaCnt 가 틀린 예 — 대치풍림아이원 1.2단지 19(5개동) vs hoCnt 90
//                              아스테리움용산 128 vs 338 → 세대당 주차 6.07대(서울 평균 1.086의 5.6배)
//     · hoCnt 가 틀린 예     — 방원예뜨랑 121 vs 3, 삼전현대 120 vs 4
//   건축물대장(건축HUB) 교차검증 12건은 kaptdaCnt 9 : hoCnt 2 → **표시값 규칙(kaptdaCnt 우선)은 유지**한다.
//   값을 우리가 고르는 대신 "두 원천이 어긋났다"는 사실만 내보내고, 그 위에 쌓는 판단
//   (주차여유 태그·점수 가산·보고서 보너스·주차 필터)만 막는다. 임의로 고르면 그게 환각이다.
//
//   ★ 이 함수를 SSOT 로 둔 이유: 세대당 주차 판정이 이미 **5곳**에 흩어져 있다
//     (propertyService 점수·태그·필터, report 보너스·장점문). 조건을 각 자리에 복사하면
//     이 저장소가 여러 번 겪은 "사본이 조용히 갈리는" 사고를 그대로 반복한다.
//     report 경로는 buildFacility 를 아예 호출하지 않으므로 이 함수를 직접 부른다.
//
//   [임계 20% 근거] 서울 207건 분포 실측 — 5%미만 157 / 5~20% 26 / 20~50% 16 / 50%이상 8.
//     20% 미만은 관리세대수와 호수의 정상적 차이(부속호실 등)로 설명되고 비율도 뒤틀리지 않는다.
const HH_CONFLICT_THRESHOLD = 0.2;
function householdsConflictOf(kaptdaCnt, hoCnt) {
  const a = parseInt(kaptdaCnt), b = parseInt(hoCnt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null; // 한쪽만 있으면 비교 불가
  if (Math.abs(a - b) / Math.max(a, b) < HH_CONFLICT_THRESHOLD) return null;
  return { kaptdaCnt: a, hoCnt: b, used: 'kaptdaCnt' };
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
      householdsSource: null,   // HH-BR-FALLBACK-2026-08-17: 위 0 은 "모름"이다(형태 일치용으로 명시)
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
  // HH-BR-FALLBACK-2026-08-17 (Sprint MMMMMMM-23): KAPT 두 원천이 **둘 다 0** 이면 종전엔 세대수가 0이었다.
  //   즉 '모름'이 값처럼 흘러 판정을 바꿨다 — 추천 게이트는 983fbc1 에서 막았지만 원인은 여기(생산 함수)다.
  //   [원천] 건축물대장(건축HUB 표제부)은 애초에 "KAPT 없는 소형·노후 단지" 보강용으로 붙인 연동이다
  //     (buildingRegisterService 헤더). 이 모집단에서 실제로 작동함을 라이브로 확인했다:
  //     지산타운 **630세대**(4개동·1991) · 일산두산위브더제니스 **2,700세대** · 위례센트럴자이 1,413세대.
  //   ⚠ KAPT 값이 있으면 **절대 덮지 않는다** — 교차검증 12건이 kaptdaCnt 9:2 로 우세했다(아래 HH-CONFLICT).
  //     건축물대장은 '모를 때만' 쓰는 3순위다.
  //   출처를 함께 내보낸다 — 어느 원천의 값인지 화면이 밝힐 수 있어야 한다(절대 룰 ②).
  const _kaptHh = _posInt(info.kaptdaCnt) || _posInt(info.hoCnt);
  const _brHh = _posInt(info._br && info._br.hhldCnt);
  const totalHouseholds = _kaptHh || _brHh;
  const householdsSource = _kaptHh ? 'kapt' : (_brHh ? 'buildingRegister' : null);
  // HH-CONFLICT-2026-08-17 (Sprint MMMMMMM — 서울 전수조사 4회차 실측):
  //   kaptdaCnt(관리세대수)와 hoCnt(호수)가 **둘 다 0이 아니면서 서로 다른** 단지가 서울에만 207곳이다.
  //   위 fallback 은 kaptdaCnt 를 무조건 우선하는데, 그 값이 틀린 케이스가 실재한다:
  //     · 대치풍림아이원 1.2단지 kaptdaCnt=19 / hoCnt=90 / **5개동** → 5개동 19세대는 성립 불가
  //     · 아스테리움용산    kaptdaCnt=128 / hoCnt=338 / 주차 777 → 세대당 6.07대(서울 평균 1.086의 5.6배)
  //   반대로 hoCnt 가 틀린 케이스도 있다(방원예뜨랑 hoCnt=3, 삼전현대 hoCnt=4) → **어느 쪽도 일괄 신뢰 불가**.
  //   건축물대장(건축HUB) 교차검증 12건은 kaptdaCnt 9 : hoCnt 2 로 kaptdaCnt 우세 → **기본 규칙은 유지**한다.
  //   [처리] 값을 바꾸지 않는다. 두 원천이 어긋났다는 **사실만** 내보내고, 그 위에 쌓는 판단
  //     ('주차여유' 태그·주차 1.2+ 필터)을 프론트에서 막는다. 우리가 임의로 고르면 그게 환각이다.
  //   [임계 20%] 서울 207건 분포 실측 — 5%미만 157 / 5~20% 26 / 20~50% 16 / 50%이상 8.
  //     20% 미만은 관리세대수와 호수의 정상적 차이(동수·부속호실)로 설명되고 비율도 뒤틀리지 않는다.
  const householdsConflict = householdsConflictOf(info.kaptdaCnt, info.hoCnt);
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
    // HH-BR-FALLBACK-2026-08-17: 'kapt' | 'buildingRegister' | null(미확인). null 이면 세대수는 0이고,
    //   그 0 은 "확인된 0세대"가 아니라 **모름**이다 — 배제·경고의 근거로 쓰면 안 된다.
    householdsSource,
    dongCount: parseInt(info.kaptDongCnt) || 0,
    parkingTotal,
    parkingRatio,
    // HH-CONFLICT-2026-08-17: null 이면 두 원천이 일치(또는 한쪽만 존재) — 평소 경로엔 아무 영향 없다.
    householdsConflict,
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

module.exports = { buildFacility, householdsConflictOf, HH_CONFLICT_THRESHOLD };
