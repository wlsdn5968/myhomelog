/**
 * BRIEFING-ARCHIVE-2026-08-19 (Sprint NNNNNNN-6, 사업기획 Phase 1 — 운영자 승인 권고안 ①):
 * 날짜별 브리핑 스냅샷 — 조합·저장·조회.
 *
 * [왜 이 구조인가] Vercel Hobby 는 런타임 파일 쓰기가 불가라 정적 아카이브를 만들 수 없다.
 * 대신 그날의 브리핑 재료를 DB(briefing_snapshots, day PK)에 jsonb 로 저장하고,
 * /briefing/:date 서버 라우트가 크롤러·사람 모두에게 완전한 서버렌더 HTML 을 돌려준다
 * (기존 /share OG 주입과 같은 계열 — 추가 인프라 비용 0).
 *
 * [생성 시점] ① 오늘 날짜 페이지 첫 조회 시 lazy 생성(멱등 upsert)
 *            ② retention cron(일간)이 보장 생성 — Hobby cron 은 누락·중복이 사양상 정상이라
 *              (cron-observability 실측) lazy 와 중복돼도 upsert 라 부작용 없음.
 * [원칙] 값이 없으면 필드를 null/빈 배열로 저장하고 렌더에서 항목째 생략 — 0·추정값 금지.
 *        3줄 시황이 비면 저장하지 않는다(빈 아카이브 방지 — 다음 요청이 재시도).
 */
'use strict';

const cache = require('../cache');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');

/**
 * KST 기준 날짜 문자열. ⚠ 서버 런타임 TZ=UTC(실사고 이력) — '하루'는 반드시 +9h 명시 계산.
 */
function kstDayString(d) {
  const base = d ? new Date(d) : new Date();
  return new Date(base.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 오늘 브리핑 재료 조합 — 전부 기존 소스 재사용, 새 외부 수집 0 */
async function buildBriefingPayload() {
  // 3줄 시황: news 라우트의 공식통계 라인 생성기 재사용(라우터 속성 export — 사본 금지)
  let lines = [];
  // REG-STRUCT-2026-08-19 (Sprint NNNNNNN-15): 구조화 items 를 원본으로, 문자열은 파생(사본 금지)
  let lines2 = [];
  try {
    const _news = require('../routes/news');
    lines2 = await _news._dataMarketItems();
    lines = _news._deriveMarketLines(lines2);
  } catch (_) { lines = []; lines2 = []; }
  if (!Array.isArray(lines)) lines = [];

  // 금리: health 와 동일 소스(공유 node-cache) — 콜드 미스면 ecosService 직접(실패 시 null 유지)
  let ecos = cache.get('ecos:rates:v1');
  if (ecos === undefined || ecos === null) {
    try { ecos = await require('./ecosService').getEcosRates(); } catch (_) { ecos = null; }
  }

  // 실거래 누적·동기화: health 가 캐시한 메타 재사용. 콜드 미스면 null → 렌더에서 생략(미확인 원칙)
  // COUNTS-FALLBACK-2026-08-19 (Sprint NNNNNNN-14): 콜드 인스턴스에서 로컬 캐시 미스 시
  //   Redis 공유 캐시(getDataCounts 가 기록)로 폴백 — 오늘 아카이브에서 실거래 누적이 빠진 실사례.
  let dc = cache.get('meta:dataCounts:v2') || null;
  if (!dc) { try { dc = await require('./redisCache').rget('meta:dataCounts:v2'); } catch (_) { dc = null; } }

  // 인기 TOP5: 일별 사전집계 스냅샷 재사용(없으면 빈 배열 — 실시간 재집계로 cron 경로를 무겁게 하지 않는다)
  let popular = [];
  try {
    const snap = await require('./popularService').readPopularSnapshot(5);
    if (Array.isArray(snap)) {
      popular = snap.slice(0, 5).map(p => ({
        aptName: p.aptName || null,
        sigungu: p.sigungu || null,
        dealCount60d: Number.isFinite(Number(p.dealCount60d)) ? Number(p.dealCount60d) : null,
      }));
    }
  } catch (_) { /* 생략 */ }

  // PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최근 실거래 최고·최저 경신.
  // 앱 브리핑 카드와 **같은 서비스 함수**를 쓴다(사본 금지 — 세금계산 사본 2개 사고 이력).
  // 하루 1회 캐시라 여기서 부르는 비용은 사실상 0. 실패하면 null 로 두고 렌더에서 통째 생략.
  let records = null;
  try { records = await require('./priceRecordsService').getPriceRecords(); } catch (_) { records = null; }

  // REG-LOG-2026-08-19 (Sprint NNNNNNN-14): 검증된 규정 이벤트 체인 — 아카이브 카드용(실패 시 빈 배열)
  let regLog = [];
  try { regLog = (await require('./regulationsService').getChangeLog()).items || []; } catch (_) { regLog = []; }

  // PARTIAL-SNAPSHOT-2026-09-05 (감사 G-5): 어떤 재료가 비었는지 스냅샷에 남긴다 — 렌더는 그대로 생략하되,
  //   그날 하루 굳히지 않고 getOrCreateSnapshot 이 30분 뒤 다시 만들어 **더 완전해졌을 때만** 덮어쓴다.
  //   종전엔 첫 조회 순간에 ECOS 가 잠깐 죽으면 그날 아카이브의 금리 칸이 하루 종일 비었다.
  const partial = [
    !lines.length && 'lines', !ecos && 'ecos', !dc && 'counts', !popular.length && 'popular', !records && 'records',
  ].filter(Boolean);
  return {
    day: kstDayString(),
    generatedAt: new Date().toISOString(),
    partial,
    lines,
    lines2,
    ecos: ecos ? {
      baseRate: ecos.baseRate != null ? ecos.baseRate : null,
      mortgageRate: ecos.mortgageRate != null ? ecos.mortgageRate : null,
      mortgageRateMonth: ecos.mortgageRateMonth || null,
    } : null,
    txTotal: dc && dc.tx ? Number(dc.tx) : null,
    syncedAt: dc && dc.lastIngestedAt ? String(dc.lastIngestedAt) : null,
    popular,
    regLog,
    records,
  };
}

/**
 * 스냅샷 조회(+오늘이면 lazy 생성). 과거·미래 날짜는 절대 생성하지 않는다 —
 * 아카이브는 "그날 실제로 만들어진 기록"이어야 신뢰 장치가 된다(소급 생성 = 조작 가능성).
 * @returns {object|null} payload — null 이면 해당 일자 기록 없음
 */
const PARTIAL_RETRY_MS = 30 * 60 * 1000;

async function getOrCreateSnapshot(day) {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  let stored = null;
  try {
    const { data } = await admin.from('briefing_snapshots').select('payload').eq('day', day).maybeSingle();
    stored = (data && data.payload) || null;
  } catch (e) {
    logger.warn({ err: e.message, day }, 'briefing 스냅샷 조회 실패');
    return null;
  }
  const isToday = day === kstDayString();
  if (stored) {
    // PARTIAL-SNAPSHOT-2026-09-05 (감사 G-5): 재료 일부가 비어 저장된 **오늘** 스냅샷은 30분마다 다시 만들어 보고,
    //   더 완전해졌을 때만 덮어쓴다. 과거 날짜는 절대 손대지 않는다(아카이브 불변 — 소급 생성 = 조작 가능성).
    const partial = Array.isArray(stored.partial) ? stored.partial : [];
    const age = Date.now() - (Date.parse(stored.generatedAt || '') || 0);
    if (!isToday || !partial.length || age < PARTIAL_RETRY_MS) return stored;
    const fresh = await buildBriefingPayload();
    if (!fresh.lines.length || (fresh.partial || []).length >= partial.length) return stored;
    await admin.from('briefing_snapshots').upsert({ day, payload: fresh }).then(() => {}, (e) => {
      logger.warn({ err: e && e.message, day }, 'briefing 스냅샷 재저장 실패(부분 결손 보완) — 다음 요청이 재시도');
    });
    return fresh;
  }
  if (!isToday) return null;

  const payload = await buildBriefingPayload();
  if (payload.lines.length) {
    // 저장 실패는 페이지 응답을 막지 않는다(다음 요청이 재시도) — 다만 기록은 남긴다
    await admin.from('briefing_snapshots').upsert({ day, payload }).then(() => {}, (e) => {
      logger.warn({ err: e && e.message, day }, 'briefing 스냅샷 저장 실패');
    });
  }
  return payload;
}

module.exports = { kstDayString, buildBriefingPayload, getOrCreateSnapshot };
