/**
 * 관리자 전용 endpoints — ADMIN_EMAILS 화이트리스트 인증
 *
 * STAB-AUDIT-2026-05-07 (운영자 ASSERT): "왜 안하고 있냐 빨리 시작해"
 *   - Vercel Hobby plan 은 cron daily 만 허용 → hourly 거부
 *   - Vercel Dashboard "Run now" 도 운영자 1 click 부담
 *   - admin endpoint 통해 즉시 trigger 가능 (운영자 token 으로 호출)
 *
 * 보안:
 *   - requireAuth (JWT 필수)
 *   - getActivePlan === 'admin' 체크 (ADMIN_EMAILS 화이트리스트)
 *   - 일반 사용자 호출 시 403
 *
 * 엔드포인트:
 *   POST /api/admin/run-geocache-backfill — 즉시 1 chunk 실행 (chunk size·daysBack 옵션)
 */
const express = require('express');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { getActivePlan } = require('../services/planService');
const { run: runGeocacheBackfill } = require('../jobs/geocacheBackfill');
// Sprint AAAA (2026-07-06): 신규 규제지역(동탄·기흥·구리) 즉시 적재 — cron(CRON_SECRET=Vercel env 전용) 수동 트리거 불가
//   → geocache-backfill 전례와 동일하게 admin token 으로 targeted molit ingest 실행.
const { runMolitIngest } = require('../jobs/molitIngest');
const { LAWD_CODES } = require('../services/transactionService');
// DEBUG-2026-05-12 (Sprint P): KAPT SigunguAptList3 raw 진단 — 송파구 (11710) sync 누락 원인
const { getAptListBySgg } = require('../services/aptInfoService');

const router = express.Router();

router.use(requireAuth);

// admin 화이트리스트 체크 미들웨어
async function requireAdmin(req, res, next) {
  try {
    const plan = await getActivePlan(req.user.id);
    if (plan !== 'admin') {
      return res.status(403).json({ error: '관리자 전용 엔드포인트입니다.' });
    }
    next();
  } catch (e) {
    logger.warn({ err: e.message, userId: req.user?.id }, 'admin 인증 실패');
    require('../utils/captureError').captureRouteError(e, 'admin'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: '인증 처리 실패' });
  }
}

router.use(requireAdmin);

/**
 * POST /api/admin/run-geocache-backfill
 *
 * Body 또는 query string:
 *   - chunk: number (default 50, max 100) — 1 chunk 단지 수
 *   - daysBack: number (default 180) — 거래 lookback
 *   - budgetMs: number (default 240000) — 총 budget (Vercel maxDuration 안)
 *
 * 응답:
 *   - { ok: true, summary: { chunks, processed, inserted, failed, elapsedMs } }
 */
// PROBE-REMOVED-2026-07-25 (Sprint UUUUUU): `/env-probe`·`/rone-probe` 삭제.
//   둘 다 R-ONE 연동 착수 시 **키 이름 확정 + 통계표 ID 탐색**을 위해 만든 임시 진단 라우트였고,
//   Sprint TTTTTT 로 roneService 가 정식 연동되면서 목적을 다했다(명세는 memory/rone-api-verified 에 확정 기록).
//   남겨두면 admin 계정이 탈취됐을 때 env 이름 나열·임의 통계 조회라는 불필요한 정보 노출 면적이 된다
//   — "쓸 일 없는 진단 경로는 지운다"가 원래 계획(SPRINT_NOTES 잔여 ③).
//   재진단이 필요하면 git history 에서 되살리면 된다.

// PUSH-TEST (Sprint EEEEEE): 웹푸시 발송 수동 트리거 — cron(18:20 UTC) 대기 없이 운영자 검증용
router.post('/run-push-notify', async (req, res) => {
  const started = Date.now();
  try {
    const summary = await require('../jobs/pushNotify').run();
    logger.info({ durationMs: Date.now() - started, summary, adminId: req.user.id }, 'admin/run-push-notify OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/run-push-notify 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
});

// ATTRIBUTION-READ-2026-08-29 (Sprint NNNNNNN-31): 유입 채널 집계 조회(운영자 전용).
//   ?days=30 (기본 30, 최대 365). 채널별 이벤트 수만 센다 — 개인 식별자는 애초에 저장하지 않는다.
router.get('/attribution', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: 'DB 미설정' });
    // ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발) — 명시 limit + 잘림 여부를 응답에 밝힌다.
    const LIM = 1000;
    const { data, error } = await admin
      .from('visit_attribution')
      .select('event, utm_source, utm_medium, utm_campaign, referrer_host')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(LIM);
    if (error) throw error;
    const rows = data || [];
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    const byEvent = {}, bySource = {}, byReferrer = {}, byCampaign = {};
    for (const r of rows) {
      bump(byEvent, r.event || '(none)');
      bump(bySource, r.utm_source || '(직접·미표기)');
      bump(byReferrer, r.referrer_host || '(direct)');
      if (r.utm_campaign) bump(byCampaign, r.utm_campaign);
    }
    const sort = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
    res.set('Cache-Control', 'no-store');
    res.json({
      days, since, sampled: rows.length,
      truncated: rows.length >= LIM, // true 면 이 창의 일부만 본 것이다 — 기간을 줄여서 다시 봐라
      byEvent: sort(byEvent), bySource: sort(bySource), byReferrer: sort(byReferrer), byCampaign: sort(byCampaign),
    });
  } catch (e) {
    logger.error({ err: e.message }, 'admin/attribution 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
});

// CONTENT-DRAFT-2026-08-29 (Sprint NNNNNNN-30, 홍보 제안서 P2): 스레드 데이터 드랍 초안.
//   운영자의 업로드 자동화가 **무엇이든**(자체 스크립트·n8n·Meta API) 가져갈 수 있게 JSON 으로 낸다.
//   AI 호출 0 · 새 외부 수집 0 — 이미 계산해 둔 숫자를 관측된 실제 게시 형식에 끼워 넣을 뿐이다.
//   ?regionCount=N 으로 지역 집중 초안 개수 조절(기본 3).
router.get('/content-draft', async (req, res) => {
  try {
    const rc = Math.min(Math.max(parseInt(req.query.regionCount) || 3, 0), 10);
    const out = await require('../services/contentDraftService').buildDrafts({ regionCount: rc });
    // 재료가 없으면 초안을 지어내지 않는다 — 빈 성공(200 + 빈 배열)으로 위장하지 않는다.
    if (!out) return res.status(503).json({ error: '초안 재료(실거래 경신 집계) 조회 실패' });
    res.set('Cache-Control', 'no-store'); // 운영자 전용 · 매번 최신
    res.json(out);
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/content-draft 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
});

// BR-MANUAL-2026-08-29 (Sprint NNNNNNN-30): 건축물대장 백필 수동 트리거.
//   [왜 필요한가] 2026-08-29 실측 — vercel cron `0 6 * * *` 회차가 **통째로 누락**됐다.
//   07:03 UTC(창 06:59 종료) 시점에 health.crons 의 마지막 기록이 전날 06:01 UTC 였고 DB 도 0건.
//   Hobby 플랜 cron 은 사양상 best effort(회차 누락 가능·재시도 없음)라 코드 결함이 아니지만,
//   그날치 백필이 그냥 사라진다. cron 은 CRON_SECRET Bearer 로만 열리므로 운영자가 손으로 돌릴 길이
//   없었다 — geocache/molit-ingest 와 같은 admin 트리거를 붙인다.
//   ⚠ 이 잡은 Kakao 를 **호출하지 않는다**(캐시 행의 법정동코드로 총괄표제부만 조회) — 지도 쿼터 무관.
//   멱등: 처리한 행에 `title._densAt` 마커가 남아 재실행해도 같은 행을 다시 부르지 않는다.
//   파라미터(전부 선택): densityCap · densityBudgetMs · densityConcurrency · skipCollect=1
//   예) ?skipCollect=1&densityCap=900&densityBudgetMs=250000&densityConcurrency=12
//   (cron 은 아무것도 넘기지 않으므로 기본 동작 무변경. maxDuration 은 300s 다.)
async function handleRunBrBackfill(req, res) {
  const started = Date.now();
  try {
    const q = { ...(req.query || {}), ...(req.body || {}) };
    const summary = await require('../jobs/buildingRegisterBackfill').run({
      ...(q.densityCap != null ? { densityCap: q.densityCap } : {}),
      ...(q.densityBudgetMs != null ? { densityBudgetMs: q.densityBudgetMs } : {}),
      ...(q.densityConcurrency != null ? { densityConcurrency: q.densityConcurrency } : {}),
      ...(q.densityMinIntervalMs != null ? { densityMinIntervalMs: q.densityMinIntervalMs } : {}),
      ...(String(q.skipCollect || '') === '1' ? { skipCollect: true } : {}),
    });
    logger.info({ durationMs: Date.now() - started, summary, adminId: req.user.id }, 'admin/run-building-register-backfill OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/run-building-register-backfill 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
}
router.post('/run-building-register-backfill', handleRunBrBackfill);
router.get('/run-building-register-backfill', handleRunBrBackfill);

router.post('/run-geocache-backfill', async (req, res) => {
  const started = Date.now();
  try {
    const opts = {
      chunk: req.body?.chunk || req.query.chunk,
      daysBack: req.body?.daysBack || req.query.daysBack,
      budgetMs: req.body?.budgetMs || req.query.budgetMs,
    };
    const summary = await runGeocacheBackfill(opts);
    logger.info({
      durationMs: Date.now() - started,
      summary,
      adminId: req.user.id,
    }, 'admin/run-geocache-backfill OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/run-geocache-backfill 실패');
    require('../utils/captureError').captureRouteError(e, 'admin'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: e.message });
  }
});

// GET 도 지원 (간단 호출용)
router.get('/run-geocache-backfill', async (req, res) => {
  const started = Date.now();
  try {
    const opts = {
      chunk: req.query.chunk,
      daysBack: req.query.daysBack,
      budgetMs: req.query.budgetMs,
    };
    const summary = await runGeocacheBackfill(opts);
    logger.info({
      durationMs: Date.now() - started,
      summary,
      adminId: req.user.id,
    }, 'admin/run-geocache-backfill OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/run-geocache-backfill 실패');
    require('../utils/captureError').captureRouteError(e, 'admin'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST|GET /api/admin/run-molit-ingest
 * (Sprint AAAA, 2026-07-06) — MOLIT 실거래 ETL 즉시 실행 (targeted 지원).
 *
 * 파라미터 (query 또는 body):
 *   - months: number (기본 3, max 24) — 이번 달부터 거꾸로 적재할 개월 수
 *   - offsetMonths: number (기본 0) — backfill 분할용
 *   - lawd: string — 콤마 구분 LAWD_CD 목록 (예: "41310,41463,41597"). 미지정 시 전체.
 *     LAWD_CODES 화이트리스트 검증 — 미등록 코드는 거부(전부 미등록이면 400).
 *
 * 응답: { ok, opts, unknownLawds?, summary: { regions, months, ok, err, skipped, elapsedMs, gapBackfill } }
 */
async function handleRunMolitIngest(req, res) {
  const started = Date.now();
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const opts = {};
    if (src.months) opts.months = parseInt(src.months);
    if (src.offsetMonths) opts.offsetMonths = parseInt(src.offsetMonths);
    let unknownLawds;
    if (src.lawd) {
      const known = new Set(Object.values(LAWD_CODES));
      const asked = String(src.lawd).split(',').map(s => s.trim()).filter(Boolean);
      const valid = asked.filter(c => known.has(c));
      unknownLawds = asked.filter(c => !known.has(c));
      if (!valid.length) {
        return res.status(400).json({ error: 'lawd 에 LAWD_CODES 등록 코드가 없습니다.', unknownLawds });
      }
      opts.onlyLawds = valid;
    }
    const summary = await runMolitIngest(opts);
    logger.info({
      durationMs: Date.now() - started,
      opts, unknownLawds,
      summary: summary && { regions: summary.regions, months: summary.months, ok: summary.ok, err: summary.err, skipped: summary.skipped },
      adminId: req.user.id,
    }, 'admin/run-molit-ingest OK');
    res.json({ ok: true, opts, ...(unknownLawds && unknownLawds.length ? { unknownLawds } : {}), summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'admin/run-molit-ingest 실패');
    require('../utils/captureError').captureRouteError(e, 'admin'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: e.message });
  }
}
router.post('/run-molit-ingest', handleRunMolitIngest);
router.get('/run-molit-ingest', handleRunMolitIngest);

/**
 * GET /api/admin/debug-kapt-list?lawdCd=11710[&q=헬리오시티]
 *
 * Sprint P (2026-05-12 디버그) — 송파구/양천구 apt_master sync 누락 원인 추적.
 *   KAPT SigunguAptList3 raw 응답 + (q) 매칭 후보 확인.
 *   요청 1회마다 cache (7일) busted 위해 별도 admin 진단 endpoint 분리.
 */
router.get('/debug-kapt-list', async (req, res) => {
  const lawdCd = String(req.query.lawdCd || '').trim();
  const q = String(req.query.q || '').trim();
  if (!lawdCd) return res.status(400).json({ error: 'lawdCd required' });
  try {
    const t0 = Date.now();
    const list = await getAptListBySgg(lawdCd);
    const elapsed = Date.now() - t0;
    const out = {
      lawdCd,
      elapsedMs: elapsed,
      total: list.length,
      sample: list.slice(0, 5).map(x => ({ kaptCode: x.kaptCode, kaptName: x.kaptName, as1: x.as1, as2: x.as2, as3: x.as3 })),
    };
    if (q) {
      // 검색어가 있을 때만 매칭 후보 (string includes / 정규화 후 비교)
      const stripped = q.replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
      const matches = list.filter(x => {
        const n = String(x.kaptName || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
        return n === stripped || n.includes(stripped) || stripped.includes(n);
      });
      out.q = q;
      out.stripped = stripped;
      out.matchedCount = matches.length;
      out.matched = matches.slice(0, 10).map(x => ({ kaptCode: x.kaptCode, kaptName: x.kaptName, as3: x.as3 }));
    }
    res.json(out);
  } catch (e) {
    logger.error({ err: e.message, lawdCd }, 'admin/debug-kapt-list 실패');
    require('../utils/captureError').captureRouteError(e, 'admin'); // SENTRY-GAP (Sprint XXXXX)
    res.status(500).json({ error: e.message });
  }
});

/**
 * REPORT-DRYRUN-2026-08-30 (Sprint OOOOOOO, 운영자 "보고서까지 제대로 나오는지 확실하게 확인"):
 *   GET /api/admin/report-candidates?lawdCd=41597&region=경기 화성시 동탄구&budget=7.3
 *   보고서의 **단지 선별 단계만** 실행한다 — AI 호출 없음(비용 0). 후보가 0이면 /generate 는
 *   그 자리에서 404 를 낸다. 즉 이 숫자가 "그 지역에서 보고서가 나오는가" 를 그대로 답한다.
 *   전 지역 전수 점검용. 결과는 저장하지 않는다.
 */
router.get('/report-candidates', async (req, res) => {
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: 'DB 미설정' });
    const { fetchCandidateApts } = require('./report');
    if (typeof fetchCandidateApts !== 'function') return res.status(500).json({ error: 'dry-run 미노출' });
    const input = {
      maxBudget: parseFloat(req.query.budget) || 7,
      myCash: 3, region: String(req.query.region || ''),
      lawdCd: String(req.query.lawdCd || ''),
      pyeong: '전체', priority: '환금성', kidPlan: '없음', stayYears: '5~10년',
      isFirstBuyer: true, houseStatus: '무주택',
    };
    const t0 = Date.now();
    const rows = await fetchCandidateApts(admin, input, 7);
    res.set('Cache-Control', 'no-store');
    res.json({
      lawdCd: input.lawdCd, region: input.region, budget: input.maxBudget,
      count: rows.length, ms: Date.now() - t0,
      lawdSeen: [...new Set(rows.map(r => r.lawd_cd).filter(Boolean))],
      names: rows.slice(0, 5).map(r => r.apt_name),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * NAME-REFRESH-2026-08-30 (Sprint OOOOOOO): apt-master-sync 수동 실행.
 *   주간 cron 은 월요일이라, 이름 갱신(DO NOTHING → DO UPDATE) 수정을 배포하고도
 *   최대 일주일간 옛 이름이 남는다. 운영자가 바로 돌릴 수 있게 admin 경로를 연다.
 *   cron 경로는 CRON_SECRET 이 필요해 브라우저에서 못 부른다 — 같은 잡을 admin 인증으로 부른다.
 *   ⚠ 잡 자체는 멱등(upsert)이라 중복 실행이 안전하다.
 */
async function handleAptMasterSync(req, res) {
  try {
    const { runAptMasterSync } = require('../jobs/aptMasterSync');
    const started = Date.now();
    const summary = await runAptMasterSync();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, elapsedMs: Date.now() - started, summary });
  } catch (e) {
    logger.error({ err: e.message }, 'admin apt-master-sync 실패');
    res.status(500).json({ ok: false, error: e.message });
  }
}
router.get('/run-apt-master-sync', handleAptMasterSync);
router.post('/run-apt-master-sync', handleAptMasterSync);

/** RENAME-REFRESH-2026-08-30: facility 백필 수동 실행(개명 단지 주소·주차 즉시 갱신용). */
async function handleFacilityBackfill(req, res) {
  try {
    const { run } = require('../jobs/facilityBackfill');
    const started = Date.now();
    const summary = await run({
      chunk: Math.min(Math.max(parseInt(req.query.chunk) || 40, 1), 200),
      budgetMs: Math.min(Math.max(parseInt(req.query.budgetMs) || 240000, 5000), 280000),
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, elapsedMs: Date.now() - started, summary });
  } catch (e) {
    logger.error({ err: e.message }, 'admin facility-backfill 실패');
    res.status(500).json({ ok: false, error: e.message });
  }
}
router.get('/run-facility-backfill', handleFacilityBackfill);
router.post('/run-facility-backfill', handleFacilityBackfill);


/**
 * TRANSIT-TRUTH-2026-08-30 (Sprint PPPPPPP): KAPT 도보시간 **자기신고값 검증**.
 *
 * 운영자 지적: "서동탄역더샵파크시티는 누가봐도 도보 30분 이상인데 지하철 5분 이내는
 *   무슨 소리냐. DB 가 잘못된 거냐." → 실제로 **결함이 두 개 겹쳐** 있었다.
 *   ① 코드: `"10~15분이내".includes("5분이내")` 가 참이라 10~15분 단지가 교통 만점을 받았다.
 *   ② 원본: KAPT 신고값 "10~15분이내" 조차 틀렸다(카카오 도보 실측 1,783m / 26.8분).
 *
 * ①은 walkBand.js 로 고쳤다. ②는 **재보지 않으면 알 수 없다** — 그래서 이 엔드포인트가 있다.
 *   좌표 보유 단지의 최근접 지하철역 직선거리를 카카오로 재고 KAPT 밴드와 나란히 돌려준다.
 *   ⚠ 여기서 판정하지 않는다. 관측치만 낸다 — 무엇을 신뢰할지는 집계를 보고 정한다.
 *
 *   GET /api/admin/audit-transit?offset=0&limit=400
 */
router.get('/audit-transit', async (req, res) => {
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: 'DB 미설정' });
    const { nearestSubway } = require('../services/kakaoService');
    const { parseWalkBand } = require('../utils/walkBand');
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.min(600, Math.max(1, parseInt(req.query.limit) || 400));

    // ⚠ 프로덕션 DDL 없이 — apt_master 페이지를 읽고 좌표를 코드/이름으로 붙인다.
    //   [[postgrest-silent-row-cap]]: range 를 명시하지 않으면 1000 에서 조용히 잘린다.
    const { data: masters, error: mErr } = await admin
      .from('apt_master')
      .select('kapt_code, apt_name, sigungu, facility')
      .order('kapt_code', { ascending: true })
      .range(offset, offset + limit - 1);
    if (mErr) return res.status(500).json({ error: mErr.message });

    const cand = (masters || [])
      .map(m => ({
        kaptCode: m.kapt_code, aptName: m.apt_name, sigungu: m.sigungu,
        rawBand: (m.facility && m.facility._dtl && m.facility._dtl.kaptdWtimesub) || null,
      }))
      .filter(m => m.rawBand);

    const byKapt = new Map();
    const byName = new Map();
    if (cand.length) {
      const keys = cand.map(c => `kapt:${c.kaptCode}`);
      for (let i = 0; i < keys.length; i += 200) {
        const chunk = keys.slice(i, i + 200);
        const { data: g1 } = await admin.from('apt_geocache')
          .select('apt_key, lat, lng').in('apt_key', chunk).limit(chunk.length);
        for (const g of g1 || []) byKapt.set(g.apt_key, g);
      }
      const names = [...new Set(cand.map(c => c.aptName))];
      for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        const { data: g2 } = await admin.from('apt_geocache')
          .select('apt_name, sigungu, lat, lng').in('apt_name', chunk).limit(3000);
        for (const g of g2 || []) byName.set(`${g.apt_name}|${g.sigungu}`, g);
      }
    }

    let noCoord = 0;
    const targets = [];
    for (const c of cand) {
      const g = byKapt.get(`kapt:${c.kaptCode}`) || byName.get(`${c.aptName}|${c.sigungu}`);
      if (!g || g.lat == null || g.lng == null) { noCoord++; continue; }
      targets.push(Object.assign({}, c, { lat: Number(g.lat), lng: Number(g.lng) }));
    }

    // 공용 페이서 — 카카오 레이트리밋은 동시성이 아니라 **속도** 로 터진다.
    //   [[br-recap-rate-limit-429]]: 동시성만 낮추면 실패가 즉시 반환돼 오히려 초당 호출이 튄다.
    let nextAt = 0;
    const GAP_MS = 30;
    const pace = async () => {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      nextAt = at + GAP_MS;
      if (at > now) await new Promise(r => setTimeout(r, at - now));
    };

    const out = [];
    let failed = 0;
    let cursor = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= targets.length) return;
        const t = targets[i];
        await pace();
        const near = await nearestSubway(t.lat, t.lng, 3000);
        if (near === undefined) { failed++; continue; } // ⚠ 실패 ≠ 역 없음
        out.push({
          kaptCode: t.kaptCode, name: t.aptName, sigungu: t.sigungu,
          band: parseWalkBand(t.rawBand), rawBand: t.rawBand,
          station: near ? near.name : null,
          distM: near ? near.distance : null,
        });
      }
    }));

    res.set('Cache-Control', 'no-store');
    res.json({
      offset, limit,
      scanned: (masters || []).length, withBand: cand.length, noCoord,
      measurable: targets.length, measured: out.length, failed, rows: out,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'admin audit-transit 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
});

/**
 * INTEREST-WARM-2026-08-30 (Sprint PPPPPPP): 장기 검색 관심도 캐시 채우기 + 키 진단.
 *
 * ⚠ 왜 요청 경로가 아니라 여기인가 — **서버리스는 응답을 보낸 뒤의 작업을 보장하지 않는다.**
 *   추천 응답 후 fire-and-forget 으로 채우게 했더니 캐시가 **0행**이었다(실측).
 *   그래서 채우기는 이 경로(관리자·크론)에서만 하고, 요청 경로는 **캐시만 읽는다**.
 *
 * 거래가 많은 단지부터 채운다 — 검색 결과에 실제로 등장할 확률이 높은 순서다.
 * 데이터랩 일일 한도를 지키려고 호출 수를 인자로 묶는다(1콜 = 단지 4곳).
 *
 *   GET /api/admin/warm-interest?calls=10
 */
router.get('/warm-interest', async (req, res) => {
  try {
    const dl = require('../services/naverDatalabService');
    if (!dl.hasKeys()) {
      return res.status(503).json({ ok: false, reason: 'NAVER_CLIENT_ID/SECRET 미설정', keyShape: dl.keyShape() });
    }
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: 'DB 미설정' });
    const calls = Math.min(60, Math.max(1, parseInt(req.query.calls) || 10));

    // 좌표가 있는 단지를 거래 많은 순으로 — apt_geocache 는 MOLIT 이름 기준이라 그대로 쓴다.
    const { data: geo, error: gErr } = await admin.from('apt_geocache')
      .select('apt_name, sigungu, lat, lng')
      .not('lat', 'is', null)
      .order('cached_at', { ascending: false })
      .range(0, 999);
    if (gErr) return res.status(500).json({ error: gErr.message });

    const seen = new Set();
    const items = [];
    for (const g of geo || []) {
      const k = `${g.apt_name}|${g.sigungu}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ aptName: g.apt_name, sigungu: g.sigungu, lat: Number(g.lat), lng: Number(g.lng) });
    }
    const t0 = Date.now();
    const summary = await dl.warmInterest(items, calls);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, anchor: dl.ANCHOR, keyShape: dl.keyShape(), candidates: items.length, elapsedMs: Date.now() - t0, ...summary });
  } catch (e) {
    logger.error({ err: e.message }, 'admin warm-interest 실패');
    require('../utils/captureError').captureRouteError(e, 'admin');
    res.status(500).json({ error: e.message });
  }
});

/**
 * NAVER-PROBE-2026-08-30 (Sprint PPPPPPP): 네이버 자격증명 진단.
 *
 * 데이터랩이 401 인데 원인이 둘로 갈린다 —
 *   (a) Client ID/Secret 자체가 틀렸다  (b) 앱에 '검색어트렌드' API 가 안 켜져 있다.
 * **같은 키로 두 API 를 찔러보면 갈린다**: 둘 다 401 이면 (a), 뉴스만 되면 (b).
 * ⚠ 응답에 **키 값은 절대 싣지 않는다** — 상태코드와 네이버가 준 메시지만 낸다.
 *
 *   GET /api/admin/naver-probe
 */
router.get('/naver-probe', async (req, res) => {
  const axios2 = require('axios');
  const dl = require('../services/naverDatalabService');
  const id = String(process.env.NAVER_CLIENT_ID || '').trim();
  const secret = String(process.env.NAVER_CLIENT_SECRET || '').trim();
  const H = { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret };
  // ⚠ **이름만** 낸다(값 금지). 변수 이름 오타로 편집이 엉뚱한 곳에 갔는지 가려낸다 —
  //   값이 두 번 연속 같은 길이로 남아 있으면 "저장이 반영 안 됐다" 와 "같은 값을 다시 넣었다" 를
  //   구분해야 하는데, 이름 목록이 그 실마리를 준다.
  const naverEnvNames = Object.keys(process.env).filter(k => /naver/i.test(k)).sort();
  const out = { keyShape: dl.keyShape(), naverEnvNames };

  // ① 검색(뉴스) API — 가장 기본. 이게 되면 자격증명 자체는 유효하다.
  try {
    const r = await axios2.get('https://openapi.naver.com/v1/search/news.json',
      { headers: H, params: { query: '부동산', display: 1 }, timeout: 6000 });
    out.news = { ok: true, status: r.status, total: r.data?.total ?? null };
  } catch (e) {
    out.news = { ok: false, status: e.response?.status || null,
      message: e.response?.data?.errorMessage || e.response?.data?.message || e.message };
  }

  // ② 데이터랩 검색어트렌드 — 앱에 별도로 켜야 하는 API.
  try {
    const r = await axios2.post('https://openapi.naver.com/v1/datalab/search',
      { startDate: '2026-01-01', endDate: '2026-02-01', timeUnit: 'month',
        keywordGroups: [{ groupName: 'probe', keywords: ['은마아파트'] }] },
      { headers: Object.assign({ 'Content-Type': 'application/json' }, H), timeout: 6000 });
    out.datalab = { ok: true, status: r.status, groups: (r.data?.results || []).length };
  } catch (e) {
    out.datalab = { ok: false, status: e.response?.status || null,
      message: e.response?.data?.errorMessage || e.response?.data?.message || e.message };
  }

  out.verdict = out.news.ok && out.datalab.ok ? '정상'
    : (!out.news.ok && !out.datalab.ok) ? '자격증명 자체가 거부됨 — Client ID/Secret 확인'
      : out.news.ok ? "자격증명은 유효 — 앱에 '검색어트렌드' API 가 안 켜져 있음"
        : '뉴스만 실패 — 예상 밖 조합, 메시지를 볼 것';
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

module.exports = router;



