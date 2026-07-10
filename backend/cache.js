const NodeCache = require('node-cache');

// CACHE-FULL-FIX-2026-07-10 (Sprint BBBB, Sentry NODE-3 ECACHEFULL):
//   [근본원인] 전 백엔드(40+ 호출부)가 이 단일 인스턴스를 공유하는데 maxKeys 500 도달 시
//   node-cache 의 set() 이 ECACHEFULL 을 throw — 장수 TTL 키(KAPT 30일·Kakao 7일·geocode 1일)가
//   warm 인스턴스에 누적되면 이후 모든 set 이 던져져 "캐시 최적화 실패"가 "기능 장애"로 번졌다.
//   실측: /api/news 503(데이터 수신 성공 후 set 에서 사망)·/api/subscription 502·
//   geocache backfill 600/600 전량 실패가 전부 이 한 줄이 원인.
//   [원칙] 캐시는 최적화일 뿐 — set 실패는 절대 기능을 죽이면 안 된다.
//   [Fix] ① maxKeys 500→2000(env CACHE_MAX_KEYS 오버라이드) ② set 안전 래핑:
//   ECACHEFULL 시 가장 먼저 조회되는 키 10% 퇴거 후 1회 재시도, 그래도 실패면 false 반환(무해).
const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  checkperiod: 600,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS || '2000'),
});

const _origSet = cache.set.bind(cache);
cache.set = function safeSet(key, value, ttl) {
  const call = () => (ttl === undefined ? _origSet(key, value) : _origSet(key, value, ttl));
  try {
    return call();
  } catch (e) {
    const isFull = e && (e.errorcode === 'ECACHEFULL' || e.name === 'ECACHEFULL' || /ECACHEFULL|max keys/i.test(e.message || ''));
    if (isFull) {
      try {
        const keys = cache.keys();
        cache.del(keys.slice(0, Math.max(1, Math.floor(keys.length / 10))));
        return call();
      } catch (_) { /* fall through */ }
    }
    return false; // 캐시 실패 ≠ 기능 실패
  }
};

module.exports = cache;
