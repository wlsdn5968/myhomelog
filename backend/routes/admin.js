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
/**
 * GET /api/admin/env-probe — 특정 env 의 "설정 여부"만 확인 (Sprint OOOOOO, 임시 진단)
 *
 * 운영자가 Vercel 에 등록한 키의 **이름을 확정**하기 위한 admin 전용 프로브.
 * ⚠ 값은 절대 반환하지 않는다 — 존재 여부(boolean)와 길이만. 시크릿 노출 경로가 되지 않도록
 *   ①admin 인증 필수(위 requireAdmin) ②이름 화이트리스트(정규식 매칭)만 조회 ③값·앞뒤 일부도 미반환.
 * R-ONE(부동산원 통계) 연동 착수 시 키 이름 확정 후 제거 예정.
 */
router.get('/env-probe', (req, res) => {
  // SCOPE-NARROWED-2026-07-25: 등록명이 REB_RONE_API_KEY 로 확인돼(값은 빈 상태) 전체 env 이름
  //   나열은 제거 — admin 계정이 탈취될 경우의 정보 노출 면적을 줄인다. 대상 키만 존재/길이 확인.
  const PATTERN = /^(REB|RONE|R_ONE)/i;
  const names = Object.keys(process.env).filter(k => PATTERN.test(k));
  res.json({
    matched: names.map(n => ({ name: n, set: !!process.env[n], length: String(process.env[n] || '').length })),
  });
});

/**
 * GET /api/admin/rone-probe — R-ONE(부동산원 통계) API 실호출 검증 (Sprint RRRRRR, 임시 진단)
 *
 * 명세(공식 개발가이드 실측): https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do
 *   필수 STATBL_ID·DTACYCLE_CD·WRTTIME_IDTFR_ID·Type, 인증 파라미터명 = KEY (미지정 시 sample 10건).
 * ⚠ 키 값은 응답·로그 어디에도 싣지 않는다 — 성공 여부와 응답 구조만 반환.
 * 통계표 ID 확정 후 정식 서비스로 옮기고 이 라우트는 제거.
 */
router.get('/rone-probe', async (req, res) => {
  const key = process.env.REB_RONE_API_KEY;
  if (!key) return res.json({ ok: false, reason: 'REB_RONE_API_KEY 미설정' });
  const axios = require('axios');
  // SSRF 차단: 엔드포인트는 화이트리스트 고정(임의 URL 호출 불가). 도메인·경로 모두 코드 상수.
  const EP = {
    data: 'SttsApiTblData.do',   // 통계 데이터 조회
    list: 'SttsApiTbl.do',       // 서비스 통계목록 (통계표 ID 탐색용)
    item: 'SttsApiTblItm.do',    // 통계 세부항목 목록
  };
  const epKey = String(req.query.ep || 'data');
  if (!EP[epKey]) return res.json({ ok: false, reason: `ep 는 ${Object.keys(EP).join('|')} 중 하나` });
  const params = { KEY: key, Type: 'json', pSize: String(req.query.pSize || 20) };
  if (epKey === 'data') {
    params.STATBL_ID = String(req.query.statblId || 'A_2024_00900');
    params.DTACYCLE_CD = String(req.query.cycle || 'YY');
    params.WRTTIME_IDTFR_ID = String(req.query.time || '2022');
  } else {
    if (req.query.statblId) params.STATBL_ID = String(req.query.statblId);
    if (req.query.q) params.STATBL_NM = String(req.query.q); // 명칭 검색(지원 시)
    if (req.query.pIndex) params.pIndex = String(req.query.pIndex);
  }
  try {
    const r = await axios.get(`https://www.reb.or.kr/r-one/openapi/${EP[epKey]}`, { params, timeout: 15000 });
    const body = r.data;
    const asStr = typeof body === 'string' ? body : JSON.stringify(body);
    res.json({
      ok: true,
      httpStatus: r.status,
      contentType: r.headers['content-type'] || null,
      // 키가 포함될 여지가 없는 구조 정보만
      topLevelKeys: (body && typeof body === 'object') ? Object.keys(body).slice(0, 10) : null,
      bodyPreview: asStr.slice(0, Math.min(parseInt(req.query.n, 10) || 600, 6000)),
    });
  } catch (e) {
    res.json({ ok: false, httpStatus: e.response?.status || null, error: String(e.message).slice(0, 200),
      bodyPreview: e.response?.data ? String(typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)).slice(0, 400) : null });
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
