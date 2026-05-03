/**
 * GET  /api/analysis?aptName=래미안&area=노원구&price=8.5
 * POST /api/analysis/total-cost
 */
const express = require('express');
const router = express.Router();
const { analyzeApt, calcTotalCost, getLawdCdFromArea } = require('../services/analysisService');

// GET /api/analysis
router.get('/', async (req, res) => {
  const { aptName, area, price } = req.query;
  let { lawdCd } = req.query;

  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  // lawdCd 없으면 area 문자열에서 역조회
  if (!lawdCd && area) lawdCd = getLawdCdFromArea(area);

  try {
    const result = await analyzeApt(lawdCd, aptName, parseFloat(price) || 0);
    res.json(result);
  } catch (err) {
    // MOB-AUDIT-2026-05-03: production 에선 generic 메시지 — 내부 에러 노출 차단
    const isProd = process.env.NODE_ENV === 'production';
    res.status(err.status || 500).json({
      error: isProd ? '분석 중 오류가 발생했어요.' : err.message,
      code: err.code,
    });
  }
});

// POST /api/analysis/total-cost
router.post('/total-cost', (req, res) => {
  const { price, loanAmount, houseStatus, isFirstBuyer } = req.body;
  if (!price) return res.status(400).json({ error: 'price 필수' });

  const result = calcTotalCost(
    parseFloat(price),
    parseFloat(loanAmount) || 0,
    houseStatus || '무주택',
    !!isFirstBuyer,
  );
  res.json(result);
});

module.exports = router;
