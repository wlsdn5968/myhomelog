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
  // P1 (2026-04-25): housing_loan + acquisition_tax 동시 반환
  // 프론트가 부팅 시 1회 fetch 로 두 정보 모두 캐시 (LTV 매칭 + calcTotalCost 모두 사용)
  const [housing, tax] = await Promise.all([
    getSnapshot('housing_loan_2025'),
    getSnapshot('acquisition_tax_2025').catch(() => ({ data: null, source: 'missing' })),
  ]);
  res.json({
    ...housing.data,
    tax: tax.data || null,
    _meta: {
      source: housing.source,
      validFrom: housing.validFrom,
      taxSource: tax.source,
    },
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
