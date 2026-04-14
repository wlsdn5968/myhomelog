const express = require('express');
const router = express.Router();
const { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES } = require('../services/transactionService');
const { validateTransactionQuery } = require('../middleware/validation');

function handleMolitError(err, res) {
  if (err.code === 'MOLIT_KEY_MISSING') {
    return res.status(503).json({
      error: '실거래가 API 미연동',
      code: 'MOLIT_KEY_MISSING',
      message: '국토부 실거래가 API 키가 설정되지 않았습니다.',
      guide: 'data.go.kr → "아파트매매 실거래가 상세자료" 검색 → 활용신청 (무료, 자동승인)',
    });
  }
  return res.status(err.status || 500).json({ error: err.message });
}

// GET /api/transactions?lawdCd=11350&dealYm=202503
router.get('/', validateTransactionQuery, async (req, res) => {
  const { lawdCd, dealYm, aptName } = req.query;
  if (!lawdCd || !dealYm) return res.status(400).json({ error: 'lawdCd, dealYm 필수' });

  try {
    const list = aptName
      ? await getTransactionsByApt(lawdCd, aptName)
      : await getTransactions(lawdCd, dealYm);
    res.json({ count: list.length, items: list, isMock: false });
  } catch (err) {
    handleMolitError(err, res);
  }
});

// GET /api/transactions/analyze?lawdCd=11350&dealYm=202503
router.get('/analyze', validateTransactionQuery, async (req, res) => {
  const { lawdCd, dealYm } = req.query;
  if (!lawdCd || !dealYm) return res.status(400).json({ error: 'lawdCd, dealYm 필수' });

  try {
    const list = await getTransactions(lawdCd, dealYm);
    res.json({ count: list.length, summary: analyzeTransactions(list), isMock: false });
  } catch (err) {
    handleMolitError(err, res);
  }
});

// GET /api/transactions/codes
router.get('/codes', (req, res) => {
  res.json({ codes: LAWD_CODES });
});

module.exports = router;
