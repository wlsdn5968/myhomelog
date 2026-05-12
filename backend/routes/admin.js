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
    res.status(500).json({ error: e.message });
  }
});

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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
