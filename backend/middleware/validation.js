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
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 content-type 이 안 맞거나
  //   본문이 없으면 req.body 가 undefined (v4 는 {}) — 가드 없으면 400 대신 500.
  const { message, context } = req.body || {};
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
      // 컨텍스트 무결성: user/assistant 만 허용, 그 외(system 등)는 user 로 강등 — 절대 system/assistant 권위 부여 X
      role: h.role === 'assistant' ? 'assistant' : 'user',
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
  // EXPRESS5-QUERY-GETTER-2026-09-06 (Plan 073): Express 5부터 req.query 는 접근할 때마다
  //   재파싱되는 getter — 여기서 req.query.aptName 에 정제값을 대입해도 다음 접근(소비자)에서는
  //   원문(예: '<script>')으로 되돌아간다(실행 재현 확인). req.sanitized 에 실어 소비자가 이걸
  //   읽게 한다. 소비자: routes/transactions.js.
  if (aptName) {
    req.sanitized = req.sanitized || {};
    req.sanitized.aptName = sanitizeString(aptName, 50);
  }
  next();
}

// 단지 검색 검증 — POST body 기반 (일부 엔드포인트는 query string)
function validatePropertySearch(req, res, next) {
  // POST /recommend 은 body, GET 엔드포인트는 query
  const isPost = req.method === 'POST';
  const src = isPost ? (req.body || {}) : (req.query || {});
  const { query, minPrice, maxPrice, region } = src;

  // EXPRESS5-QUERY-GETTER-2026-09-06 (Plan 073): req.body 는 body-parser 가 만든 고정 객체라
  //   직접 mutate 해도 안전(POST 는 기존 그대로). req.query 는 Express 5 부터 접근마다 재파싱되는
  //   getter라 GET 분기에서 src(=req.query)에 쓴 값은 다음 접근에서 원문으로 되돌아간다 —
  //   GET 은 req.sanitized 로 우회.
  const out = isPost ? src : (req.sanitized = req.sanitized || {});

  if (query) out.query = sanitizeString(query, 100);
  if (minPrice !== undefined) out.minPrice = sanitizeNumber(minPrice, 0, 999);
  if (maxPrice !== undefined) out.maxPrice = sanitizeNumber(maxPrice, 0, 999);

  // 광역 키워드 화이트리스트 — "서울 강북구" 같은 복합 입력도 허용
  // METRO-SUB-2026-07-17 (Sprint UUUUU): 프론트 REGION_SUB['지방'] 은 "지방 해운대" 형태로 보내 시/도명이
  //   없어 통과 실패(해운대·수영·수성·유성). 이미 적재된 광역시 구라 세부 라벨을 화이트리스트에 추가
  //   (광주서구는 '광주' 로 통과). 특정 리터럴만 추가 — 인젝션 위험 없음.
  // REGION-SWAP-2026-08-10: '청주' 추가(프론트가 "지방 청주" 형태로 보냄).
  //   '광주'는 유지 — 광주광역시는 커버리지에서 빠졌지만 **경기 광주시(41610)** 가 남아 있어
  //   "광주시" 단독 입력을 막으면 안 된다.
  const allowedWide = ['서울','경기','인천','부산','대구','광주','대전','울산','세종',
    '강원','충북','충남','전북','전남','경북','경남','제주',
    '해운대','수영','수성','유성','청주'];
  if (region) {
    const normalized = String(region).normalize('NFC').trim();
    out.region = normalized;
    const passesWide = allowedWide.some(w => normalized.includes(w));
    if (!passesWide) {
      return res.status(400).json({ error: '유효하지 않은 지역입니다.', region: normalized });
    }
  }
  next();
}

module.exports = { validateChatInput, validateTransactionQuery, validatePropertySearch };
