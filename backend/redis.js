/**
 * Upstash Redis 클라이언트 (REST 기반 — Vercel Serverless 최적)
 *
 * 설정: Vercel/로컬 env 에 둘 다 필요
 *   UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN=AXXX...
 *
 * 미설정 시: null 반환 → 호출자는 fallback(in-memory) 으로 동작해야 함.
 * 이 설계로 dev 머신에서 Upstash 없이도 개발 가능.
 *
 * ⚠️ 장기적으로: 모든 캐시(서비스 응답) 도 Redis 로 통합 예정. (Phase 1 과제)
 *    지금은 rate-limit/dailyLimit 만 Redis 로 — multi-instance 에서 깨지면 쿼터 우회 취약점.
 */
const { Redis } = require('@upstash/redis');
const logger = require('./logger');

let client = null;
let warnedMissing = false;

function getRedis() {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (!warnedMissing) {
      logger.warn({
        hasUrl: !!url, hasToken: !!token,
      }, 'Upstash Redis env 미설정 — rate-limit/dailyLimit 가 in-memory fallback 으로 동작 (multi-instance 에선 부정확)');
      warnedMissing = true;
    }
    return null;
  }

  try {
    client = new Redis({
      url, token,
      // Upstash 자동 재시도 (네트워크 블립)
      retry: { retries: 2, backoff: (n) => Math.min(100 * 2 ** n, 1000) },
      // Vercel edge/node 양쪽 모두 fetch 사용
      automaticDeserialization: true,
    });
    logger.info({ url: url.replace(/https?:\/\//, '').slice(0, 20) + '...' }, 'Upstash Redis 연결 초기화');
    return client;
  } catch (e) {
    logger.error({ err: e }, 'Upstash Redis 초기화 실패');
    return null;
  }
}

module.exports = { getRedis };
