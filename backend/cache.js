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

// ROWS-NOCLONE-2026-11-14: node-cache 는 기본(useClones)으로 get·set 때마다 값을 깊게 복제한다.
//   거래 목록(행 수천 개)은 꺼낼 때마다 그 비용을 냈다(로컬 실측: 1,000행 get 7.2ms, 6,000행 55.6ms).
//   행이 숫자·문자열뿐인 평평한 객체라면 행마다 얕은 복사({...r})가 깊은 복제와 결과가 같다(1,000행 0.32ms).
//   값을 함수로 감싸 넣으면 라이브러리가 복제하지 않는다(함수는 그대로 돌려준다, 로컬 확인).
//   넣을 때 한 번, 꺼낼 때마다 한 번 얕은 복사를 해 호출자끼리 행 객체를 공유하지 않는다(지금과 같은 격리).
//   ⚠ 원소가 모두 숫자·문자열 필드만 가진 객체 리터럴인 배열에만 쓸 것. 행 안에 객체·배열 값, 원소가 null·원시값, class 인스턴스,
//     배열에 붙인 추가 속성은 얕은 복사로 지켜지지 않는다(2026-11-14 반증 검토 실험). 같은 인스턴스라 del·flushAll·keys 는 그대로 동작하고,
//     getStats().vsize 는 함수 값을 작게 센다(상태 숫자만 영향). mget·take 로 읽으면 함수가 나오니 getRows 로만 읽는다.
const ROWS_BOX = Symbol('rowsBox');
cache.setRows = function setRows(key, rows, ttl) {
  if (!Array.isArray(rows)) return cache.set(key, rows, ttl);
  const stored = rows.map(r => ({ ...r }));
  const box = () => stored.map(r => ({ ...r }));
  box[ROWS_BOX] = true;
  return cache.set(key, box, ttl);
};
cache.getRows = function getRows(key) {
  const v = cache.get(key);
  return (typeof v === 'function' && v[ROWS_BOX]) ? v() : v;
};

module.exports = cache;
