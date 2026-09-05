/**
 * RENT-WARM-2026-09-05: 국토부 전월세 월별 캐시를 하루 1회 예열한다(Redis 공유 캐시, rentService 2차 계층).
 *
 * [왜] 보고서 콜드 경로가 최종 후보 구 × 6개월을 실시간으로 조회한다 — 초당 한도 때문에 350ms 간격이라 36콜 ≈ 12~13초
 *   (프로덕션 실측 2026-09-05: 14.7s → 28.9s). 분석탭(단지 상세 전세가율)도 콜드면 6콜 ≈ 2초. 예열되면 둘 다 0 에 가깝다.
 * [범위] LAWD_CODES 전 지역(폐지 제외). 최근 2개월은 매일(계약 등록 지연 반영), 그 이전 4개월은 지역을 7조로 나눠
 *   하루 한 조(주 1회) — Redis TTL(최근 30h · 이전 8일)과 맞물린다. 하루 ≈ 124×2 + 18×4 ≈ 320콜 × 350ms ≈ 2분.
 * [한도] 국토부 일 트래픽 한도는 운영자 콘솔에서만 보인다 — 일 한도 초과(code=22)를 만나면 즉시 멈추고 사유를 남긴다.
 *   시간 예산 240s(함수 상한 300s 안). 초당 한도(code=23)는 rentService 의 페이서·1회 재시도가 맡고, 그래도 실패면 그 달만 건너뛴다.
 * [멱등] 이미 캐시된 (구,월)은 건너뛴다 → Hobby cron 이 두 번 불려도 부작용 없음(같은 날 재실행은 대부분 skip).
 */
const logger = require('../logger');

function defaultCodes() {
  const { LAWD_CODES, RETIRED_LAWD_CODES } = require('../services/transactionService');
  const seen = new Set();
  for (const c of Object.values(LAWD_CODES)) {
    const s = String(c);
    if (RETIRED_LAWD_CODES && RETIRED_LAWD_CODES.has(s)) continue;
    seen.add(s);
  }
  return [...seen].sort();
}

const QUOTA_RE = /LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR|code=22(?!\d)/;

async function run({ codes, now = new Date(), dayIdx, budgetMs = 240000, concurrency = 3 } = {}) {
  const rent = require('../services/rentService');
  const list = codes || defaultCodes();
  const months = rent.monthsWindow(now);
  const recent = months.slice(0, 2);
  const older = months.slice(2);
  const slot = dayIdx != null ? dayIdx : Math.floor(now.getTime() / 86400000) % 7;
  const tasks = [];
  list.forEach((code, i) => {
    for (const ym of recent) tasks.push([code, ym]);
    if (i % 7 === slot) for (const ym of older) tasks.push([code, ym]);
  });
  const t0 = Date.now();
  const out = { regions: list.length, slot, planned: tasks.length, skipped: 0, fetched: 0, failed: 0, stopped: null, remaining: 0, elapsedMs: 0 };
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length && !out.stopped) {
      if (Date.now() - t0 >= budgetMs) { out.stopped = 'budget'; break; }
      const [code, ym] = tasks[idx++];
      try {
        if (await rent.isRentCached(code, ym)) { out.skipped++; continue; }
        await rent.getRentTransactions(code, ym);
        out.fetched++;
      } catch (e) {
        out.failed++;
        if (QUOTA_RE.test(String((e && e.reason) || ''))) { out.stopped = 'quota'; break; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(concurrency) || 1) }, worker));
  out.remaining = Math.max(0, tasks.length - idx);
  out.elapsedMs = Date.now() - t0;
  logger.info(out, 'cron/warm-rent');
  return out;
}

module.exports = { run, defaultCodes };
