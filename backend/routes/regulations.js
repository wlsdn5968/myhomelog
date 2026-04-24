/**
 * GET /api/regulations — 현행 대출 규제 정보
 *
 * Phase 5.3 (4.14): 하드코딩 → regulations_snapshot 테이블 조회
 *   - DB 에 최신 row 삽입하면 재배포 없이 갱신
 *   - DB 장애 시 regulationsService 의 FALLBACK 으로 폴백
 */
const express = require('express');
const router = express.Router();
const { getSnapshot } = require('../services/regulationsService');

router.get('/', async (req, res) => {
  const snap = await getSnapshot('housing_loan_2025');
  res.json({
    ...snap.data,
    _meta: { source: snap.source, validFrom: snap.validFrom },
  });
});

router.get('/ltv', async (req, res) => {
  const snap = await getSnapshot('housing_loan_2025');
  res.json({
    ltvTable: snap.data.ltvTable,
    lastUpdated: snap.data.lastUpdated,
    _meta: { source: snap.source, validFrom: snap.validFrom },
  });
});

module.exports = router;
