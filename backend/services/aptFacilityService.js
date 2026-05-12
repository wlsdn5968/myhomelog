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

/**
 * 단지 facility 해결 — { aptName, sigungu, umdNm, aptSeq? } 로 호출
 *
 * APTSEQ-FALLBACK-2026-05-12 (Sprint M — 운영자 발견 + Chrome MCP audit 으로 [VERIFIED]):
 *   apt_master 에 헬리오시티/리센츠/파크리오/한신잠실코아/서강예가 등 핵심 단지 누락 (송파구 1500+ 중 일부).
 *   findMaster 가 정확/부분/토큰 매칭 모두 실패 → facility null → 단지정보 탭 빈 메시지.
 *   해결: MOLIT 실거래의 apt_seq 가 KAPT kaptCode 와 동일 (data.go.kr 표준). aptSeq fallback 로 KAPT 직접 호출.
 *
 * @returns {{ kaptCode, official, raw }|null}
 */
async function resolveFacility({ aptName, sigungu, umdNm, aptSeq }) {
  if (!aptName) return null;
  const memKey = `facility:${aptName}|${sigungu||''}|${umdNm||''}|${aptSeq||''}`;
  const mem = cache.get(memKey);
  if (mem !== undefined) return mem;

  const m = await findMaster(aptName, sigungu, umdNm);
  if (m?.kapt_code) {
    // 캐시 신선도
    if (m.facility && m.facility_fetched_at) {
      const ageDays = (Date.now() - new Date(m.facility_fetched_at).getTime()) / (1000*60*60*24);
      if (ageDays < CACHE_TTL_DAYS) {
        const out = { kaptCode: m.kapt_code, official: m.apt_name, raw: m.facility };
        cache.set(memKey, out, 3600);
        return out;
      }
    }

    // API 호출 + DB 갱신 (fire-and-forget UPSERT)
    const raw = await fetchFromApi(m.kapt_code);
    if (raw) {
      const a = admin();
      if (a) {
        a.from('apt_master').update({
          facility: raw,
          facility_fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('kapt_code', m.kapt_code).then(() => {}, () => {});
      }
    }

    const out = raw ? { kaptCode: m.kapt_code, official: m.apt_name, raw } : null;
    cache.set(memKey, out, out ? 3600 : 300);
    return out;
  }

  // APTSEQ-FALLBACK-2026-05-12: apt_master 매칭 실패 → MOLIT aptSeq 로 KAPT 직접 호출.
  //   apt_master 동기화 누락 단지 (예: 헬리오시티, 리센츠, 파크리오) 도 facility 보장.
  //   aptSeq 가 KAPT kaptCode 와 동일 (data.go.kr V4 API 표준).
  if (aptSeq && String(aptSeq).trim()) {
    const code = String(aptSeq).trim();
    const raw = await fetchFromApi(code);
    if (raw) {
      logger.info({ aptName, sigungu, umdNm, aptSeq: code },
        'APTSEQ-FALLBACK: apt_master 미매칭 → MOLIT aptSeq 로 KAPT facility 직접 호출 성공');
      const out = { kaptCode: code, official: aptName, raw };
      cache.set(memKey, out, 3600);
      return out;
    }
  }

  cache.set(memKey, null, 300);
  return null;
}

module.exports = { resolveFacility };
