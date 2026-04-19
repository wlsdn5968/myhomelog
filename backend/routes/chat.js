const express = require('express');
const router = express.Router();
const { callAI } = require('../services/aiService');
const { validateChatInput } = require('../middleware/validation');

/**
 * POST /api/chat
 * AI 채팅 엔드포인트
 */
router.post('/', validateChatInput, async (req, res) => {
  const { message, context } = req.body;

  // 사용자 세션 컨텍스트(현재 보고있는 매물·조건)를 첫 시스템성 메시지로 주입
  const sessionMessages = [];
  if (context?.session) {
    const s = context.session;
    const lines = [];
    if (s.userProfile) {
      const u = s.userProfile;
      lines.push(`[사용자 조건] 예산 ${u.maxBudget||'?'}억 / 자기자본 ${u.myCash||'?'}억 / 지역 ${u.region||'?'} / 보유 ${u.houseStatus||'?'} / 생애최초 ${u.isFirstBuyer?'예':'아니오'} / 학군 ${u.schoolNeeded?'중요':'보통'}${u.workplaceArea?` / 직장 ${u.workplaceArea}`:''}`);
    }
    if (s.focusProperty) {
      const p = s.focusProperty;
      lines.push(`[현재 상세보기 단지] ${p.aptName} (${p.area||''}, ${p.buildYear||'?'}년) 평균 ${p.avgPrice||'?'}억, 점수 ${p.score||'?'}/100, LTV ${p.ltv||'?'}`);
    }
    if (s.recommendedProperties?.length) {
      const list = s.recommendedProperties
        .map((p, i) => `${i + 1}. ${p.aptName}(${p.area||''}) ${p.avgPrice||'?'}억 / 점수 ${p.score||'?'}`)
        .join(' · ');
      lines.push(`[최근 추천 5건] ${list}`);
    }
    if (lines.length) {
      sessionMessages.push({
        role: 'user',
        content: `(시스템 컨텍스트 — 사용자에게 보이지 않음)\n${lines.join('\n')}\n위 정보를 참고하되, 답변에서 이 정보를 그대로 복창하지 말고 자연스럽게 활용하세요. 매수 추천·가격 예측 표현은 절대 금지.`,
      });
      sessionMessages.push({ role: 'assistant', content: '네, 사용자 조건과 매물 정보를 참고해서 중립적으로 답변하겠습니다.' });
    }
  }

  const messages = [
    ...sessionMessages,
    ...(context?.history || []),
    { role: 'user', content: message },
  ];

  // 최대 10턴 유지 (토큰 절약) — 단, 세션 컨텍스트는 항상 보존
  const trimmed = sessionMessages.length
    ? [...sessionMessages, ...messages.slice(sessionMessages.length).slice(-20)]
    : messages.slice(-20);

  const result = await callAI(trimmed, false).catch(err => {
    throw Object.assign(new Error(err.message), { status: 502 });
  });

  res.json({
    reply: result.content,
    fromCache: result.fromCache || false,
    usage: process.env.NODE_ENV === 'development' ? result.usage : undefined,
  });
});

module.exports = router;
