/**
 * 분산 Rate-Limit 미들웨어 — Upstash Redis 기반 sliding window
 *
 * Vercel Serverless 에선 함수 인스턴스가 병렬로 뜨므로
 * express-rate-limit 의 in-memory store 는 multi-instance 에서 우회 가능.
 * → @upstash/ratelimit 의 중앙 Redis 카운터로 교체.
 *
 * Redis 미설정 시 in-memory express-rate-limit 로 자동 fallback (dev 편의).
 * Redis 장애(네트워크 블립) 시 fail-open (가용성 우선, warn 로그) — 공격이 아닌 장애에선
 * 우리 서비스를 스스로 차단하지 않는 쪽이 비즈니스상 더 안전.
 *
 * 사용:
 *   const limiter = makeRateLimiter({ limit: 60, windowSec: 60, scope: 'general', message: '...' });
 *   app.use('/api/', limiter);
 */
const rateLimit = require('express-rate-limit');
const { Ratelimit } = require('@upstash/ratelimit');
const { getRedis } = require('../redis');
const logger = require('../logger');
const { maskIp } = require('../logger');

/**
 * @param {Object} opts
 * @param {number} opts.limit   — 윈도우 내 허용 요청 수
 * @param {number} opts.windowSec — 윈도우 크기(초)
 * @param {string} opts.scope   — 키 prefix 분리 (general/chat/data)
 * @param {string} opts.message — 429 응답 문구
 * @param {string} [opts.keySuffix] — ip 외에 추가 식별자 (예: ':chat')
 */
function makeRateLimiter({ limit, windowSec, scope, message, keySuffix = '' }) {
  const redis = getRedis();

  // ── Fallback: Redis 없으면 express-rate-limit in-memory ────
  if (!redis) {
    return rateLimit({
      windowMs: windowSec * 1000,
      max: limit,
      message: { error: message },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: keySuffix
        ? (req) => `${req.ip}${keySuffix}`
        : undefined,
    });
  }

  // ── 정상: @upstash/ratelimit sliding window ────────────────
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
    prefix: `rl:${scope}`,
    analytics: false, // 필요 시 true (Upstash 분석 대시보드)
  });

  return async function upstashRateLimiter(req, res, next) {
    const ip = req.ip || 'unknown';
    const identifier = `${ip}${keySuffix}`;

    try {
      const { success, limit: lim, remaining, reset } = await rl.limit(identifier);

      // RateLimit-* 표준 헤더 (RFC draft)
      res.setHeader('RateLimit-Limit', String(lim));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
      res.setHeader('RateLimit-Reset', String(Math.ceil((reset - Date.now()) / 1000)));

      if (!success) {
        logger.info({
          scope, limit: lim, ip: maskIp(ip),
          resetInSec: Math.ceil((reset - Date.now()) / 1000),
        }, 'rate limit exceeded');
        return res.status(429).json({ error: message });
      }

      return next();
    } catch (e) {
      // Redis 장애 → fail-open (가용성 우선). 공격이 아닌 단순 장애에서 자체 차단 회피.
      logger.warn({ err: e, scope }, 'Upstash ratelimit 장애 — fail-open');
      return next();
    }
  };
}

module.exports = { makeRateLimiter };
