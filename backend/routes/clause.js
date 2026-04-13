/**
 * POST /api/clause
 * 매물 조건 기반 맞춤 특약문구 AI 자동 생성
 */
const express = require('express');
const router = express.Router();
const { callAI } = require('../services/aiService');
const cache = require('../cache');

router.post('/', async (req, res) => {
  const { aptName, area, price, ltv, houseStatus, isFirstBuyer, buildYear, issues } = req.body;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  const cacheKey = `clause:${aptName}:${price}:${houseStatus}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  const prompt = `다음 아파트 매수 계약에 필요한 맞춤 특약문구를 생성해줘.

매물 정보:
- 단지: ${aptName} (${area})
- 매수가: ${price}억원
- 준공: ${buildYear}년
- 매수자: ${houseStatus} / 생애최초: ${isFirstBuyer ? 'Y' : 'N'}
- 대출 규제: LTV ${ltv}
- 특이사항: ${issues || '없음'}

아래 JSON 형식으로만 반환 (\`\`\` 없이):
{
  "essential": [
    {"title": "특약 제목", "content": "특약 내용 전문", "reason": "왜 이 특약이 필요한지"}
  ],
  "recommended": [
    {"title": "특약 제목", "content": "특약 내용 전문", "reason": "이유"}
  ],
  "caution": "이 계약에서 특히 주의할 점 1~2줄"
}

essential: 반드시 넣어야 할 특약 3~4개
recommended: 상황에 따라 추가할 특약 2~3개
실제 계약서에 바로 쓸 수 있는 정확한 문구로 작성.`;

  try {
    const result = await callAI([{ role: 'user', content: prompt }], false);
    const cleaned = result.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    cache.set(cacheKey, parsed, 7200);
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '특약 생성 실패', detail: e.message });
  }
});

// POST /api/clause/risk - 리스크 시나리오 생성
router.post('/risk', async (req, res) => {
  const { aptName, area, price, buildYear, ltv, score } = req.body;
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  const cacheKey = `risk:${aptName}:${price}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  const prompt = `다음 아파트 매수 시 발생 가능한 리스크 시나리오를 분석해줘.

매물: ${aptName} (${area}) / 매수가 ${price}억 / ${buildYear}년 / LTV ${ltv} / AI점수 ${score}/100

JSON만 반환 (\`\`\` 없이):
{
  "risks": [
    {
      "level": "높음|중간|낮음",
      "title": "리스크 제목",
      "scenario": "구체적 시나리오 설명",
      "probability": "발생 가능성 %",
      "countermeasure": "대응 방법"
    }
  ],
  "overallRisk": "낮음|보통|높음",
  "summary": "종합 리스크 요약 2줄"
}
리스크 3~4개, 현실적이고 구체적으로.`;

  try {
    const result = await callAI([{ role: 'user', content: prompt }], false);
    const cleaned = result.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    cache.set(cacheKey, parsed, 7200);
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '리스크 분석 실패' });
  }
});

module.exports = router;
