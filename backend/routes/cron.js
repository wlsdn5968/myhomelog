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

// MV-ABORT-2026-08-16 (Plan 011): 검색용 MV 갱신 RPC 의 상한.
//   [측정] `REFRESH MATERIALIZED VIEW CONCURRENTLY molit_apt_index` 실소요 = **11,451ms**
//   (2026-08-16 프로덕션 실측, clock_timestamp 차이). 여기에 여유를 크게 둬 60s 로 잡는다.
//   [왜 필요한가] 상한이 없으면 갱신 지연 시 이 await 가 함수 maxDuration(300s)까지 붙잡아,
//   뒤따르는 recordCronRun·res.json 이 아예 실행되지 않는다 — **적재가 성공했어도 그날 cron
//   실행 기록 자체가 health 에 안 남는다**(필드 누락이 아니라 레코드 부재).
//   [겹침 위험] molit-ingest 는 slot 3개가 15분 간격으로 돌고 같은 MV 를 갱신한다.
//   CONCURRENTLY 는 선행 갱신이 끝날 때까지 대기하므로 겹치면 대기 시간이 실제로 늘어난다.
const MV_REFRESH_ABORT_MS = 60000;

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

// FRESHNESS-2026-08-08 (Sprint AAAAAAA): 실거래 적재 신선도 감시 — retention cron(18:00 UTC, molit 1h 후)에 편승.
//   실사고: 08-02 부터 molit ingest 가 전면 실패(적재 0)했는데 6일간 아무도 몰랐다. cron 자체가 안 도는
//   경우(스케줄 소실)는 molit 핸들러 안의 어떤 경보도 발동할 수 없다 — **다른 cron 이 데이터로 감시**해야 한다.
//   MAX(ingested_at) 48h 초과 시 Sentry error(고정 메시지 = 이슈 그룹 유지, 가변값은 extra). 실패는 삼킨다.
async function checkIngestFreshness() {
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const { data } = await admin.from('molit_transactions')
      .select('ingested_at').order('ingested_at', { ascending: false }).limit(1).maybeSingle();
    const last = data && data.ingested_at ? new Date(data.ingested_at).getTime() : null;
    if (!last) return; // 판단 불가 시 침묵(오탐 방지)
    const hours = Math.round((Date.now() - last) / 3600000);
    if (hours >= 48) {
      Sentry.captureMessage('cron 감시: 실거래 적재가 48시간 이상 정체 — molit cron·API 키 확인 필요', {
        level: 'error', tags: { route: 'cron.retention', monitor: 'data-freshness' },
        extra: { lastIngestedAt: data.ingested_at, staleHours: hours },
      });
      logger.error({ lastIngestedAt: data.ingested_at, staleHours: hours }, '실거래 적재 정체 감지');
    }
  } catch (e) { logger.warn({ err: e.message }, '적재 신선도 점검 실패(무시)'); }
}

// CRON-STALE-2026-08-17 (Sprint MMMMMMM-12): "안 돈 cron" 감시 — checkIngestFreshness 의 형제.
//   저건 **데이터**(적재 신선도)를 보고, 이건 **실행 기록**을 본다. 2026-08-16 실측에서 cron 3종이
//   기록 없이 사라졌는데 Sentry 오류도 0건이라 실패인지 미실행인지 구별조차 못 했다.
//   ⚠ 한계: 이 점검 자체가 retention cron 에 얹혀 있으므로 retention 이 안 돌면 그날은 점검도 안 된다.
//     그래도 매일 돌기 때문에 누락은 하루 늦어질 뿐 영구 은폐되지는 않는다. 실패는 삼킨다.
async function checkCronStaleness() {
  try {
    const { getCronLatest, findStaleCrons } = require('../services/cronStats');
    const latest = await getCronLatest();
    if (!latest) return;                       // Redis 미설정·조회 실패 → 침묵(오탐 방지)
    const { stale, never } = findStaleCrons(latest, Date.now());
    if (!stale.length) return;
    // 고정 메시지 = Sentry 이슈 그룹 유지. 가변값은 extra 로 (checkIngestFreshness 와 동일 규약).
    Sentry.captureMessage('cron 감시: 예정된 cron 이 기대 주기를 넘도록 실행되지 않음 — 스케줄·배포 확인 필요', {
      level: 'error', tags: { route: 'cron.retention', monitor: 'cron-staleness' },
      extra: { stale, neverRecorded: never },
    });
    logger.error({ stale, never }, 'cron 미실행 감지');
  } catch (e) { logger.warn({ err: e.message }, 'cron 미실행 점검 실패(무시)'); }
}

router.post('/retention', async (req, res) => {
  try {
    const started = Date.now();
    const summary = await runRetention();
    logger.info({ durationMs: Date.now() - started }, 'cron/retention OK');
    // Sprint MMMMMMM-12: retention 자신의 실행 기록 — 종전엔 popular-snapshot 만 남아
    //   "retention 이 돌았는가" 를 스냅샷 성패로 유추해야 했다.
    await require('../services/cronStats').recordCronRun('retention', summary).catch(() => {});
    // POPULAR-SNAPSHOT-2026-07-11 (Sprint LLLL): 인기 단지 일별 사전집계 — retention(18:00 UTC)은
    //   molit-ingest(17:00 UTC) 1시간 뒤라 신선한 데이터로 계산됨. 실패해도 retention 응답은 ok
    //   (스냅샷은 부가 기능 — /popular 이 라이브 집계로 자체 fallback).
    let popularSnapshot = null;
    try { popularSnapshot = await computePopularSnapshot(); }
    catch (e) { logger.warn({ err: e.message }, 'popular 스냅샷 계산 실패 (retention 은 정상)'); popularSnapshot = { stored: false, err: e.message }; }
    // SNAP-OBSERV-2026-08-08 (Sprint BBBBBBB-4): 스냅샷 갱신 성패를 health.crons 로 — cron 이
    //   조용히 스킵(usedFallback)을 반복해 스냅샷이 노화되던 것을 아무도 못 봤다(NODE-9 순환의 축).
    await require('../services/cronStats').recordCronRun('popular-snapshot', {
      ok: popularSnapshot && popularSnapshot.stored ? 1 : false,
      processed: popularSnapshot && popularSnapshot.count,
      error: (popularSnapshot && (popularSnapshot.reason || popularSnapshot.err
        || (popularSnapshot.usedFallback ? 'usedFallback(RPC 실패)' : undefined))) || undefined,
    }).catch(() => {});
    await checkIngestFreshness(); // Sprint AAAAAAA — 적재 정체 감시(실패는 내부에서 삼킴)
    await checkCronStaleness();   // Sprint MMMMMMM-12 — 안 돈 cron 감시
    // RATE-WARM-2026-08-08 (Sprint BBBBBBB-3): HF·ECOS 금리 캐시 워밍 — health 의 비차단 백그라운드
    //   갱신은 응답 반환 후 서버리스 동결로 완주가 안 될 수 있다(HF 실측: 12:01 까지 반복 ECONNABORTED,
    //   신규 실패 기록조차 없는 "잘림" 상태). 요청 경로인 여기서 하루 1회 완주시켜 Redis 에 남기면
    //   전 인스턴스가 12h 공유한다. 실패해도 retention 은 정상(삼킴).
    try { await require('../services/hfService').getHfRates(); } catch (_) {}
    try { await require('../services/ecosService').getEcosRates(); } catch (_) {}
    res.json({ ok: true, summary, popularSnapshot });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/retention 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.retention' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('retention', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12
    res.status(500).json({ error: e.message });
  }
});

// GET 은 Vercel 의 수동 트리거/헬스체크용 (Vercel Cron 은 POST 가 기본이지만 두 방식 모두 지원)
router.get('/retention', async (req, res) => {
  try {
    const summary = await runRetention();
    await require('../services/cronStats').recordCronRun('retention', summary).catch(() => {}); // Sprint MMMMMMM-12
    // GET-PARITY-2026-08-09 (Sprint BBBBBBB-5, 실측): popular 스냅샷 계산이 **POST 쌍둥이에만** 있었는데
    //   스냅샷 도입(7/11) 이래 computed_at 이 cron 시각(18:00 UTC)이었던 적이 없다 — Vercel cron 이
    //   이 GET 을 호출하고 있어 **cron 스냅샷 갱신이 한 번도 실행되지 않았다**는 실측 정합(NODE-9 노화
    //   순환의 진짜 뿌리). 메서드 논쟁과 무관하게 두 쌍둥이를 동일하게 맞춘다.
    let popularSnapshot = null;
    try { popularSnapshot = await computePopularSnapshot(); }
    catch (e) { logger.warn({ err: e.message }, 'popular 스냅샷 계산 실패 (retention 은 정상)'); popularSnapshot = { stored: false, err: e.message }; }
    await require('../services/cronStats').recordCronRun('popular-snapshot', {
      ok: popularSnapshot && popularSnapshot.stored ? 1 : false,
      processed: popularSnapshot && popularSnapshot.count,
      error: (popularSnapshot && (popularSnapshot.reason || popularSnapshot.err
        || (popularSnapshot.usedFallback ? 'usedFallback(RPC 실패)' : undefined))) || undefined,
    }).catch(() => {});
    await checkIngestFreshness(); // Sprint AAAAAAA — 적재 정체 감시
    await checkCronStaleness();   // Sprint MMMMMMM-12 — 안 돈 cron 감시(POST 쌍둥이와 동일)
    try { await require('../services/hfService').getHfRates(); } catch (_) {}   // Sprint BBBBBBB-3 워밍
    try { await require('../services/ecosService').getEcosRates(); } catch (_) {}
    res.json({ ok: true, summary, popularSnapshot });
  } catch (e) {
    // SENTRY-GAP-2026-07-17 (Sprint XXXXX): POST 쌍둥이(72행)만 캡처하고 GET 은 무로그·무캡처였음 — 동일 처리
    logger.error({ err: e.message, stack: e.stack }, 'cron/retention(GET) 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.retention' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('retention', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12 (POST 쌍둥이와 동일)
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
      // REGION-CHUNK-2026-07-12 (Sprint VVVV): 지역 자동분할 — 커버리지 확장으로 지역수↑ 시 maxDuration 300s
      //   초과 방지. vercel.json 이 slot=0..slotCount-1 을 스태거 스케줄로 호출 → 각 슬롯은 지역의 1/slotCount 만.
      slot: req.query.slot != null ? parseInt(req.query.slot) : undefined,
      slotCount: req.query.slotCount != null ? parseInt(req.query.slotCount) : undefined,
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
        // FULLFAIL-2026-08-08 (Sprint AAAAAAA): ok=0(적재 0건 = 전면 실패)은 '부분 실패' warning 과
        //   분리해 **error 레벨 별도 이슈**로 — 08-02~08-08 전면 중단이 기존 warning 이슈에 묻혀
        //   6일간 인지되지 못한 실사고 후속. 메시지는 고정 문자열(가변값은 extra)로 그룹핑 유지.
        const fullFail = summary.ok === 0;
        Sentry.captureMessage(
          fullFail
            ? 'cron/molit-ingest 전면 실패: 적재 0건 — 즉시 확인 필요'
            : `cron/molit-ingest 부분 실패: ok=${summary.ok} err=${summary.err} skipped=${summary.skipped} range=${summary.monthsRange}`,
          { level: fullFail ? 'error' : 'warning', tags: { route: 'cron.molit-ingest', partial: String(!fullFail) },
            extra: { ok: summary.ok, err: summary.err, skipped: summary.skipped, monthsRange: summary.monthsRange,
              firstError: summary.firstError } }
        );
      } catch (_) {}
    }
    // CRON-OBSERV-2026-08-08 (Sprint AAAAAAA): geocache-backfill 과 동일하게 health.crons 로 노출 —
    //   실거래 적재가 며칠 멈춰도 로그(1h 보존)·Sentry 를 안 보면 몰랐다. 숫자+대표 사유만(_pick 화이트리스트).
    // SEARCH-MV-2026-08-16 (Sprint TTTTTTT): 적재 직후 **검색용 MV 갱신**.
    //   자동완성은 이제 molit_apt_index(단지 단위 집계, 22,473행)를 읽는다 — 적재만 하고 갱신을
    //   안 하면 새 거래가 검색에 영영 안 잡힌다. `CONCURRENTLY` 라 갱신 중에도 읽기는 안 막힌다(실측).
    //   ⚠ RPC 는 SECURITY DEFINER 라 service_role 전용이다(anon·authenticated 실행 권한 회수 완료).
    //   실패해도 ingest 응답은 ok — 검색은 직전 스냅샷으로 계속 동작하고 다음 cron 이 재시도한다.
    let _mvRefreshMs;
    try {
      const sc = require('../db/client').getSupabaseAdmin();
      if (!sc) {
        logger.warn('검색 MV 갱신 skip — service_role 미설정(적재는 정상)');
      } else {
        const _t = Date.now();
        const { error: _mvErr } = await sc.rpc('refresh_molit_apt_index')
          .abortSignal(AbortSignal.timeout(MV_REFRESH_ABORT_MS));
        if (_mvErr) logger.warn({ err: _mvErr.message }, '검색 MV 갱신 실패 — 적재는 정상(다음 cron 재시도)');
        else _mvRefreshMs = Date.now() - _t;
      }
    } catch (e) { logger.warn({ err: e.message }, '검색 MV 갱신 예외 — 적재는 정상'); }
    await require('../services/cronStats').recordCronRun('molit-ingest', {
      mvRefreshMs: _mvRefreshMs,
      ok: summary.ok, err: summary.err, skipped: summary.skipped, elapsedMs: summary.elapsedMs,
      retried: summary.gapBackfill && summary.gapBackfill.retried, filled: summary.gapBackfill && summary.gapBackfill.filled,
      error: summary.firstError || summary.reason || undefined, // reason = 키 미설정 skip 케이스
      // ZERO-FETCH-WATCH-2026-08-10 (Sprint KKKKKKK-4): 광주 5개 구 44일 무적재가 status='ok' 라
      //   기존 지표(ok/err)로는 전혀 안 보였다 — 지역 단위 0건을 health 로 올린다.
      slot: summary.slot, regionsCount: summary.regionsCount,
      zeroFetchRegions: summary.zeroFetchRegions, zeroFetchLawds: summary.zeroFetchLawds,
    }).catch(() => {});
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/molit-ingest 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.molit-ingest' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('molit-ingest', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12
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
    await require('../services/cronStats').recordCronRun('apt-master-sync', summary).catch(() => {}); // Sprint MMMMMMM-12
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/apt-master-sync 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.apt-master-sync' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('apt-master-sync', { ok: false, error: e.message }).catch(() => {});
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
    await require('../services/cronStats').recordCronRun('regulations-check', summary).catch(() => {}); // Sprint MMMMMMM-12
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/regulations-check 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.regulations-check' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('regulations-check', { ok: false, error: e.message }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
}
router.post('/regulations-check', handleRegulationsCheck);
router.get('/regulations-check', handleRegulationsCheck);

// ── Phase 20 + 37 (2026-05-04): regulations 자동 fetch + AI 분석 ──
// 매일 21:30 UTC (= 익일 06:30 KST) — schedule "30 21 * * *" (정책 발표 후)
// Phase 37 → REG-ZERO-COST-2026-08-16 (Sprint LLLLLLL): RSS fetch(Phase 20) + **룰베이스** 대조.
//   종전의 Claude 유료 호출·제안 SQL 자동 생성은 제거됐다(법령 SQL 을 추론으로 만들지 않는다).
//   지금은 키워드 맵으로 스냅샷 key 별 RSS 를 대조해 '검토 필요' 건수만 센다 — proposedSQL 은 항상 null.
async function handleRegulationsAutoFetch(req, res) {
  try {
    const started = Date.now();
    const result = await runRegulationsAiCheck();
    logger.info({
      durationMs: Date.now() - started,
      totalMatched: result.rssResults.totalMatched,
      reviewNeeded: result.aiResults.reviewNeededCount,
    }, 'cron/regulations-auto-fetch OK');
    await require('../services/cronStats').recordCronRun('regulations-auto-fetch', {   // Sprint MMMMMMM-12
      ok: 1, processed: result.rssResults && result.rssResults.totalMatched,
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/regulations-auto-fetch 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.regulations-auto-fetch' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('regulations-auto-fetch', { ok: false, error: e.message }).catch(() => {});
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
    await require('../services/cronStats').recordCronRun('audit-prune', summary).catch(() => {}); // Sprint MMMMMMM-12
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/audit-prune 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.audit-prune' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('audit-prune', { ok: false, error: e.message }).catch(() => {});
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
    // CRON-OBSERV-2026-07-25 (Sprint XXXXXX): 위 로그는 **1시간 뒤 사라진다**(Vercel Hobby 보존 1h,
    //   cron 은 하루 1회) → 사후 원인 추적이 원천 불가였다. 실제로 07-13~24 백필 정체를 조사할 때
    //   로그가 없어 DB 행 카운트로 우회해야 했고, 그마저 사용자 온디맨드 지오코딩과 섞여 분리가 어려웠다.
    //   같은 값을 Redis 에 남겨 다음부터는 언제든 확인 가능하게 한다(DB 변경 0·fail-open).
    await require('../services/cronStats').recordCronRun('geocache-backfill', summary).catch(() => {});
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/geocache-backfill 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.geocache-backfill' } }); } catch(_){}
    // Sprint MMMMMMM-12: **실패도 기록한다**. 종전엔 이 저장소의 cron 핸들러 중 실패 경로에
    //   기록을 남기는 것이 **하나도 없었다**(popular-snapshot 만 try 안에서 ok:false 를 남겼다).
    //   그래서 2026-08-16 에 기록이 빈 cron 을 두고 "안 돈 건지 실패한 건지" 를 구별할 수 없었다.
    await require('../services/cronStats').recordCronRun('geocache-backfill', { ok: false, error: e.message }).catch(() => {});
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
    // CRON-OBSERV-2026-08-08 (Sprint AAAAAAA): data.go.kr 3형제(molit·facility·건축물대장) 전부
    //   health.crons 노출 — 08-02 키 장애 때 세 cron 이 동시에 조용히 죽은 것을 아무도 못 봤다.
    await require('../services/cronStats').recordCronRun('facility-backfill', summary).catch(() => {});
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/facility-backfill 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.facility-backfill' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('facility-backfill', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12
    res.status(500).json({ error: e.message });
  }
}
router.post('/facility-backfill', handleFacilityBackfill);
router.get('/facility-backfill', handleFacilityBackfill);

// ── BR-BACKFILL-2026-07-19 (Sprint LLLLLL-4): building_register 세대수 점진 백필 ──
// 매일 1회 06:00 UTC (= 15:00 KST) — facility-backfill(05:00) 1시간 후. 거래 활발 단지의 KAPT 미매칭
// 세대수를 건축물대장으로 미리 채워 추천 콜드 지연 감소. Kakao 쿼터 보호 위해 total cap 보수적(기본 100).
// 게이트: get_br_backfill_candidates 함수 미생성 시 graceful no-op(운영자 SQL 대기).
const { run: runBrBackfill } = require('../jobs/buildingRegisterBackfill');
async function handleBrBackfill(req, res) {
  try {
    const started = Date.now();
    const opts = { cap: req.query.cap ? parseInt(req.query.cap) : undefined };
    const summary = await runBrBackfill(opts);
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/building-register-backfill OK');
    await require('../services/cronStats').recordCronRun('building-register-backfill', summary).catch(() => {}); // Sprint AAAAAAA
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/building-register-backfill 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.building-register-backfill' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('building-register-backfill', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12
    res.status(500).json({ error: e.message });
  }
}
router.post('/building-register-backfill', handleBrBackfill);
router.get('/building-register-backfill', handleBrBackfill);

// ── PUSH-NOTIFY (Sprint EEEEEE): 관심단지 신규 실거래 웹푸시 발송 ──
// 매일 1회 22:30 UTC — molit-ingest 3슬롯(17:00~17:30) 완료 후. 게이트(VAPID env·테이블) 미충족 시 { skipped }.
//   ⚠ 2026-08-17 정정 — 이 주석의 시각이 vercel.json 의 실제 스케줄("30 22 * * *")과 4시간 어긋나 있었다.
//     계약 테스트가 vercel.json 을 읽어 두 값을 묶는다. (옛 값은 테스트의 금지 문자열이라 여기 적지 않는다.)
const { run: runPushNotify } = require('../jobs/pushNotify');
async function handlePushNotify(req, res) {
  try {
    const started = Date.now();
    const summary = await runPushNotify();
    logger.info({ durationMs: Date.now() - started, summary }, 'cron/push-notify OK');
    await require('../services/cronStats').recordCronRun('push-notify', summary).catch(() => {}); // Sprint MMMMMMM-12
    res.json({ ok: true, summary });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/push-notify 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.push-notify' } }); } catch(_){}
    await require('../services/cronStats').recordCronRun('push-notify', { ok: false, error: e.message }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
}
router.post('/push-notify', handlePushNotify);
router.get('/push-notify', handlePushNotify);

module.exports = router;
