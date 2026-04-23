/**
 * IP 기반 일일 사용 한도 미들웨어 (Upstash Redis 우선 + node-cache fallback)
 *
 * Vercel Serverless 에선 함수 인스턴스가 여러 개 병렬로 뜨므로
 * in-memory 카운트는 쿼터 우회 가능 → Upstash Redis 로 중앙 집중.
 * Redis 미설정 시엔 in-memory 로 동작 (dev 편의) + 기동 시 warn.
 *
 * 키 포맷: `dl:{scope}:{yyyymmdd}:{ip}` (자정 만료)
 * TTL: 자정까지 초 단위 계산 → 하루 단위 리셋
 *
 * 사용:
 *   app.use('/api/properties',
 *     dailyLimit({ limit: 5, scope: 'search' }), router);
 */
const cache = require('../cache'); // in-memory fallback
const { getRedis } = require('../redis');
const logger = require('../logger');
const { maskIp } = require('../logger');

function getClientIp(req) {
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

/**
 * Redis atomic INCR + EXPIRE — 경합 안전
 * 실패 시(네트워크/장애) in-memory fallback 으로 degrade (가용성 우선)
 */
async function incrementUsage(key, ttl) {
  const redis = getRedis();
  if (!redis) {
    // fallback: in-memory
    const used = cache.get(key) || 0;
    cache.set(key, used + 1, ttl);
    return { used: used + 1, source: 'memory' };
  }
  try {
    // pipeline 으로 1RTT — upstash REST 는 auto-pipelining 지원
    const [count] = await Promise.all([
      redis.incr(key),
    ]);
    // 최초 생성 시에만 EXPIRE 세팅 (이미 있으면 NX 로 덮어쓰지 않음)
    if (count === 1) await redis.expire(key, ttl);
    return { used: count, source: 'redis' };
  } catch (e) {
    // Redis 장애 시 in-memory 로 degrade (가용성 > 정확성) — 하지만 로그 남김
    logger.warn({ err: e, key }, 'Redis incr 실패 — in-memory fallback');
    const used = cache.get(key) || 0;
    cache.set(key, used + 1, ttl);
    return { used: used + 1, source: 'memory-degraded' };
  }
}

async function readUsage(key) {
  const redis = getRedis();
  if (!redis) return cache.get(key) || 0;
  try {
    const v = await redis.get(key);
    return Number(v) || 0;
  } catch (e) {
    return cache.get(key) || 0;
  }
}

function dailyLimit({ limit = 5, scope = 'global' } = {}) {
  return async function (req, res, next) {
    // 헬스체크/조회성 GET 등은 카운팅하지 않음
    if (req.method === 'GET' && scope !== 'chat') return next();

    const ip = getClientIp(req);
    const key = `dl:${scope}:${todayKey()}:${ip}`;
    const ttl = secondsUntilMidnight();

    // 1) 선 조회 — limit 초과 여부 판단
    const currentUsed = await readUsage(key);
    if (currentUsed >= limit) {
      logger.info({
        scope, limit, used: currentUsed, ip: maskIp(ip),
      }, 'daily limit exceeded');
      return res.status(429).json({
        error: 'DAILY_LIMIT_EXCEEDED',
        message: `오늘의 무료 ${scope === 'chat' ? 'AI 채팅' : '검색'} 한도(${limit}회)를 모두 사용했어요. 내일 다시 이용해주세요.`,
        used: currentUsed,
        limit,
        resetIn: ttl,
      });
    }

    // 2) 증가 — atomic
    const { used, source } = await incrementUsage(key, ttl);

    res.setHeader('X-Daily-Limit', String(limit));
    res.setHeader('X-Daily-Remaining', String(Math.max(0, limit - used)));
    res.setHeader('X-Daily-Store', source);
    next();
  };
}

async function getUsage(req, scope = 'search') {
  const ip = getClientIp(req);
  const key = `dl:${scope}:${todayKey()}:${ip}`;
  return readUsage(key);
}

module.exports = { dailyLimit, getUsage, getClientIp };
