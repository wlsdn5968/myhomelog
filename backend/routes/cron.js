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
const crypto = require('crypto');
const logger = require('../logger');
const { run: runRetention } = require('../jobs/retention');
const { runMolitIngest } = require('../jobs/molitIngest');
const { runAptMasterSync } = require('../jobs/aptMasterSync');
const { run: runRegulationsCheck } = require('../jobs/regulationsCheck');
const { run: runRegulationsAutoFetch } = require('../jobs/regulationsAutoFetch');
// Phase 37 (2026-05-04): AI 기반 정책 자동 분석 + 제안 SQL 생성
const { runFullCheck: runRegulationsAiCheck } = require('../jobs/regulationsAiCheck');
const { run: runAuditPrune } = require('../jobs/auditPrune');
// STAB-AUDIT-2026-05-06: apt_geocache 점진 백필 (172 → 16K 점진 채우기)
const { run: runGeocacheBackfill } = require('../jobs/geocacheBackfill');
// FACILITY-BACKFILL-2026-06-18: apt_master.facility(세대수·주차 등) 점진 백필 — 단지 비교 토대
const { run: runFacilityBackfill } = require('../jobs/facilityBackfill');
// POPULAR-SNAPSHOT-2026-07-11 (Sprint LLLL): 인기 단지 일별 사전집계 (retention cron 에 편승)
const { computeAndStoreSnapshot: computePopularSnapshot } = require('../services/popularService');
// MOB-AUDIT-2026-05-03: cron 실패는 운영자 즉시 알림 — Sentry capture (logger.error 외 추가)
const Sentry = require('@sentry/node');

const router = express.Router();

function authorizeCron(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 운영 환경에서 누락된 경우 — 403 으로 완전 차단 (잘못된 배포 시 공개 실행 방지)
    logger.error('CRON_SECRET 미설정 — cron 엔드포인트 비활성');
    return res.status(403).json({ error: 'cron 엔드포인트가 비활성화되어 있습니다.' });
  }
  const h = req.headers.authorization || '';
  // AUDIT-2026-07-05: 상수시간 비교(timingSafeEqual) — 단순 !== 는 조기종료로 타이밍 사이드채널 이론상 노출.
  //   원격 타이밍 공격은 네트워크 지터로 실익 극미하나 정석 방어심층. 길이 다르면 timingSafeEqual 예외 → 사전 길이 체크.
  const provided = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const pb = Buffer.from(provided), sb = Buffer.from(secret);
  if (pb.length !== sb.length || !crypto.timingSafeEqual(pb, sb)) {
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
    // POPULAR-SNAPSHOT-2026-07-11 (Sprint LLLL): 인기 단지 일별 사전집계 — retention(18:00 UTC)은
    //   molit-ingest(17:00 UTC) 1시간 뒤라 신선한 데이터로 계산됨. 실패해도 retention 응답은 ok
    //   (스냅샷은 부가 기능 — /popular 이 라이브 집계로 자체 fallback).
    let popularSnapshot = null;
    try { popularSnapshot = await computePopularSnapshot(); }
    catch (e) { logger.warn({ err: e.message }, 'popular 스냅샷 계산 실패 (retention 은 정상)'); popularSnapshot = { stored: false, err: e.message }; }
    res.json({ ok: true, summary, popularSnapshot });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/retention 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.retention' } }); } catch(_){}
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
// 매일 17:00 UTC (= 익일 02:00 KST) — schedule "0 17 * * *". 최근 2개월 × 32 region 갱신
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
    // 부분 실패 가시화 (2026-05-31): summary.err>0(일부 region-month ingest 실패)는 200 유지 —
    //   molit ingest 는 멱등(dedup_key UNIQUE)이라 다음 cron tick 이 이어받으며, 500 으로 Vercel Cron
    //   재시도를 유발하면 MOLIT 무료 키 쿼터를 재소모하므로 회피. 기존엔 logger.info 만이라 운영자에게
    //   안 보였음 → Sentry.captureMessage(warning) 알림만 추가 (status·재시도·ingest 로직 불변).
    if (summary && summary.err > 0) {
      try {
        Sentry.captureMessage(
          `cron/molit-ingest 부분 실패: ok=${summary.ok} err=${summary.err} skipped=${summary.skipped} range=${summary.monthsRange}`,
          { level: 'warning', tags: { route: 'cron.molit-ingest', partial: 'true' },
            extra: { ok: summary.ok, err: summary.err, skipped: summary.skipped, monthsRange: summary.monthsRange } }
        );
      } catch (_) {}
    }
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/molit-ingest 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.molit-ingest' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/molit-ingest', handleMolitIngest);
router.get('/molit-ingest', handleMolitIngest);

// ── 단지 마스터 동기화 (Phase 4, 2026-04-26) ────────────────
// 주 1회 월 20:00 UTC (= 화 05:00 KST) — schedule "0 20 * * 1". AptInfo 로 sgg 별 단지 목록 적재 (멱등).
async function handleAptMasterSync(req, res) {
  try {
    const started = Date.now();
    const summary = await runAptMasterSync();
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/apt-master-sync OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/apt-master-sync 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.apt-master-sync' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/apt-master-sync', handleAptMasterSync);
router.get('/apt-master-sync', handleAptMasterSync);

// ── Phase 18 (2026-05-04): regulations stale 자동 검증 ───────
// 매일 21:00 UTC (= 익일 06:00 KST) — schedule "0 21 * * *" (월요일엔 apt-master-sync 1시간 후)
async function handleRegulationsCheck(req, res) {
  try {
    const started = Date.now();
    const summary = await runRegulationsCheck();
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/regulations-check OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/regulations-check 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.regulations-check' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/regulations-check', handleRegulationsCheck);
router.get('/regulations-check', handleRegulationsCheck);

// ── Phase 20 + 37 (2026-05-04): regulations 자동 fetch + AI 분석 ──
// 매일 21:30 UTC (= 익일 06:30 KST) — schedule "30 21 * * *" (정책 발표 후)
// Phase 37: RSS fetch (Phase 20) + Claude AI 분석 + 제안 SQL 생성
async function handleRegulationsAutoFetch(req, res) {
  try {
    const started = Date.now();
    const result = await runRegulationsAiCheck();
    logger.info({
      durationMs: Date.now() - started,
      totalMatched: result.rssResults.totalMatched,
      aiHighConfidence: result.aiResults.highConfidenceCount,
    }, 'cron/regulations-auto-fetch OK');
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/regulations-auto-fetch 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.regulations-auto-fetch' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/regulations-auto-fetch', handleRegulationsAutoFetch);
router.get('/regulations-auto-fetch', handleRegulationsAutoFetch);

// ── Phase 33 #5 (2026-05-04): audit_log 자동 정리 (pg_cron fallback) ──
async function handleAuditPrune(req, res) {
  try {
    const started = Date.now();
    const summary = await runAuditPrune();
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/audit-prune OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/audit-prune 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.audit-prune' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/audit-prune', handleAuditPrune);
router.get('/audit-prune', handleAuditPrune);

// ── STAB-AUDIT-2026-05-06: apt_geocache 점진 백필 ─────────────
// 매일 1회 04:00 UTC (= 13:00 KST) — vercel.json crons "0 4 * * *" (Hobby plan: daily 만 허용).
// 1회 호출 = budgetMs(기본 240s, 핸들러는 chunk/daysBack 만 전달) 안에서 50건/chunk multi-chunk loop.
// 월 외부 geocoding quota 사용량은 런타임 가변(chunk 수 × 외부 응답 latency) — 고정 산정 불가.
// 운영자 발견 (2026-05-06): apt_geocache 172/16,044 = 1% coverage → 99% 마커 미표시
async function handleGeocacheBackfill(req, res) {
  try {
    const started = Date.now();
    const opts = {
      chunk: req.query.chunk ? parseInt(req.query.chunk) : undefined,
      daysBack: req.query.daysBack ? parseInt(req.query.daysBack) : undefined,
    };
    const summary = await runGeocacheBackfill(opts);
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/geocache-backfill OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/geocache-backfill 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.geocache-backfill' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/geocache-backfill', handleGeocacheBackfill);
router.get('/geocache-backfill', handleGeocacheBackfill);

// ── FACILITY-BACKFILL-2026-06-18: apt_master.facility 점진 백필 (단지 비교 토대) ──
// 매일 1회 05:00 UTC (= 14:00 KST) — geocache(04:00) 1시간 후. KAPT BasisInfo + DTL(주차) 적재.
// 운영자 발견 (2026-06-18): facility 140/10,107 = 1.39% + 주차 0% → 세대당주차·세대수 비교 불가였음.
async function handleFacilityBackfill(req, res) {
  try {
    const started = Date.now();
    const opts = { chunk: req.query.chunk ? parseInt(req.query.chunk) : undefined };
    const summary = await runFacilityBackfill(opts);
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/facility-backfill OK');
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/facility-backfill 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.facility-backfill' } }); } catch(_){}
    res.status(500).json({ error: e.message });
  }
}
router.post('/facility-backfill', handleFacilityBackfill);
router.get('/facility-backfill', handleFacilityBackfill);

module.exports = router;
