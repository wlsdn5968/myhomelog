'use strict';
const cache = require('../cache');
const logger = require('../logger');

// DATA-COUNTS-2026-06-14: 랜딩/배너 표시 건수 동적화(하드코딩 stale 방지). 일 단위 변동(MOLIT ingest) → node-cache 6h, head:true(행 미전송이라 가벼움).
// HEALTH-PERF+SYNCTIME-2026-07-25 (Sprint VVVVVV):
//   [문제 1 — 성능] 위 6h node-cache 는 **서버리스에서 공유되지 않는다**(Sprint TTTTTT-3 과 동일 클래스).
//     `/api/health` 는 모든 페이지 로드에서 호출되는데, 프로덕션 5회 연속 실측이 632~793ms 로
//     캐시가 사실상 안 먹고 있었다. 원인은 exact count 2건 — EXPLAIN ANALYZE 로 molit COUNT(*) 가
//     **781ms**(168,964행 × 2 워커 Index Only Scan, Heap Fetches 169,698). 즉 초기 로딩에 직격.
//     → Redis 2차 캐시로 인스턴스 간 공유. 미설정 시 rget/rset 이 no-op → 기존 동작 폴백.
//   [문제 2 — 정확성] 프론트 배너 "마지막 데이터 동기화"가 `health.timestamp`(= 응답 생성 시각 = 지금)를
//     쓰고 있어 **언제 접속하든 항상 '방금 갱신됨'** 으로 보였다. 데이터가 며칠 안 들어와도 알 수 없는
//     허위 신뢰 시그널(절대 룰 ② 위반). → 실제 최신 적재 시각(molit ingested_at 최대값)을 함께 반환.
//   SYNC-SOURCE-2026-09-26 (Plan 113): 위 "MAX(ingested_at) 은 인덱스 없이 975ms" 문단은 34만 행 시절
//     실측이라 지금은 사실이 아니다 — 476,716행 기준 웜 EXPLAIN ANALYZE 재실측은 3,945ms(Parallel Seq
//     Scan)다. PostgREST 접속 역할 authenticator 의 statement_timeout 8s 에 콜드스타트·동시부하로
//     걸리면 supabase-js 는 throw 없이 {data:null} 을 주고, 그 null 이 6시간 캐시(메모리+Redis)에 굳어
//     랜딩·브리핑의 "동기화" 표기가 조용히 사라졌다(2026-09-26 실사고). ingested_at 인덱스 추가는
//     여전히 하지 않는다(DDL, ≈4MB) — 같은 의미("마지막 성공 적재 시각")를 이미 인덱스가 있는
//     molit_ingest_runs.finished_at(status='ok', max(ingested_at)과 4초 차)으로 소스만 바꿨다.
// TX-HIST-MERGE-2026-09-26 (Plan 107b-1/B4): `opts.includeHist` 는 **opt-in**이다(기본 false —
//   기존 시그니처·반환 모양 불변). 왜 매개변수로 뒀는가: 이 함수 하나가 CK 캐시를 채우는 유일한
//   경로이고 브리핑·OG 이미지는 그 캐시를 직접 읽으므로(server.js:660 의 호출부만 고치면
//   3소비처 전부에 반영된다는 계획 취지 그대로), 반면 `backend/test/data-counts-sync.test.js`
//   (Plan 113)가 `_getDataCounts()`를 인자 없이 불러 "admin.from() 정확히 3회·반환 객체
//   {tx,apt,lastIngestedAt} 정확히 3키"를 고정해 뒀다 — 이 테스트는 건드리지 않는다(절대 규칙).
//   기본값 false 로 두면 그 테스트의 경로는 100% 그대로이고, 실제 서비스 호출부만 true 를 넘겨
//   이력 합산을 받는다.
async function getDataCounts(opts) {
  const includeHist = !!(opts && opts.includeHist);
  const CK = 'meta:dataCounts:v2';
  const hit = cache.get(CK);
  if (hit) return hit;
  const redisCache = require('./redisCache');
  if (!opts || !opts.skipRedis) {
    try {
      const rHit = await redisCache.rget(CK);
      // SYNC-SOURCE-2026-09-26 (Plan 113): rHit.lastIngestedAt 이 null 이면 과거 실패가 굳은 오염 캐시다 —
      //   히트로 쓰지 말고 미스로 취급해 아래 DB 재조회로 넘어간다(Redis 오염 복구, 배포 후 6시간 대기 방지).
      if (rHit && rHit.lastIngestedAt) { cache.set(CK, rHit, 21600); return rHit; }
    } catch (_) { /* Redis 실패는 무시하고 DB 조회 */ }
  }
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const [tx, apt, lastIngest] = await Promise.all([
      admin.from('molit_transactions').select('*', { count: 'exact', head: true }),
      admin.from('apt_master').select('*', { count: 'exact', head: true }),
      // SYNC-SOURCE-2026-09-26 (Plan 113): 종전에는 ingested_at 컬럼을 내림차순 정렬해 최신 1건을
      //   가져왔는데 그 컬럼에 인덱스가 없어 476K 행 병렬 seq scan(웜 3,945ms 실측)이라
      //   authenticator 의 statement_timeout 8s 에 걸리면
      //   null 이 6시간 캐시에 굳었다(2026-09-26 실사고 — 랜딩·브리핑 "동기화" 표기 소실).
      //   마지막 성공 적재 시각은 molit_ingest_runs 가 이미 갖고 있다(7K 행·status 인덱스, 4초 차).
      admin.from('molit_ingest_runs').select('finished_at').eq('status', 'ok')
        .order('finished_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const txLive = tx.count || 0;
    const out = {
      tx: txLive,
      apt: apt.count || 0,
      // ISO 문자열 또는 null. 프론트는 null 이면 "언제 갱신됐는지" 표기를 아예 하지 않는다.
      lastIngestedAt: lastIngest?.data?.finished_at || null,
    };
    // TX-HIST-MERGE-2026-09-26 (Plan 107b-1/B4): "실거래 누적"(랜딩·브리핑·OG 이미지)이 원본만
    //   세고 있었다 — 107c 로 원본을 16개월 창으로 자르면 누적 숫자가 갑자기 줄어든 것처럼 보인다.
    //   협폭 이력(molit_transactions_hist, 129만 행·인덱스 없음) count(*) 는 매 요청마다 부르면
    //   안 되므로 이 CK 캐시가 미스할 때(≈6시간에 1회)만 딱 1번 부른다. 실패하면 0 으로 지어내지
    //   않고 직전 성공값(HIST_CK, 24h)을 재사용 — 그마저 없으면 txHistUnknown 을 실어 tx 는
    //   원본(txLive)만 유지한다(프론트가 "누적" 대신 "원본"이라고 쓸 수 있게).
    if (includeHist) {
      out.txLive = txLive;
      const HIST_CK = 'meta:dataCounts:txHistCount:v1';
      try {
        const hist = await admin.from('molit_transactions_hist').select('*', { count: 'exact', head: true });
        if (hist.error) throw hist.error;
        const txHist = hist.count || 0;
        out.txHist = txHist;
        out.tx = txLive + txHist;
        cache.set(HIST_CK, txHist, 86400); // 24h — 다음 실패 때 재사용할 "직전 캐시값"
      } catch (e) {
        const prevHist = cache.get(HIST_CK);
        if (typeof prevHist === 'number') { out.txHist = prevHist; out.tx = txLive + prevHist; }
        else { out.txHistUnknown = true; } // tx 는 txLive 그대로 — 이력을 지어내지 않는다
        logger.warn({ err: e.message }, 'molit_transactions_hist count 실패 — 직전 캐시 또는 원본만 사용');
      }
    }
    // SYNC-SOURCE-2026-09-26 (Plan 113): 실패(null)를 6시간 캐시에 굳히지 않는다 — 60초만 메모리에 두고
    //   Redis 에는 쓰지 않아 다음 요청이 곧바로 재시도하게 한다.
    // COUNTS-ERR-2026-10-18 (Plan 158): 건수 조회가 실패하면 0 이 6시간 캐시·Redis 에 굳었다(Plan 113 과 같은 클래스).
    const countsFailed = !!(tx.error || apt.error);
    if (countsFailed) logger.warn({ txErr: tx.error?.message, aptErr: apt.error?.message }, 'getDataCounts: 건수 조회 실패 — 60초만 캐시');
    const cacheOk = out.lastIngestedAt && !countsFailed;
    const ttl = cacheOk ? 21600 : 60;
    cache.set(CK, out, ttl);
    if (cacheOk) redisCache.rset(CK, out, 21600).catch(() => {}); // 인스턴스 간 공유(fire-and-forget)
    return out;
  } catch (e) { return null; }
}

// DATA-QUALITY-MONITOR-2026-07-12 (Sprint AAAAA, 운영자 "이런 에러 사전 자동검출 — 일일이 안 찾게"):
//   apt_master.facility 데이터 품질 지표. 주차(_dtl) 누락·세대수 0·KAPT 조회실패(_empty)·facility 없음을
//   카운트해 /api/health 로 노출 + warn 플래그(임계 초과). count head 쿼리 5개(6h 캐시)라 부하 무시.
//   ⚠ 조건은 검증된 SQL 과 동일(주차누락 dtl null·세대수0 kaptdaCnt 0/null·_empty 키 존재). 배포 후 실측 대조.
async function getFacilityQuality() {
  const CK = 'meta:facilityQuality';
  const hit = cache.get(CK);
  if (hit) return hit;
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const H = () => ['*', { count: 'exact', head: true }];
    // HH-BR-OBSERV-2026-08-17 (Sprint MMMMMMM-26): 아래 emptyFetch·householdsZero 는 **KAPT 커버리지**를
    //   재는 지표다. 건축물대장으로 세대수를 채워도(Sprint MMMMMMM-23) 그 두 수치는 그대로 남는다 —
    //   KAPT 가 여전히 못 준 것은 사실이기 때문이다. 그래서 지표만 보면 "407곳 미확인" 이 영원히 유지되고
    //   실제로 해소된 몫이 보이지 않는다. crons.brWritten 은 **그 회차 처리량**이라 누계를 알 수 없다.
    //   → 두 모집단 **안에서** 건축물대장으로 해소된 수를 따로 세어 '실질 미확인' 을 함께 낸다.
    //   ⚠ `_br` 전체를 세면 안 된다 — KAPT 가 나중에 성공한 행도 `_br` 을 보존하므로(재조회 시 유실 방지)
    //     모집단 밖 행까지 빼게 되어 실질 미확인이 과소 집계된다. 반드시 각 조건과 AND 로 묶어 센다.
    const [total, facNull, empty, dtlMissing, hhZero, brInEmpty, brInZero] = await Promise.all([
      admin.from('apt_master').select(...H()),
      admin.from('apt_master').select(...H()).is('facility', null),
      admin.from('apt_master').select(...H()).not('facility->_empty', 'is', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null).is('facility->_dtl', null),
      // HH-HOCNT-FALLBACK-2026-07-14 (Sprint IIIII): hoCnt fallback 도입 후 "세대수 미상"은 kaptdaCnt·hoCnt 둘 다
      //   무효인 경우만(실측 346→16). 두 .or() 는 PostgREST 에서 AND 로 결합.
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null)
        .or('facility->>kaptdaCnt.eq.0,facility->>kaptdaCnt.is.null')
        .or('facility->>hoCnt.eq.0,facility->>hoCnt.is.null'),
      // 위 두 모집단 **안에서** 건축물대장으로 세대수가 채워진 수 (각 조건과 AND).
      admin.from('apt_master').select(...H()).not('facility->_empty', 'is', null).not('facility->_br', 'is', null),
      admin.from('apt_master').select(...H()).not('facility', 'is', null).is('facility->_empty', null)
        .or('facility->>kaptdaCnt.eq.0,facility->>kaptdaCnt.is.null')
        .or('facility->>hoCnt.eq.0,facility->>hoCnt.is.null')
        .not('facility->_br', 'is', null),
    ]);
    // FACQ-ERR-2026-10-18 (Plan 161): count 오류를 || 0 으로 버려 실패 시 0 이 6시간 굳었다(Plan 158 과 같은 클래스).
    const _errs = [total, facNull, empty, dtlMissing, hhZero, brInEmpty, brInZero].filter(x => x && x.error).map(x => x.error.message);
    if (_errs.length) {
      logger.warn({ errs: _errs }, 'facilityQuality: 건수 조회 실패 — 캐시하지 않음');
      return null;
    }
    const t = total.count || 0;
    const dtl = dtlMissing.count || 0, hh = hhZero.count || 0, emp = empty.count || 0, fnull = facNull.count || 0;
    const brE = brInEmpty.count || 0, brZ = brInZero.count || 0;
    // 실질 미확인 = KAPT 도 건축물대장도 세대수를 못 준 수. 음수 방어(모집단 정의가 바뀌어도 안전).
    const hhUnknown = Math.max(0, (emp - brE)) + Math.max(0, (hh - brZ));
    const dtlPct = t > 0 ? Math.round((dtl / t) * 100) : null;
    const out = {
      total: t,
      facilityNull: fnull,          // facility 미적재 (백필 대상)
      emptyFetch: emp,              // KAPT 조회 실패 sentinel (건축물대장으로 채워져도 이 값은 유지된다)
      parkingMissing: dtl,          // 주차(_dtl) 누락 → 주차필터 제외 원인
      parkingMissingPct: dtlPct,
      householdsZero: hh,           // KAPT 세대수 0/null
      // HH-BR-OBSERV-2026-08-17: 위 두 수치는 **KAPT 커버리지**라 건축물대장 보강 뒤에도 안 줄어든다.
      //   실제로 화면에 세대수가 뜨는지는 아래 두 값이 말해준다.
      householdsFilledByBr: brE + brZ,   // 건축물대장으로 해소된 누계
      householdsUnknown: hhUnknown,      // 어느 원천으로도 못 채운 실질 미확인
      warn: (dtlPct != null && dtlPct >= 15) || hhUnknown >= 50 || fnull >= 10,
    };
    // ALERT-DEDUP-FIX-2026-07-14 (Sprint HHHHH-3, Sentry NODE-4 107 events 실측): health 경로 captureMessage 는
    //   서버리스 인스턴스별 캐시라 dedup 불가(인스턴스 수만큼 발생) + 주간 apt-master-sync 의 신규 단지 유입
    //   (facilityNull 0→3,452)이 임계를 상시 초과 → 경보 스팸. 경보는 facility-backfill cron(일 1회) 종료 시로
    //   이동(facilityBackfill.js) — health 는 지표 노출만.
    cache.set(CK, out, 21600); // 6h — 데이터 품질은 일 단위 완만 변동(백필 cron 이후 갱신)
    return out;
  } catch (e) { return null; }
}

// HEALTH-SNAPSHOT-2026-10-18 (Plan 161): 새 인스턴스가 첫 health 에서 무거운 count 10개를 동시에 날려
//   배포 직후 DB 가 포화(statement_timeout 8s 초과 500, 운영 로그 실측)됐다. 건수는 하루 1회 적재 뒤에만 바뀌므로
//   retention cron(18:00 UTC)이 한 번 세어 computed_snapshots 에 두고, health 는 그 한 행만 읽는다.
const SNAP_COUNTS = 'health:dataCounts:v1';
const SNAP_FACQ = 'health:facilityQuality:v1';

/** cron 전용 — 캐시를 비우고 실제로 다시 센 뒤 성공한 값만 스냅샷에 둔다. 절대 throw 하지 않는다. */
async function refreshHealthSnapshots() {
  const out = { counts: false, facility: false };
  try {
    const { putSnapshot } = require('./snapshotStore');
    cache.del('meta:dataCounts:v2');
    const dc = await getDataCounts({ includeHist: true, skipRedis: true });
    // txLive(원본 건수)로 판정 — tx 는 이력 합산이라 원본 count 가 실패(0)해도 양수가 된다.
    if (dc && dc.lastIngestedAt && Number(dc.txLive != null ? dc.txLive : dc.tx) > 0 && Number(dc.apt) > 0) { await putSnapshot(SNAP_COUNTS, dc); out.counts = true; }
    cache.del('meta:facilityQuality');
    const fq = await getFacilityQuality();
    if (fq && Number(fq.total) > 0) { await putSnapshot(SNAP_FACQ, fq); out.facility = true; }
  } catch (e) { logger.warn({ err: e && e.message }, 'health 스냅샷 갱신 실패'); }
  return out;
}

/** health 전용 — 메모리 → 스냅샷(한 행) → (스냅샷이 아직 없을 때만) 기존 실시간 계산. */
async function readDataCounts() {
  const hit = cache.get('meta:dataCounts:v2');
  if (hit) return hit;
  try {
    const { getLastSnapshot } = require('./snapshotStore');
    const s = await getLastSnapshot(SNAP_COUNTS);
    if (s && s.payload && s.payload.lastIngestedAt) {
      cache.set('meta:dataCounts:v2', s.payload, 1800); // 30분 — 같은 키를 읽는 브리핑도 그대로 쓴다
      return s.payload;
    }
  } catch (_) { /* 스냅샷 실패는 아래 기존 경로로 */ }
  return getDataCounts({ includeHist: true });
}

/** health 전용 — 메모리 → 스냅샷. 둘 다 없으면 null 을 주고 (스냅샷이 아예 없을 때만) 백그라운드 계산. */
async function readFacilityQuality() {
  const hit = cache.get('meta:facilityQuality');
  if (hit !== undefined) return hit;
  try {
    const { getLastSnapshot } = require('./snapshotStore');
    const s = await getLastSnapshot(SNAP_FACQ);
    if (s && s.payload) { cache.set('meta:facilityQuality', s.payload, 1800); return s.payload; }
  } catch (_) { /* 아래로 */ }
  getFacilityQuality().catch(() => {});
  return null;
}

module.exports = { getDataCounts, getFacilityQuality, refreshHealthSnapshots, readDataCounts, readFacilityQuality, SNAP_COUNTS, SNAP_FACQ };
