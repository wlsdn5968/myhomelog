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

module.exports = router;
