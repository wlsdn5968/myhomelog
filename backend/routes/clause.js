/**
 * POST /api/clause
 * AI 특약 중단(2026-11-13): aptName 이 없으면 400, 있으면 410 만 돌려준다.
 * 화면의 특약 초안은 규칙 템플릿(buildRuleClause)이라 이 라우트와 무관하다.
 */
const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  const { aptName } = req.body || {};
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  // NO-PAID-AI-2026-11-13 (운영자 지시): 운영자, 프로 플랜 누구도 통과하지 않는다.
  return res.status(410).json({ code: 'ai_removed', error: 'AI 특약은 제공하지 않아요. 특약 초안 화면의 표준 특약 템플릿을 이용해 주세요.' });
});

module.exports = router;
