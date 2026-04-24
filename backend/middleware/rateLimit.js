/**
 * 분산 Rate-Limit 미들웨어 — Upstash Redis 기반 sliding window
 *
 * Vercel Serverless 에선 함수 인스턴스가 병렬로 뜨므로
 * express-rate-limit 의 in-memory store 는 multi-instance 에서 우회 가능.
 * → @upstash/ratelimit 의 중앙 Redis 카운터로 교체.
 *
 * Redis 미설정 시 in-memory express-rate-limit 로 자동 fallback (dev 편의).
 *
 * ── 장애 정책 (Phase 4.11) ──────────────────────────────────
 * Redis 장애 시 기본은 fail-open (가용성 우선) 이지만 **비용이 걸린 경로** 는
 * fail-closed 로 전환해야 한다. 근거:
 *   - chat/clause (AI) 는 호출당 Anthropic 비용 발생 → Redis 죽으면 무제한 호출 윈도우
 *     → 악성 사용자가 지갑 공격 가능 → fail-closed (안전>가용성).
 *   - general/data 는 비용이 제로이거나 외부 API 쿼터 차원 → 자체 차단 회피.
 *
 * 사용:
 *   makeRateLimiter({ limit: 60, windowSec: 60, scope: 'general', ... })         // fail-open
 *   makeRateLimiter({ limit: 10, windowSec: 60, scope: 'chat', failClosed: true })// fail-closed
 */
const rateLimit = require('express-rate-limit');
const { Ratelimit } = require('@upstash/ratelimit');
const { getRedis } = require('../redis');
const logger = require('../logger');
const { maskIp } = require('../logger');

/**
 * 식별자 — 로그인 사용자는 userId, 비로그인은 IP.
 * NAT/회사망/모바일 캐리어가 IP 를 공유 → 로그인 사용자는 userId 가 공정한 PK.
 */
function getRateLimitIdentity(req) {
  if (req.user?.id) return `u:${req.user.id}`;
  return `i:${req.ip || 'unknown'}`;
}

// chat 등 비용 수반 scope 는 기본 fail-closed 처리 (호출자가 명시해도 강제 덮어씀)
const COST_SENSITIVE_SCOPES = new Set(['chat']);

/**
 * @param {Object} opts
 * @param {number} opts.limit
 * @param {number} opts.windowSec
 * @param {string} opts.scope
 * @param {string} opts.message
 * @param {string} [opts.keySuffix]
 * @param {boolean} [opts.failClosed] — Redis 장애 시 429 반환 (기본 false = fail-open).
 *   scope 가 COST_SENSITIVE_SCOPES 에 속하면 강제로 true.
 */
function makeRateLimiter({ limit, windowSec, scope, message, keySuffix = '', failClosed = false }) {
  const redis = getRedis();
  const effectiveFailClosed = failClosed || COST_SENSITIVE_SCOPES.has(scope);

  // ── Fallback: Redis 없으면 express-rate-limit in-memory ────
  // dev 환경은 fail-closed 강제가 의미 없음 (어차피 단일 프로세스) → 그대로 사용.
  if (!redis) {
    if (process.env.NODE_ENV === 'production' && effectiveFailClosed) {
      logger.error({ scope }, 'Redis 미설정 + fail-closed scope — production 에서 Upstash 설정 필수');
    }
    return rateLimit({
      windowMs: windowSec * 1000,
      max: limit,
      message: { error: message },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `${getRateLimitIdentity(req)}${keySuffix}`,
    });
  }

  // ── 정상: @upstash/ratelimit sliding window ────────────────
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
    prefix: `rl:${scope}`,
    analytics: false,
  });

  return async function upstashRateLimiter(req, res, next) {
    const baseId = getRateLimitIdentity(req);
    const identifier = `${baseId}${keySuffix}`;

    try {
      const { success, limit: lim, remaining, reset } = await rl.limit(identifier);

      res.setHeader('RateLimit-Limit', String(lim));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
      res.setHeader('RateLimit-Reset', String(Math.ceil((reset - Date.now()) / 1000)));

      if (!success) {
        logger.info({
          scope, limit: lim,
          identity: baseId.startsWith('u:') ? baseId : `i:${maskIp(req.ip || 'unknown')}`,
          resetInSec: Math.ceil((reset - Date.now()) / 1000),
        }, 'rate limit exceeded');
        return res.status(429).json({ error: message });
      }

      return next();
    } catch (e) {
      // 장애 정책 분기
      if (effectiveFailClosed) {
        // AI 등 비용 경로 — Redis 장애 시 자원 보호 목적으로 차단.
        // 사용자 경험은 일시적으로 나빠지나, 지갑 공격 창을 막는 것이 우선.
        logger.error({ err: e.message, scope, identity: baseId }, 'Upstash ratelimit 장애 — fail-closed (비용 보호)');
        return res.status(503).json({
          error: '일시적으로 서비스 제한 중입니다. 잠시 후 다시 시도해주세요.',
          code: 'ratelimit_unavailable',
        });
      }
      logger.warn({ err: e.message, scope }, 'Upstash ratelimit 장애 — fail-open');
      return next();
    }
  };
}

module.exports = { makeRateLimiter, getRateLimitIdentity };
