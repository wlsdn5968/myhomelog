const express = require('express');
const router = express.Router();
const { getAIRecommendations } = require('../services/propertyService');
const { getNearbyAmenities, getTransitMinutes, getCarMinutes, keywordToCoord } = require('../services/kakaoService');
const { validatePropertySearch } = require('../middleware/validation');
const { dailyLimit } = require('../middleware/dailyLimit');
const { isValidKoreaCoord } = require('../utils/geo');

// DEAD-ENDPOINT-REMOVED-2026-09-05 (감사 P2-11): GET /info 제거 — 2026-05-13 에 DEPRECATED 로 표기한 뒤 4개월간 프론트 호출 0.
//   /api/search/facility 가 같은 정보(+altCandidates·nearbySchools)를 준다.

// POST /api/properties/recommend
router.post('/recommend', validatePropertySearch, async (req, res) => {
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  const {
    maxBudget, myCash, availableLoan,
    region, lawdCd, houseStatus, isFirstBuyer,
    purpose, schoolNeeded, childPlan, workplaceArea,
    minArea, maxArea,
    minHouseholds, minParkingRatio, saleOnly, // FILTER-2026-07-12: 좋은-아파트 조건 필터
  } = req.body || {};

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
    lawdCd, // REGION-CODE-2026-08-30: 있으면 문자열 해석 대신 이 코드로 확정

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
  // BR-KEY-2026-10-18: 공개 요청의 aptKey 는 받지 않는다 — 그대로 캐시 키가 돼 값만 바꿔 외부 API·행 추가를 반복할 수 있었다.
  //   프런트(index.html _loadBuildingRegister)와 서버 내부 호출 모두 aptKey 를 쓰지 않는다(전수 확인).
  const { lawdCd, sigungu, umd, apt } = req.query;
  if (!lawdCd || !apt) return res.status(400).json({ error: 'lawdCd, apt 필수' });
  if (!require('../services/transactionService').isKnownLawdCd(lawdCd)) return res.status(400).json({ error: '지원하지 않는 지역이에요.', title: null });
  try {
    const { getBuildingTitle } = require('../services/buildingRegisterService');
    const title = await getBuildingTitle({
      lawdCd: String(lawdCd),
      sigungu: sigungu ? String(sigungu) : '',
      umdNm: umd ? String(umd) : '',
      aptName: String(apt).slice(0, 80),
    });
    res.json({ title: title || null });
  } catch (e) {
    // SENTRY-GAP-2026-07-17 (Sprint XXXXX): 무로그·무캡처였던 502 — 건축물대장 upstream 실패는 헬퍼가 그룹핑
    require('../logger').warn({ err: e.message }, 'building-register 조회 실패');
    require('../utils/captureError').captureRouteError(e, 'properties/building-register');
    res.status(502).json({ error: '건축물대장을 불러오지 못했어요.', title: null });
  }
});

// GET /api/properties/nearby?lat=..&lng=..  주변 편의시설 카운트
// SEC-1030-NEARBY (C11): dailyLimit 은 GET 을 건너뛰므로 이 라우트만 includeGet 으로 일일 한도를 건다.
//   임의 좌표마다 캐시 미스 -> 카카오 호출이 일어나 쿼터를 소모할 수 있다.
router.use('/nearby', dailyLimit({ limit: 100, scope: 'nearby', loggedInBonus: 100, includeGet: true }));
router.get('/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat,lng 필수' });
  // SEC-1030-NEARBY: 한국 범위 밖은 400, 좌표는 소수 4자리(약 11m)로 반올림 -> 캐시 키 분산(무한 미스) 차단.
  if (!isValidKoreaCoord(lat, lng)) return res.status(400).json({ error: '한국 범위의 lat,lng 가 필요해요' });
  const data = await getNearbyAmenities(Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4);
  if (!data) return res.json({ available: false });
  res.json({ available: true, ...data });
});

// POST /api/properties/transit  단지→직장 통근시간
// body: { aptLat, aptLng, workplace }  workplace는 키워드(주소 또는 장소명)
router.post('/transit', async (req, res) => {
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  const { aptLat, aptLng, workplace } = req.body || {};
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
