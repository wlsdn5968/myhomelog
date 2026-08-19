/**
 * 검색 이력 API (search_history)
 *
 * 보안:
 *   - 모든 엔드포인트 requireAuth (JWT 필수)
 *   - userScopedClient 로 생성 → RLS 자동 적용 ((select auth.uid()) = user_id)
 *
 * 엔드포인트:
 *   POST /api/search/history  — 검색 1건 기록 → 201 { id, createdAt }
 *     (COMMENT-FIX-2026-08-16: 이전 설명 "fire-and-forget" 은 **사실이 아니었다**.
 *      아래 구현은 insert 를 await 하고 `.select().single()` 로 받은 id·created_at 을 응답한다.
 *      실패하면 next(e) 로 에러 핸들러에 넘어간다 — 호출측이 결과를 신뢰해도 되는 계약이다.
 *      계획 011 에서 발견했으나 범위 밖이라 미뤄뒀던 항목.)
 *   GET  /api/search/history  — 최근 50건 (최신순)
 *   DELETE /api/search/history — 내 이력 전체 삭제
 *
 * 설계 노트:
 *   - 북마크와 달리 "로컬 캐시 + 서버 진실" 이중화 안 함 — 검색 로그는
 *     서버 전용. 비로그인 시엔 그냥 기록 안 함 (401 삼키고 진행).
 *   - queryType 허용 값: 'recommend' | 'address' | 'kapt' | 'keyword'
 *   - resultCount 는 선택. 0 은 "결과 없음" 을 명시적으로 기록하는 의미.
 */
const express = require('express');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리
const { getUserScopedClient: userScopedClient, getSupabaseReadonly } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');
// SEARCH-PERF-2026-07-10 (Sprint DDDD): 자동완성 결과 캐시 — 실측 웜 1.4~1.6s(은마 1,641ms).
//   EXPLAIN 확정: 2글자 한글은 pg_trgm GIN 이 후보 30.9만행(전테이블화)이라 seq scan 591ms 가 최선 —
//   인덱스로 해결 불가한 본질 비용 → 같은 검색어 재계산 제거(서버 10분 + CDN s-maxage).
//   molit 데이터는 daily cron 갱신이라 10분 캐시 무해. cache.set 은 safeSet(Sprint BBBB)이라 실패 무해.
const cache = require('../cache');
// SEC-REDOS-2026-07-17 (Sprint TTTTT): 사용자 입력이 new RegExp 소스로 들어가는 곳(620행 /facility 공개
//   엔드포인트 등)의 정규식 메타문자 이스케이프 — evil regex 주입으로 인한 catastrophic backtracking 차단.
const _reEsc = (s) => String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { resolveCoordBatch, resolveCoord } = require('../services/geocodeCacheService');
// SENTRY-GAP-2026-07-17 (Sprint XXXXX): 자체 res.status(5xx) 응답 catch 가 전역 핸들러를 우회해
//   Sentry 에 안 잡히던 사각 해소 — 응답 shape 불변, 캡처만 추가(일시 오류는 헬퍼가 그룹핑).
const { captureRouteError } = require('../utils/captureError');
const { resolveFacility } = require('../services/aptFacilityService');
const { resolveSchools } = require('../services/schoolService');
// STAB-AUDIT-2026-05-07 P1: 학교알리미 NEIS API 통합 — 학생수·학급수
const { resolveSchoolNeisBatch } = require('../services/schoolNeisService');
// STAB-AUDIT-2026-05-07 P2: 학구도 (배정 초·중) 매핑
const { resolveSchoolDistrict } = require('../services/schoolDistrictService');
// Sprint OO (2026-05-19): 강연 자료 적용 — 학군 권역 + 학원가
const { resolveAcademies } = require('../services/academyService');
// NAMEFIX-2026-05-11 + FACILITY-HELPER-2026-05-12: 검색 path 정규화 + facility schema 일관
// NAME-MERGE-2026-05-12 (Sprint S): baseAptName helper 로 동/letter/층 suffix 분리 신고 통합
const { normalizeAptName, baseAptName } = require('../utils/aptName');
// SNAPSHOT-2026-07-11 (Sprint LLLL): 인기 단지 집계 서비스 분리 + 일별 사전집계 스냅샷
const { buildPopularResults, readPopularSnapshot, storePopularSnapshot } = require('../services/popularService');
const { buildFacility } = require('../utils/buildFacility');

const router = express.Router();

const ALLOWED_TYPES = new Set(['recommend', 'address', 'kapt', 'keyword']);
const MAX_QUERY_LEN = 200;
const HISTORY_LIMIT = 50;

// ── GET: 단지명·동명 검색 (자동완성) — 인증 불필요 (공개 데이터) ──
// P0 (2026-04-25 Phase 2 시나리오 A): 호갱노노 핵심 사용 패턴 — 단지명 직접 검색.
// molit_transactions 의 pg_trgm 인덱스 (idx_molit_aptname_trgm) 활용 — ILIKE 고속.
// SSOT-2026-08-09 (Plan 007): 구명 adminClient 는 실권한과 불일치(공개키 우선 readonly) —
//   db/client.getSupabaseReadonly 로 통합(키 체인 동일, 콜사이트 이름만 정리).
const adminClient = () => getSupabaseReadonly();

// SEARCH-DEGRADE-OBSERVE-2026-08-16 (Sprint LLLLLLL): 강등 빈도를 Redis 일별 카운터로 남긴다.
//   Hobby 로그는 1시간이면 증발해 "얼마나 자주 강등되는가"를 사후에 알 수 없다. 실제로
//   배포 직후 라이브 콜드 요청 1건이 곧바로 강등을 탔으므로(은마 검색 4.3s, molit 미반영)
//   빈도 파악이 다음 판단(인덱스·캐시 워밍·상한 조정)의 근거가 된다. health.searchDegrade 로 노출.
//   전부 fail-open + await 하지 않음 — 이미 느린 강등 응답을 더 늦추지 않는다.
/**
 * 강등 판정 — 라우트 밖에서 검증할 수 있도록 순수 함수로 분리 (Sprint NNNNNNN 회귀 가드).
 *   apt_master 는 이름·동명 **2개** 쿼리라 "한쪽만 실패"라는 상태가 존재한다. 이걸 놓치면
 *   결과 일부가 빠진 응답이 '정상'으로 캐시·CDN 에 굳는다 — 실제로 코드리뷰에서 발각된 결함이라
 *   판정을 이 한 곳에 모으고 테스트로 고정한다(characterization.test.js).
 * @param {object|null} molitErr        molit_transactions 조회 오류
 * @param {object|null} masterNameErr   apt_master.apt_name ILIKE 오류
 * @param {object|null} masterUmdErr    apt_master.umd_nm ILIKE 오류
 * @returns {{masterAllFailed:boolean, masterPartial:boolean, degraded:boolean, fatal:boolean}}
 *   fatal = molit 과 apt_master 가 동시에 전멸 → 돌려줄 데이터가 없어 500 이 정직하다.
 */
function computeDegrade(molitErr, masterNameErr, masterUmdErr) {
  const masterAllFailed = !!(masterNameErr && masterUmdErr);
  const masterPartial = !masterAllFailed && !!(masterNameErr || masterUmdErr);
  return {
    masterAllFailed,
    masterPartial,
    degraded: !!(molitErr || masterAllFailed || masterPartial),
    fatal: !!(molitErr && masterAllFailed),
  };
}

// SEARCH-ABORT-2026-08-16 (Sprint RRRRRRR) — 자동완성이 최대 7.4s 를 쓰던 것을 상한으로 끊는다.
//   [실측 2026-08-16 04:2x, 라이브 /api/search/apt · 캐시 우회]
//     래미 7,401ms(강등) · 주공 7,304ms(강등) · 자이 5,270ms(강등) · 푸르지오 3,808ms(강등)
//     은마 4,485ms(**500** — molit+master 동시 실패) · 헬리오시티 1,440ms(정상)
//     health.searchDegrade: 03:26 molit-timeout 5 → 03:46 **11** (전부 실사용자) — 시간당 약 3건.
//   [원인 — EXPLAIN(ANALYZE, BUFFERS)]
//     `apt_name ILIKE '%q%'` 는 435,613행 **병렬 Seq Scan**. buffers 가 전부 shared hit(디스크 IO 0)
//     인데도 스캔에 2,467ms — 즉 **CPU 바운드 ILIKE** 다. Sort 는 top-N heapsort 0.015ms 로 무시 가능
//     (ORDER BY 제거는 무의미). GIN trgm 강제는 오히려 느리다(후보 362,429행 → 323,914행 Recheck 폐기).
//     ⚠ EXPLAIN 의 TIMING ON 은 행마다 타이머를 호출해 값을 부풀린다 — 같은 쿼리가
//     TIMING ON 2,625ms / **TIMING OFF 917ms**. 실제 비용은 후자 쪽이다.
//   [선택] 근본 해법은 스캔 대상 축소(단지 단위 집계 = 21,977행, 20배)뿐인데 **DDL 이라 운영자 SQL**
//     이 필요하다. 코드로 지금 할 수 있는 건 "3s statement_timeout 을 다 쓰고 실패하는 것"을 막는 것:
//     2.5s 에 먼저 끊으면 (a) 사용자 대기가 짧아지고 (b) DB 가 죽은 쿼리에 CPU 를 덜 쓴다.
//     2.5s 근거 = 웜 실비용 917ms + PostgREST/네트워크 오버헤드의 약 2배 여유, statement_timeout 3s 보다 앞.
const MOLIT_ABORT_MS = 2500;
// ENRICH-ABORT-2026-08-16 (Sprint SSSSSSS): master 결과의 buildYear 보충 조회 상한.
//   본 쿼리(2.5s)보다 **짧아야** 전체 응답을 늘리지 않는다. 실측 428ms 의 약 2배 여유.
const ENRICH_ABORT_MS = 1000;

// postgrest-js 의 abort 처리 — dist/index.cjs 실물 확인 결과(추측 아님):
//   · 재시도 루프 안(270행)에서는 AbortError/ABORT_ERR 를 rethrow 하지만,
//   · **상위 catch(312행)가 이를 받아** `{ success:false, error:{message,details,hint,code:''}, data:null }`
//     을 **반환**한다(마지막 `return res.then(onfulfilled, onrejected)`).
//   → 즉 Promise.all 은 reject 되지 않는다. 그래도 이 헬퍼를 두는 이유는 **방어층**이다:
//     라이브러리 버전이 바뀌어 rethrow 로 돌아서면 강등(200)이 조용히 500 으로 퇴행하기 때문이다.
//     네트워크 예외(fetch failed 등) 같은 진짜 reject 도 여기서 강등으로 흡수된다.
//   ⚠ 반환되는 error 에는 `aborted` 필드가 **없다**. abort 판정은 아래 _isAbortErr 가 문자열로 한다
//     (여기서 붙이는 aborted:true 는 reject 경로 전용).
function _softQuery(p) {
  return Promise.resolve(p).then(
    (r) => r,
    (e) => ({
      data: null,
      error: {
        message: (e && e.message) || 'aborted',
        code: (e && (e.code || e.name)) || 'ABORT_ERR',
        aborted: !!(e && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'ABORT_ERR')),
      },
    })
  );
}
// abort 판정 — postgrest-js 는 message 를 `${name}: ${msg}` 로 만들고(AbortError/TimeoutError),
//   AbortError/ABORT_ERR 인 경우 hint 에 "Request was aborted (timeout or manual cancellation)" 를 넣는다.
//   ⚠ `AbortSignal.timeout()` 이 던지는 것은 **TimeoutError** 라 name 만 보면 놓친다 — 문자열 전체를 본다.
//   이 판정이 실패하면 우리가 의도적으로 끊은 요청이 'molit-error' 로 분류돼 **Sentry 이슈가 매번 생긴다.**
function _isAbortErr(err) {
  if (!err) return false;
  if (err.aborted === true) return true;
  return /abort|timeouterror/i.test(
    `${err.name || ''} ${err.code || ''} ${err.message || ''} ${err.hint || ''}`
  );
}
// DEGRADE-AWAIT-2026-08-16 (감사 #45): 이전엔 반환값이 없어 호출부가 기다릴 수 없었다.
//   서버리스는 응답 직후 함수를 동결할 수 있어, 응답 **직전**에 쏜 Redis 쓰기는 유실될 수 있다.
//   → Promise 를 돌려주도록 바꿔서 그런 경로만 await 할 수 있게 했다.
//   여전히 **실패는 삼킨다** — 관측이 응답을 막으면 안 된다(그게 원래 설계 의도).
// DEGRADE-SHARED-2026-08-17 (Sprint MMMMMMM-18): 구현을 `services/degradeStats` 로 옮겼다.
//   보고서 경로(report-pool-cut)가 같은 Redis 키에 써야 해서 같은 코드가 두 벌 있었는데,
//   이 저장소는 사본이 조용히 갈리는 사고를 반복해서 겪었다 — 키가 갈리면 health 에서 한쪽이 사라진다.
//   ⚠ 함수 이름·시그니처·호출부는 **그대로 둔다**. 계약 테스트가 "Promise 를 반환하고,
//     응답 직전 경로에서 await 되며, 그 await 가 res.json 보다 앞" 이라는 형태를 고정하고 있고
//     그건 서버리스 동결로 관측이 유실되던 실사고(ba1db07)의 방어다. 위임만 한다.
function _observeDegrade(kind) {
  return require('../services/degradeStats').observeDegrade(kind);
}
router.get('/apt', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);
  // 2026-05-31: 최소 2글자 — 1글자 ILIKE %x% 는 수천 row 매칭 → cold start 시 DB 부하.
  //   프론트 자동완성(index.html L7958)은 빈 results 를 zero-result 제안 UI 로 정상 처리.
  if (q.length < 2) return res.json({ results: [] });
  // SEARCH-SUFFIX-2026-06-14: molit 은 "은마"/"헬리오시티"로 저장하나 사용자는 "은마아파트"로 검색 →
  //   긴 쿼리가 짧은 저장명을 substring ILIKE 로 못 찾음(은마아파트 → 0건). 끝 "아파트(단지)" 접미사 제거한
  //   검색어로 apt_name ILIKE (`%qApt%` 는 `%q%` 의 상위집합이라 결과 손실 0·일부 broaden). display·dedup 은 원본 보존.
  //   가드: 제거 후 2자 미만이면 원본 유지("아파트"만 입력 시 전체매칭 방지).
  const _qStrip = q.replace(/\s*아파트(?:단지)?\s*$/, '').trim();
  const qApt = _qStrip.length >= 2 ? _qStrip : q;
  // SEARCH-PERF-2026-07-10 (Sprint DDDD): q별 결과 캐시 + CDN 공유 캐시.
  //   자동완성은 인증 무관 동일 응답(공개 데이터) → Vercel edge s-maxage 로 전 사용자 공유(인기 검색어 즉시).
  const SEARCH_CDN = 'public, s-maxage=600, stale-while-revalidate=3600';
  const sck = `searchapt:${q.toLowerCase()}:${limit}`;
  const cached = cache.get(sck);
  if (cached) {
    res.set('Cache-Control', SEARCH_CDN);
    return res.json(cached);
  }
  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '검색 서비스 일시 불가' });
  try {
    // Phase 4 (2026-04-26): molit_transactions + apt_master 두 출처 병합 검색.
    //   1) molit: 실거래 있는 단지 (recent deal_date·build_year 노출 — 우선)
    //   2) apt_master: 거래 0건 단지도 검색에 노출 (기존엔 영원히 안 나옴)
    //   같은 단지가 두 출처에 모두 있으면 molit 우선 (거래 정보 풍부).
    // Phase 21 (2026-05-04): SQL 병목 fix — OR 조건 제거 (umd_nm 인덱스 없음)
    //   진단 (EXPLAIN): apt_name ILIKE OR umd_nm ILIKE → Full Seq Scan (244k rows, 2.3s)
    //   원인: idx_molit_aptname_trgm GIN 있으나 umd_nm GIN 없음 → OR 시 둘 다 인덱스 X
    //   변경: molit_transactions 는 apt_name 만 (인덱스 활용 → ~50ms),
    //         umd_nm (동명) 검색은 apt_master 에 위임 (이미 idx_apt_master_umd_trgm 있음)
    // SEC-ORFILTER-2026-07-17 (Sprint TTTTT): 기존 .or(`apt_name.ilike.%${qApt}%,umd_nm.ilike.%${q}%`) 는
    //   사용자 입력이 PostgREST or= 미니 문법에 원시 삽입돼 콤마 등으로 임의 필터 절 주입 가능(유일한 원시 경로).
    //   → 파라미터 인코딩되는 .ilike() 2회 병렬 + 병합으로 교체 — "상계주공9(고층)" 같은 괄호 검색어도 무손실.
    const _masterSel = 'apt_name, sigungu, umd_nm, lawd_cd, kapt_code';
    const _tQuery = Date.now();
    const [molitRes, masterNameRes, masterUmdRes] = await Promise.all([
      // SEARCH-MV-2026-08-16 (Sprint TTTTTTT): 조회 대상을 거래 테이블 → **단지 단위 집계 MV** 로 교체.
      //   [실측] 동일 ILIKE 가 molit_transactions(435,613행) **917ms** → molit_apt_index(22,473행) **32ms**
      //   = 약 29배. 원인은 CPU 바운드 Seq Scan 이었고 행수를 19.4배 줄인 것이 그대로 반영됐다.
      //   [부수 개선] limit*30(300) 의 단위가 '거래' → '단지' 로 바뀐다. 종전엔 거래가 많은 단지 하나가
      //   300행을 다 먹어 다른 단지가 잘렸다(주석에 남아 있던 '상계주공1 119건' 문제) — 이제 안 잘린다.
      //   [주의] MV 는 cron 이 REFRESH 한다(molit-ingest 직후). 갱신 전엔 최신 거래가 최대 1일 늦다 —
      //   자동완성 목록의 recentDealDate 표시에만 영향이고, 단지 상세·거래 목록은 원본을 그대로 읽는다.
      _softQuery(admin.from('molit_apt_index')
        .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, recent_deal_date, deal_count, apt_seq')
        .ilike('apt_name', `%${qApt}%`)  // qApt: 접미사 정규화
        .order('recent_deal_date', { ascending: false })
        .limit(limit * 30)
        .abortSignal(AbortSignal.timeout(MOLIT_ABORT_MS))),
      _softQuery(admin.from('apt_master').select(_masterSel).ilike('apt_name', `%${qApt}%`).limit(limit * 5)), // 접미사 정규화명
      _softQuery(admin.from('apt_master').select(_masterSel).ilike('umd_nm', `%${q}%`).limit(limit * 5)),      // 동명은 원본
    ]);
    const _msQuery = Date.now() - _tQuery;
    // SEARCH-DEGRADE-2026-08-16 (Sprint LLLLLLL — Sentry NODE-5): molit 조회 실패를 500 으로 올리던 것을
    //   apt_master-only 강등으로 교체 — 바로 아래 "apt_master 실패 → molit only" 폴백과 대칭.
    //   실측 근거(EXPLAIN ANALYZE, 2026-08-16 · 339,958행):
    //     · `apt_name ILIKE '%2글자%' ORDER BY deal_date DESC LIMIT 300` = 병렬 Seq Scan, 웜 1,272ms
    //     · enable_seqscan=off 로 GIN trgm 강제 시 1,808ms (Bitmap Index Scan 이 362,429행 후보를 뱉고
    //       Recheck 에서 323,914행을 버림) → **인덱스로는 줄일 수 없는 본질 비용**. 새 인덱스 제안 금지.
    //     · anon 역할 statement_timeout = 3s → 콜드 버퍼/동시부하에서 초과 시 pg 57014.
    //   같은 검색어의 apt_master 경로는 313ms 라, molit 이 죽어도 결과를 돌려줄 수 있다.
    // SEARCH-MV-2026-08-16 (Sprint TTTTTTT): MV 행 → 기존 그룹핑이 기대하는 모양으로 정규화.
    //   아래 그룹핑은 **"행 1개 = 거래 1건"** 전제로 쓰여 있다(`cur.count++`, `seqCounts.set(seq, cnt+1)`).
    //   MV 행은 이미 단지 단위 집계라 그 전제가 깨진다 → 컬럼명(recent_deal_date→deal_date)과
    //   가중치(_w = 그 행이 대표하는 거래 건수)를 **여기서 한 번에** 맞춰 그룹핑 본체는 그대로 둔다.
    //   ⚠ `_w` 기본값 1 — 혹시 원본 테이블로 되돌려도 그룹핑이 종전과 동일하게 작동한다(하위 호환).
    let molitRows = (molitRes.data || []).map((r) => ({
      ...r,
      deal_date: r.recent_deal_date != null ? r.recent_deal_date : r.deal_date,
      _w: Number(r.deal_count) > 0 ? Number(r.deal_count) : 1,
    }));
    const _molitErr = molitRes.error || null;
    // 57014(statement timeout)는 위 EXPLAIN 으로 원인이 확정된 기지 사항 → Sentry 노이즈만 만든다.
    //   그 외 오류(권한·스키마 드리프트 등)는 조용히 강등되면 안 되므로 캡처 — 단 캡처 시점은
    //   아래 throw 판정 **뒤**다(같은 오류가 'search/apt-molit'+'search/apt' 2건으로 잡히는 것 방지).
    // SEARCH-ABORT-2026-08-16: 우리 2.5s abort 도 DB 3s 타임아웃과 동일한 "기지(旣知) 지연" 이다
    //   → Sentry 캡처 제외 대상에 함께 넣는다(원인이 위 주석으로 확정돼 있어 노이즈만 만든다).
    //   관측(searchDegrade)에서는 둘을 **구분**한다 — abort 가 늘면 상한이 실제로 동작하는 것이고,
    //   timeout 이 늘면 DB 가 2.5s 안에도 못 끝낸다는 뜻이라 대응이 다르다.
    const _isMolitAbort = _isAbortErr(_molitErr);
    const _isMolitTimeout = _molitErr
      ? (_isMolitAbort || /statement timeout|57014/i.test(`${_molitErr.code || ''} ${_molitErr.message || ''}`))
      : false;
    if (_molitErr) {
      molitRows = [];
      logger.warn({ err: _molitErr.message, code: _molitErr.code, q, msQuery: _msQuery },
        'molit 검색 실패 — apt_master only 로 강등');
      _observeDegrade(_isMolitAbort ? 'molit-abort' : (_isMolitTimeout ? 'molit-timeout' : 'molit-error'));
    }
    // 병목 위치 계측 — 라이브에서 7.4s 가 나왔는데 그중 DB 조회가 얼마인지 몰라 조치 범위를 못 좁혔다.
    //   (Hobby 로그 1시간이라 사후 추적이 안 되므로 임계 초과 시에만 남긴다.)
    if (_msQuery >= 2000) logger.warn({ q, msQuery: _msQuery }, '검색 DB 조회 지연(2s+)');
    // 두 쿼리 결과 병합 (기존 .or() 와 동일 집합·동일 상한) + 중복 제거
    let masterRes;
    const _mNameErr = masterNameRes.error || null;
    const _mUmdErr = masterUmdRes.error || null;
    const _dg = computeDegrade(_molitErr, _mNameErr, _mUmdErr);
    if (_dg.masterAllFailed) {
      masterRes = { error: _mNameErr };
    } else {
      const _seenMk = new Set();
      const _rows = [];
      for (const r of [...(masterNameRes.data || []), ...(masterUmdRes.data || [])]) {
        const k = `${r.apt_name}|${r.lawd_cd}|${r.umd_nm}`;
        if (_seenMk.has(k)) continue;
        _seenMk.add(k);
        _rows.push(r);
      }
      masterRes = { data: _rows };
    }
    if (masterRes.error) {
      // apt_master 미존재/접근 실패는 fallback (molit 만 사용)
      // LOG-TRUTH-2026-08-16 (Sprint QQQQQQQ, 크로스체크 지적): molit 도 함께 죽은 fatal 케이스에서
      //   'molit only'(= molit 만으로 응답 가능) 는 **거짓**이다 — 아래 205행에서 500 으로 throw 된다.
      //   종전엔 molit 오류를 최상단에서 즉시 throw 했기에 이 줄에 도달할 수 없었는데, Sprint NNNNNNN
      //   에서 강등 판정을 뒤로 미루면서 fatal 도 이 줄을 지나게 됐다. 장애 조사 때 "molit 은 살아
      //   있었다"는 정반대 판단을 유도하므로 두 상황을 구분해 남긴다.
      logger.warn({ err: masterRes.error.message, molitAlsoFailed: !!_molitErr, q },
        _molitErr ? 'apt_master + molit 동시 실패 — 돌려줄 데이터 없음(500)' : 'apt_master 조회 실패 — molit only');
    }
    // DEGRADE-PARTIAL-2026-08-16 (Sprint NNNNNNN — 코드리뷰 지적, 재현 확인):
    //   apt_master 는 **이름·동명 2개** 쿼리인데 위 판정은 *둘 다* 실패해야 error 를 세운다.
    //   → 한쪽만 실패하면 masterRes 는 `{data}` 라 `.error` 가 undefined → _degraded=false 가 되어
    //   **결과 일부가 빠진 응답이 "정상"으로 서버 10분 + CDN s-maxage 600(+SWR 1h) 에 굳었다.**
    //   경고 로그조차 없어 사후 추적도 불가(Hobby 로그 1시간). 게다가 umd_nm 쿼리는 접미 정규화 전
    //   원본 q 로 더 넓게 스캔해 timeout 확률이 apt_name 쪽보다 높다 — 실제로 걸리는 쪽이다.
    if (_dg.masterPartial) {
      logger.warn({ nameErr: _mNameErr && _mNameErr.message, umdErr: _mUmdErr && _mUmdErr.message, q },
        'apt_master 부분 실패 — 결과 일부 누락(캐시 제외)');
      _observeDegrade(_mNameErr ? 'master-name-partial' : 'master-umd-partial');
    }
    // 두 출처가 **동시에** 죽으면 돌려줄 데이터가 없다 → 빈 배열로 위장하지 말고 정직하게 500.
    if (_dg.fatal) throw _molitErr;   // catch 가 'search/apt' 로 1회 캡처
    // 강등으로 살아남은 경우에만 molit 오류를 따로 캡처 — throw 경로에서 함께 하면 동일 오류가
    //   'search/apt-molit' + 'search/apt' 2건으로 잡힌다(코드리뷰 LOW 지적).
    if (_molitErr && !_isMolitTimeout) captureRouteError(_molitErr, 'search/apt-molit');
    // 한쪽만 죽은 응답은 불완전 → 캐시에 굳히면 안 된다(서버 10분 + CDN s-maxage 600 은 전 사용자 공유).
    const _degraded = _dg.degraded;

    // NAME-MERGE-2026-05-12 (Sprint S — 운영자 발견 + 3-source cross-check [VERIFIED]):
    //   MOLIT 가 한 단지를 동/letter/층 suffix 로 분리 신고 → dropdown 에 같은 단지 2+ row.
    //   해결: baseAptName + sigungu + umd_nm + build_year 로 group → 1 row.
    //
    //   group key 에 build_year 포함 이유: false-positive 방어
    //     예) "상계주공1" 1988 (P3 (고층)/(저층) 같이 그룹) vs "상계주공1" 다른 연도 → 별개.
    //   기존 raw_key 도 보관 (seen 매칭 변환 없도록) — dealCount 합산 + apt_seq 대표값 선택.
    //
    //   대표 row 선택:
    //     - aptName: baseAptName 으로 정규화한 결과 (P3 상계주공 1 → "상계주공1", P1 풍림아파트A → "풍림아파트")
    //     - dealCount: 그룹 전체 거래량 합산 (Phase 10 인기 배지 정확)
    //     - recentDealDate: 그룹 내 가장 최근
    //     - buildYear / lawdCd / sigungu / umd_nm: group key 동일
    //     - aptSeq: 거래 가장 많은 row 의 apt_seq (KAPT 직접 호출 대표값)
    //     - aliasNames: 합쳐진 원본 raw 이름들 (운영자 디버깅 + frontend 거래 fetch 시 base 매칭 보강용)
    const aptMap = new Map(); // mergeKey → group state
    for (const row of molitRows) {
      const base = baseAptName(row.apt_name) || normalizeAptName(row.apt_name) || row.apt_name;
      const mergeKey = `${base}|${row.sigungu}|${row.umd_nm}|${row.build_year || ''}`;
      // SEARCH-MV-2026-08-16: 종전의 상수 1 을 `row._w`(그 행이 대표하는 거래 건수)로 대체.
      //   MV 이전엔 행 1개가 거래 1건이라 1 이 맞았다. 지금은 행 1개가 단지 1개(= _w 건)다.
      //   이 치환이 빠지면 dealCount 와 대표 apt_seq 선택이 **거래량이 아니라 행수 기준**이 되어
      //   인기 정렬(SEARCH-RANK)이 통째로 뒤틀린다.
      const _w = row._w || 1;
      const cur = aptMap.get(mergeKey);
      if (cur) {
        cur.count += _w;
        if (String(row.deal_date || '') > String(cur.firstRow.deal_date || '')) {
          cur.firstRow = row; // 최신 거래 row 를 firstRow 로 갱신
        }
        // apt_seq 별 거래량 counter (대표 apt_seq 선택용)
        const seqCnt = cur.seqCounts.get(row.apt_seq) || 0;
        cur.seqCounts.set(row.apt_seq, seqCnt + _w);
        // alias raw name 누적 (set 으로 중복 제거)
        cur.rawNames.add(row.apt_name);
      } else {
        const seqCounts = new Map();
        if (row.apt_seq) seqCounts.set(row.apt_seq, _w);
        aptMap.set(mergeKey, {
          count: _w,
          firstRow: row,
          baseName: base,
          seqCounts,
          rawNames: new Set([row.apt_name]),
        });
      }
    }
    // 정렬: (0) 검색어 일치 우선, (a) 거래량 desc, (b) 최근 거래 desc — 인기 + 최신성 균형
    // SEARCH-RANK-2026-07-11 (Sprint HHHH, 라이브 재현 "은마" → 1위 화성 '시범다은마을월드반도'):
    //   부분매칭+거래량순뿐이라 정확일치 단지가 밀림 → 정확일치(0)·시작일치(1)·포함(2) 등급을 최우선.
    //   동명(umd) 검색은 전부 2등급 동률이라 기존 순서 그대로 (회귀 없음).
    const _qn = String(q).replace(/\s+/g, '').toLowerCase();
    const _qRank = (n) => {
      const s = String(n || '').replace(/\s+/g, '').toLowerCase();
      return s === _qn ? 0 : (s.startsWith(_qn) ? 1 : 2);
    };
    const sortedMolit = Array.from(aptMap.values())
      .sort((a, b) => (_qRank(a.baseName) - _qRank(b.baseName)) || (b.count - a.count) || (String(b.firstRow.deal_date||'').localeCompare(String(a.firstRow.deal_date||''))));

    const seen = new Set();
    const out = [];
    // molit 우선 (실거래 있는 단지) — 인기순
    // NAMEFIX-2026-05-11: aptName 표시 시점에 `(고층)/(저층)/(중층)` suffix 제거.
    // NAME-MERGE-2026-05-12 (Sprint S): baseAptName 으로 동/letter 까지 통합.
    for (const grp of sortedMolit) {
      const row = grp.firstRow;
      const key = `${grp.baseName}|${row.sigungu}|${row.umd_nm}|${row.build_year||''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 대표 apt_seq: 거래 가장 많은 raw row 의 것
      let repSeq = row.apt_seq || null;
      let maxSeqCnt = 0;
      for (const [seq, cnt] of grp.seqCounts) {
        if (cnt > maxSeqCnt) { maxSeqCnt = cnt; repSeq = seq; }
      }
      out.push({
        aptName: grp.baseName, // base name 으로 표시 (예: "풍림아파트")
        sigungu: row.sigungu,
        umdNm: row.umd_nm,
        lawdCd: row.lawd_cd,
        buildYear: row.build_year,
        recentDealDate: row.deal_date,
        dealCount: grp.count, // 그룹 전체 거래량 합산
        aptSeq: repSeq, // 대표 apt_seq
        source: 'molit',
        // NAME-MERGE 디버깅 + 거래 fetch 시 base 매칭 보강
        aliasNames: grp.rawNames.size > 1 ? Array.from(grp.rawNames) : undefined,
      });
      if (out.length >= limit) break;
    }
    // apt_master 보충 (거래 0건 단지)
    // NAME-MERGE-2026-05-12 (Sprint S): master 도 동일 baseAptName 기준 dedupe.
    //   master 는 KAPT 정식명 (이미 base form) 이지만, molit 그룹과 collision (같은 base) 시
    //   molit 가 이미 seen 추가했으므로 자동 차단됨.
    if (out.length < limit) {
      for (const row of (masterRes.data || [])) {
        const base = baseAptName(row.apt_name) || normalizeAptName(row.apt_name) || row.apt_name;
        const key = `${base}|${row.sigungu}|${row.umd_nm}|`;  // master 는 buildYear 부재 → 빈 ''
        // molit out 의 seen key 와 collision 체크 (같은 base+sigungu+umd_nm 면 buildYear 무관 dedupe)
        // SEARCH-SUFFIX-2026-06-14: dedup 비교 시 끝 "아파트" 흡수 — molit "헬리오시티" ↔ master "헬리오시티아파트"
        //   (동일 단지, 이름 접미사만 차이) 1개로 병합. 표시명(aptName) 은 각자 원본 유지(비교에서만 정규화).
        const _baseNoApt = String(base).replace(/아파트$/, '');
        let alreadyInOut = false;
        for (const exist of out) {
          if (String(exist.aptName).replace(/아파트$/, '') === _baseNoApt && exist.sigungu === row.sigungu && exist.umdNm === row.umd_nm) {
            alreadyInOut = true; break;
          }
        }
        if (alreadyInOut) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          aptName: base,
          sigungu: row.sigungu,
          umdNm: row.umd_nm,
          lawdCd: row.lawd_cd,
          buildYear: null,
          recentDealDate: null,
          kaptCode: row.kapt_code,
          aptSeq: row.kapt_code || null, // master 는 kaptCode = aptSeq 동일 (KAPT 표준)
          source: 'master',
        });
        if (out.length >= limit) break;
      }
    }

    // Phase 4 (2026-04-26): master 단지 buildYear/recentDealDate 토큰 매칭 자동 채우기
    // 사용자 지적: '왜 ?년 이지? 정보 못 찾았냐?' — apt_master 에 build_year 컬럼 없음.
    // 같은 (lawd_cd, umd_nm) molit_transactions 중 토큰 매칭 단지의 buildYear/dealDate 사용.
    const masterEmpty = out.filter(r => r.source === 'master' && !r.buildYear && r.lawdCd && r.umdNm);
    if (masterEmpty.length) {
      // 같은 (lawd_cd, umd_nm) 그룹 별 1번 fetch
      const groups = {};
      for (const r of masterEmpty) {
        const gk = `${r.lawdCd}|${r.umdNm}`;
        if (!groups[gk]) groups[gk] = { lawdCd: r.lawdCd, umdNm: r.umdNm, items: [] };
        groups[gk].items.push(r);
      }
      const _tEnrich = Date.now();
      await Promise.all(Object.values(groups).map(async g => {
        // ENRICH-ABORT-2026-08-16 (Sprint SSSSSSS): 이 보충 조회에 1s 상한.
        //   [실측] `lawd_cd=41171 AND umd_nm='안양동'` → **428ms**(TIMING OFF). 인덱스는 있으나
        //   BitmapAnd(umd_nm trgm + lawd_date) 후 1,783행 heap 접근 + top-N 정렬이라 싸지 않다.
        //   그리고 이건 **그룹마다** 돈다.
        //   [악순환] molit 본 쿼리가 느려 강등되면 → 결과가 master 위주가 되고 → buildYear 가 빈 행이
        //   늘어 → 이 보충 조회가 **더 많이** 돈다. 느릴수록 더 느려지는 구조였다.
        //   [근거] 이건 표시용 **부가 정보**다(없으면 종전처럼 '?년'). 검색 결과 자체는 이미 확정돼
        //   있으므로 빨리 포기하는 편이 낫다 — 실패는 아래 `if (!txs?.length) return;` 이 이미 흡수한다.
        //   1s = 실측 428ms 의 약 2배 여유. 본 쿼리(2.5s)보다 짧아야 전체 응답을 늘리지 않는다.
        const { data: txs } = await _softQuery(admin
          .from('molit_transactions')
          .select('apt_name, build_year, deal_date')
          .eq('lawd_cd', g.lawdCd).eq('umd_nm', g.umdNm)
          .order('deal_date', { ascending: false })
          .limit(200)
          .abortSignal(AbortSignal.timeout(ENRICH_ABORT_MS)));
        if (!txs?.length) return;
        // distinct apt_name + dealCount 누적 (Sprint BB: master 단지 dealCount 일관성)
        const aptInfo = {};
        for (const t of txs) {
          if (!aptInfo[t.apt_name]) aptInfo[t.apt_name] = { build_year: t.build_year, deal_date: t.deal_date, count: 0 };
          aptInfo[t.apt_name].count++;
        }
        for (const m of g.items) {
          // 정식명에서 핵심 토큰 추출 (3글자 이상)
          const baseName = m.aptName
            .replace(new RegExp(`^(${_reEsc(m.sigungu)}|${_reEsc(m.umdNm)})\\s*`, 'g'), '') // DB 파생값이지만 방어적 이스케이프
            .replace(/\s+/g, '');
          const tokens = [];
          for (let len = 4; len >= 3; len--) {
            for (let i = 0; i <= baseName.length - len; i++) {
              const t = baseName.substring(i, i + len);
              if (!tokens.includes(t)) tokens.push(t);
            }
          }
          // 최고 점수 단지 찾기 + 매칭된 모든 단지의 dealCount 합산 (Sprint BB)
          let best = null, bestScore = 0, totalDeals = 0;
          for (const [aptName, info] of Object.entries(aptInfo)) {
            let score = 0;
            for (const tok of tokens) {
              if (aptName.includes(tok)) score = Math.max(score, tok.length);
            }
            if (score >= 3) totalDeals += info.count;
            if (score > bestScore) { best = info; bestScore = score; }
          }
          if (best && bestScore >= 3) {
            m.buildYear = best.build_year;
            m.recentDealDate = best.deal_date;
            // MASTER-DEAL-COUNT-2026-05-13 (Sprint BB — 운영자 발견 일관성):
            //   master dropdown row 도 dealCount 표시 (🔥 배지 등 molit 와 일관)
            //   매칭된 모든 raw apt_name 의 거래 합산
            if (totalDeals > 0) m.dealCount = totalDeals;
          }
        }
      }));
      // 후처리 몫을 따로 남긴다 — 라이브 7.4s 중 DB 본조회가 아닌 부분이 어디인지 몰라
      //   조치 범위를 못 좁혔던 구간이다(_msQuery 와 짝).
      const _msEnrich = Date.now() - _tEnrich;
      if (_msEnrich >= 1000) {
        logger.warn({ q, msEnrich: _msEnrich, groupCount: Object.keys(groups).length },
          '검색 buildYear 보충 지연(1s+)');
      }
    }

    // SEARCH-RANK-2026-06-14: 결과를 거래량(dealCount) 내림차순 정렬 — 동명/브랜드 검색 시 거래 활발한 단지 우선.
    //   (기존: molit 이름매칭 → master 동매칭 순서라 "대치동" 검색에 1건짜리가 22건짜리보다 위로 뜸.)
    //   거래 없는 master 단지(dealCount 미정)는 0 으로 후순위. exact 단지명 검색은 결과 1~2개라 영향 없음.
    //   동률은 기존 순서 보존(JS sort stable) → molit 우선·이름매칭 순서 유지.
    // SEARCH-RANK-2026-07-11 (Sprint HHHH 보강): 이 최종 정렬이 위 molit 그룹 rank 정렬을 덮어써
    //   master 병합 항목("시범다은마을월드반도" 60건)이 정확일치 "은마"(44건)를 다시 이기던 것 —
    //   라이브 재검증으로 발각. 일치 등급(정확0·시작1·포함2)을 최종 정렬에서도 최우선으로.
    out.sort((a, b) => (_qRank(a.aptName) - _qRank(b.aptName)) || ((b.dealCount || 0) - (a.dealCount || 0)));

    // degraded 를 응답에 명시 — 위장하지 않기 위한 표식이자, 로그가 1시간이면 사라지는 이 경로에서
    //   "이 응답이 반쪽이었나"를 사후에 확인할 유일한 수단이다.
    //   ⚠ **프론트가 이 필드를 실제로 소비한다**(frontend/index.html 의 `j.degraded` → "⚠ 일부 데이터를
    //   불러오지 못해 결과가 불완전해요" 배너, Sprint NNNNNNN-3). 이 필드를 지우면 사용자 고지가
    //   조용히 사라진다 — 관측용이라고만 보고 정리하지 말 것.
    const payload = _degraded ? { results: out, query: q, degraded: true } : { results: out, query: q };
    if (_degraded) {
      // 강등 응답은 서버 캐시·CDN 어디에도 굳히지 않는다 — 3초 타임아웃 한 번이 10분(+SWR 1시간)
      //   동안 전 사용자에게 반쪽 결과를 고정시키는 것을 막는다. 다음 요청이 정상 경로를 다시 탄다.
      res.set('Cache-Control', 'no-store');
    } else {
      cache.set(sck, payload, 600); // 10분 — molit 데이터는 daily cron 갱신
      res.set('Cache-Control', SEARCH_CDN);
    }
    res.json(payload);
  } catch (e) {
    logger.warn({ err: e.message, q }, '단지 검색 실패');
    captureRouteError(e, 'search/apt');
    // MOB-AUDIT-2026-05-03: production 에선 detail 제거 — 내부 에러 누출 차단
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: '검색 실패',
      ...(isProd ? {} : { detail: e.message }),
    });
  }
});

// ── GET: 인기 단지 (마커 prefill) — 인증 불필요 ──────────
// P0 (Phase 2 3-2): 첫 진입 시 빈 지도 첫인상 차단.
// POPULAR-HONEST-2026-06-14 (운영자 결정 "전국 거래량순으로 정직하게"):
//   [근본 원인] 선정용 RPC search_popular_apts 가 DB 에 부재 → 코드가 항상 fallback 으로 떨어졌고,
//     그 fallback 이 (a) 강남4구+마용성 7개 구 하드코딩 + (b) 최근 200건 샘플 내 카운트 였음.
//     결과: 전국 60일 거래량 top25 중 84%(평촌어바인퍼스트 63건 1위 포함)가 화이트리스트 밖이라 제외,
//           화면엔 샘플 2~7건짜리 강남권 단지만 노출 → "인기"라 부르기 어려운 지역 편향.
//   [Fix] search_popular_apts RPC(전국 60일 GROUP BY count desc) 를 1차 소스로 사용. 지역 하드코딩·200샘플 제거.
//         좌표 join + lazy-fill 은 기존 검증 로직 그대로 재사용(소스만 교체) → 회귀 최소.
//   [회귀 위험] RPC 장애 시 fallback 도 지역 하드코딩 없이 전국 샘플 그룹핑으로 degrade (편향 재발 방지).
// SNAPSHOT-2026-07-11 (Sprint LLLL): 집계 로직은 services/popularService.js 로 이동 (로직 무변경).
//   서빙 우선순위: ① 서버 인메모리 캐시 → ② 일별 사전집계 스냅샷(cron 이 저장, 36h 신선) →
//   ③ 라이브 집계(RPC 7s + 품질 후처리 + 좌표 lazy-fill) + 성공본이면 스냅샷도 갱신.
//   스냅샷 테이블 미생성(운영자 SQL 전)이어도 ②가 조용히 null → ③ 동작 — 완전 무해.
router.get('/popular', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 30);
  try {
    const CDN_OK = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';
    // ① 서버 인메모리 캐시 (Sprint HHHH)
    const pck = `popular:${limit}`;
    const pcached = cache.get(pck);
    if (pcached) {
      res.set('Cache-Control', CDN_OK);
      return res.json(pcached);
    }
    // ② 일별 사전집계 스냅샷 — 콜드 RPC timeout 근본 회피 (밀리초 응답)
    const snap = await readPopularSnapshot(limit);
    if (snap) {
      const payload = { results: snap };
      cache.set(pck, payload, 1800);
      res.set('Cache-Control', CDN_OK);
      return res.json(payload);
    }
    // ③ 라이브 집계 — POPULAR-QUALITY-FIX-2026-07-11: fallback(저품질) 결과는 캐시 2분만
    const { results: out, usedFallback } = await buildPopularResults(limit);
    res.set('Cache-Control', usedFallback
      ? 'public, max-age=0, s-maxage=120, stale-while-revalidate=600'
      : CDN_OK);
    const payload = { results: out };
    if (out.length) cache.set(pck, payload, usedFallback ? 120 : 1800); // 빈 응답은 캐시 안 함
    // 정상 품질(RPC 성공본)이면 스냅샷도 갱신 — 다음 콜드 사용자를 위해.
    // FREEZE-FIX-2026-08-16 (Plan 011): 종전엔 await 없이 던져만 뒀다. Vercel 서버리스는
    //   res.json() 직후 인스턴스를 동결하므로 남은 upsert 가 유실될 수 있다 — 유실되면 스냅샷
    //   computed_at 이 갱신되지 않아 노화하고, 그러면 사용자 요청이 무거운 라이브 집계를 다시 타는
    //   원래 순환으로 돌아간다(POPULAR-STALE·SNAPROLE 이 손보려던 바로 그 문제).
    //   2026-08-09 Plan 003 이 같은 이유로 geocodeCacheService 의 좌표 저장을 await 로 고쳤는데
    //   이 경로만 남아 있었다. 응답 전에 완주시키되(단일 upsert, 수십 ms) 실패는 기존대로 삼킨다.
    if (!usedFallback && out.length && limit === 12) {
      await storePopularSnapshot(out).catch(() => {});
    }
    return res.json(payload);
  } catch (e) {
    logger.warn({ err: e.message }, '인기 단지 조회 실패');
    // POPULAR-STALE-2026-08-16 (Sprint LLLLLLL — Sentry NODE-9 statement timeout 8건):
    //   라이브 집계가 죽어도 만료 스냅샷(최대 7일)이 있으면 그걸 준다 — 프론트는 !r.ok 를
    //   조용히 return 해서 **빈 지도**가 되는데, 60일 거래량 랭킹은 며칠 묵어도 유효하다.
    //   stale 표기를 payload 에 남겨 위장하지 않는다. 캐시는 2분만(다음 요청이 정상 경로 재시도).
    const stale = await readPopularSnapshot(limit, 7 * 24 * 60 * 60 * 1000).catch(() => null);
    if (stale && stale.length) {
      logger.warn({ count: stale.length }, '인기 단지 — 만료 스냅샷 폴백');
      // ★ 여기만 await 한다 — 바로 다음 줄이 응답이라 fire-and-forget 이면 동결에 걸려 유실될 수 있다.
      //   (위 molit/master 강등 경로는 이후 처리가 더 이어지므로 그대로 둔다 — 지연을 안 만드는 쪽이 낫다.)
      await _observeDegrade('popular-stale');
      res.set('Cache-Control', 'public, max-age=0, s-maxage=120');
      return res.json({ results: stale, stale: true });
    }
    captureRouteError(e, 'search/popular');
    res.status(500).json({ error: '조회 실패' });
  }
});

// ── GET /api/search/in-bounds — 지도 영역 단지 조회 (Phase 4, 2026-04-26) ──
//   ?south=&west=&north=&east=&limit= → apt_geocache 좌표 기반 영역 필터
//   사용자가 지도 panning 후 "이 영역 단지 보기" 클릭 → 호갱노노 패턴
router.get('/in-bounds', async (req, res) => {
  const south = parseFloat(req.query.south);
  const west = parseFloat(req.query.west);
  const north = parseFloat(req.query.north);
  const east = parseFloat(req.query.east);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  if (!south || !west || !north || !east) return res.status(400).json({ error: 'bounds 필수' });
  if (north - south > 1 || east - west > 1) return res.status(400).json({ error: '영역 너무 큼 (1도 이내)' });

  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });

  try {
    // apt_geocache 좌표 범위 필터 + molit_transactions 평균가 join
    const { data: coords, error } = await admin
      .from('apt_geocache')
      .select('apt_name, sigungu, umd_nm, lat, lng, apt_key, place_name')
      .gte('lat', south).lte('lat', north)
      .gte('lng', west).lte('lng', east)
      .limit(limit);
    if (error) throw error;
    if (!coords?.length) return res.json({ results: [] });

    // 단지별 최근 거래 평균가 fetch
    const names = [...new Set(coords.map(c => c.apt_name))];
    // CROSS-REGION-FIX-2026-06-03 (운영자 발견 "지도 영역보기 단지가 검색과 다르고 실거래 0건"):
    //   [근본 원인] 아래 stats join 이 apt_name 만으로 매칭(.in('apt_name', names)) → 시군구/동 스코프 없음.
    //     "풍림아파트"/"현대"/"벽산"/"청구" 등 전국 동명 단지 거래가 1개 stats 로 뭉쳐짐 → geocache 의 노원구
    //     좌표가 용인(lawd 41465) 거래의 lawdCd·buildYear·평균가를 상속. 마커 클릭 → openAptDetail 이
    //     타지역 lawdCd 로 /transactions 호출 → sigungu 필터가 전부 제거 → "거래 데이터 부족"(검색과 불일치).
    //     실측(2026-06-03): 공릉동 in-bounds 41개 마커 중 16개(39%)가 타지역 lawd_cd. 749개 이름이 충돌 위험.
    //   [Fix] (apt_name, sigungu, umd_nm) 정확 키로 stats 집계 + 쿼리도 동(umd) 스코프로 한정.
    //     검색(/search/apt)이 molit row 자신의 sigungu/umd 로 스코프하는 것과 동일 기준 → 두 path 일관.
    //   [회귀 위험] geocache triple 8878 중 8816(99.3%)이 동일 (name,sigungu,umd) molit row 보유 →
    //     정상 단지 영향 0. 자기 지역 매칭 없는 유령 마커(예: 공릉동 "풍림아파트" — 실제는 공릉풍림아이원)만 사라짐.
    const umds = [...new Set(coords.map(c => c.umd_nm).filter(Boolean))];
    // REST-CAP-FIX-2026-08-09 (Sprint GGGGGGG): 기존 .limit(1000) 단일 쿼리는 PostgREST 1000행
    //   캡 — 실측(상위 100단지 180일 거래 8,881건)상 밀집/광역 viewport 에서 최신 일부만 집계돼
    //   마커 평균가·건수가 왜곡됐다. range 페이징(상한 10,000)으로 전량 수집 — 통상 viewport 는
    //   1페이지(<1000)로 끝나 왕복 증가 없음. 2차 정렬키 id 로 페이지 경계 안정화.
    const _cut180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // PARALLEL-BLOCKS-2026-08-17 (Plan 030): 아래 거래 페이징과 alias 페이징은 **서로의 결과를
    //   전혀 참조하지 않는다**(둘 다 위에서 이미 계산된 names/umds 만 읽고, 합치는 코드는 양쪽이
    //   다 끝난 뒤에 온다). 순차로 돌 이유가 없어 Promise.all 로 겹친다. 지도를 움직일 때마다
    //   호출되는 핫패스다.
    //   ⚠ 각 promise 에 `.catch` 를 **일부러 달지 않았다** — 현재 동작은 조회가 throw 하면
    //     라우트 상위 try/catch 로 가는 것이고, 여기서 빈 배열로 삼키면 마커 개수·평균가가
    //     조용히 왜곡된다(이 저장소가 겪은 사고 유형). 병렬화는 대기만 겹칠 뿐 실패 의미는 그대로다.
    //   ⚠ 페이지 크기·상한(9000/4000)·정렬 키·필터는 한 글자도 바꾸지 않았다 — 각각 근거 주석이 있다.
    const _fetchTxs = async () => {
      const txs = [];
      for (let _from = 0; _from <= 9000; _from += 1000) {
        let _q = admin
          .from('molit_transactions')
          .select('apt_name, sigungu, umd_nm, deal_amount, build_year, deal_date, lawd_cd')
          .in('apt_name', names);
        if (umds.length) _q = _q.in('umd_nm', umds); // 동 스코프 — 전국 동명 충돌 차단 + row budget 보호
        const { data: _page } = await _q
          .gte('deal_date', _cut180)
          .order('deal_date', { ascending: false })
          .order('id', { ascending: false })
          .range(_from, _from + 999);
        if (_page && _page.length) txs.push(..._page);
        if (!_page || _page.length < 1000) break;
      }
      return txs;
    };
    // (원래 `if (umds.length)` 블록 안에 있던 루프 — 조건을 그대로 유지하고 거짓이면 빈 배열)
    const _fetchMasters = async () => {
      if (!umds.length) return [];
      // REST-CAP-FIX-2026-08-09: limit 없는 SELECT 는 PostgREST 서버 캡(1000)에 조용히 잘림 —
      //   molit_aliases 보유 행이 14,901(사실상 전체)라 광역 viewport(상위 100동 = 실측 4,574행)에서
      //   alias 병합 누락 → 같은 단지 마커 분리(ALIAS-MERGE 이전 버그) 재발 위험. kapt_code 안정
      //   정렬 + range 페이징(상한 5,000).
      const masters = [];
      for (let _mf = 0; _mf <= 4000; _mf += 1000) {
        const { data: _mp } = await admin
          .from('apt_master')
          .select('apt_name, sigungu, umd_nm, kapt_code, molit_aliases')
          .in('umd_nm', umds)
          .not('molit_aliases', 'is', null)
          .order('kapt_code', { ascending: true })
          .range(_mf, _mf + 999);
        if (_mp && _mp.length) masters.push(..._mp);
        if (!_mp || _mp.length < 1000) break;
      }
      return masters;
    };
    const [txs, _masters] = await Promise.all([_fetchTxs(), _fetchMasters()]);
    const aptStats = {};
    for (const t of (txs || [])) {
      // (apt_name|sigungu|umd_nm) 정확 키 — 동명 타지역 단지 합산 차단
      const _k = `${t.apt_name}|${t.sigungu}|${t.umd_nm}`;
      if (!aptStats[_k]) aptStats[_k] = { sum: 0, n: 0, buildYear: t.build_year, lawdCd: t.lawd_cd };
      aptStats[_k].sum += t.deal_amount || 0;
      aptStats[_k].n++;
    }

    // ALIAS-MERGE-2026-05-21 (운영자 발견 "검색 vs 지도 영역보기 매물 불일치"):
    //   apt_geocache 는 MOLIT raw 단지명 (예: "풍림아파트A"/"풍림아파트B") 으로 좌표 보유 →
    //   in-bounds 가 raw 명 그대로 노출 → 같은 단지(공릉풍림아이원)가 지도에 2~3개 별도 마커로 분리.
    //   검색(/search/apt)은 apt_master + molit_aliases 로 1개 단지로 병합 → 두 path 가 별개 물건처럼 보임.
    //   Fix: 영역 내 동(umd)의 apt_master.molit_aliases 로 raw→canonical 역매핑 → 같은 master 단지로 병합.
    //   master 단지는 source:'master' + aptSeq(kaptCode) 부여 → frontend 가 검색과 동일한 상세 모달 fetch 가능.
    //   (umds 는 위 CROSS-REGION-FIX 에서 이미 계산 — 재사용)
    const aliasToMaster = {}; // key: `${alias}|${umd}` → master row
    // PARALLEL-BLOCKS-2026-08-17 (Plan 030): 조회 자체는 위 `_fetchMasters` 가 거래 조회와 병렬로
    //   이미 끝냈다. 여기 남은 것은 순수 계산(역매핑 조립)뿐이다. `umds.length` 게이트는
    //   `_fetchMasters` 안으로 옮겼고, 비면 빈 배열이라 이 루프가 안 돈다 — 동작 동일.
    for (const m of (_masters || [])) {
      const al = Array.isArray(m.molit_aliases) ? m.molit_aliases : [];
      for (const a of al) aliasToMaster[`${a}|${m.umd_nm}`] = m;
    }

    // CANON-COORD-FIX-2026-06-03 (운영자 발견 "공릉풍림아이원 마커가 단지 아닌 충전소 위치에 찍힘"):
    //   geocache 의 alias 좌표(풍림아파트A/B)는 Kakao 가 '전기차충전소'·'B상가주차장' 같은 하위시설로 매칭한
    //   오프셋 좌표(본체에서 158~392m). 같은 단지의 kapt 키(kapt:kaptCode) 좌표는 place_name=단지 본체("공릉풍림아파트")로
    //   정확. master 그룹 대표좌표를 kapt 본체 좌표로 교체(아래 grouping 후).
    const kaptCoord = {}; // kaptCode → {lat,lng} (본체 좌표)
    for (const c of coords) {
      if (typeof c.apt_key === 'string' && c.apt_key.startsWith('kapt:') && c.lat != null && c.lng != null) {
        const _kc = c.apt_key.slice(5);
        if (_kc) kaptCoord[_kc] = { lat: Number(c.lat), lng: Number(c.lng) };
      }
    }
    // CANON-COORD-FIX-2026-06-03: 하위시설 place_name (단지 본체서 오프셋된 좌표) 판별 — 대표좌표 선택 시 deprioritize.
    //   ("상가"·"입구"는 주상복합/"서울대입구" false-positive 로 제외 — 정확성 우선.)
    // SUBFEATURE-WIDEN-2026-08-17 (Sprint MMMMMMM, 서울 전수조사 4회차): '경로당·노인정·교차로' 추가.
    //   전국 place_name 실측 — 경로당/노인정 298건·교차로 9건이 이 그물에 안 걸려 대표좌표로 뽑히고 있었다.
    //   단지명에 이 세 단어가 든 경우는 apt_master·molit 모두 0건(SQL 실측) → 오탐 위험 없음.
    //   ⚠ 이 정규식은 **한 그룹에 후보가 2개 이상일 때 순위를 매기는 용도**다. 후보가 하나뿐이면
    //     하위시설이어도 그대로 쓰인다 — 근본 해소는 geocacheBackfill 의 reheal(같은 단어 추가함)이 한다.
    const SUBFEATURE_RE = /충전소|주차장|정류장|정문|후문|관리사무소|경비실|놀이터|경로당|노인정|교차로|주민센터|복지관|다이소|출구|치과|기공소/;

    // MOB-AUDIT-2026-05-04: 거래 0건 단지 (apt_geocache 에 좌표만 있고 molit 매칭 X) 는
    //   avgPrice 0.00억 으로 노출되어 사용자 오인 → 결과에서 제외 (legal 보호)
    // ALIAS-MERGE-2026-05-21: canonical 단지명 기준으로 그룹화 (alias 거래 합산).
    const groups = {};
    for (const c of coords) {
      const master = aliasToMaster[`${c.apt_name}|${c.umd_nm}`] || null;
      const canonName = master ? master.apt_name : c.apt_name;
      const gkey = `${canonName}|${c.umd_nm}`;
      if (!groups[gkey]) groups[gkey] = {
        aptName: canonName,
        sigungu: master ? master.sigungu : c.sigungu,
        umdNm: c.umd_nm,
        lat: Number(c.lat), lng: Number(c.lng),
        sum: 0, n: 0, buildYear: null, lawdCd: null,
        aptSeq: master ? (master.kapt_code || null) : null,
        source: master ? 'master' : 'molit',
        _bestN: -1, _bestRank: -1,
      };
      const g = groups[gkey];
      // CROSS-REGION-FIX-2026-06-03: 정확 키(name|sigungu|umd)로 조회 — 동명 타지역 stats 상속 차단
      const s = aptStats[`${c.apt_name}|${c.sigungu}|${c.umd_nm}`];
      if (s && s.n && s.sum) {
        g.sum += s.sum; g.n += s.n;
        if (!g.buildYear) g.buildYear = s.buildYear;
        if (!g.lawdCd) g.lawdCd = s.lawdCd;
        // CANON-COORD-FIX-2026-06-03: 대표 좌표 = 본체 우선(비하위시설 > 하위시설), 동순위는 거래량.
        //   alias 좌표가 충전소/주차장 등 하위시설이면 오프셋 → 같은 그룹의 비하위시설(본체) 좌표를 우선 선택.
        const _rank = SUBFEATURE_RE.test(c.place_name || '') ? 0 : 1;
        if (_rank > g._bestRank || (_rank === g._bestRank && s.n > g._bestN)) {
          g._bestRank = _rank; g._bestN = s.n; g.lat = Number(c.lat); g.lng = Number(c.lng);
        }
      }
    }
    // CANON-COORD-FIX-2026-06-03: master 그룹 대표좌표를 kapt 본체 좌표로 교체 (alias 하위시설 오프셋 교정)
    for (const g of Object.values(groups)) {
      if (g.source === 'master' && g.aptSeq && kaptCoord[g.aptSeq]) {
        g.lat = kaptCoord[g.aptSeq].lat;
        g.lng = kaptCoord[g.aptSeq].lng;
      }
    }
    const out = Object.values(groups).map(g => {
      if (!g.n || !g.sum) return null; // 거래 0건 → 제외
      const avg = +(g.sum / g.n / 10000).toFixed(2);
      if (!avg || avg <= 0) return null;
      return {
        aptName: g.aptName,
        sigungu: g.sigungu,
        umdNm: g.umdNm,
        lat: g.lat,
        lng: g.lng,
        avgPrice: avg,
        dealCount: g.n,
        buildYear: g.buildYear || null,
        lawdCd: g.lawdCd || null,
        aptSeq: g.aptSeq || null,
        source: g.source,
      };
    }).filter(Boolean);
    res.json({ results: out, count: out.length });
  } catch (e) {
    logger.warn({ err: e.message }, '영역 검색 실패');
    captureRouteError(e, 'search/in-bounds');
    res.status(500).json({ error: '영역 검색 실패' });
  }
});

// ── GET /api/search/facility — 단지 상세 풍부화 (Phase 4, 2026-04-26) ──
//   인증 불필요 (단지 공공정보) — requireAuth 앞에 마운트
router.get('/facility', async (req, res) => {
  const aptName = String(req.query.aptName || '').trim();
  const sigungu = String(req.query.sigungu || '').trim() || null;
  const umdNm = String(req.query.umdNm || '').trim() || null;
  // APTSEQ-FALLBACK-2026-05-12: aptSeq query param 받기 (apt_master 미매칭 단지 fallback)
  const aptSeq = String(req.query.aptSeq || '').trim() || null;
  // KAPT-LOOKUP-2026-05-12: lawdCd query param 받기 (SigunguAptList3 runtime lookup)
  const lawdCd = String(req.query.lawdCd || '').trim() || null;
  // FACILITY-SPLIT-2026-07-11 (Sprint IIII, 실측 4.7~7.3s + 모달당 이중호출 발견):
  //   mode=basic  → 학교·학구도·학원·NEIS(Kakao 콜 다수) 스킵 — 모달 첫 표시용 (~1s, DB 위주)
  //   mode=schools → altCandidates DB 조회 스킵 — 모달 표시 후 lazy 학교 로드용
  //   기본(full)  → 기존 전체 (기존 호출자 회귀 0)
  const mode = String(req.query.mode || 'full');
  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  const admin = adminClient();
  if (!admin) return res.status(503).json({ error: '서비스 일시 불가' });

  try {
    // AC-PARALLEL-2026-08-17 (실측 후 정정): 학교 블록과만 겹치면 **프론트 경로에서는 이득이 0** 이다.
    //   프론트는 mode 를 `basic`(모달 첫 표시) 과 `schools`(lazy) 로만 쓴다(grep 실측, `full` 호출 없음):
    //     - basic  → 학교 블록이 통째로 스킵 → 겹칠 상대가 없다
    //     - schools → alias 가 [] 로 즉시 반환 → 겹칠 상대가 없다
    //   실제로 남는 유일한 병렬화 기회는 **resolveFacility(KAPT/DB) ∥ alias(DB)** 다. 둘 다
    //   req.query 와 admin 만 쓰고 서로를 참조하지 않는다 → 여기서 미리 띄우고 아래에서 기다린다.
    //   ⚠ `.catch(()=>{})` 는 **unhandled rejection 경고만** 막는다. 원본 promise 는 여전히 rejected
    //     상태로 남아 아래 Promise.all 이 그대로 받는다 → 실패 의미·전파 경로는 종전과 동일하다.
    const _altP = _fetchAltCandidates();
    _altP.catch(() => {});
    const facility = await resolveFacility({ aptName, sigungu, umdNm, aptSeq, lawdCd });

    // STAB-AUDIT-2026-05-07 P0+P1+P2: 학교 정보 통합 (검색 path 풍부화)
    //   - P0 카카오맵: 반경 1km 학교 list (이름·거리·종류)
    //   - P1 학교알리미 NEIS: 학생수·학급수·교사수 (학교명 매칭)
    //   - P2 학구도: 단지 좌표 → 배정 초·중 (서울 우선)
    // Sprint OO (2026-05-19): 강연 자료 적용 — 학군 권역 라벨 + 학원가 정보
    //   - schoolCluster: 3대 학원가 + 4권역 정적 라벨 (sigungu/umdNm 매핑)
    //   - nearbyAcademies: 반경 500m 학원 카운트 + 카테고리 분류
    let nearbySchools = [];
    let schoolDistrict = null;
    let nearbyAcademies = null;
    // PARALLEL-BLOCKS-2026-08-17 (Plan 030): 이 학교/학원 블록과 아래 alias 후보 블록은 서로를
    //   전혀 참조하지 않는다(alias 는 req.query 의 aptName/sigungu/umdNm 만 읽는다). 순차로 두면
    //   Kakao/NEIS 다수 콜(실측 4.7~7.3s)이 끝날 때까지 DB 한 방 조회가 그냥 기다린다.
    //   ⚠ 기존 try/catch 를 **함수 안에 그대로** 둔다 — 학교 실패가 alias 를 죽이면 회귀다.
    //   ⚠ nearbySchools/schoolDistrict/nearbyAcademies 는 상위 스코프 let 에 그대로 대입한다
    //     (응답 조립부를 건드리지 않는 것이 우선).
    const _schoolsBlock = async () => {
    if (mode !== 'basic') try { // FACILITY-SPLIT (Sprint IIII): basic 은 Kakao/NEIS 콜 전부 스킵
      const coord = await resolveCoord({
        kaptCode: facility?.kaptCode,
        aptName, sigungu, umdNm,
        address: facility?.raw?.doroJuso || facility?.raw?.kaptAddr,
      });
      if (coord?.lat && coord?.lng) {
        // P0: 반경 1km 학교 fetch + 학원 fetch (병렬 P1·P2 와 함께)
        // Sprint OO+ (2026-05-19 verify): 각 promise .catch 추가 — 학원 실패가 학교 실패 캐스케이드 차단
        const [schools, district, academies] = await Promise.all([
          resolveSchools({ kaptCode: facility?.kaptCode, aptName, sigungu, umdNm, lat: coord.lat, lng: coord.lng }).catch(e => { logger.debug({err:e.message},'학교 실패'); return []; }),
          resolveSchoolDistrict({ lat: coord.lat, lng: coord.lng, sigungu, umdNm }).catch(e => { logger.debug({err:e.message},'학구도 실패'); return null; }),
          resolveAcademies({ kaptCode: facility?.kaptCode, aptName, sigungu, umdNm, lat: coord.lat, lng: coord.lng }).catch(e => { logger.debug({err:e.message},'학원 실패'); return null; }),
        ]);
        // P1: 학교알리미 NEIS 풍부화 (학생수·학급수)
        const enriched = schools && schools.length
          // LAWD-FIRST-2026-08-10: lawdCd 를 넘겨 시도교육청을 코드로 확정한다
          //   (이름 추정은 '해운대구'·'수성구'·'청주시상당구' 를 전부 서울로 오판했다).
          ? await resolveSchoolNeisBatch(schools, sigungu, lawdCd)
          : [];
        nearbySchools = enriched;
        schoolDistrict = district;
        nearbyAcademies = academies;
      }
    } catch (schoolErr) {
      logger.debug({ err: schoolErr.message, aptName }, '학교/학원 데이터 조회 실패 (무시)');
    }
    };

    // CLUSTER-RETIRE-2026-08-19 (Sprint NNNNNNN-3, 사업기획 v2 판정): 학군 권역 정적 라벨 제거.
    //   출처가 '강연 자료 + KB 보고서'로, 우리 절대 룰(정부 공식 출처만 인용)과 충돌하는 유일한
    //   데이터였다. NEIS 실데이터(nearbySchools 의 학생수·학급수)만 남긴다.
    //   응답 키는 유지하고 null 고정 — 프론트 렌더 블록은 같은 스프린트에서 제거(계약 파손 방지).
    const schoolCluster = null;

    // 같은 동의 다른 MOLIT 단지명 — alias 후보 (사용자 표시용)
    // Phase 4 (2026-04-26): 토큰 매칭 우선순위 — 정식명 핵심 단어가 MOLIT 신고명에 포함되면
    //   같은 단지일 가능성 높음 (예: '공릉풍림아이원' 의 '풍림' → '풍림아파트A/B' 우선).
    //   이전: 거래량 순 50건 안에 풍림아파트B(14건) 누락 → 사용자 거래 누락.
    // ⚠ 화살표 const 가 아니라 **함수 선언**이다 — 위쪽(resolveFacility 앞)에서 먼저 호출해야 해서
    //   호이스팅이 필요하다. 정의를 통째로 위로 옮기면 diff 가 커지고 검증이 어려워진다.
    async function _fetchAltCandidates() {
      // FACILITY-SPLIT: schools 는 alias DB 조회 불필요 (원래 `if` 게이트를 조기 return 으로 뒤집었을 뿐)
      if (!(mode !== 'schools' && sigungu && umdNm)) return [];
      const { data: alts } = await admin
        .from('molit_transactions')
        .select('apt_name, build_year')
        .eq('sigungu', sigungu)
        .eq('umd_nm', umdNm)
        .neq('apt_name', aptName)
        .limit(500);
      const seen = new Set();
      // 정식명에서 핵심 토큰 추출 (행정구역 prefix 제거 후 길이 2+ 단어들)
      const baseName = aptName
        .replace(new RegExp(`^(${_reEsc(sigungu)}|${_reEsc(umdNm)})\\s*`, 'g'), '')
        .replace(/\s+/g, '');
      // 부분 문자열 (3+ 글자) 추출 — '공릉풍림아이원' → ['풍림', '아이원', '풍림아이원']
      const tokens = [];
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= baseName.length - len; i++) {
          const t = baseName.substring(i, i + len);
          if (!tokens.includes(t)) tokens.push(t);
        }
      }
      // Sprint NN (2026-05-17, A 작업 sample 검증 중 발견):
      //   "고덕현대아파트" (명일동) 검색 → 명일동 모든 단지가 alt candidate 로 잡힘.
      //   원인: '아파트' (3글자) token 이 거의 모든 MOLIT 단지명에 substring 매칭 → false positive.
      //   결과: master fallback 으로 무관한 "고덕삼환/명일지에스/명일다성이즈빌" 거래 표시 → 환각.
      //   Fix: generic stop tokens 매칭 제외. 정체성 약한 일반 명사 단어 ('아파트', '오피스텔') 제거.
      //   '풍림아파트A' 매칭은 '풍림아' (3글자) 로 score=3 유지 — 회귀 0.
      const STOP_TOKENS = new Set(['아파트', '오피스텔']);
      const candidates = [];
      for (const r of (alts || [])) {
        if (seen.has(r.apt_name)) continue;
        seen.add(r.apt_name);
        // 토큰 매칭 점수 — 더 긴 토큰 매칭 = 우선
        let score = 0;
        for (const tok of tokens) {
          if (STOP_TOKENS.has(tok)) continue; // Sprint NN: generic stop token 제외
          if (tok.length >= 3 && r.apt_name.includes(tok)) score = Math.max(score, tok.length);
        }
        // Phase 4 (2026-04-26): score >= 3 (3글자 이상 매칭) 만 진짜 alias 후보.
        // 이전: score 0도 포함 → '67디벨리움', '건영아파트' 같은 무관 단지가 alias 매칭됨.
        // '공릉풍림아이원' 의 '풍림아' (3글자) 가 '풍림아파트A/B' 와 매칭 — 정확.
        if (score >= 3) {
          candidates.push({ aptName: r.apt_name, buildYear: r.build_year, _score: score });
        }
      }
      // 점수 ↓ → 단지명 ↑ 정렬, 상위 8개 (12 → 8 — false positive 차단)
      candidates.sort((a, b) => b._score - a._score || a.aptName.localeCompare(b.aptName));
      // 작업 D 철회 (2026-05-20, 총괄책임자 판단): molit_aliases DB backfill 제거.
      //   사유: altCandidates 가 이미 동적 계산 (작동 중) + read 로직 없어 저장해도 무의미.
      //   backend update 가 RLS/jsonb 이슈로 미작동 → 매 호출 실패 DB 호출 = 응답 지연만 유발.
      //   RLS 디버깅은 사용자 가치 낮음 + 보안 위험 → 중단. 동적 계산으로 충분.
      return candidates.slice(0, 8).map(({ _score, ...c }) => c);
    }
    // PARALLEL-BLOCKS-2026-08-17 (Plan 030): 학교 블록(느림)과 alias 조회를 겹친다.
    //   학교 블록은 값을 상위 스코프 변수에 대입하므로 반환값을 쓰지 않는다(구멍 뚫린 구조분해).
    //   `_altP` 는 위에서 이미 시작됐다 — 여기서는 기다리기만 한다.
    const [, altCandidates] = await Promise.all([_schoolsBlock(), _altP]);
    // FACILITY-HELPER-2026-05-12 + DTL-INFO-2026-05-13 (Sprint X):
    //   resolveFacility 반환: { kaptCode, official, raw, detail } — Sprint X 부터 detail 동봉.
    //   buildFacility(info, kaptCode, detail) 로 표준 facility 객체 빌드 (주차 등 detail 필드 포함).
    const builtFacility = facility
      ? Object.assign(buildFacility(facility.raw, facility.kaptCode, facility.detail) || {}, {
          official: facility.official || null,
        })
      : null;
    res.json({ facility: builtFacility, altCandidates, nearbySchools, schoolDistrict, schoolCluster, nearbyAcademies });
  } catch (e) {
    logger.warn({ err: e.message, aptName }, 'facility 조회 실패');
    captureRouteError(e, 'search/facility');
    res.status(500).json({ error: 'facility 조회 실패' });
  }
});

router.use(requireAuth);

// ── POST: 검색 1건 기록 ────────────────────────────────────
router.post('/history', async (req, res, next) => {
  try {
    const { query, queryType, resultCount } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query 필수 (string)' });
    }
    const qt = String(queryType || 'keyword');
    if (!ALLOWED_TYPES.has(qt)) {
      return res.status(400).json({ error: `queryType 은 ${[...ALLOWED_TYPES].join('|')} 중 하나` });
    }
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('search_history')
      .insert({
        user_id: req.user.id,
        query: String(query).trim().slice(0, MAX_QUERY_LEN),
        query_type: qt,
        result_count: Number.isInteger(resultCount) ? resultCount : null,
      })
      .select('id, created_at')
      .single();
    if (error) throw error;
    res.status(201).json({ id: data.id, createdAt: data.created_at });
  } catch (e) { next(e); }
});

// ── GET: 최근 50건 ────────────────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('search_history')
      .select('id, query, query_type, result_count, created_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (e) { next(e); }
});

// ── DELETE: 내 이력 전체 삭제 ─────────────────────────────
// 개별 삭제는 의미 없음 — 로그성 데이터
router.delete('/history', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    // RLS 가 본인 row 만 보장하므로 user_id 필터는 불필요하지만
    // 안전망으로 명시 (방어적 코딩 — RLS 실수 시 피해 최소화)
    const { error } = await sb
      .from('search_history')
      .delete()
      .eq('user_id', req.user.id);
    if (error) throw error;
    logger.info({ userId: req.user.id }, '검색 이력 전체 삭제');
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
// 순수 판정 함수 노출 — 테스트 전용(라우터 동작에는 영향 없음). Express Router 는 함수 객체라 프로퍼티 부착 가능.
module.exports.computeDegrade = computeDegrade;
// SEARCH-ABORT-2026-08-16: abort 정규화가 틀리면 Promise.all 이 reject 되어 **강등이 500 으로 퇴행**한다.
//   순수 함수라 DB 없이 계약을 고정할 수 있다 → 테스트에서 직접 호출한다.
module.exports._softQuery = _softQuery;
module.exports._isAbortErr = _isAbortErr;
module.exports.MOLIT_ABORT_MS = MOLIT_ABORT_MS;
