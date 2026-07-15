/**
 * Redis read-through 캐시 — REDIS-CACHE-2026-07-14 (Sprint KKKKK)
 *
 * 배경:
 *   AI 가 만든 값비싼 응답(보고서·뉴스 3줄 시황·특약)이 node-cache(인스턴스 로컬)에만 저장 —
 *   Vercel 서버리스가 콜드스타트/스케일아웃으로 인스턴스를 갈아끼울 때마다 캐시 미스 → 동일 입력에
 *   AI 를 다시 호출(비용). rate-limit/dailyLimit/globalAiBudget 은 이미 같은 Upstash Redis 로 인스턴스 간
 *   정합을 맞추고 있음(redis.js) — 응답 캐시도 동일 인프라 재사용.
 *
 * 설계 (fail-open):
 *   - cache.js(node-cache, 동기)는 전 백엔드 40+ 호출부가 동기 인터페이스로 사용 → 전면 교체 불가.
 *     비싼 async 경로(report/news/clause)에서만 로컬 미스 시 Redis 2차 조회(read-through).
 *   - Redis 미설정(getRedis null)·오류 시 undefined/무시 — 기존 로컬 캐시 동작 그대로(회귀 0).
 *   - Upstash automaticDeserialization: set(객체)→JSON 직렬화, get→자동 파싱.
 */
const { getRedis } = require('../redis');
const logger = require('../logger');

const PREFIX = 'rc:'; // rate-limit 등 기존 키와 네임스페이스 분리

/** @returns 캐시 값 또는 undefined(미스/미설정/오류) */
async function rget(key) {
  try {
    const r = getRedis();
    if (!r) return undefined;
    const v = await r.get(PREFIX + key);
    return v === null || v === undefined ? undefined : v;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'redisCache get 실패 (무시 — 로컬 캐시만 사용)');
    return undefined;
  }
}

/** fire-and-forget 가능 — 실패해도 기능 무영향 */
async function rset(key, value, ttlSec) {
  try {
    const r = getRedis();
    if (!r) return;
    await r.set(PREFIX + key, value, { ex: Math.max(60, parseInt(ttlSec) || 60) });
  } catch (e) {
    logger.warn({ err: e.message, key }, 'redisCache set 실패 (무시)');
  }
}

module.exports = { rget, rset };
