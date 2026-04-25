/**
 * AI 챗봇 응답 출력 필터 (post-processing safety net)
 *
 * 배경:
 *   - SYS prompt 의 "절대 매수 권유 금지/가격 예측 금지" 규칙은 100% 보장 불가.
 *   - LLM hallucination 또는 prompt injection 우회로 단 한 번이라도 단언 표현이
 *     나가면:
 *       · 자본시장법상 투자자문업 무허가 영업 소지
 *       · 공정거래법상 부당 표시·광고 (확정적 표시) 소지
 *       · 사용자 손실 발생 시 disclaimer 로 방어 안 되는 "중대한 과실"
 *
 * 설계:
 *   - 단언적 매수/매도 권유, 가격 예측 단언, 절대 표현만 차단.
 *   - hedged 표현 ("~가능성이 있다", "~경향이 있다") 은 통과 — SYS prompt 가
 *     자연스럽게 유도하도록.
 *   - 매칭 시 응답을 fallback 메시지로 교체 (재시도 X — 토큰 비용 + 무한루프 방지).
 *   - 로그 기록은 호출자 책임 (audit_log 권장).
 *
 * 한계 (인정):
 *   - 변형 표현 (e.g. "사실수밖에 없죠") 은 못 잡음 → 정기적으로 패턴 보강 필요.
 *   - "오를 거 같아요" (구어체 hedged) 는 통과 — borderline. 향후 보강.
 */

// ── 차단 패턴: 단언적 표현만 (hedged 는 통과) ─────────────
// 각 패턴은 한 번이라도 매칭되면 응답 전체 차단.
const FORBIDDEN_PATTERNS = [
  // 매수 권유 (단언)
  { name: 'buy_imperative',  re: /사세요|사야\s*합니다|사면\s*됩니다|사면\s*돼요|매수하세요|구매하세요|구입하세요/ },
  { name: 'buy_recommend',   re: /매수[이를을]?\s*추천(드립|합)?|구매[이를을]?\s*추천(드립|합)?/ },
  // 매도 권유 (단언)
  { name: 'sell_imperative', re: /파세요|파시면|매도하세요|처분하세요|팔아야\s*합니다/ },
  { name: 'sell_recommend',  re: /매도[이를을]?\s*추천(드립|합)?|처분[이를을]?\s*권/ },
  // 가격 단언 (확정적 미래)
  { name: 'price_up',   re: /(오를|상승할|올라갈)\s*(것|거)(입니다|이에요|예요|에요)/ },
  { name: 'price_down', re: /(떨어질|하락할|내릴)\s*(것|거)(입니다|이에요|예요|에요)/ },
  { name: 'price_certain_up',   re: /(반드시|확실히|틀림없이|당연히)\s*(오릅|오를|상승|올라)/ },
  { name: 'price_certain_down', re: /(반드시|확실히|틀림없이|당연히)\s*(떨어|하락|내려)/ },
  // 절대 단언
  { name: 'absolute_certain', re: /무조건\s*(좋은|좋습니다|좋아요|사야|매수|상승|오릅)/ },
  { name: 'guarantee', re: /보장(드립니다|해\s*드립|합니다)/ },
];

// 사용자 안내용 fallback — 자연스럽고 다음 행동 유도
const FALLBACK_REPLY =
  '죄송해요. 답변에 매수·매도 권유나 가격 예측 단언 표현이 포함될 수 있어, ' +
  '시스템에서 답변을 보류했어요.\n\n' +
  '다시 질문해주시면 **사실 정보 위주**로 답변하겠습니다:\n' +
  '- 과거 N개월 실거래 추이\n' +
  '- 현재 시세 위치 (백분위)\n' +
  '- 전세가율·갭·LTV·DSR 한도\n' +
  '- 규제·세제 정보\n\n' +
  '※ 본 서비스는 매수·매도 추천이 아니며, 모든 의사결정 책임은 본인에게 있습니다.';

/**
 * 응답 텍스트를 검사하여 단언 표현 매칭 시 fallback 으로 교체.
 *
 * @param {string} reply  AI 응답 원문
 * @returns {{
 *   text: string,        // 사용자에게 보낼 최종 텍스트 (원문 또는 fallback)
 *   filtered: boolean,   // 차단 발생 여부
 *   matched: string[],   // 매칭된 패턴 이름 (운영 로그용)
 * }}
 */
function filterAdviceOutput(reply) {
  if (!reply || typeof reply !== 'string') {
    return { text: reply, filtered: false, matched: [] };
  }
  const matched = [];
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(reply)) matched.push(name);
  }
  if (matched.length > 0) {
    return { text: FALLBACK_REPLY, filtered: true, matched };
  }
  return { text: reply, filtered: false, matched: [] };
}

module.exports = { filterAdviceOutput, FORBIDDEN_PATTERNS, FALLBACK_REPLY };
