/**
 * 단지 상세 facility 풍부화 (Phase 4, 2026-04-26)
 *
 * 목적:
 *   apt_master.kapt_code 활용 → AptInfo 단지 기본정보 V3 호출 → DB 캐시.
 *   세대수·시공사·주차·승강기·교통·거주성 점수 등 풍부 데이터.
 *
 * 매핑:
 *   apt_name + sigungu + umd_nm → apt_master.kapt_code → facility
 *
 * Lazy fill:
 *   사용자가 단지 클릭 시 (showDetail) 호출 → 첫 호출 ~1초, 이후 캐시 hit.
 *   apt_master.facility 컬럼에 영구 저장 (90일 만료).
 */
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): 직접+Edge 릴레이
const { getSupabaseAdmin } = require('../db/client');
const { getAptListBySgg, getAptDtlInfo } = require('./aptInfoService');
const { isInsertionMatch } = require('../utils/aptName');
const cache = require('../cache');
const logger = require('../logger');

const APT_INFO_KEY = process.env.APT_INFO_API_KEY || process.env.MOLIT_API_KEY;
// AptInfo 기본정보 endpoint 후보 — 첫 호출 시 동작하는 것 발견하면 이후 캐시 사용.
// Phase 8+ (2026-04-26): 사용자 활용신청 endpoint V4 가 표준. V3/V2/V1 fallback.
const FACILITY_ENDPOINTS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4',
  'http://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'http://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBassInfoV2',
  'https://apis.data.go.kr/1613000/AptBasisInfoService/getAphusBassInfo',
];
const CACHE_TTL_DAYS = 90;
let _diagLogged = false;
let _workingEndpoint = null; // 최초 1회 발견 시 캐시 (cold start 마다 재탐색)

function admin() { return getSupabaseAdmin(); }

/** Phase 8+ (2026-04-26): 토큰 매칭 (sliding 2~4) — '한진(609-1)' vs '돈암한신한진아파트' 매칭 */
function tokenize(name) {
  const cleaned = String(name || '')
    .replace(/\([^)]*\)/g, '') // 괄호 제거 (예: "한진(609-1)" → "한진")
    .replace(/\s+/g, '')
    .replace(/아파트$/, '')
    .replace(/^\d+/, '');       // 선두 숫자 제거
  const tokens = new Set();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= cleaned.length - len; i++) {
      tokens.add(cleaned.substring(i, i + len));
    }
  }
  return Array.from(tokens);
}

function nameMatchScore(a, b) {
  const at = tokenize(a);
  const bSet = new Set(tokenize(b));
  let best = 0;
  for (const t of at) if (bSet.has(t) && t.length > best) best = t.length;
  return best;
}

/** STAB-2 (2026-05-03 / RISK-6 fix C): 정규화 후 길이 — wrong match 차단 보조 */
function normalizedLen(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .replace(/아파트$/, '')
    .replace(/^\d+/, '')
    .length;
}

// DEDUP-2026-07-17 (Sprint YYYYY, improve 감사 DEBT-02 후속): 자체 _lcsLen/_isInsertionMatch 사본 제거 —
//   Sprint Z+ 에서 utils/aptName.js 로 추출된 공유본을 이미 import·사용 중(328행)인데 사본이 잔존해
//   임계값(4 vs 5)까지 드리프트된 상태였음. grep 실측 호출처 0(죽은 코드) — 동작 영향 없이 삭제.
//   알고리즘 문서·검증 사례(한신잠실코아↔한신코아 등)는 utils/aptName.js 주석 참조.

/* ────────────────────────────────────────────────────────────────────────────
 * IDENTITY-GATE-2026-08-10 (Sprint KKKKKKK — 운영자 발견 P0)
 *
 * 사고: 도봉구 방학동 MOLIT "신동아아파트1"(1986년 준공·지번 271-1·3,169세대 방학신동아1단지)에
 *   KAPT "신동아 타워 아파트"(1997년·104세대 주상복합)가 붙어, 인기 단지로 노출된 대단지의
 *   단지정보 탭이 통째로 남의 단지 값이었다. 같은 동의 신동아 1~5단지 5개 전부 동일 오답으로 매칭.
 *
 * 근본원인 [원본 함수 vm 재현으로 실증]: STAB-2 의 ratio(=score/min(정규화길이)) 게이트가
 *   **이름이 짧은 후보를 구조적으로 편애**한다. 공통 토큰은 "신동아"(score 3) 하나로 모두 같은데
 *     · 정답 "방학신동아1단지" → minLen 7 → ratio 0.429 → 차단
 *     · 오답 "신동아타워"      → minLen 5 → ratio 0.600 → 통과(임계와 정확히 동일)
 *   즉 정답만 골라 떨어뜨리고 오답만 통과시켰다. 임계값 조정으로는 못 고친다 — 신호가 부족한 것.
 *
 * 해법: 이름 유사도를 **유일한 근거로 쓰지 않는다**. 실거래가 들고 있는 물리적 신원
 *   (지번 jibun · 건축년도 build_year)을 KAPT 값(kaptAddr · kaptUsedate)과 대조한다.
 *     1순위 지번 일치 → 이름과 무관하게 확정 (전국 실측: MOLIT 지번 보유 68.7%, KAPT 지번 추출 95.3%)
 *     2순위 이름 매칭 → 지번/연도 교차검증 통과분만 채택, 실패하면 **거부(null)**
 *   "그럴듯한 틀린 정보"보다 "정보 없음"이 낫다 — 절대 룰(환각 차단).
 *
 * 연도 허용오차 근거 [실측]: 이름 완전일치(= 확실한 정답) 2,841쌍의 |build_year - kaptUsedate| 분포는
 *   0년 2,814(99.05%) / 1년 15 / 2년 3 / 3년 이상 9. 따라서 ±1년이면 정답의 99.6%를 보존한다.
 *   이름 완전일치는 동명 단지 구분 실패만 걸러내면 되므로 ±3년으로 완화(재건축·증축 신고 편차 흡수).
 * ──────────────────────────────────────────────────────────────────────────── */
const YEAR_TOL_WEAK = 1;   // ILIKE·공백정규화·토큰 등 약한 이름매칭
const YEAR_TOL_EXACT = 3;  // 이름 완전일치

/** KAPT 지번주소("서울특별시 도봉구 방학동 271-1 방학신동아1단지")에서 지번만 추출 */
function jibunFromKaptAddr(addr) {
  const m = String(addr || '').match(/[가-힣0-9]+(?:동|리|가)\s+(\d+(?:-\d+)?)/);
  return m ? m[1] : null;
}

/** 지번 본번(부번 제거) — 대단지는 필지가 여러 개라 본번까지만 비교한다 ('271-1'/'271-4' → '271') */
function bonbun(jibun) {
  const m = String(jibun || '').trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * MOLIT 실거래가 말해주는 단지 신원 — 오매칭 차단의 기준값.
 * 최근 거래 60건의 최빈 build_year / 최빈 지번 본번. (호출처 수정 없이 모든 경로를 방어하려고
 *  resolveFacility 안에서 직접 조회한다 — 결과는 memKey 캐시에 함께 실려 반복 조회 없음.)
 */
async function molitIdentity(aptName, sigungu, umdNm) {
  const a = admin();
  if (!a || !aptName || !sigungu || !umdNm) return null;
  try {
    const { data, error } = await a.from('molit_transactions')
      .select('build_year, jibun')
      .eq('apt_name', aptName).eq('sigungu', sigungu).eq('umd_nm', umdNm)
      .order('deal_date', { ascending: false })
      .limit(60);
    if (error || !data || !data.length) return null;
    const years = new Map(), jibuns = new Map();
    for (const r of data) {
      if (r.build_year > 1900) years.set(r.build_year, (years.get(r.build_year) || 0) + 1);
      const b = bonbun(r.jibun);
      if (b) jibuns.set(b, (jibuns.get(b) || 0) + 1);
    }
    const top = (m) => { let k = null, v = 0; for (const [kk, vv] of m) if (vv > v) { k = kk; v = vv; } return k; };
    const buildYear = top(years), jibunBon = top(jibuns);
    if (!buildYear && !jibunBon) return null;
    return { buildYear, jibunBon };
  } catch (_) { return null; }
}

/**
 * 후보 검증 — MOLIT 신원과 대조해 채택 가능한지 판정.
 * facility(KAPT 값)가 아직 없는 후보는 판정 불가라 통과시키고, resolveFacility 가 API 응답을
 * 받은 뒤 verifyResolved() 로 한 번 더 검증한다(2단 방어).
 * @returns {{ ok:boolean, reason:string }}
 */
function verifyCandidate(kaptUsedate, kaptAddr, identity, mode) {
  if (!identity) return { ok: true, reason: 'no-identity' };

  // 지번 일치 = 강한 긍정 신호 → 즉시 채택.
  const kBon = bonbun(jibunFromKaptAddr(kaptAddr));
  if (identity.jibunBon && kBon && identity.jibunBon === kBon) {
    return { ok: true, reason: 'jibun-match' };
  }
  // 단, 지번 **불일치는 거부 근거로 쓰지 않는다** [실측]: 이름 완전일치(= 확실한 정답) 2,426쌍 중
  //   10.47%(254건)가 본번 불일치다 — 대단지가 여러 필지에 걸쳐 MOLIT 신고 지번과 KAPT 대표 지번이
  //   서로 다른 필지를 가리키는 경우가 흔하다. 거부 신호로 쓰면 정상 매칭 10%를 날린다.
  //   거부는 연도로만 한다 (정답의 99.05%가 연도차 0 — 훨씬 깨끗한 신호).
  const ky = String(kaptUsedate || '').slice(0, 4);
  if (identity.buildYear && /^\d{4}$/.test(ky)) {
    // 공백 차이만 있는 이름(space-norm)은 사실상 완전일치로 본다 — 전수 진단 실측에서
    //   MOLIT "영도센트럴에일린의뜰"(2023) ↔ KAPT "영도 센트럴 에일린의뜰"(2021) 같은 정답 쌍이
    //   ±1년 게이트에 걸려 거부되는 것이 확인됐다. 포함매칭(ilike)·토큰은 오매칭 위험이 커 ±1 유지.
    const tol = (mode === 'exact' || mode === 'space-norm') ? YEAR_TOL_EXACT : YEAR_TOL_WEAK;
    const diff = Math.abs(Number(ky) - identity.buildYear);
    if (diff > tol) {
      return { ok: false, reason: `준공연도 ${diff}년 차이(실거래 ${identity.buildYear} vs KAPT ${ky})` };
    }
  }
  return { ok: true, reason: 'verified' };
}

/** apt_name + sigungu + umd_nm 으로 apt_master 매칭 → kapt_code (identity 로 교차검증) */
async function findMaster(aptName, sigungu, umdNm, identity) {
  const a = admin();
  if (!a || !aptName) return null;
  const COLS = 'kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at';
  const check = (cand, mode) => verifyCandidate(
    cand?.facility?.kaptUsedate, cand?.facility?.kaptAddr, identity, mode);

  // 동/리 정보가 없으면 후보를 좁힐 수 없다 — 기존대로 이름 완전일치만 (검증은 동일 적용)
  if (!sigungu || !umdNm) {
    let q = a.from('apt_master').select(COLS).eq('apt_name', aptName);
    if (sigungu) q = q.eq('sigungu', sigungu);
    const { data } = await q.maybeSingle();
    if (!data) return null;
    const v = check(data, 'exact');
    if (!v.ok) {
      logger.warn({ aptName, sigungu, master: data.apt_name, reason: v.reason },
        'KAPT 매칭 거부 (IDENTITY-GATE)');
      return null;
    }
    return data;
  }

  // 같은 sigungu+umd_nm 후보 전량 — 기존 limit(80) 은 실측 최대 81개 동에서 잘렸다(range 페이징).
  const candidates = [];
  for (let from = 0; from <= 900; from += 300) {
    const { data: page, error } = await a.from('apt_master').select(COLS)
      .eq('sigungu', sigungu).eq('umd_nm', umdNm)
      .order('kapt_code', { ascending: true })
      .range(from, from + 299);
    if (error) break;
    if (page && page.length) candidates.push(...page);
    if (!page || page.length < 300) break;
  }
  if (!candidates.length) return null;

  // ── 1순위: 지번 매칭 — 이름이 아무리 달라도 같은 땅이면 같은 단지 ──
  //    MOLIT "신동아아파트1"(271-1) → KAPT "방학신동아1단지"(방학동 271-1) 정답 복원 경로.
  if (identity && identity.jibunBon) {
    const hits = candidates.filter(
      (c) => bonbun(jibunFromKaptAddr(c?.facility?.kaptAddr)) === identity.jibunBon);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      // 한 필지에 여러 KAPT 단지(단지 분할 등록) — 준공연도 일치를 먼저 보고, 그 다음 이름 유사도
      let best = null, bestYear = -1, bestScore = -1;
      for (const c of hits) {
        const ky = String(c?.facility?.kaptUsedate || '').slice(0, 4);
        const yearOk = (identity.buildYear && /^\d{4}$/.test(ky)
          && Math.abs(Number(ky) - identity.buildYear) <= YEAR_TOL_WEAK) ? 1 : 0;
        const s = nameMatchScore(aptName, c.apt_name);
        if (yearOk > bestYear || (yearOk === bestYear && s > bestScore)) {
          bestYear = yearOk; bestScore = s; best = c;
        }
      }
      return best;
    }
  }

  const stripped = String(aptName).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');

  // ── 2순위: 이름 매칭 단계별 후보 → 각각 검증, 실패하면 다음 단계로 ──
  //    (기존 순서 보존: 정확일치 → 이름포함 → 공백정규화 일치 → 토큰. 달라진 건 "검증 통과분만 채택".)
  const rejected = [];
  const tryPick = (cand, mode) => {
    if (!cand) return null;
    const v = check(cand, mode);
    if (v.ok) return cand;
    rejected.push({ master: cand.apt_name, mode, reason: v.reason });
    return null;
  };

  const exact = candidates.find((c) => c.apt_name === aptName);
  const picked1 = tryPick(exact, 'exact');
  if (picked1) return picked1;

  // ILIKE 상당 — molit 가 더 길 때 ('래미안엘파인아파트' 안에 master '래미안엘파인')
  if (stripped) {
    const partial = candidates.find((c) => String(c.apt_name).includes(stripped));
    const picked2 = tryPick(partial, 'ilike');
    if (picked2) return picked2;

    // SPACE-NORM-2026-07-15 (Sprint LLLLL): 공백만 다른 이름 — master 'e편한세상 강변' vs molit
    //   'e편한세상강변'(활성 509건 실측). 정확 일치만 허용(포함 확장 X — 오병합 방지).
    const spaceNorm = candidates.find(
      (c) => String(c.apt_name).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '') === stripped);
    const picked3 = tryPick(spaceNorm, 'space-norm');
    if (picked3) return picked3;
  }

  // 토큰 매칭 — RISK-6/STAB-2 게이트 유지(score>=3, ratio>=0.6). 단 이제 통과해도 검증을 거친다.
  //   ratio 게이트가 짧은 이름을 편애하는 구조적 편향이 있으므로(위 사고 원인) 점수 상위부터
  //   차례로 검증하고, 전부 탈락하면 매칭 없음으로 끝낸다.
  const scored = [];
  for (const c of candidates) {
    const score = nameMatchScore(aptName, c.apt_name);
    if (score < 3) continue;
    const minLen = Math.min(normalizedLen(aptName), normalizedLen(c.apt_name));
    const ratio = minLen > 0 ? score / minLen : 0;
    const ky = String(c?.facility?.kaptUsedate || '').slice(0, 4);
    const diff = (identity && identity.buildYear && /^\d{4}$/.test(ky))
      ? Math.abs(Number(ky) - identity.buildYear) : null;
    const yearRank = diff === 0 ? 2 : (diff === 1 ? 1 : 0);
    // ratio 게이트 면제 — 준공연도가 실거래와 **정확히** 같을 때만.
    //   이 게이트가 짧은 이름을 편애해 정답을 떨어뜨린 것이 이번 사고의 원인이었다.
    //   예) MOLIT "신동아아파트5"(1998) 는 지번이 없어 이름으로만 찾아야 하는데
    //       정답 "방학신동아5단지"(1998) 는 ratio 0.429 로 탈락하고
    //       오답 "신동아 타워"(1997) 만 ratio 0.600 으로 통과했다.
    if (ratio < 0.6 && yearRank < 2) continue;
    scored.push({ c, score, ratio, yearRank });
  }
  // 준공연도 일치도 → 이름 점수 → 비율 순. 연도가 맞는 후보를 이름만 비슷한 후보보다 앞세운다.
  scored.sort((x, y) => (y.yearRank - x.yearRank) || (y.score - x.score) || (y.ratio - x.ratio));
  for (const { c } of scored) {
    const picked = tryPick(c, 'token');
    if (picked) return picked;
  }

  if (rejected.length) {
    logger.warn({ aptName, sigungu, umdNm, identity, rejected: rejected.slice(0, 5) },
      'KAPT 매칭 거부 (IDENTITY-GATE) — 실거래 신원과 불일치');
  }
  return null;
}

/** 한 endpoint 시도 — 성공 시 raw item, 실패 시 null + 진단 로그 */
async function tryEndpoint(url, kaptCode) {
  let r;
  try {
    r = await dgk.get(url, {
      params: { serviceKey: APT_INFO_KEY, kaptCode, _type: 'json' },
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    const status = e?.response?.status;
    const rd = e?.response?.data;
    const bodyPreview = typeof rd === 'string' ? rd.slice(0, 800) : JSON.stringify(rd || {}).slice(0, 800);
    return { ok: false, reason: `HTTP ${status}`, bodyPreview };
  }
  // XML 응답 가능성 — string 인 경우 짧게 반환 (진단용)
  if (typeof r.data === 'string') {
    const preview = r.data.slice(0, 300);
    return { ok: false, reason: 'non-json', bodyPreview: preview };
  }
  const header = r.data?.response?.header;
  if (header?.resultCode && !['00', '000'].includes(header.resultCode)) {
    return { ok: false, reason: `code ${header.resultCode}: ${header.resultMsg}`, bodyPreview: '' };
  }
  const body = r.data?.response?.body;
  // item 1개 직접 또는 items 안에 1개
  const item = body?.item
    || (Array.isArray(body?.items) ? body.items[0] : body?.items?.item)
    || body; // V1 은 body 자체가 item 일 수도
  if (!item || (typeof item === 'object' && Object.keys(item).length === 0)) {
    return { ok: false, reason: 'empty body', bodyPreview: JSON.stringify(r.data).slice(0,200) };
  }
  // EMPTY-VALUES-2026-05-12 (Sprint O — 운영자 발견 디버깅):
  //   KAPT 가 잘못된 kaptCode 호출 시 "schema 만 있고 값 모두 null" 응답 반환 (예: aptSeq "11710-8865" 직접 호출).
  //   기존: Object.keys 만 검사 → ok:true → 빈 facility 노출 (totalHouseholds 0 / builtDate null).
  //   해결: 핵심 식별 필드 (kaptName / kaptCode / kaptdaCnt) 모두 null 이면 empty 로 판정.
  if (typeof item === 'object') {
    const meaningful = item.kaptName || item.kaptCode || item.kaptdaCnt || item.kaptUsedate;
    if (!meaningful) {
      return { ok: false, reason: 'all-null body', bodyPreview: JSON.stringify(item).slice(0, 300) };
    }
  }
  return { ok: true, item };
}

/** AptInfo 단지 기본정보 호출 — fallback 체인 */
async function fetchFromApi(kaptCode) {
  if (!APT_INFO_KEY) return null;
  // 작동하는 endpoint 발견 시 이후 그것만 사용 (cold start 안에서)
  const order = _workingEndpoint
    ? [_workingEndpoint, ...FACILITY_ENDPOINTS.filter(u => u !== _workingEndpoint)]
    : FACILITY_ENDPOINTS;
  const attempts = [];
  for (const url of order) {
    const r = await tryEndpoint(url, kaptCode);
    attempts.push({ url: url.split('/').slice(-2).join('/'), ok: r.ok, reason: r.reason, body: r.bodyPreview });
    if (r.ok) {
      _workingEndpoint = url;
      if (!_diagLogged) {
        _diagLogged = true;
        logger.warn({ kaptCode, working: url, attempts }, 'facility endpoint 발견');
      }
      return r.item;
    }
  }
  if (!_diagLogged) {
    _diagLogged = true;
    // 첫 attempt 의 bodyPreview 도 로그 (full)
    const firstFail = attempts[0];
    logger.error({
      kaptCode, attempts,
      keyLen: APT_INFO_KEY ? APT_INFO_KEY.length : 0,
      keyHasPercent: APT_INFO_KEY ? APT_INFO_KEY.includes('%') : null,
    }, 'facility 모든 endpoint 실패 — 진단');
  }
  return null;
}

/** KAPT-LOOKUP-2026-05-12 (Sprint N): apt_master 누락 단지의 KAPT lookup fallback.
 *
 *  flow: lawdCd 의 KAPT SigunguAptList3 응답 (apt_master sync 와 동일 source) 에서
 *        runtime 매칭. apt_master 가 아직 sync 안 된 단지도 즉시 매칭 가능.
 *        매칭 시 자동 apt_master upsert (다음 호출부터 fast path).
 *
 *  Sprint M (aptSeq fallback) 효과 없음 [VERIFIED — MOLIT aptSeq != KAPT kaptCode].
 *  본 Sprint N 이 진짜 fix.
 */
async function _lookupKaptByName(lawdCd, aptName, sigungu, umdNm) {
  if (!lawdCd || !aptName) {
    logger.info({ lawdCd, aptName }, 'KAPT-LOOKUP: 입력 부족 → skip');
    return null;
  }
  try {
    const list = await getAptListBySgg(lawdCd);
    if (!list?.length) {
      logger.warn({ lawdCd, aptName, listLen: list?.length || 0 },
        'KAPT-LOOKUP: SigunguAptList3 빈 리스트 → null');
      return null;
    }
    // KAPT-LOOKUP-DIAG-2026-05-12 (Sprint O): list 정상 수신 시 sample 도 log (debugging)
    //   매칭 실패 원인 추적 — list 에 정말 단지 있는지, kaptName 형식 어떤지
    logger.info({ lawdCd, aptName, listLen: list.length, sample: list.slice(0, 3).map(x => x.kaptName) },
      'KAPT-LOOKUP: SigunguAptList3 list 수신');
    // 정확 매칭 우선
    const stripped = String(aptName).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
    let best = null, bestScore = 0;
    let topCandidates = []; // 디버깅 보조: 점수 ≥ 2 후보 모두 수집
    for (const item of list) {
      if (!item.kaptCode || !item.kaptName) continue;
      const itemStripped = String(item.kaptName).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
      // 1) 정확 매칭
      if (itemStripped === stripped) {
        logger.info({ aptName, lawdCd, matched: item.kaptName, kaptCode: item.kaptCode, mode: 'exact' },
          'KAPT-LOOKUP: SigunguAptList3 정확 매칭 성공');
        return item;
      }
      // 1.5) "포함" 매칭 — KAPT 가 행정구역 prefix 가진 경우 (가락 헬리오시티, 송파헬리오시티 등)
      //      stripped 가 itemStripped 에 포함 (또는 역) + 길이 차이 충분히 작음 (방어적)
      if (stripped.length >= 4 && itemStripped.includes(stripped)) {
        const lenDiff = itemStripped.length - stripped.length;
        if (lenDiff <= 6) { // 너무 큰 길이 차이는 wrong-match 위험
          logger.info({ aptName, lawdCd, matched: item.kaptName, kaptCode: item.kaptCode, mode: 'contains' },
            'KAPT-LOOKUP: SigunguAptList3 포함 매칭 성공');
          return item;
        }
      }
      // 1.7) LCS-MATCH-2026-05-13 (Sprint T → Sprint Z+ 으로 utils 추출):
      //       "한신잠실코아" ↔ KAPT "한신코아", "서강예가" ↔ KAPT "서강쌍용예가" 같은 case.
      //       isInsertionMatch (backend/utils/aptName.js) — transactionService 와 동일 알고리즘.
      if (isInsertionMatch(stripped, itemStripped)) {
        logger.info({ aptName, lawdCd, matched: item.kaptName, kaptCode: item.kaptCode, mode: 'lcs-insertion' },
          'KAPT-LOOKUP: SigunguAptList3 LCS 부분수열 매칭 성공');
        return item;
      }
      // 2) 토큰 매칭 (3자+) — false-positive 차단
      const score = nameMatchScore(aptName, item.kaptName);
      if (score >= 2) topCandidates.push({ name: item.kaptName, score });
      if (score < 3) continue;
      const minLen = Math.min(normalizedLen(aptName), normalizedLen(item.kaptName));
      const ratio = minLen > 0 ? score / minLen : 0;
      if (ratio < 0.6) continue;
      if (score > bestScore) { bestScore = score; best = item; }
    }
    if (best) {
      logger.info({ aptName, lawdCd, matched: best.kaptName, kaptCode: best.kaptCode, score: bestScore, mode: 'token' },
        'KAPT-LOOKUP: SigunguAptList3 토큰 매칭 성공');
    } else {
      // KAPT-LOOKUP-DIAG-2026-05-12: 매칭 실패 시 후보 list (점수 2+) 도 log 출력
      logger.warn({ aptName, lawdCd, stripped, topCandidates: topCandidates.slice(0, 5) },
        'KAPT-LOOKUP: SigunguAptList3 매칭 실패 — 후보 없음');
    }
    return best;
  } catch (e) {
    logger.warn({ err: e.message, lawdCd, aptName }, 'KAPT-LOOKUP: SigunguAptList3 fallback 실패');
    return null;
  }
}

/**
 * 단지 facility 해결 — { aptName, sigungu, umdNm, aptSeq?, lawdCd? } 로 호출
 *
 * fallback chain (Sprint N + T):
 *   1) apt_master 매칭 (정확 → 부분 → 토큰)
 *   2) KAPT SigunguAptList3 runtime lookup (lawdCd 필요)         ← Sprint N (진짜 fix) + Sprint T (LCS insertion 매칭)
 *   3) null
 *
 *   NOTE: Sprint M 의 aptSeq fallback 은 Sprint V (2026-05-13) 에서 제거됨.
 *   MOLIT aptSeq (예: 11710-8865) 가 KAPT kaptCode (예: A10025850) 와 형식 다름 — 늘 실패 → 무효.
 *   Sprint O 의 tryEndpoint all-null 검출이 빈 응답 차단해서 회귀 위험은 0 이었지만,
 *   불필요한 KAPT API 호출 소비 + 코드 noise 제거.
 *
 *   호환성: 함수 signature 의 aptSeq param 은 유지 (frontend / search.js 호출자 호환).
 *   파라미터 받지만 무시됨.
 *
 * @returns {{ kaptCode, official, raw }|null}
 */
async function resolveFacility({ aptName, sigungu, umdNm, aptSeq /* deprecated, ignored */, lawdCd }) {
  if (!aptName) return null;
  const memKey = `facility:${aptName}|${sigungu||''}|${umdNm||''}|${aptSeq||''}|${lawdCd||''}`;
  const mem = cache.get(memKey);
  if (mem !== undefined) return mem;

  // IDENTITY-GATE-2026-08-10 (Sprint KKKKKKK): 실거래가 말해주는 단지 신원(지번·건축년도)을 먼저 확보해
  //   이름 매칭의 근거로 쓰고 결과를 교차검증한다. 호출처(search/report/analysis) 수정 없이 전 경로 방어.
  const identity = await molitIdentity(aptName, sigungu, umdNm);

  let m = await findMaster(aptName, sigungu, umdNm, identity);

  // KAPT-LOOKUP-2026-05-12 (Sprint N): master 매칭 실패 시 KAPT SigunguAptList3 runtime lookup.
  //   apt_master sync 아직 누락된 단지도 즉시 catch + 자동 upsert.
  if (!m?.kapt_code && lawdCd) {
    const lookup = await _lookupKaptByName(lawdCd, aptName, sigungu, umdNm);
    if (lookup?.kaptCode) {
      m = { kapt_code: lookup.kaptCode, apt_name: lookup.kaptName };
      // 자동 apt_master upsert (다음 호출부터 fast path)
      const a = admin();
      if (a) {
        a.from('apt_master').upsert({
          kapt_code: lookup.kaptCode,
          apt_name: lookup.kaptName,
          lawd_cd: lawdCd,
          sigungu: sigungu || null,
          umd_nm: umdNm || (lookup.as3 || null),
          source: 'kapt-lookup-runtime',
        }, { onConflict: 'kapt_code', ignoreDuplicates: true }).then(() => {}, () => {});
      }
    }
  }

  if (m?.kapt_code) {
    // IDENTITY-GATE 2단 방어: KAPT-LOOKUP fallback 은 이름만 보고 매칭하므로(SigunguAptList3 응답에
    //   지번·준공일 없음) findMaster 의 검증을 우회한다. 실제 KAPT 값을 손에 쥔 이 시점에 한 번 더 본다.
    const gate = (raw, where) => {
      const v = verifyCandidate(raw?.kaptUsedate, raw?.kaptAddr, identity, 'weak');
      if (!v.ok) {
        logger.warn({ aptName, sigungu, umdNm, kaptCode: m.kapt_code, master: m.apt_name, where, reason: v.reason },
          'KAPT 매칭 거부 (IDENTITY-GATE 2단)');
      }
      return v.ok;
    };

    // 캐시 신선도 (FACILITY-BACKFILL-2026-06-18: _empty sentinel 은 캐시로 안 봄 → 온디맨드 재시도 허용)
    if (m.facility && m.facility_fetched_at && !m.facility._empty) {
      const ageDays = (Date.now() - new Date(m.facility_fetched_at).getTime()) / (1000*60*60*24);
      if (ageDays < CACHE_TTL_DAYS) {
        if (!gate(m.facility, 'cached')) { cache.set(memKey, null, 300); return null; }
        // DTL-INFO-2026-05-13 (Sprint X): 캐시된 BasisInfo 와 함께 detail 도 병렬 fetch.
        // PERF-DTL-SKIP-2026-07-15 (Sprint LLLLL): 저장 facility 에 _dtl 이 이미 병합돼 있으면(백필·이전 조회)
        //   KAPT detail 재조회 생략 — recommend 경로(propertyService 의 stored._dtl 체크)와 대칭.
        //   report 후보 최대 20개 기준 콜드 KAPT 콜 최대 20개 절감. _dtl 없을 때만 기존대로 라이브 조회.
        const detail = m.facility._dtl || await getAptDtlInfo(m.kapt_code).catch(() => null);
        const out = { kaptCode: m.kapt_code, official: m.apt_name, raw: m.facility, detail };
        cache.set(memKey, out, 3600);
        return out;
      }
    }

    // API 호출 + DB 갱신 (fire-and-forget UPSERT)
    // Sprint X: BasisInfo + Detail 을 병렬로 fetch (KAPT API 단일 호출 비용 비슷)
    const [raw, detail] = await Promise.all([
      fetchFromApi(m.kapt_code),
      getAptDtlInfo(m.kapt_code).catch(() => null),
    ]);
    if (raw) {
      const a = admin();
      if (a) {
        // FACILITY-DTL-STORE-2026-06-18: DTL(주차/CCTV/승강기)을 facility._dtl 로 함께 저장.
        //   기존엔 raw(BasisInfo)만 저장 → 주차가 DB에 안 남아 단지 비교(세대당주차)에 못 썼음.
        const facilityToStore = detail ? { ...raw, _dtl: detail } : raw;
        a.from('apt_master').update({
          facility: facilityToStore,
          facility_fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('kapt_code', m.kapt_code).then(() => {}, () => {});
      }
    }

    // 저장(upsert)은 kapt_code 기준이라 그대로 둔다 — 잘못된 건 데이터가 아니라 이 단지와의 연결이다.
    // 다른 단지가 같은 kapt_code 를 정당하게 쓸 수 있으므로 반환만 차단한다.
    const out = (raw && gate(raw, 'api')) ? { kaptCode: m.kapt_code, official: m.apt_name, raw, detail } : null;
    cache.set(memKey, out, out ? 3600 : 300);
    return out;
  }

  // Sprint V (2026-05-13): aptSeq fallback 제거됨. MOLIT aptSeq != KAPT kaptCode 형식 — 늘 빈 응답.
  // Sprint U (Supabase MCP 직접 backfill) + Sprint N (runtime KAPT-LOOKUP) + Sprint T (LCS 매칭) 으로
  // 송파구/양천구 327 단지 + 다른 KAPT 매칭 가능 단지 모두 정상 해결됨.
  // 본 path 까지 도달 = 진짜 KAPT 미등록 단지 (대부분 청년주택/임대 등) → null 반환 + 짧은 cache.

  cache.set(memKey, null, 300);
  return null;
}

/**
 * FACILITY-BACKFILL-2026-06-18 (운영자 "단지 비교 토대 = facility+주차 전수 적재"):
 *   kaptCode 직접 백필 — BasisInfo + DTL(주차) 받아 apt_master.facility 에 AWAIT 저장(병합).
 *   이름매칭 불필요(kaptCode 보유). 실패(KAPT 미등록/빈응답)는 {_empty:true} sentinel 로 표시 →
 *   backfill 후보(facility IS NULL)에서 제외돼 매 run 무한 재시도 방지(geocode 교훈). 온디맨드 열람은 재시도됨.
 * @returns {{ ok, kaptCode, hasParking, reason? }}
 */
async function backfillFacilityByKaptCode(kaptCode) {
  if (!kaptCode) return { ok: false, reason: 'no-kaptCode' };
  const a = admin();
  if (!a) return { ok: false, reason: 'no-admin' };
  const [raw, detail] = await Promise.all([
    fetchFromApi(kaptCode),
    getAptDtlInfo(kaptCode).catch(() => null),
  ]);
  if (!raw) {
    // 실패 sentinel — facility 가 NULL 이 아니게 만들어 backfill 후보에서 빠지게(무한재시도 차단).
    await a.from('apt_master').update({
      facility: { _empty: true },
      facility_fetched_at: new Date().toISOString(),
    }).eq('kapt_code', kaptCode).then(() => {}, () => {});
    return { ok: false, reason: 'no-basisinfo', kaptCode };
  }
  const facilityToStore = detail ? { ...raw, _dtl: detail } : raw;
  const { error } = await a.from('apt_master').update({
    facility: facilityToStore,
    facility_fetched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('kapt_code', kaptCode);
  return {
    ok: !error,
    kaptCode,
    hasParking: !!(detail && (detail.kaptdPcnt || detail.kaptdPcntu)),
    error: error?.message,
  };
}

/**
 * REC-PERF-2026-07-10 (Sprint FFFF): kapt_code 배치로 apt_master.facility 일괄 조회.
 *   recommend enrichment 가 15단지×(BasisInfo+DtlInfo)=30 KAPT 콜을 콜드마다 반복(인메모리 30일 캐시는
 *   인스턴스 재시작에 소실). facility 컬럼은 backfill cron 이 동일 raw(+_dtl)를 이미 저장 —
 *   실측 10,638/10,638 보유(유효 99.7%, _empty 29). 1쿼리로 대체, miss 만 KAPT API 폴백.
 * @returns {Promise<Map<string, object>>} kapt_code → facility raw(+_dtl). _empty/null 은 제외(폴백 유도).
 */
async function getFacilitiesByKaptCodes(kaptCodes) {
  const a = admin();
  if (!a || !Array.isArray(kaptCodes) || !kaptCodes.length) return new Map();
  try {
    const { data, error } = await a
      .from('apt_master')
      .select('kapt_code, facility')
      .in('kapt_code', kaptCodes);
    if (error) throw error;
    const m = new Map();
    for (const r of (data || [])) {
      if (r.facility && !r.facility._empty) m.set(r.kapt_code, r.facility);
    }
    return m;
  } catch (e) {
    logger.warn({ err: e.message, n: kaptCodes.length }, 'facility 배치 조회 실패 — KAPT API 폴백');
    return new Map();
  }
}

module.exports = {
  resolveFacility, backfillFacilityByKaptCode, getFacilitiesByKaptCodes,
  // IDENTITY-GATE 검증용 (테스트에서 직접 호출)
  findMaster, molitIdentity, verifyCandidate, jibunFromKaptAddr, bonbun,
};
