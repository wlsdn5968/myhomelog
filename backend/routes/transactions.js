const express = require('express');
const router = express.Router();
const { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES } = require('../services/transactionService');
const { validateTransactionQuery } = require('../middleware/validation');

// GET /api/transactions?lawdCd=11350&dealYm=202503
router.get('/', validateTransactionQuery, async (req, res) => {
  const { lawdCd, dealYm, aptName } = req.query;
  if (!lawdCd || !dealYm) return res.status(400).json({ error: 'lawdCd, dealYm 필수' });

  const list = aptName
    ? await getTransactionsByApt(lawdCd, aptName).catch(() => [])
    : await getTransactions(lawdCd, dealYm).catch(() => []);

  res.json({ count: list.length, items: list });
});

// GET /api/transactions/analyze?lawdCd=11350&dealYm=202503
router.get('/analyze', validateTransactionQuery, async (req, res) => {
  const { lawdCd, dealYm } = req.query;
  if (!lawdCd || !dealYm) return res.status(400).json({ error: 'lawdCd, dealYm 필수' });

  const list = await getTransactions(lawdCd, dealYm).catch(() => []);
  const analysis = analyzeTransactions(list);
  res.json({ count: list.length, summary: analysis });
});

// GET /api/transactions/codes - 법정동코드 목록
router.get('/codes', (req, res) => {
  res.json({ codes: LAWD_CODES });
});

module.exports = router;
