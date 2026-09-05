/**
 * GET  /api/analysis?aptName=래미안&area=노원구&price=8.5
 * (POST /total-cost 는 2026-09-05 제거 — 프론트 호출 0건)
 */
const express = require('express');
const router = express.Router();
const { analyzeApt, getLawdCdFromArea, compareBatch } = require('../services/analysisService');

// GET /api/analysis
router.get('/', async (req, res) => {
  const { aptName, area, price, sigungu, umdNm } = req.query;
  let { lawdCd } = req.query;

  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  // lawdCd 없으면 area 문자열에서 역조회
  if (!lawdCd && area) lawdCd = getLawdCdFromArea(area);

  try {
    // CROSS-REGION-FIX-2026-06-03: sigungu/umdNm 전달 → 가격시그널 표본을 실거래가 탭과 동일 동(umd) 스코프
    const result = await analyzeApt(lawdCd, aptName, parseFloat(price) || 0, sigungu || null, umdNm || null);
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

// POST /api/analysis/compare — 단지 비교 (Phase1, COMPARE-2026-06-21)
//   body: { apts: [{ aptName, sigungu, umdNm, lawdCd }], dealMonths? }
//   평당가(전용)·facility 비교. 룰 준수(점수/등급/승자 금지·미보정 라벨·disclaimer 는 서비스가 부여).
router.post('/compare', async (req, res) => {
  const { apts, dealMonths } = req.body || {};
  if (!Array.isArray(apts) || apts.length < 2) {
    return res.status(400).json({ error: '비교할 단지를 2개 이상 선택하세요.' });
  }
  if (apts.length > 6) {
    return res.status(400).json({ error: '한 번에 최대 6개 단지까지 비교할 수 있어요.' });
  }
  try {
    const result = await compareBatch(apts, { dealMonths });
    res.json(result);
  } catch (err) {
    const isProd = process.env.NODE_ENV === 'production';
    res.status(err.status || 500).json({
      error: isProd ? '비교 중 오류가 발생했어요.' : err.message,
      code: err.code,
    });
  }
});

// DEAD-ENDPOINT-REMOVED-2026-09-05 (감사 P2-11): POST /total-cost 제거 — 프론트 호출 0건(grep 실측). 취득세·총비용은
//   클라이언트가 계산한다. analysisService.calcTotalCost 는 프론트 사본과의 1,620조합 대조(계약 테스트)의 오라클로 남긴다.

module.exports = router;
