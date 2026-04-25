/**
 * Cron 엔드포인트 — Vercel Cron (또는 외부 스케줄러) 에서 호출
 *
 * 보안:
 *   - CRON_SECRET 환경변수로 Authorization: Bearer <token> 검증
 *   - Vercel Cron 은 자동으로 `Authorization: Bearer ${CRON_SECRET}` 주입 (Vercel 표준)
 *   - 외부 호출자가 강제 실행하는 것을 차단
 *
 * 엔드포인트:
 *   - POST /api/cron/retention — 소프트 삭제 만료 hard delete + search/chat 파기
 *
 * 주의:
 *   - 서버리스 함수 타임아웃(10s Hobby / 60s Pro) 내 처리 안 되면 다음 tick 이 이어받음
 *   - retention.js 는 한 번에 100명까지만 처리하도록 제한되어 있어 반복 호출 안전
 */
const express = require('express');
const logger = require('../logger');
const { run: runRetention } = require('../jobs/retention');
const { runMolitIngest } = require('../jobs/molitIngest');
const { runAptMasterSync } = require('../jobs/aptMasterSync');

const router = express.Router();

function authorizeCron(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 운영 환경에서 누락된 경우 — 403 으로 완전 차단 (잘못된 배포 시 공개 실행 방지)
    logger.error('CRON_SECRET 미설정 — cron 엔드포인트 비활성');
    return res.status(403).json({ error: 'cron 엔드포인트가 비활성화되어 있습니다.' });
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || h.slice(7).trim() !== secret) {
    return res.status(401).json({ error: 'cron 인증 실패' });
  }
  next();
}

router.use(authorizeCron);

router.post('/retention', async (req, res) => {
  try {
    const started = Date.now();
    const summary = await runRetention();
    logger.info({ durationMs: Date.now() - started }, 'cron/retention OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/retention 실패');
    res.status(500).json({ error: e.message });
  }
});

// GET 은 Vercel 의 수동 트리거/헬스체크용 (Vercel Cron 은 POST 가 기본이지만 두 방식 모두 지원)
router.get('/retention', async (req, res) => {
  try {
    const summary = await runRetention();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MOLIT 실거래가 ETL ─────────────────────────────────────
// 매일 17:00 KST — 최근 2개월 × 32 region 갱신
async function handleMolitIngest(req, res) {
  try {
    const started = Date.now();
    // Phase 4 (2026-04-26): backfill 지원 — ?months=12&offsetMonths=0 등
    //   기본 cron: 최근 3개월 (정정거래 + 늦게 등록 거래 보정)
    //   12개월 backfill 분할 예: ?months=6&offsetMonths=0 (최근 6) + ?months=6&offsetMonths=6 (그 이전 6)
    const opts = {
      months: req.query.months ? parseInt(req.query.months) : undefined,
      offsetMonths: req.query.offsetMonths ? parseInt(req.query.offsetMonths) : undefined,
    };
    const summary = await runMolitIngest(opts);
    logger.info({ durationMs: Date.now() - started, opts, summary: {
      ok: summary.ok, err: summary.err, skipped: summary.skipped,
      monthsRange: summary.monthsRange,
    }}, 'cron/molit-ingest OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/molit-ingest 실패');
    res.status(500).json({ error: e.message });
  }
}
router.post('/molit-ingest', handleMolitIngest);
router.get('/molit-ingest', handleMolitIngest);

// ── 단지 마스터 동기화 (Phase 4, 2026-04-26) ────────────────
// 주 1회 (월 03:00 KST) — AptInfo 로 sgg 별 단지 목록 적재 (멱등).
async function handleAptMasterSync(req, res) {
  try {
    const started = Date.now();
    const summary = await runAptMasterSync();
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/apt-master-sync OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/apt-master-sync 실패');
    res.status(500).json({ error: e.message });
  }
}
router.post('/apt-master-sync', handleAptMasterSync);
router.get('/apt-master-sync', handleAptMasterSync);

module.exports = router;
