/**
 * 입력 검증 미들웨어
 * 모든 사용자 입력은 여기서 sanitize
 *
 * 설계:
 *   - LLM 프롬프트·DB 저장 전 sanitize 로는 "HTML escape" 가 맞다.
 *     특수문자 제거(과거 방식)는 "3.5 <= 금리" 같은 수식/비교 질문을 훼손.
 *   - HTML 렌더링 시점(프론트) 에서 다시 한번 escape (defense-in-depth).
 *   - 유니코드 정규화(NFKC) + 제어문자 제거 + 길이 바이트 기준 제한.
 */

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  // 1) Unicode 정규화 (전각→반각 등 homograph 공격 방어)
  let s = str.normalize('NFKC');
  // 2) 제어문자 제거 (\x00-\x1F, \x7F)
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  // 3) 길이 제한 (문자 단위)
  s = s.slice(0, maxLen);
  // 4) HTML escape — 제거 대신 안전한 치환
  s = s.replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
  return s.trim();
}

function sanitizeNumber(val, min, max) {
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

// 채팅 입력 검증
function validateChatInput(req, res, next) {
  const { message, context } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '메시지가 필요합니다.' });
  }
  req.body.message = sanitizeString(message, 1000);
  if (req.body.message.length < 1) {
    return res.status(400).json({ error: '메시지가 너무 짧습니다.' });
  }
  // history는 배열이어야 하고 최대 20턴
  if (context?.history && Array.isArray(context.history)) {
    req.body.context.history = context.history.slice(-20).map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: sanitizeString(h.content, 2000),
    }));
  }
  next();
}

// 실거래가 조회 검증
function validateTransactionQuery(req, res, next) {
  const { lawdCd, dealYm, aptName } = req.query;

  // 법정동코드: 5자리 숫자
  if (lawdCd && !/^\d{5}$/.test(lawdCd)) {
    return res.status(400).json({ error: '유효하지 않은 법정동코드입니다.' });
  }
  // 거래년월: YYYYMM
  if (dealYm && !/^\d{6}$/.test(dealYm)) {
    return res.status(400).json({ error: '거래년월 형식: YYYYMM' });
  }
  if (aptName) {
    req.query.aptName = sanitizeString(aptName, 50);
  }
  next();
}

// 단지 검색 검증 — POST body 기반 (일부 엔드포인트는 query string)
function validatePropertySearch(req, res, next) {
  // POST /recommend 은 body, GET 엔드포인트는 query
  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const { query, minPrice, maxPrice, region } = src;

  if (query) src.query = sanitizeString(query, 100);
  if (minPrice !== undefined) src.minPrice = sanitizeNumber(minPrice, 0, 999);
  if (maxPrice !== undefined) src.maxPrice = sanitizeNumber(maxPrice, 0, 999);

  // 광역 키워드 화이트리스트 — "서울 강북구" 같은 복합 입력도 허용
  const allowedWide = ['서울','경기','인천','부산','대구','광주','대전','울산','세종',
    '강원','충북','충남','전북','전남','경북','경남','제주'];
  if (region) {
    const normalized = String(region).normalize('NFC').trim();
    src.region = normalized;
    const passesWide = allowedWide.some(w => normalized.includes(w));
    if (!passesWide) {
      return res.status(400).json({ error: '유효하지 않은 지역입니다.', region: normalized });
    }
  }
  next();
}

module.exports = { validateChatInput, validateTransactionQuery, validatePropertySearch };
