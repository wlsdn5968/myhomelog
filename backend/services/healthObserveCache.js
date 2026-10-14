/**
 * backend/services/healthObserveCache.js — Plan 139
 *
 * /api/health 가 매 요청 Redis 에서 읽던 "사용자별이 아닌" 관측값(cron 최근 실행, 챗 의도·검색 강등 일 카운터)을
 * 인스턴스 메모리에 5분 캐시한다. health 는 요청마다 사용자별이 아닌 값을 Redis 에서 5회(get 1 + hgetall 4) 읽었다 — 2026-10-05 이후 Upstash 무료 한도(월 500,000 명령) 초과 상태라 요청 경로의 명령을 줄인다.
 *
 * - 캐시하지 않는 것: 사용자별 사용량(getUsage), 월 예산, 관리자 전용 recentMisses(lrange — 원문 PII 라 공유 캐시 금지).
 * - 날짜(UTC YYYYMMDD)가 키에 들어가므로 자정 넘어 어제 값이 오늘로 보이지 않는다.
 * - Redis 실패 시 null 을 돌려주고 **캐시하지 않는다**(복구되면 다음 요청에서 바로 다시 시도).
 */
'use strict';

const TTL_MS = 5 * 60 * 1000;

function createHealthObserveCache({ getRedis, getCronLatest, now = () => Date.now(), ttlMs = TTL_MS }) {
  let cron = null; // { at, value }
  let counters = null; // { at, day, value }

  async function cronLatest() {
    const t = now();
    if (cron && t - cron.at < ttlMs) return cron.value;
    const value = await Promise.resolve().then(() => getCronLatest()).catch(() => null);
    if (value != null) cron = { at: t, value }; // null(실패·기록 없음)은 캐시하지 않는다
    return value;
  }

  async function intentCounters() {
    const r = getRedis();
    if (!r) return null;
    const t = now();
    const day = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    if (counters && counters.day === day && t - counters.at < ttlMs) return counters.value;
    const yday = new Date(t - 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const [today, yesterday, degToday, degYday] = await Promise.all([
        r.hgetall(`chatint:${day}`), r.hgetall(`chatint:${yday}`),
        r.hgetall(`searchdeg:${day}`), r.hgetall(`searchdeg:${yday}`),
      ]);
      const value = {
        chatIntents: { today: today || {}, yesterday: yesterday || {} },
        searchDegrade: { today: degToday || {}, yesterday: degYday || {} },
      };
      counters = { at: t, day, value };
      return value;
    } catch (_) { return null; }
  }

  return { cronLatest, intentCounters, _reset() { cron = null; counters = null; } };
}

module.exports = { createHealthObserveCache, TTL_MS };
