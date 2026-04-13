const express = require('express');
const router = express.Router();
const { getAIRecommendations } = require('../services/propertyService');
const { validatePropertySearch } = require('../middleware/validation');

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
