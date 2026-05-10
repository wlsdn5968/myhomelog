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
  // MOB-AUDIT-2026-05-03 (revised): 부정 표현은 "추천" 뒤에 다양한 형태로 옴 → 함수에서 추가 부정 검증 (filterAdviceOutput 내부)
  //   regex 는 1차 매칭만, 부정 키워드 후속 30자 검사로 false-positive 차단 (단언 vs 부정 정확화)
  { name: 'buy_recommend',   re: /(?:매수|구매)[이를을]?\s*추천(드립|합)?/ },
  // 매도 권유 (단언)
  { name: 'sell_imperative', re: /파세요|파시면|매도하세요|처분하세요|팔아야\s*합니다/ },
  { name: 'sell_recommend',  re: /(?:매도)[이를을]?\s*추천(드립|합)?|처분[이를을]?\s*권/ },
  // 가격 단언 (확정적 미래) — MOB-AUDIT: 과거·인용 lookbehind 추가 (예: "오를 것이라는 기대" 통과)
  // P1-7 (2026-05-04): "이라"·"이라고 본다"·"이라며" 패턴도 통과 — 인용 표현 false-positive 차단
  { name: 'price_up',   re: /(?<!기대|예상|전망|이라는|이라고|이라며|이라|이라고\s본|던|었|였)(?:오를|상승할|올라갈)\s*(것|거)(입니다|이에요|예요|에요)/ },
  { name: 'price_down', re: /(?<!기대|예상|전망|이라는|이라고|이라며|이라|이라고\s본|던|었|였)(?:떨어질|하락할|내릴)\s*(것|거)(입니다|이에요|예요|에요)/ },
  { name: 'price_certain_up',   re: /(반드시|확실히|틀림없이|당연히)\s*(오릅|오를|상승|올라)/ },
  { name: 'price_certain_down', re: /(반드시|확실히|틀림없이|당연히)\s*(떨어|하락|내려)/ },
  // 절대 단언
  { name: 'absolute_certain', re: /무조건\s*(좋은|좋습니다|좋아요|사야|매수|상승|오릅)/ },
  { name: 'guarantee', re: /보장(드립니다|해\s*드립|합니다)/ },
];

// MOB-2 (2026-05-03): 사용자 안내 fallback 더 친화·actionable.
//   기존: "답변을 보류했어요" → AI 가 잘못한 인상 + 너무 길어 부자연스러움.
//   변경: 정책 안내 + 즉시 다시 시도할 수 있는 예시 3개. 사용자 중단 최소화.
const FALLBACK_REPLY =
  '✋ 정보 위주로 다시 질문해주세요.\n\n' +
  '본 서비스는 정책상 **매수·매도 권유**나 **가격 예측 단언**은 답변하지 않아요.\n\n' +
  '이렇게 바꿔서 질문해보세요:\n' +
  '- "RR이 무슨 뜻인가요?" (용어 설명)\n' +
  '- "마포 84㎡ 최근 6개월 실거래 추이" (사실 데이터)\n' +
  '- "9억 매수 시 LTV·DSR 한도" (규제 계산)\n\n' +
  '※ 모든 의사결정 책임은 본인에게 있습니다.';

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
// MOB-AUDIT-2026-05-03: 매수/매도 추천 매칭 시 뒤 30자 안에 부정 키워드 있으면 통과 (false-positive 차단)
//   예) "매수를 추천드리지 않습니다" / "매수 추천이 어렵습니다" / "매수를 추천하지 못합니다" → PASS
const _NEGATION_RE = /않|못|어렵|곤란|불가|마세요|마십시오|아닙|아닌|없다|없습|없어/;
function _hasNegationAfter(txt, fromIdx, span = 30) {
  return _NEGATION_RE.test(txt.slice(fromIdx, fromIdx + span));
}

function filterAdviceOutput(reply) {
  if (!reply || typeof reply !== 'string') {
    return { text: reply, filtered: false, matched: [] };
  }
  const matched = [];
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    const m = re.exec(reply);
    if (!m) continue;
    // 매수/매도/처분 추천 매칭 시 뒤 30자 부정 검증 — 단언 vs 부정 정확화
    if (name === 'buy_recommend' || name === 'sell_recommend') {
      if (_hasNegationAfter(reply, m.index + m[0].length)) continue;
    }
    matched.push(name);
  }
  if (matched.length > 0) {
    return { text: FALLBACK_REPLY, filtered: true, matched };
  }
  return { text: reply, filtered: false, matched: [] };
}

// FILTER-UNIFY-2026-05-10 (M-3 β): clause/report 처럼 JSON 다단계 응답에 deep filter.
//
// 설계:
//   - chat.js 는 plain text 1문장 → filterAdviceOutput 매칭 시 응답 통째 fallback 으로 교체.
//   - clause/report 는 JSON (essential[].content / apartments[].pros 등) → 통째 fallback 으로 바꾸면
//     구조 깨지고 사용자 경험도 망가짐.
//   - β안: **사용자 가시 자유 텍스트 필드만 화이트리스트** 로 검사 → 매칭 시 해당 필드 string 만
//     짧은 안내 텍스트 (FILTERED_FIELD_REPLACEMENT) 로 교체. 구조 보존.
//   - enum/숫자/백엔드 주입 fact 등은 검사 X — false-positive 방지.
//
// path 표현 (배열 index 무시):
//   - 'caution', 'summary'                    — root 직속 string
//   - 'coreMessages', 'tips'                  — root 직속 array-of-string (path = 부모 key)
//   - 'essential.content'                     — array-of-object 의 prop (index 무시)
//   - 'apartments.pros' 등                    — 동일
//
// 반환:
//   { filtered: boolean, matched: string[] } — 검사된 패턴 이름 누적 (logger 용)
//   원본 obj 는 in-place 변형 (호출자가 검증된 응답을 그대로 res.json 으로 내보낼 수 있게).
const FILTERED_FIELD_REPLACEMENT =
  '※ 정책상 단언적 표현이 감지되어 본 항목은 표시하지 않습니다. 다른 항목/요약을 참고해주세요.';

function filterAdviceOutputDeep(obj, fieldWhitelist) {
  const matched = new Set();
  let filtered = false;
  if (!obj || typeof obj !== 'object' || !(fieldWhitelist instanceof Set)) {
    return { filtered: false, matched: [] };
  }

  function _check(str) {
    const result = filterAdviceOutput(str);
    if (result.filtered) {
      filtered = true;
      for (const m of result.matched) matched.add(m);
      return FILTERED_FIELD_REPLACEMENT; // 짧은 안내로 교체 — fallback 전체보다 가독성 ↑
    }
    return null;
  }

  function _visit(node, pathStr) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          // array-of-string — path 는 부모 key (e.g. 'coreMessages')
          if (fieldWhitelist.has(pathStr)) {
            const replaced = _check(item);
            if (replaced !== null) node[i] = replaced;
          }
        } else if (item && typeof item === 'object') {
          // array-of-object — path 변화 없음 (index 무시)
          _visit(item, pathStr);
        }
      }
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        const next = pathStr ? pathStr + '.' + k : k;
        if (typeof v === 'string') {
          if (fieldWhitelist.has(next)) {
            const replaced = _check(v);
            if (replaced !== null) node[k] = replaced;
          }
        } else if (v && typeof v === 'object') {
          _visit(v, next);
        }
      }
    }
  }
  _visit(obj, '');
  return { filtered, matched: Array.from(matched) };
}

// clause/report 가 import 해서 그대로 사용 — 추측 금지, 실제 응답 구조 기반.
//   clause 응답 schema (routes/clause.js prompt line 64~83 참고):
//     essential[].title/content/reason · recommended[].title/content/reason · caution · summary
//     · risks[].title/scenario/countermeasure (level=enum / probability=수치 / overallRisk=enum 제외)
const CLAUSE_FILTER_FIELDS = new Set([
  'essential.title', 'essential.content', 'essential.reason',
  'recommended.title', 'recommended.content', 'recommended.reason',
  'caution', 'summary',
  'risks.title', 'risks.scenario', 'risks.countermeasure',
]);
//   report 응답 schema (routes/report.js prompt line 63~85 + line 182~187 backend 주입 참고):
//     coreMessages[] · checklist[].text · apartments[].{ratio,location,pros,cons,priceFit,recommendation,matchReason}
//     · longTermView · tips[]
//   제외: apartments[].name (단지명), rank·areaSqm·areaPyeong·buildYear·households (숫자)
//        checklist[].stars (숫자), apartments[].objectiveFacts/matchScore (backend 주입 fact)
const REPORT_FILTER_FIELDS = new Set([
  'coreMessages',
  'checklist.text',
  'apartments.ratio', 'apartments.location',
  'apartments.pros', 'apartments.cons',
  'apartments.priceFit', 'apartments.recommendation', 'apartments.matchReason',
  'longTermView',
  'tips',
]);

module.exports = {
  filterAdviceOutput,
  filterAdviceOutputDeep,
  FORBIDDEN_PATTERNS,
  FALLBACK_REPLY,
  FILTERED_FIELD_REPLACEMENT,
  CLAUSE_FILTER_FIELDS,
  REPORT_FILTER_FIELDS,
};
