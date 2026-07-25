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

/**
 * GET /api/admin/kosis-probe — KOSIS 통계표 실호출 검증 (Sprint YYYYYY, **임시 진단**)
 *
 * 왜: 인구이동 6번째 칸을 붙이려면 통계표의 itmId·objL 구조·주기(prdSe)를 확정해야 하는데,
 *   공식 카탈로그에 ID 가 있어도 OpenAPI 가 반려하는 전례가 있다(Sprint HHHHH: 101/DT_1YL202001E
 *   → "해당 통계표가 존재하지 않습니다"). **실호출 전에는 코드를 쓰지 않는다**는 절차를 지키기 위한 경로.
 *
 * 보안:
 *   - admin 전용(위 requireAdmin) · **키 값은 응답·로그 어디에도 싣지 않는다**.
 *   - 도메인·경로는 코드 상수 화이트리스트 → 임의 URL 호출 불가(SSRF 차단).
 *   - orgId/tblId 는 탐색이 목적이라 자유롭되 형식 검증([A-Za-z0-9_] 만).
 * 명세 확정 후 이 라우트는 제거한다(rone-probe 와 동일 수명).
 */
router.get('/kosis-probe', async (req, res) => {
  const key = process.env.KOSIS_API_KEY;
  if (!key) return res.json({ ok: false, reason: 'KOSIS_API_KEY 미설정' });
  const axios = require('axios');
  const EP = {
    data: 'https://kosis.kr/openapi/Param/statisticsParameterData.do', // 통계 데이터
    meta: 'https://kosis.kr/openapi/statisticsData.do',                // 항목/분류 메타
  };
  const mode = String(req.query.mode || 'data');
  if (!EP[mode]) return res.json({ ok: false, reason: `mode 는 ${Object.keys(EP).join('|')}` });
  const safe = (v, d) => { const s = String(v == null ? d : v); return /^[A-Za-z0-9_]+$/.test(s) ? s : d; };

  const params = { apiKey: key, format: 'json', jsonVD: 'Y',
    orgId: safe(req.query.orgId, '101'), tblId: safe(req.query.tblId, 'DT_1B26001_A01') };
  if (mode === 'data') {
    params.method = 'getList';
    params.itmId = safe(req.query.itmId, 'ALL');
    params.objL1 = safe(req.query.objL1, 'ALL');
    if (req.query.objL2 !== 'skip') params.objL2 = safe(req.query.objL2, 'ALL');
    params.prdSe = safe(req.query.prdSe, 'M');
    params.newEstPrdCnt = safe(req.query.n, '3');
  } else {
    params.method = 'getMeta';
    params.type = safe(req.query.type, 'ITM'); // ITM(항목) | OBJ(분류)
  }
  try {
    const r = await axios.get(EP[mode], { params, timeout: 20000 });
    const b = r.data;
    if (!Array.isArray(b)) {
      // KOSIS 는 오류를 객체로 준다 — 메시지 그대로 보여야 원인 확정이 된다(키는 안 들어감)
      return res.json({ ok: false, httpStatus: r.status, notArray: true,
        body: JSON.stringify(b).slice(0, 600) });
    }
    const take = Math.min(parseInt(req.query.take, 10) || 5, 30);
    return res.json({ ok: true, httpStatus: r.status, rows: b.length,
      fields: b[0] ? Object.keys(b[0]) : [],
      sample: b.slice(0, take),
      // 지역/항목 구별에 쓸 후보값 분포 — 어떤 컬럼이 시군구인지 한눈에
      distinct: b[0] ? Object.fromEntries(['C1_NM','C2_NM','ITM_NM','PRD_DE','PRD_SE']
        .filter(k => k in b[0])
        .map(k => [k, Array.from(new Set(b.map(x => x[k]))).slice(0, 12)])) : {},
    });
  } catch (e) {
    return res.json({ ok: false, httpStatus: e.response?.status || null,
      error: String(e.message).slice(0, 200),
      body: e.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : null });
  }
});

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
