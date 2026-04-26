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

/**
 * 식별자 결정 — 로그인 사용자는 userId, 비로그인은 IP
 *
 * 이유:
 *   - IP 기반은 NAT/회사망/모바일 캐리어 IP 공유로 다수 사용자에게 누명을 씌움
 *   - 로그인 사용자는 user.id 가 안정 PK 라 더 공정·정확
 *   - 비로그인은 IP 외엔 안정 식별자 없음 → 기존 동작 유지
 */
function getLimitIdentity(req) {
  if (req.user?.id) return { kind: 'u', value: String(req.user.id) };
  return { kind: 'i', value: getClientIp(req) };
}

// P1 (Phase 2 8-2 2026-04-25): 로그인 사용자 보너스 한도
// Phase 3 (2026-04-25): Pro/Team 플랜 별 한도 분기 — 결제 가치 보장.
//   비로그인: limit (예: 5)
//   로그인 free: limit + loggedInBonus (예: 15)
//   로그인 pro:  planLimits.dailyChat / dailySearch (예: 100/50)
//   로그인 team: planLimits (예: 300/150)
const { getActivePlan, getLimitsForPlan } = require('../services/planService');

function dailyLimit({ limit = 5, scope = 'global', loggedInBonus = 0 } = {}) {
  return async function (req, res, next) {
    if (req.method === 'GET' && scope !== 'chat') return next();

    const id = getLimitIdentity(req);

    // Phase 3: Pro/Team 플랜 한도 우선 적용. Free 는 기존 base+bonus.
    let effectiveLimit = req.user?.id ? (limit + (loggedInBonus || 0)) : limit;
    let plan = 'free';
    if (req.user?.id) {
      plan = await getActivePlan(req.user.id);
      if (plan !== 'free') {
        const planLimits = getLimitsForPlan(plan);
        const planScopeKey = scope === 'chat' ? 'dailyChat' : 'dailySearch';
        if (planLimits[planScopeKey]) effectiveLimit = planLimits[planScopeKey];
      }
    }

    // Phase 5+ (2026-04-26): 관리자 무제한 — 한도 체크 자체 skip + 사용량 카운트도 안 올림
    if (plan === 'admin') {
      res.setHeader('X-Daily-Limit', 'unlimited');
      res.setHeader('X-Daily-Remaining', 'unlimited');
      res.setHeader('X-Plan', 'admin');
      return next();
    }

    const key = `dl:${scope}:${todayKey()}:${id.kind}:${id.value}`;
    const ttl = secondsUntilMidnight();

    const currentUsed = await readUsage(key);
    if (currentUsed >= effectiveLimit) {
      logger.info({
        scope, limit: effectiveLimit, used: currentUsed, plan,
        identity: id.kind === 'u' ? `u:${id.value}` : `i:${maskIp(id.value)}`,
      }, 'daily limit exceeded');
      const isAnonymous = !req.user?.id;
      const isPaid = plan === 'pro' || plan === 'team';
      return res.status(429).json({
        error: 'DAILY_LIMIT_EXCEEDED',
        message: isPaid
          ? `오늘 ${plan === 'pro' ? '프로' : '팀'} 플랜 ${scope === 'chat' ? 'AI 채팅' : '단지 검색'} 한도(${effectiveLimit}회)를 모두 사용했어요. 내일 다시 이용해주세요.`
          : isAnonymous && loggedInBonus > 0
          ? `오늘 무료 ${scope === 'chat' ? 'AI 채팅' : '단지 검색'} ${effectiveLimit}회를 모두 사용했어요. 로그인하면 ${loggedInBonus}회를 추가로 받을 수 있어요.`
          : `오늘의 무료 ${scope === 'chat' ? 'AI 채팅' : '단지 검색'} 한도(${effectiveLimit}회)를 모두 사용했어요. 내일 다시 이용해주세요.`,
        used: currentUsed,
        limit: effectiveLimit,
        plan,
        resetIn: ttl,
        canBoostByLogin: isAnonymous && loggedInBonus > 0,
        bonusOnLogin: loggedInBonus || 0,
      });
    }

    const { used, source } = await incrementUsage(key, ttl);
    res.setHeader('X-Daily-Limit', String(effectiveLimit));
    res.setHeader('X-Daily-Remaining', String(Math.max(0, effectiveLimit - used)));
    res.setHeader('X-Daily-Store', source);
    res.setHeader('X-Plan', plan);
    next();
  };
}

async function getUsage(req, scope = 'search') {
  const id = getLimitIdentity(req);
  const key = `dl:${scope}:${todayKey()}:${id.kind}:${id.value}`;
  return readUsage(key);
}

module.exports = { dailyLimit, getUsage, getClientIp, getLimitIdentity };
