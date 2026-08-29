/**
 * building_register 점진 백필 — BR-BACKFILL-2026-07-19 (Sprint LLLLLL-4)
 *
 * 배경:
 *   건축물대장 세대수(getBuildingTitle)는 추천/보고서에서 KAPT 미매칭 후보에 온디맨드로 채워지고
 *   building_register 에 캐시된다(LLLLLL-3). 하지만 아직 검색 안 된 단지는 캐시가 비어 콜드 때
 *   추천이 느리다. 이 cron 이 거래 활발한 단지(6개월 n>=2) 중 캐시 없는 곳을 미리 채운다.
 *
 * 카카오 쿼터 보호 (중요):
 *   getBuildingTitle 은 지번→법정동코드에 Kakao 주소검색을 쓴다 — 지오코딩/검색과 쿼터를 공유하므로
 *   대량 호출은 실서비스(지도)를 깰 수 있다. 따라서 하루 total cap 을 매우 보수적으로(기본 100) 두고
 *   단일 실행에서만 처리한다(chunk loop 최소). building_register 캐시라 1회 채우면 재호출 없음.
 *
 * 게이트:
 *   후보 선정은 molit 그룹핑 anti-join 이 필요해 Postgres 함수 get_br_backfill_candidates 사용.
 *   함수 미생성 시 graceful no-op(로그만) — 운영자 SQL(SPRINT_NOTES BR-BACKFILL) 실행 후 활성.
 *
 * 안전:
 *   - getBuildingTitle 은 실패 시 null(캐시 미기록) — 실패 단지는 다음 실행에서 재시도(무한재시도는
 *     total cap 이 방어). 성공분은 building_register 에 남아 후보에서 제외(anti-join).
 *   - budgetMs 마진에서 종료(Vercel maxDuration 안전).
 */
const { getBuildingTitle, fetchRecapOnly } = require('../services/buildingRegisterService');
const logger = require('../logger');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (null-게이트 의미 유지)
const { getSupabaseAdmin } = require('../db/client');

// BR-ACCEL-2026-07-22 (Sprint MMMMMM, 백로그 감사 A3): 100→300. 실측 3일 정상 가동(일 ~100 적재,
//   351행)·실패 0 확인 후 상향. Kakao +300/일(한도 100K)·건축HUB ~300-600/일(한도 10K) — 둘 다 안전.
//   잔여 ~9.2K → 92일에서 ~31일로 단축. 수동 트리거 상한(MAX)은 500.
const DEFAULT_TOTAL_CAP = 300;
const MAX_TOTAL_CAP = 500;
const CONCURRENCY = 3;

function adminClient() {
  return getSupabaseAdmin();
}

// HH-BR-WRITEBACK-2026-08-17 (Sprint MMMMMMM-23): 수집은 되는데 **합류가 안 되고 있었다**.
//   이 cron 은 building_register 를 채우지만(08-15 실측 257건 확보) 그 값이 apt_master.facility 로
//   되쓰이지 않아, 세대수 미확인 단지는 계속 미확인으로 남았다. 추천 경로만 요청 시점에 메모리로
//   덧대고(propertyService `_brHh`) 검색·지도·상세는 영원히 '미상'이었다.
//   [실측 2026-08-17] 미확인 407곳(= 조회실패 sentinel 395 + 세대수 0 인 12) 중 이미 BR 캐시가 있는 곳 17.
//     그 17곳 세대수는 250~2,700(평균 878) — 전부 100세대 이상이다. 2,700세대 단지가 미확인이었다.
//   API 호출 0 — 캐시만 읽어 붙인다.
// ⚠ 기아(starvation) 방지 — 첫 실행 실측(2026-08-17)에서 드러난 결함을 고친 값이다.
//   종전 300 은 대상(_empty 395)보다 작았다. 채운 행은 `_br` 필터로 후보에서 빠지지만
//   **건축물대장 캐시가 없는 389곳은 영원히 후보에 남는다** → 매 회차 앞 300개만 훑게 되고
//   뒤쪽은 영구히 스캔 밖이다. 실제로 캐시가 있는데도 못 붙은 단지가 4곳 있었다.
//   대상 전체(현재 407)를 한 회차에 덮는 값으로 올린다. PostgREST 는 1000행에서 잘리므로
//   그 이상은 의미가 없고, 상한에 닿으면 경고로 알린다(그때는 페이징이 필요하다는 신호).
const WRITE_BACK_SCAN = 1000;

async function writeBackToMaster(admin) {
  const base = () => admin.from('apt_master')
    .select('kapt_code, apt_name, lawd_cd, facility')
    .not('kapt_code', 'is', null)
    .not('facility', 'is', null)
    .is('facility->_br', null);          // 이미 붙인 행은 건너뛴다(멱등)
  // 대상 2종. ⚠ KAPT 세대수가 있는 행은 조건상 애초에 안 잡힌다 — 좋은 값을 덮을 경로가 없다.
  //   '0' 은 문자열 비교다(실측: 12곳 전부 kaptdaCnt/hoCnt 키가 "0" 문자열로 존재).
  const [emptyRes, zeroRes] = await Promise.all([
    base().not('facility->_empty', 'is', null).limit(WRITE_BACK_SCAN),
    base().eq('facility->>kaptdaCnt', '0').eq('facility->>hoCnt', '0').limit(WRITE_BACK_SCAN),
  ]);
  if (emptyRes.error || zeroRes.error) {
    logger.warn({ err: (emptyRes.error || zeroRes.error).message }, 'BR 되쓰기: 후보 조회 실패 — 건너뜀');
    return { scanned: 0, written: 0, ambiguous: 0 };
  }
  const rows = [...(emptyRes.data || []), ...(zeroRes.data || [])];
  if (!rows.length) return { scanned: 0, written: 0, ambiguous: 0 };
  // 상한에 닿았다 = 이번 회차에 못 본 후보가 있다는 뜻. 조용히 넘기면 그 뒤쪽이 영구 기아가 된다.
  for (const [label, res] of [['_empty', emptyRes], ['세대수0', zeroRes]]) {
    if ((res.data || []).length >= WRITE_BACK_SCAN) {
      logger.warn({ label, scan: WRITE_BACK_SCAN }, 'BR 되쓰기: 후보가 스캔 상한에 닿음 — 페이징 필요');
    }
  }

  // ⚠ 동명 가드: BR 캐시 키는 `name:단지명|lawd_cd` 라 같은 구에 같은 이름 단지가 둘이면 어느 쪽 값인지
  //   구별할 수 없다. 그런 키는 **쓰지 않는다**(현재 대상 407곳엔 0건이나 마스터 전체엔 5쌍 존재).
  const keyOf = (r) => `name:${r.apt_name}|${r.lawd_cd}`;
  const seen = new Map();
  for (const r of rows) seen.set(keyOf(r), (seen.get(keyOf(r)) || 0) + 1);

  const keys = [...seen.keys()].filter(k => seen.get(k) === 1);
  const titleByKey = new Map();
  // PostgREST 는 1000행에서 조용히 잘린다 — 키를 200개씩 끊어 조회한다.
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await admin.from('building_register')
      .select('apt_key, title').in('apt_key', keys.slice(i, i + 200));
    if (error) { logger.warn({ err: error.message }, 'BR 되쓰기: 캐시 조회 실패'); return { scanned: rows.length, written: 0, ambiguous: 0 }; }
    for (const b of (data || [])) if (b.title) titleByKey.set(b.apt_key, b.title);
  }

  let written = 0;
  const ambiguous = rows.length - keys.length;
  for (const r of rows) {
    const k = keyOf(r);
    // ⚠ 이 가드는 위 keys 필터와 **이중**이다 — 회귀 주입 실측(2026-08-17): 이 줄만 지워도 동작은
    //   그대로다(중복 키는 애초에 조회되지 않아 titleByKey 에 없다). 반대로 keys 필터를 지우면
    //   ambiguous 카운트가 틀려져 테스트가 잡는다. 둘 다 남긴다 — 어느 한쪽을 나중에 손대도
    //   "동명 단지에 남의 세대수를 붙이는" 사고가 나지 않게 하기 위해서다.
    if (seen.get(k) !== 1) continue;
    const t = titleByKey.get(k);
    const hh = t ? parseInt(t.hhldCnt, 10) : NaN;
    // 값이 없으면 **아무것도 적지 않는다** — 모름을 0으로 굳히지 않기 위해서다.
    if (!Number.isFinite(hh) || hh <= 0) continue;
    const facility = {
      ...(r.facility || {}),
      _br: {
        hhldCnt: hh,
        dongCnt: Number.isFinite(parseInt(t.dongCnt, 10)) ? parseInt(t.dongCnt, 10) : null,
        useAprDay: t.useAprDay || null,
        source: 'buildingRegister',
        at: new Date().toISOString(),
      },
    };
    const { error } = await admin.from('apt_master').update({ facility }).eq('kapt_code', r.kapt_code);
    if (!error) written++;
  }
  if (ambiguous) logger.warn({ ambiguous }, 'BR 되쓰기: 동명 단지라 판별 불가로 건너뛴 행');
  return { scanned: rows.length, written, ambiguous };
}

// DENSITY-BACKFILL-2026-08-29: 기존 캐시 행에 대지 단위 지표(용적률·건폐율·대지면적)를 채운다.
//
// [왜 별도 경로인가] 후보 함수 get_br_backfill_candidates 는 "building_register 미보유" 단지만 뽑는다.
//   즉 **이미 캐시된 5,918행은 영원히 후보가 아니다** — 새 필드가 저절로 채워질 경로가 없다.
//   실측(2026-08-29): 5,918행 중 vlRat 키를 가진 행 **0건**. 즉 화면에 이 값을 보는 사용자가 0명이다.
//
// [Kakao 를 쓰지 않는다] 캐시 행은 sigungu_cd/bjdong_cd/bun/ji 를 컬럼으로 들고 있고(실측 5,918/5,918
//   완비), fetchRecapOnly 가 그 값으로 총괄표제부만 직접 부른다. 이 파일 상단 주석이 경고하는
//   "Kakao 쿼터 공유" 위험이 이 경로엔 **없다**.
//
// [멱등·기아 방지] 처리한 행에는 값이 null 이어도 `title._densAt` 마커를 남긴다.
//   실측상 1988년 이하 준공은 총괄표제부가 아예 없어 영구 null 이다 — 마커가 없으면 그 행들이
//   매 회차 후보로 되돌아와 신축 행이 영원히 처리되지 않는다(기아).
//   준공 최신순으로 처리해 **값이 실제로 오는 구간(2003년 이후 3,394건)부터** 채운다.
// cap 200 · 동시성 5 — 이 경로는 **Kakao 를 쓰지 않으므로** 파일 상단이 경고하는 쿼터 제약과 무관하다.
//   건축HUB 한도(1만/일) 대비 200 은 여유가 크다. 대상 4,984건(1995년 이후 미처리) → 약 25일 소요.
const DENSITY_CAP = 200;
const DENSITY_BUDGET_MS = 70000;
const DENSITY_CONCURRENCY = 5;
// 준공 하한 — 실측(2026-08-29)상 1988년 이하는 총괄표제부가 없어 전부 null 이고, 2003년 이후는 전부 값이 왔다.
//   경계가 그 사이 어디인지는 미확인이라 **1995** 로 잡아 미확인 구간까지 덮는다(4,984건).
//   그 이전 단지는 호출해봐야 빈 값이라 대상에서 뺀다(무의미한 API 호출 절약).
const DENSITY_MIN_APR = '1995';

async function backfillDensity(admin, { cap = DENSITY_CAP, budgetMs = DENSITY_BUDGET_MS } = {}) {
  const t0 = Date.now();
  const { data, error } = await admin.from('building_register')
    .select('apt_key, sigungu_cd, bjdong_cd, bun, ji, title')
    .is('title->_densAt', null)              // 아직 시도하지 않은 행 (apt_master._br 와 동일 패턴)
    // ⚠ JSON 경로 정렬(.order('title->>useAprDay'))은 이 레포에 선례가 없어 쓰지 않는다.
    //   대신 **필터**로 대상을 좁힌다 — `.eq('facility->>kaptdaCnt','0')` 로 이미 검증된 패턴이다.
    //   useAprDay 는 'YYYYMMDD' 8자리 고정이라 문자열 비교가 곧 연도 비교다.
    .gte('title->>useAprDay', DENSITY_MIN_APR)
    .limit(cap);
  if (error) {
    logger.warn({ err: error.message }, '밀도 백필: 후보 조회 실패 — 건너뜀');
    return { scanned: 0, filled: 0, empty: 0, failed: 0 };
  }
  const rows = data || [];
  if (!rows.length) return { scanned: 0, filled: 0, empty: 0, failed: 0 };

  let filled = 0, empty = 0, failed = 0;
  const queue = rows.slice();
  async function worker() {
    while (queue.length) {
      if ((Date.now() - t0) > budgetMs - 8000) return;
      const r = queue.shift();
      const d = await fetchRecapOnly({
        sigunguCd: r.sigungu_cd, bjdongCd: r.bjdong_cd, bun: r.bun, ji: r.ji,
      });
      // null = 호출 실패. 마커를 남기지 않아 다음 회차에 재시도한다(값 없음과 구별).
      if (!d) { failed++; continue; }
      const title = { ...(r.title || {}), ...d, _densAt: new Date().toISOString() };
      const { error: upErr } = await admin.from('building_register')
        .update({ title }).eq('apt_key', r.apt_key);
      if (upErr) { failed++; continue; }
      if (d.vlRat != null) filled++; else empty++;
    }
  }
  await Promise.all(Array.from({ length: DENSITY_CONCURRENCY }, () => worker()));
  logger.info({ scanned: rows.length, filled, empty, failed, elapsedMs: Date.now() - t0 },
    `밀도 백필: 용적률 ${filled} 채움 / ${empty} 값없음 / ${failed} 실패`);
  return { scanned: rows.length, filled, empty, failed };
}

/**
 * @param {Object} opts
 * @param {number} [opts.cap=100]        — 하루 total 처리 상한 (Kakao 쿼터 보호)
 * @param {number} [opts.budgetMs=180000]
 */
async function run({ cap = DEFAULT_TOTAL_CAP, budgetMs = 180000 } = {}) {
  const started = Date.now();
  const admin = adminClient();
  if (!admin) return { ok: false, error: 'Supabase 미설정', processed: 0 };

  const totalCap = Math.min(Math.max(parseInt(cap) || DEFAULT_TOTAL_CAP, 1), MAX_TOTAL_CAP);

  // HH-BR-WRITEBACK-2026-08-17: **후보 조회보다 먼저** 돌린다 — 아래엔 조기 return 이 3개 있어
  //   뒤에 두면 "후보 없음" 인 날엔 되쓰기가 통째로 건너뛰어진다(그런 날이 대부분이 된다).
  //   이번 run 이 새로 채운 캐시는 다음 회차에 합류한다(하루 지연, 멱등이라 중복 없음).
  let wb = { scanned: 0, written: 0, ambiguous: 0 };
  try { wb = await writeBackToMaster(admin); }
  catch (e) { logger.warn({ err: e.message }, 'BR 되쓰기 실패(무시) — 수집은 계속한다'); }

  // DENSITY-BACKFILL-2026-08-29: 되쓰기와 같은 이유로 **조기 return 앞**에 둔다
  //   ("후보 없음"인 날에 통째로 건너뛰어지면 5,918행이 영원히 안 채워진다).
  //   자체 시간 상한(60s)을 둬서 아래 수집 단계의 예산을 잠식하지 않는다.
  let dens = { scanned: 0, filled: 0, empty: 0, failed: 0 };
  try { dens = await backfillDensity(admin); }
  catch (e) { logger.warn({ err: e.message }, '밀도 백필 실패(무시) — 수집은 계속한다'); }

  // 후보 조회 — Postgres 함수(거래 n>=2 & building_register 미보유). 미생성 시 graceful no-op.
  let candidates = [];
  try {
    const { data, error } = await admin.rpc('get_br_backfill_candidates', { lim: totalCap });
    if (error) {
      // 42883: function 미존재 → 게이트 미충족(운영자 SQL 대기)
      logger.warn({ err: error.message, code: error.code }, 'building-register 백필: 후보 함수 미생성(운영자 SQL 대기) — no-op');
      return { ok: true, gated: true, processed: 0, brScanned: wb.scanned, brWritten: wb.written, dens, note: 'get_br_backfill_candidates 미생성' };
    }
    candidates = Array.isArray(data) ? data : [];
  } catch (e) {
    logger.warn({ err: e.message }, 'building-register 백필: 후보 조회 실패 — no-op');
    return { ok: true, processed: 0, brScanned: wb.scanned, brWritten: wb.written, dens, error: e.message };
  }
  if (!candidates.length) return { ok: true, processed: 0, brScanned: wb.scanned, brWritten: wb.written, dens, message: '후보 없음(캐시 최신)' };

  let filled = 0, missed = 0;
  const queue = candidates.slice(0, totalCap);
  async function worker() {
    while (queue.length) {
      if ((Date.now() - started) > budgetMs - 10000) return; // budget 마진 종료
      const c = queue.shift();
      try {
        const t = await getBuildingTitle({
          lawdCd: String(c.lawd_cd || ''),
          sigungu: String(c.sigungu || ''),
          umdNm: String(c.umd_nm || ''),
          aptName: String(c.apt_name || ''),
        });
        if (t && Number.isFinite(t.hhldCnt) && t.hhldCnt > 0) filled++;
        else missed++;
      } catch (_) { missed++; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = Date.now() - started;
  logger.info({
    source: 'building-register-backfill',
    candidates: candidates.length, filled, missed,
    brScanned: wb.scanned, brWritten: wb.written, brAmbiguous: wb.ambiguous, elapsedMs: elapsed,
  }, `building-register 백필: ${filled} 채움 / ${missed} 미확인 · 마스터 되쓰기 ${wb.written}/${wb.scanned} (${elapsed}ms)`);
  return {
    ok: true, processed: filled + missed, filled, missed,
    brScanned: wb.scanned, brWritten: wb.written, dens, elapsedMs: elapsed,
  };
}

// writeBackToMaster 는 "좋은 KAPT 값을 덮지 않는다 · 동명은 건드리지 않는다 · 값이 없으면 아무것도 적지 않는다"
//   라는 성질을 담당하므로 테스트에서 **직접 실행**해 고정한다(형태 검사로는 이 세 가지를 못 잡는다).
module.exports = { run, writeBackToMaster, backfillDensity };
