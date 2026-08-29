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

module.exports = router;
