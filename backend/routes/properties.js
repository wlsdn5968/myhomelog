const express = require('express');
const router = express.Router();
const { getAIRecommendations } = require('../services/propertyService');
const { getAptBasisInfo } = require('../services/aptInfoService');
const { validatePropertySearch } = require('../middleware/validation');

// GET /api/properties/info?aptSeq=A13559101
// 단지 기본정보 (총세대수·동수·준공일자 등)
router.get('/info', async (req, res) => {
  const { aptSeq } = req.query;
  if (!aptSeq) return res.status(400).json({ error: 'aptSeq 필수' });
  const info = await getAptBasisInfo(String(aptSeq).trim());
  if (!info) return res.json({ available: false, message: '단지 기본정보 조회 실패 또는 데이터 없음' });
  res.json({
    available: true,
    aptName: info.kaptName,
    address: info.doroJuso || info.codeAptNm,
    dongCount: info.kaptDongCnt,
    householdCount: info.kaptdaCnt,
    builtDate: info.kaptUsedate,
    parkingTotal: info.kaptdPcnt,
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
  } = req.body;

  if (!maxBudget || maxBudget <= 0) {
    return res.status(400).json({ error: '매수 예산(maxBudget) 필수' });
  }

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
  }).catch(err => {
    throw Object.assign(new Error(err.message), { status: 502 });
  });

  res.json(result);
});

module.exports = router;
