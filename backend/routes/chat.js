const express = require('express');
const router = express.Router();
// CHAT-ZERO-COST-2026-08-12 (Sprint KKKKKKK-16, 운영자 A안 승인): LLM(Anthropic) 호출을 **구조적으로
//   제거** — 모든 응답은 룰베이스 데이터 라우터(공식 데이터 조회)가 만든다. 운영자 방침 "비용 0원
//   영구 보장"의 유일한 계약적 해법(무료 티어 LLM 전수 조사 결과: 상업 이용 허용이 명확하고
//   학습 미사용이 명문화되고 영구 보장까지 되는 조합은 존재하지 않음 — 2026-08-12 실조사).
//   부수 효과: 환각 0 (절대 룰 '환각 차단'과 정합).
const { route: routeDataChat } = require('../services/chatDataRouter');
const { validateChatInput } = require('../middleware/validation');
const logger = require('../logger');

/**
 * POST /api/chat
 * AI 채팅 엔드포인트
 */
// PIPA 제3조 (최소수집 원칙) — 사용자가 챗에 입력한 민감 PII 는 Anthropic 으로
// 보내지 않고 즉시 차단. 챗봇 답변에 주민번호·계좌·카드 정보가 필요한 경우는 없음.
const PII_PATTERNS = {
  ssn:        { re: /\b\d{6}\s*-?\s*[1-4]\d{6}\b/g,                label: '주민등록번호' },
  phone:      { re: /\b01[016789]\s*-?\s*\d{3,4}\s*-?\s*\d{4}\b/g, label: '휴대전화번호' },
  bankAcct:   { re: /\b\d{3,6}\s*-?\s*\d{2,6}\s*-?\s*\d{2,7}\b/g,  label: '계좌번호' },
  cardNumber: { re: /\b\d{4}\s*-?\s*\d{4}\s*-?\s*\d{4}\s*-?\s*\d{4}\b/g, label: '카드번호' },
  passport:   { re: /\b[A-Z]\d{8}\b/g,                              label: '여권번호' },
};
function detectPII(text) {
  const t = String(text || '');
  const found = [];
  for (const [k, { re, label }] of Object.entries(PII_PATTERNS)) {
    if (re.test(t)) found.push(label);
    re.lastIndex = 0;
  }
  return found;
}

// PIPA 최소수집 — AI(Anthropic)로 전송되는 "모든 클라이언트 제공 텍스트"를 PII 검사 대상으로 수집.
//   최신 message 뿐 아니라 context.history[*].content 와 context.session 의 사용자 자유입력 가능 문자열 필드까지
//   포함해야 history/session 경유 PII 우회 전송을 차단할 수 있다.
//   숫자 필드(예산/자기자본/가격/점수/LTV/면적 등)는 수집 제외 — 정상 숫자가 계좌/번호 패턴으로 오탐되는 것 방지.
//   필드 구분자는 비-공백 ' | ' — \s* 패턴이 필드 경계를 넘어 숫자열을 잇는 오탐 차단.
function collectClientPIIText(message, context) {
  const parts = [String(message || '')];
  const hist = context && context.history;
  if (Array.isArray(hist)) {
    for (const h of hist) { if (h && typeof h.content === 'string') parts.push(h.content); }
  }
  const s = context && context.session;
  if (s) {
    if (s.userProfile) {
      for (const k of ['region', 'houseStatus', 'workplaceArea']) {
        if (typeof s.userProfile[k] === 'string') parts.push(s.userProfile[k]);
      }
    }
    if (s.focusProperty) {
      for (const k of ['aptName', 'area']) {
        if (typeof s.focusProperty[k] === 'string') parts.push(s.focusProperty[k]);
      }
    }
    if (Array.isArray(s.recommendedProperties)) {
      for (const p of s.recommendedProperties) {
        if (!p) continue;
        for (const k of ['aptName', 'area']) {
          if (typeof p[k] === 'string') parts.push(p[k]);
        }
      }
    }
  }
  return parts.join(' | ');
}

router.post('/', validateChatInput, async (req, res) => {
  const { message, context } = req.body;

  // PII 차단 — Anthropic 으로 보내기 전 즉시 reject (message + context.history + context.session 문자열 전수 검사)
  const piiFound = detectPII(collectClientPIIText(message, context));
  if (piiFound.length > 0) {
    logger.warn({ source: 'chat-pii-block', scope: 'message+context', userId: req.user?.id || null, types: piiFound },
      '챗 입력(메시지/이력/세션) PII 감지 — 처리 중단');
    return res.status(400).json({
      error: `대화 입력에 개인정보(${piiFound.join(', ')})가 포함되어 있어 처리하지 않았어요. 해당 정보를 제거하고 다시 보내주세요.`,
      code: 'pii_blocked',
      types: piiFound,
    });
  }

  // sanitizeString 이 HTML escape 를 적용해 두므로 분류 전 unescape (렌더 시점 escape 는 프론트 addMsg 몫)
  const _unescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  try {
    const { reply, intent, suggestions } = await routeDataChat(_unescape(message), context);
    // KKKKKKK-19/20: 후속 칩 — 문자열(질문 전송) 또는 {label, view}(탭 이동, 화이트리스트만).
    //   프론트는 textContent + 고정 핸들러 맵으로만 렌더(임의 코드·URL 전달 불가).
    const ALLOWED_VIEWS = new Set(['report', 'calc', 'clause', 'map', 'list']);
    const sug = Array.isArray(suggestions)
      ? suggestions.map(s => {
          if (typeof s === 'string' && s.trim().length >= 2) return s.slice(0, 40);
          if (s && typeof s === 'object' && typeof s.label === 'string' && s.label.trim().length >= 2
              && ALLOWED_VIEWS.has(s.view)) return { label: s.label.slice(0, 40), view: s.view };
          return null;
        }).filter(Boolean).slice(0, 3)
      : [];
    return res.json({ reply, intent, suggestions: sug, source: 'data-router' });
  } catch (err) {
    // 라우터 내부는 데이터 실패를 개별 삼킴 — 여기 도달은 예외적. 정직한 실패 안내(위장 금지).
    logger.error({ err: err.message, userId: req.user?.id || null }, '데이터 도우미 라우터 실패');
    require('../utils/captureError').captureRouteError(err, 'chat');
    return res.status(503).json({
      code: 'router_error',
      error: '도우미 응답 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.',
      retryAfterSec: 30,
    });
  }
});

module.exports = router;
