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
  // CDN-CACHE-2026-06-14: 규제정보는 정책변경 시에만 갱신(드묾)인데 매 부팅 fetch(loadRegulatedKeywords) → 엣지 캐시 효과 큼.
  res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400');
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

// DEAD-ENDPOINT-REMOVED-2026-09-05 (감사 P2-11): GET /ltv 제거 — 프론트는 GET / 한 번으로 LTV 표까지 받는다(호출 0건).

// REG-LOG-2026-08-19 (Sprint NNNNNNN-12→14): 로직은 regulationsService.getChangeLog 로 승격 — 서버렌더 브리핑 페이지와 공유(사본 금지).
router.get('/log', async (req, res) => {
  const out = await require('../services/regulationsService').getChangeLog();
  // ⚠ CACHE-POISON-2026-08-29: getChangeLog 는 DB 미설정·조회 실패에도 `{ items: [] }` 를 200 으로 준다.
  //   그걸 s-maxage=6h 로 캐시하면 **일시적 DB 장애가 6시간짜리 장애로 승격**된다
  //   (프론트는 items.length 로 카드 표시를 결정하므로 규제 로그 카드가 6시간 사라진다).
  //   운영자 검증을 거친 행만 쌓이는 구조라 정상 상태에서 빈 배열은 나오지 않는다 → 빈 배열 = 열화.
  const degraded = !out || !Array.isArray(out.items) || out.items.length === 0;
  res.set('Cache-Control', degraded ? 'no-store' : 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.json(out);
});

module.exports = router;
