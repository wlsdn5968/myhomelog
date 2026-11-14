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
      limited: true, // AUDIT2-BR-1111: 공개 경로는 국토부 라이브 호출 수를 묶는다
      kakaoGate: require('./geocode').createKakaoGate(1, req), // AUDIT4-1114: Kakao 주소검색 1회를 IP 예산과 전역 일일 상한에 넣는다
    });
    // AUDIT4-1114: 관문(오늘 조회 한도)에 막힌 것은 '없음'과 구별해 알린다(화면이 '정보 없음'으로 잘못 안내하지 않게)
    if (title && title._gated) return res.json({ title: null, limited: true });
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
//   입력 검사를 한도보다 먼저 둔다(적대 리뷰 2026-10-30: 거절될 잘못된 입력이 한도를 깎던 것).
const _nearbyCheck = (req, res, next) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat,lng 필수' });
  // SEC-1030-NEARBY: 한국 범위 밖은 400, 좌표는 소수 4자리(약 11m)로 반올림 -> 캐시 키 분산(무한 미스) 차단.
  if (!isValidKoreaCoord(lat, lng)) return res.status(400).json({ error: '한국 범위의 lat,lng 가 필요해요' });
  next();
};
router.get('/nearby', _nearbyCheck, dailyLimit({ limit: 100, scope: 'nearby', loggedInBonus: 100, includeGet: true }), async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  // AUDIT6-1114 (run-6): 캐시와 DB 에 없는 좌표만 Kakao 를 부르는데, 그 호출(최대 7회)을 IP 예산과 전역 일일 상한에 넣는다.
  const data = await getNearbyAmenities(Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, { gate: require('./geocode').createKakaoGate(7, req) });
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
  // AUDIT6-1114 (보안 점검 run-6, properties.kakao-directions-no-global-budget): 좌표 범위와 직장 이름 길이를 보지 않았고,
  //   Kakao 키워드 검색과 길찾기가 전역 일일 상한 밖에서 나갔다(IP 하루 5회뿐). 같은 길찾기도 동시에 두 번 불렀다.
  //   한국 범위 좌표만 받고 4자리로 맞춘다(nearby 와 같은 규칙). 직장 이름은 60자까지. Kakao 호출 2회분을 IP 예산과 전역 상한에 넣는다.
  const lat = parseFloat(aptLat), lng = parseFloat(aptLng);
  if (!isValidKoreaCoord(lat, lng)) return res.status(400).json({ error: '한국 범위의 aptLat,aptLng 가 필요해요' });
  const wp = typeof workplace === 'string' ? workplace.trim() : '';
  if (!wp) return res.status(400).json({ error: '직장 이름을 넣어 주세요' });
  if (wp.length > 60) return res.status(400).json({ error: '직장 이름은 60자까지 넣을 수 있어요' });
  // 관문은 캐시에 없어 Kakao 를 실제로 부를 때만 쓰인다(서비스 함수가 캐시 확인 뒤에 묻는다). 막혔는지는 여기서 기억한다.
  const _gate = require('./geocode').createKakaoGate(2, req);
  let gated = false;
  const gate = async () => { const ok = await _gate(); if (!ok) gated = true; return ok; };
  const dest = await keywordToCoord(wp, gate);
  if (!dest) return res.json(gated ? { available: false, limited: true } : { available: false, error: '직장 좌표 조회 실패' });
  const oLat = Math.round(lat * 1e4) / 1e4, oLng = Math.round(lng * 1e4) / 1e4;
  // 차량 시간을 먼저 받아 캐시에 넣은 뒤 대중교통 추정을 낸다(안에서 같은 길찾기를 다시 읽는다 — 동시에 부르면 두 번 나갔다)
  const carMin = await getCarMinutes(oLat, oLng, dest.lat, dest.lng, gate);
  const transitMin = await getTransitMinutes(oLat, oLng, dest.lat, dest.lng, gate);
  if (carMin == null && gated) return res.json({ available: false, limited: true });
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
