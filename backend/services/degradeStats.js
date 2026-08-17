/**
 * 요청 경로 강등(degrade) 카운터 — DEGRADE-SHARED-2026-08-17 (Sprint MMMMMMM-15)
 *
 * [왜 만드나]
 *   보고서 후보 풀이 시간 예산에 걸려 잘리는 일이 **얼마나 자주** 일어나는지 알 방법이 없었다.
 *   Vercel Hobby 런타임 로그는 1시간 보존이라 logger.warn 만으로는 사후 추적이 불가능하다
 *   (cron 에서 이미 같은 벽에 부딪혀 cronStats 를 만들었다 — 요청 경로판이 이것이다).
 *
 * [설계]
 *   - search.js 의 `_observeDegrade` 와 **같은 Redis 키**(`searchdeg:{YYYYMMDD}`)에 쓴다.
 *     그래야 `/api/health` 의 `searchDegrade` 블록에 추가 배선 없이 그대로 나타난다.
 *   - Promise 를 반환한다. 서버리스는 응답 직후 함수를 동결하므로 응답 **직전** 경로는 await 해야
 *     기록이 유실되지 않는다(커밋 ba1db07 에서 실제로 겪은 유실).
 *   - 실패는 삼킨다 — 관측이 응답을 막아선 안 된다.
 *
 * ⚠ search.js 에는 아직 같은 내용의 지역 함수가 남아 있다. 오늘은 **보고서 경로만** 이 모듈을 쓴다
 *   (같은 날 프로덕션 장애를 낸 직후라 검색 경로까지 동시에 건드리지 않는다). 두 구현이 같은 키에
 *   쓰므로 관측은 합쳐져 보이고, 통합은 별도 작업으로 남긴다. 계약 테스트가 **키 접두어 일치**를 고정한다.
 */
const KEY_PREFIX = 'searchdeg:';
const TTL_SEC = 60 * 60 * 24 * 21;

/**
 * @param {string} kind 강등 종류 (예: 'report-pool-cut')
 * @returns {Promise<void>} 절대 reject 하지 않는다
 */
function observeDegrade(kind) {
  try {
    const r = require('../redis').getRedis();
    if (!r) return Promise.resolve();
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return Promise.all([
      Promise.resolve(r.hincrby(`${KEY_PREFIX}${day}`, kind, 1)).catch(() => {}),
      Promise.resolve(r.expire(`${KEY_PREFIX}${day}`, TTL_SEC)).catch(() => {}),
    ]).then(() => {});
  } catch (_) { /* 관측은 응답을 막지 않는다 */ }
  return Promise.resolve();
}

module.exports = { observeDegrade, KEY_PREFIX };
