const express = require('express');
const router = express.Router();
const { getAIRecommendations } = require('../services/propertyService');
const { getAptBasisInfo, getAptDtlInfo } = require('../services/aptInfoService');
const { getNearbyAmenities, getTransitMinutes, getCarMinutes, keywordToCoord } = require('../services/kakaoService');
const { validatePropertySearch } = require('../middleware/validation');

// GET /api/properties/info?aptSeq=A13559101
// 단지 기본정보 (총세대수·동수·준공일자·주차 등)
// DEPRECATED-NOTE-2026-05-13 (Sprint CC): frontend 미사용 endpoint [VERIFIED via grep].
//   외부 backward-compat 위해 유지. Sprint AA/BB 에서 V4 fix 적용해서 정확 데이터 반환.
//   /api/search/facility 가 사실상 대체 endpoint (facility schema + altCandidates + nearbySchools 까지).
// PARK-FIX-2026-05-13 (Sprint AA): KAPT V4 의 주차는 detail endpoint 필요 (BasisInfo 에 부재).
// BasisInfo + DtlInfo 병렬 호출 + 진짜 필드명 (kaptdPcnt 지상 + kaptdPcntu 지하) 합산.
router.get('/info', async (req, res) => {
  const { aptSeq } = req.query;
  if (!aptSeq) return res.status(400).json({ error: 'aptSeq 필수' });
  const code = String(aptSeq).trim();
  const [info, detail] = await Promise.all([
    getAptBasisInfo(code),
    getAptDtlInfo(code).catch(() => null),
  ]);
  if (!info) return res.json({ available: false, message: '단지 기본정보 조회 실패 또는 데이터 없음' });
  const surfP = parseInt(detail?.kaptdPcnt) || 0;
  const underP = parseInt(detail?.kaptdPcntu) || 0;
  const parkingTotal = (surfP + underP) || parseInt(info.kaptdPcnt) || null;
  res.json({
    available: true,
    aptName: info.kaptName,
    address: info.doroJuso || info.codeAptNm,
    dongCount: info.kaptDongCnt,
    householdCount: info.kaptdaCnt,
    builtDate: info.kaptUsedate,
    parkingTotal,
    elevatorCount: parseInt(detail?.kaptdEcnt) || parseInt(info.kaptdEcntp) || null,
    cctvCount: parseInt(detail?.kaptdCccnt) || null,
    heatType: info.codeHeatNm,
    floorArea: info.kaptMarea,
    raw: process.env.NODE_ENV === 'development' ? info : undefined,
  });
});

// POST /api/properties/recommend
router.post('/recommend', validatePropertySearch, async (req, res) => {
  const {
    maxBudget, myCash, availableLoan,
    region, houseStatus, isFirstBuyer,
    purpose, schoolNeeded, childPlan, workplaceArea,
    minArea, maxArea,
    minHouseholds, minParkingRatio, saleOnly, // FILTER-2026-07-12: 좋은-아파트 조건 필터
  } = req.body;

  if (!maxBudget || maxBudget <= 0) {
    return res.status(400).json({ error: '매수 예산(maxBudget) 필수' });
  }

  // PYEONG-FILTER-FIX-2026-05-21 (운영자 발견 "단지 정리 목록이 이상하게 나와"):
  //   frontend pyRange() 가 {minArea,maxArea} (평) 전송하나 route 가 destructure 누락 →
  //   getAIRecommendations 에 undefined 전달 → minPy=15/maxPy=60 기본값 → 평형 필터 무시.
  //   (예: "중형 23~33평" 요청에 18·20·21평 단지 혼입). minArea/maxArea pass-through 로 수정.
  const result = await getAIRecommendations({
    maxBudget: parseFloat(maxBudget),
    myCash: parseFloat(myCash) || 0,
    availableLoan: parseFloat(availableLoan) || 0,
    region: region || '서울',
    houseStatus: houseStatus || '무주택',
    isFirstBuyer: isFirstBuyer === true || isFirstBuyer === 'true',
    purpose: purpose || '실거주',
    schoolNeeded: schoolNeeded === true || schoolNeeded === 'true',
    childPlan, workplaceArea,
    minArea, maxArea,
    minHouseholds, minParkingRatio, saleOnly, // FILTER-2026-07-12
  }).catch(err => {
    throw Object.assign(new Error(err.message), { status: 502 });
  });

  res.json(result);
});

// GET /api/properties/building-register — KAPT 없는 단지(성지 등) 건축물대장 표제부 fallback (SSSS)
router.get('/building-register', async (req, res) => {
  const { lawdCd, sigungu, umd, apt, aptKey } = req.query;
  if (!lawdCd || !apt) return res.status(400).json({ error: 'lawdCd, apt 필수' });
  try {
    const { getBuildingTitle } = require('../services/buildingRegisterService');
    const title = await getBuildingTitle({
      lawdCd: String(lawdCd),
      sigungu: sigungu ? String(sigungu) : '',
      umdNm: umd ? String(umd) : '',
      aptName: String(apt),
      aptKey: aptKey ? String(aptKey) : undefined,
    });
    res.json({ title: title || null });
  } catch (e) {
    res.status(502).json({ error: e.message, title: null });
  }
});

// GET /api/properties/nearby?lat=..&lng=..  주변 편의시설 카운트
router.get('/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat,lng 필수' });
  const data = await getNearbyAmenities(lat, lng);
  if (!data) return res.json({ available: false });
  res.json({ available: true, ...data });
});

// POST /api/properties/transit  단지→직장 통근시간
// body: { aptLat, aptLng, workplace }  workplace는 키워드(주소 또는 장소명)
router.post('/transit', async (req, res) => {
  const { aptLat, aptLng, workplace } = req.body;
  if (!aptLat || !aptLng || !workplace) {
    return res.status(400).json({ error: 'aptLat,aptLng,workplace 필수' });
  }
  const dest = await keywordToCoord(workplace);
  if (!dest) return res.json({ available: false, error: '직장 좌표 조회 실패' });
  const [carMin, transitMin] = await Promise.all([
    getCarMinutes(parseFloat(aptLat), parseFloat(aptLng), dest.lat, dest.lng),
    getTransitMinutes(parseFloat(aptLat), parseFloat(aptLng), dest.lat, dest.lng),
  ]);
  res.json({
    available: carMin != null,
    destinationName: dest.name,
    destinationLat: dest.lat,
    destinationLng: dest.lng,
    carMinutes: carMin,
    transitMinutes: transitMin,
  });
});

module.exports = router;
