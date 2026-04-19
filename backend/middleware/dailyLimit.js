/**
 * IP 기반 일일 사용 한도 미들웨어
 * - 비로그인 사용자에게 무료 체험 한도 제공 (BYOK 안티패턴 제거 대신)
 * - cache(node-cache)에 일자별 카운트 저장 (자정 만료)
 *
 * 사용 예: app.use('/api/properties', dailyLimit({ limit: 5, scope: 'search' }), router)
 *
 * 주의: 운영 환경에서 다중 인스턴스라면 Redis로 교체 필요.
 *      Vercel 서버리스에선 인스턴스 간 카운트가 분산될 수 있음 (P1에서 Supabase로 정착 예정).
 */
const cache = require('../cache');

function getClientIp(req) {
  // trust proxy 가 켜진 환경 가정
  return (
    req.ip ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function secondsUntilMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(60, Math.floor((next - now) / 1000));
}

function dailyLimit({ limit = 5, scope = 'global' } = {}) {
  return function (req, res, next) {
    // 헬스체크/조회성 GET 등은 카운팅하지 않음
    if (req.method === 'GET' && scope !== 'chat') return next();

    const ip = getClientIp(req);
    const key = `dl:${scope}:${todayKey()}:${ip}`;
    const used = cache.get(key) || 0;

    if (used >= limit) {
      return res.status(429).json({
        error: 'DAILY_LIMIT_EXCEEDED',
        message: `오늘의 무료 ${scope === 'chat' ? 'AI 채팅' : '검색'} 한도(${limit}회)를 모두 사용했어요. 내일 다시 이용해주세요.`,
        used,
        limit,
        resetIn: secondsUntilMidnight(),
      });
    }

    cache.set(key, used + 1, secondsUntilMidnight());
    res.setHeader('X-Daily-Limit', String(limit));
    res.setHeader('X-Daily-Remaining', String(Math.max(0, limit - used - 1)));
    next();
  };
}

function getUsage(req, scope = 'search') {
  const ip = getClientIp(req);
  const key = `dl:${scope}:${todayKey()}:${ip}`;
  return cache.get(key) || 0;
}

module.exports = { dailyLimit, getUsage, getClientIp };
