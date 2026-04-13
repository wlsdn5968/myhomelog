/**
 * 입력 검증 미들웨어
 * 모든 사용자 입력은 여기서 sanitize
 */

// 허용 문자 목록 기반 sanitize (XSS 방지)
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, maxLen)
    .replace(/[<>'"]/g, '') // 기본 XSS 제거
    .trim();
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

// 매물 검색 검증
function validatePropertySearch(req, res, next) {
  const { query, minPrice, maxPrice, region } = req.query;

  if (query) req.query.query = sanitizeString(query, 100);

  req.query.minPrice = sanitizeNumber(minPrice, 0, 999);
  req.query.maxPrice = sanitizeNumber(maxPrice, 0, 999);

  const allowedRegions = [
    '서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산', '세종',
    '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'
  ];
  if (region && !allowedRegions.includes(region)) {
    return res.status(400).json({ error: '유효하지 않은 지역입니다.' });
  }
  next();
}

module.exports = { validateChatInput, validateTransactionQuery, validatePropertySearch };
