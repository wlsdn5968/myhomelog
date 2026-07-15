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
const axios = require('axios');
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

/** LCS-MATCH-2026-05-13 (Sprint T): MOLIT 와 KAPT 정식명이 builder/지역명 insertion 으로 다른 case 매칭.
 *
 *  MOLIT raw vs KAPT 정식 예시 [VERIFIED via AptInfo MCP]:
 *    "한신잠실코아"   ↔ "한신코아"        (KAPT 송파구 A13824003) — "잠실" 중간 삽입
 *    "서강예가"       ↔ "서강쌍용예가"     (KAPT 마포구 A12119006) — "쌍용" 중간 삽입
 *
 *  기존 토큰 매칭 (3자 공통 + ratio 0.6) 으론 score=2(2자만)라 임계 미달.
 *
 *  알고리즘:
 *    1) shorter 가 longer 의 부분수열 (LCS 완전) — "한신코아" 의 모든 글자가 "한신잠실코아" 에 순서대로 존재
 *    2) shorter 가 longer 의 prefix/suffix 가 아님 (다른 단지 확장 차단)
 *         "공덕래미안" (5) ↔ "공덕래미안자이" (7) — prefix MATCH → 차단 (별개 단지)
 *    3) shorter.length >= 4, length 차이 ≤ 4 (= 짧은 insertion 만 인정)
 *
 *  false-positive 가드 verification:
 *    "공덕래미안" (5) prefix of "공덕래미안자이" (7) — startsWith MATCH → 차단 ✓
 *    "한신코아" (4) prefix of "한신잠실코아" (6)? "한신잠실코아"[:4]="한신잠실" ≠ "한신코아" ✗ → 통과 ✓
 */
function _lcsLen(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1;
      else if (dp[j - 1] > dp[j]) dp[j] = dp[j - 1];
      prev = tmp;
    }
  }
  return dp[n];
}

function _isInsertionMatch(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false; // 3자 단지명 보호
  if (longer.length - shorter.length > 4) return false; // 너무 큰 차이 (별개 단지 위험)
  if (longer.startsWith(shorter)) return false; // prefix → 확장 단지명 (예: 공덕래미안 → 공덕래미안자이)
  if (longer.endsWith(shorter)) return false;   // suffix → 같은 이유
  // 부분수열 완전 매칭 (shorter 의 모든 글자가 longer 에 순서대로)
  return _lcsLen(shorter, longer) === shorter.length;
}

/** apt_name + sigungu + umd_nm 으로 apt_master 매칭 → kapt_code */
async function findMaster(aptName, sigungu, umdNm) {
  const a = admin();
  if (!a || !aptName) return null;
  // 1) 정확 매칭
  let q = a.from('apt_master')
    .select('kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at')
    .eq('apt_name', aptName);
  if (sigungu) q = q.eq('sigungu', sigungu);
  if (umdNm) q = q.eq('umd_nm', umdNm);
  const { data } = await q.maybeSingle();
  if (data) return data;

  if (!sigungu || !umdNm) return null;

  // 2) 부분 매칭 ILIKE — molit 가 더 길 때 ('래미안엘파인아파트' 안에 master '래미안엘파인')
  //    선두/말미 키워드 추출 (괄호·아파트·숫자 제거 후)
  const stripped = String(aptName).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
  if (stripped) {
    // 양방향 시도
    const directions = [
      a.from('apt_master').select('kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at')
        .eq('sigungu', sigungu).eq('umd_nm', umdNm).ilike('apt_name', `%${stripped}%`).limit(1),
    ];
    for (const dir of directions) {
      const { data: partial } = await dir.maybeSingle();
      if (partial) return partial;
    }
  }

  // 3) 토큰 매칭 — 같은 sigungu+umd_nm 의 모든 master 가져와서 sliding 토큰 비교
  //    ("한진(609-1)" vs "돈암한신한진아파트" → 토큰 "한진" score 2 매칭) ← 너무 느슨
  //
  // RISK-6 fix (2026-05-02): score 임계 2 → 3 으로 상향
  //   사례: "휴먼빌"(평균 8.92억) 같은 단지가 master "마포한강아이파크"(평균 15.81억) 와
  //   "마포" 2글자 공통만으로 score=2 통과 → wrong match → 보고서에 잘못된 단지명·평균가 노출.
  //   3글자 이상 공통 (예: "래미안", "푸르지", "아이파") 있어야 매칭 — false-positive 차단.
  const { data: candidates } = await a.from('apt_master')
    .select('kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at')
    .eq('sigungu', sigungu).eq('umd_nm', umdNm)
    .limit(80);
  // SPACE-NORM-2026-07-15 (Sprint LLLLL): 공백만 다른 이름 매칭 — master 'e편한세상 강변' vs molit
  //   'e편한세상강변' 같은 쌍(활성 509건 실측)은 위 ILIKE 가 구조적으로 실패(molit 쪽만 공백 제거,
  //   master 원본엔 공백 잔존 — DB 재현 확인). 토큰 매칭 전에 "공백 제거 후 정확 일치"를 우선 시도.
  //   정확 일치만 허용(포함 매칭 확장 X — 오병합 방지).
  if (stripped) {
    for (const m of (candidates || [])) {
      const mStripped = String(m.apt_name).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/아파트$/, '');
      if (mStripped === stripped) return m;
    }
  }
  let best = null, bestScore = 0;
  // STAB-2 (2026-05-03 / RISK-6 fix C): score >= 3 만으로는 4글자 공통 토큰 false-positive 잔존.
  //   사례: '마포한강제이스카이' (9) ↔ master '마포한강 아이파크' (정규화 8) score=4 통과 → wrong match.
  //   해결: score / min(len) >= 0.6 비율 검증 추가. 짧은 단지명일수록 비율 자연 높아 OK.
  //   - '공덕래미안자이' (8) ↔ '공덕래미안자이아파트' (정규화 8): score=8, ratio=1.0 → 통과 ✅
  //   - '마포한강제이스카이' (9) ↔ '마포한강아이파크' (정규화 8): score=4, ratio=0.5 → 차단 ✅
  //   - '휴먼빌' (3) ↔ '망원휴먼빌아파트' (정규화 6): score=3, ratio=1.0 → 통과 ✅ (정상 매칭)
  for (const m of (candidates || [])) {
    const score = nameMatchScore(aptName, m.apt_name);
    if (score < 3) continue; // 기존 RISK-6 fix B
    const minLen = Math.min(normalizedLen(aptName), normalizedLen(m.apt_name));
    const ratio = minLen > 0 ? score / minLen : 0;
    if (ratio < 0.6) continue; // STAB-2 fix C — 비율 검증
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  // 매칭 신뢰도 낮으면 운영자 모니터링용 warn (호출량 적은 경로라 부담 낮음)
  if (best) {
    const aLen = normalizedLen(aptName);
    const bLen = normalizedLen(best.apt_name);
    const r = bestScore / Math.min(aLen, bLen);
    if (r < 0.75) {
      logger.warn({ aptName, master: best.apt_name, score: bestScore, ratio: r.toFixed(2) },
                  'KAPT 매칭 신뢰도 낮음 (RISK-6 모니터)');
    }
  }
  return best;
}

/** 한 endpoint 시도 — 성공 시 raw item, 실패 시 null + 진단 로그 */
async function tryEndpoint(url, kaptCode) {
  let r;
  try {
    r = await axios.get(url, {
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

  let m = await findMaster(aptName, sigungu, umdNm);

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
    // 캐시 신선도 (FACILITY-BACKFILL-2026-06-18: _empty sentinel 은 캐시로 안 봄 → 온디맨드 재시도 허용)
    if (m.facility && m.facility_fetched_at && !m.facility._empty) {
      const ageDays = (Date.now() - new Date(m.facility_fetched_at).getTime()) / (1000*60*60*24);
      if (ageDays < CACHE_TTL_DAYS) {
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

    const out = raw ? { kaptCode: m.kapt_code, official: m.apt_name, raw, detail } : null;
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

module.exports = { resolveFacility, backfillFacilityByKaptCode, getFacilitiesByKaptCodes };
