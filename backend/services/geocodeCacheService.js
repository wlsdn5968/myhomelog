/**
 * 단지 좌표 해결 서비스 — 2단계 캐시 + Kakao 폴백
 *
 * 설계 원칙:
 *   1) DB 캐시(apt_geocache) 우선 조회 — serverless 재시작에도 유지
 *   2) DB miss → Kakao 지오코딩 → 성공 시 UPSERT
 *   3) 완전 실패 시 null — 프론트는 null 이면 마커를 그리지 않음
 *
 * 왜 기존 batchGeocode(/api/geocode/batch) 대신 이 서비스를 만드는가:
 *   - in-process cache 만 사용 → serverless 함수 간 공유 불가
 *   - propertyService 가 응답 확정 전에 좌표까지 내려주기 위해 동기적 해결 필요
 *   - 추천 결과에 좌표 포함 → 프론트 getLat/getLng 의 랜덤 jitter 제거 가능 (Bug #2 근본 해결)
 *
 * Key 정책:
 *   - kaptCode 가 있으면 `kapt:${kaptCode}` — 안정적, 동일 단지 중복 저장 X
 *   - 없으면 `name:${normName}|${sigungu}|${umdNm}` — 같은 이름 단지가 여러 구에 있어도 구분
 *     (예: "래미안" 이 수십 개 구에 산재)
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');
const { normalizeAptName } = require('../utils/aptName');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (DB_ENABLED 게이트 의미 유지)
const { getSupabaseAdmin, hasAdminEnv } = require('../db/client');

const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;

const DB_ENABLED = hasAdminEnv();
const KAKAO_ENABLED = !!KAKAO_KEY && KAKAO_KEY !== 'your_kakao_rest_key';

const KAKAO_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const KAKAO_ADDRESS = 'https://dapi.kakao.com/v2/local/search/address.json';

// CROSS-CITY-FIX-2026-06-03 (운영자 발견 "좌표와 실제 매물 불일치 검증"):
//   중복 시군구명 — 여러 도시에 같은 이름 자치구가 존재(molit COUNT(DISTINCT lawd_cd)>=2 로 검증).
//   예: "서구"=부산/대구/인천/광주/대전, "중구"=서울/부산/대구/인천/대전/울산.
//   이들은 sigungu 이름만으론 도시 식별 불가 → 지오코딩 시 umd(법정동) 하드 검증 필수.
const AMBIGUOUS_SGG = new Set(['강서구', '남구', '동구', '북구', '서구', '중구']);

// Sprint LL #2/#3 + CANON-COORD-FIX-2026-06-03: 非아파트/하위시설(충전소/주차장/정류장/정문/
//   관리사무소/놀이터 등) 좌표 환각 차단 패턴. "상가"는 주상복합 명칭 충돌로 제외(소프트 강등만).
// GEO-VALIDATE-SSOT-2026-08-09 (Sprint GGGGGGG): routes/geocode.js 가 동일 검증을 복붙했다가
//   ca9fcf7(Sprint LL) 1회 동기화 후 방치돼 드리프트(충전소·중개사 등 미차단)된 실이력 —
//   상수를 모듈 레벨로 승격·export 해 두 경로가 같은 패턴을 쓰게 한다. 갱신은 여기 한 곳만.
// NONRES-GERONTO-2026-08-17 (Sprint MMMMMMM, 서울 전수조사 4회차): '경로당·노인정·교차로' 추가.
//   [규모] apt_geocache.place_name 전국 실측 — 경로당/노인정 **298건**(비단지 place 최대 단일 항목),
//     교차로 9건. 라이브 지오코딩에서 '은마' → "은마아파트입구교차로"(본체와 약 200m 차)가 나왔다.
//   [오탐 위험 0 — 실측] 이 세 단어가 든 단지명은 apt_master **0건**, molit_transactions **0건**.
//     즉 진짜 단지를 잘못 걸러낼 여지가 없다(과거 '상가'를 소프트 강등으로만 둔 것과는 상황이 다르다).
//   ※ '플라자'는 넣지 않았다 — 주상복합 명칭에 실제로 쓰여 오탐 위험이 있다('반포자이플라자'는
//     아래 sanggaPenalty 로도 안 걸리는 잔여 케이스로 남는다. 근거 없이 넓히지 않는다.)
const NON_APT_PATTERNS = /빌라|사우나|어린이집|유치원|학원|마트|편의점|식당|카페|커피|사옥|호텔|모텔|병원|약국|의원|학교|교회|성당|사찰|공원|체육관|주유소|미용실|세탁소|꽃집|충전소|주차장|정류장|정문|후문|관리사무소|경비실|놀이터|경로당|노인정|교차로|공인중개사|중개사|부동산|사무소|은행|노래방/;
const NON_APT_CATEGORY = /빌라|사우나|어린이집|유치원|학원|마트|편의점|음식점|카페|커피|호텔|모텔|병원|약국|학교|종교|공원|체육|주유소|미용|세탁|꽃집|충전|주차|정류|중개|부동산|은행/;

function dbClient() {
  if (!DB_ENABLED) return null;
  return getSupabaseAdmin();
}

function normalizeName(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** 단지 식별자 → 캐시 키 */
function buildKey({ kaptCode, aptName, sigungu, umdNm }) {
  if (kaptCode) return `kapt:${kaptCode}`;
  return `name:${normalizeName(aptName)}|${(sigungu || '').trim()}|${(umdNm || '').trim()}`;
}

/** DB 캐시 조회 — 2차 캐시(프로세스 메모리) 활용으로 같은 요청 내 중복 쿼리 방지 */
async function getFromDb(key) {
  const mem = cache.get(`geo-db:${key}`);
  if (mem !== undefined) return mem;

  const admin = dbClient();
  if (!admin) return null;
  try {
    const { data } = await admin
      .from('apt_geocache')
      .select('lat,lng,address,place_name')
      .eq('apt_key', key)
      .maybeSingle();
    // COORD-GUARD-2026-07-25 (Sprint NNNNNN): 저장된 좌표가 한국 범위 밖이면 "캐시 없음"으로 취급.
    //   현재 DB CHECK(lat 33~39·lng 124~132)가 범위를 강제하므로 실질 no-op 이지만, 과거 데이터·
    //   제약 변경·수동 INSERT 등으로 이상 좌표가 들어와도 지도에 찍히지 않게 하는 방어(비용 0).
    const out = (data && isValidKoreaCoord(Number(data.lat), Number(data.lng))) ? {
      lat: Number(data.lat),
      lng: Number(data.lng),
      address: data.address,
      placeName: data.place_name,
    } : null;
    // 양성 결과 1h / 음성 결과 5분 (DB 에 없으면 Kakao 호출 재시도 창)
    cache.set(`geo-db:${key}`, out, out ? 3600 : 300);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'apt_geocache DB 조회 실패');
    return null;
  }
}

// P1 (2026-04-25 감사 13): Kakao 일일 호출 모니터링
//   - 무료 한도: 100,000건/일 (앱당). 초과 시 다음 날까지 좌표 마커 미표시 → "지도 안 떠요" 이탈.
//   - 600K 도달 시 (실제론 60K) Sentry alert + audit_log 기록.
//   - 카운터는 in-process — serverless instance 별로 분산되지만 단일 인스턴스 폭주 감지엔 충분.
const KAKAO_DAILY_THRESHOLD = 60000; // 60K 도달 시 경고 (안전 마진 40%)
let _kakaoCallCount = 0;
let _kakaoCountResetAt = new Date().setHours(24, 0, 0, 0); // 자정 reset
let _kakaoAlertSent = false;
function _trackKakaoCall() {
  const now = Date.now();
  if (now >= _kakaoCountResetAt) {
    _kakaoCallCount = 0;
    _kakaoAlertSent = false;
    _kakaoCountResetAt = new Date(now).setHours(24, 0, 0, 0);
  }
  _kakaoCallCount += 1;
  if (!_kakaoAlertSent && _kakaoCallCount >= KAKAO_DAILY_THRESHOLD) {
    _kakaoAlertSent = true;
    logger.error({
      source: 'kakao-quota-warning',
      callsToday: _kakaoCallCount,
      threshold: KAKAO_DAILY_THRESHOLD,
      resetAt: new Date(_kakaoCountResetAt).toISOString(),
    }, '⚠ Kakao API 일일 호출 60K 도달 — 100K 무료 한도 임박');
  }
}
// KAKAO-DIAG-2026-07-10 (Sprint CCCC): backfill 600/600 "조용한 실패" 원격 진단 —
//   kakaoGeocode 개별 실패가 debug 레벨이라 prod 로그에 안 남아 원인(429 rate-limit vs 200 무매칭) 구분 불가.
//   에러코드·무매칭·성공 분포를 in-process 집계해 getKakaoUsageStats 로 노출(backfill run 응답에 포함).
let _kakaoOkCount = 0;
let _kakaoNoMatchCount = 0;
const _kakaoErrStats = {};
let _kakaoLastErr = null;
function _trackKakaoResult(kind, detail) {
  if (kind === 'ok') _kakaoOkCount += 1;
  else if (kind === 'nomatch') _kakaoNoMatchCount += 1;
  else { _kakaoErrStats[kind] = (_kakaoErrStats[kind] || 0) + 1; _kakaoLastErr = detail || kind; }
}
function getKakaoUsageStats() {
  return {
    callsToday: _kakaoCallCount, threshold: KAKAO_DAILY_THRESHOLD, resetAt: new Date(_kakaoCountResetAt).toISOString(),
    ok: _kakaoOkCount, noMatch: _kakaoNoMatchCount, errors: _kakaoErrStats, lastErr: _kakaoLastErr,
  };
}

/** 주소 전용 지오코딩 — ADDR-VERIFY-2026-07-17 (Sprint ZZZZZ): 이름 키워드 검색과 달리 모호성이 없어
 *  좌표 검증·교정의 진실 소스로 사용(KAPT 공식 주소 / MOLIT 신고 지번). 실패 시 null(호출측 skip). */
async function kakaoAddressGeocode(address) {
  if (!KAKAO_ENABLED) return null;
  const addr = String(address || '').trim();
  if (addr.length < 5) return null;
  try {
    _trackKakaoCall();
    const r = await axios.get(KAKAO_ADDRESS, {
      headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
      params: { query: addr, size: 1 }, timeout: 5000,
    });
    const d = (r.data?.documents || [])[0];
    if (!d) { _trackKakaoResult('nomatch'); return null; }
    const lat = parseFloat(d.y), lng = parseFloat(d.x);
    if (!isValidKoreaCoord(lat, lng)) return null;
    _trackKakaoResult('ok');
    return { lat, lng, address: d.address_name || addr };
  } catch (e) {
    const code = e.response?.status ? `http_${e.response.status}` : (e.code || 'err');
    _trackKakaoResult(code, `${code} addr: ${String(e.message).slice(0, 100)}`);
    return null;
  }
}

/** Kakao 다중 쿼리 폴백 — 가장 정확한 매칭을 위해 여러 형태로 시도
 *  GEO-FAIL-SENTINEL-2026-07-22: 선택 인자 _diag({}) 전달 시 실패 사유를 _diag.outcome 에 기록 —
 *  'ok' | 'nomatch'(정상 응답이나 매칭 없음/검증 탈락 — 재시도 무의미) | 'error'(HTTP 오류 포함 — 일시적일 수 있음).
 *  백필이 'nomatch' 만 sentinel 기록하기 위한 구분. 기존 호출처(인자 1개)는 무영향. */
async function kakaoGeocode({ aptName, sigungu, umdNm, address }, _diag) {
  if (!KAKAO_ENABLED) { if (_diag) _diag.outcome = 'error'; return null; }
  const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
  // NAMEFIX-2026-05-11: query 시점에 `(고층)/(중층)/(저층)` suffix 제거 — Kakao 검색 매칭률 ↑.
  //   raw apt_name 은 caller (propertyService 등) 가 그대로 전달 → buildKey 의 DB cache 키는 raw 유지.
  const name = normalizeAptName(aptName);
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  const addr = String(address || '').trim();

  // JIBUN-FIRST-2026-08-10 (Sprint KKKKKKK-6): **주소를 맨 앞으로**.
  //   기존 순서(이름 검색 3회 → 주소)는 이름이 그럴듯하게 맞는 **다른 단지**를 먼저 채택해버렸다.
  //   실사고: '신동아아파트3'(방학동 530) → "신동아1단지아파트 3동"(272) 로 잡혀 마커가 남의 단지 안에.
  //   주소(지번)는 모호성이 0이므로 있으면 항상 먼저 쓴다. 이름 검색은 주소가 없거나 실패할 때의 폴백.
  const tries = [
    addr ? { url: KAKAO_ADDRESS, q: addr } : null,
    { url: KAKAO_KEYWORD, q: `${sgg} ${umd} ${name}`.trim() },
    { url: KAKAO_KEYWORD, q: `${sgg} ${name}`.trim() },
    { url: KAKAO_KEYWORD, q: name },
  ].filter(t => t && t.q && t.q.length > 1);

  for (const t of tries) {
    try {
      _trackKakaoCall();
      const r = await axios.get(t.url, {
        headers, params: { query: t.q, size: 5 }, timeout: 5000,  // size 1 → 5 (정확 매칭 후보 보강)
      });
      const docs = r.data?.documents || [];
      if (!docs.length) continue;

      // STAB-AUDIT-2026-05-06 (운영자 발견): 동명이지 단지 환각 차단.
      //   "대우" 검색 시 Kakao 첫 결과가 "구로구 고척동 대우" (요청 sigungu="성동구") → 잘못된 좌표.
      //   변경: 결과 후보 중 sigungu 일치 row 만 수락. 일치 없으면 다음 query 후보로.
      //   sgg 미지정 (검색 fallback `${name}` only) 인 경우는 검증 X — 좌표 정확성 보장 X.
      // Sprint LL (2026-05-16, 운영자 발견 "좌표·주소 불일치 많음"):
      //   ↳ Audit: 7195 rows 중 199건 의심 (73 non-apt place_name + 110 umdNm 불일치 + 16 sigungu 불일치)
      //   #1 umdNm 검증 추가 — sgg 같지만 다른 동 응답 차단 (예: 모아1 중흥동 요청 → 두암동 응답)
      //   #2 place_name 카테고리 필터 — 어린이집/사우나/학원/마트/오피스텔 등 非아파트 결과 차단
      //   #3 category_name 도 검증 — "주거시설>아파트" 만 우선 (Kakao 의 카테고리 분류)
      let chosen = null;
      let bestScore = -1;
      for (const d of docs) {
        const lat = parseFloat(d.y);
        const lng = parseFloat(d.x);
        if (!isValidKoreaCoord(lat, lng)) continue;
        const addrText = d.address_name || d.address?.address_name || '';
        const placeName = d.place_name || '';
        const categoryName = d.category_name || '';
        // sgg 명시 시 address 가 sgg 포함하는지 검증 (환각 차단)
        // SIGUNGU-SPACE-FIX-2026-06-14 (실측 확정): molit 은 "안양시동안구"(붙임)·Kakao 는 "안양시 동안구"(띄어쓰기) →
        //   includes 가 경기 모든 시+구(안양/수원/성남/고양/용인/안산..) 단지를 전량 reject → 좌표 갭 4,987 핵심.
        //   공백 제거 후 비교로 흡수. (단일어 sgg "송파구" 는 무영향, 타지역 오매칭은 공백만 제거라 영향 없음.)
        if (sgg && !addrText.replace(/\s+/g, '').includes(sgg.replace(/\s+/g, ''))) continue;
        // CROSS-CITY-FIX-2026-06-03: 중복 시군구명(강서구/남구/동구/북구/서구/중구)은 구명만으론 도시 식별 불가.
        //   umd(법정동)를 하드 필터로 요구 → 타도시 동명 구 오매칭 차단.
        //   실측 4건: 동진3 인천 서구 석남동→대구 서구 좌표 / 교동 울산 중구→대구 중구 / 해원맨션 울산 남구→포항 / 대림e편한세상 부산 서구→서울권.
        //   비중복 구(강남구·노원구 등)는 무영향(회귀 0). molit umd=법정동 ↔ Kakao 지번 address_name=법정동 기준이라 정상 단지는 매칭됨.
        if (sgg && umd && AMBIGUOUS_SGG.has(sgg) && !addrText.replace(/\s+/g, '').includes(umd.replace(/\s+/g, ''))) continue;
        // Sprint LL #2/#3: 非아파트 place_name 또는 category 면 score 페널티 (다른 후보 우선)
        const isNonApt = (placeName && NON_APT_PATTERNS.test(placeName))
                      || (categoryName && NON_APT_CATEGORY.test(categoryName));
        // Sprint LL #1: umdNm 일치 score (SIGUNGU-SPACE-FIX-2026-06-14: 공백 무시 비교)
        const umdMatch = umd && addrText.replace(/\s+/g, '').includes(umd.replace(/\s+/g, '')) ? 2 : 0;
        // 카테고리 "아파트" 일치 score
        const aptCategory = categoryName.includes('아파트') ? 2 : 0;
        // 페널티
        const nonAptPenalty = isNonApt ? -5 : 0;
        // SANGGA-SOFT-2026-07-17 (Sprint YYYYY): '상가' place 는 차단(-5) 대신 소프트 강등(-1) —
        //   아파트 본체 후보가 있으면 항상 그쪽이 이기고, 상가 후보뿐이면 여전히 채택(주상복합 명칭
        //   충돌 우려로 하드 차단하지 않던 기존 의도 유지). 기존 1,091건 잔존의 신규 유입 축소.
        const sanggaPenalty = (!isNonApt && /상가/.test(placeName)) ? -1 : 0;
        const score = umdMatch + aptCategory + nonAptPenalty + sanggaPenalty;
        if (score > bestScore) {
          bestScore = score;
          chosen = { d, lat, lng, addrText, placeName, score };
        }
      }
      // Sprint LL: bestScore 가 0 미만이면 차단 — 매칭 신뢰도 부족 (非아파트 카테고리 등)
      //   - 정상 아파트 매칭: aptCategory(2~3) + umdMatch(0~2) = 2~5
      //   - 잘못된 매칭: nonAptPenalty(-5) + umdMatch(0~2) = -5 ~ -3
      if (!chosen || chosen.score < 0) continue;

      _trackKakaoResult('ok');
      if (_diag) _diag.outcome = 'ok';
      return {
        lat: chosen.lat, lng: chosen.lng,
        address: chosen.addrText || addr,
        placeName: chosen.d.place_name || name,
      };
    } catch (e) {
      // 일시 실패 — 다음 후보로 계속 진행 (KAKAO-DIAG: 상태코드별 집계, prod 로그 스팸 없이 관측)
      const code = e.response?.status ? `http_${e.response.status}` : (e.code || 'err');
      if (_diag) _diag.hadError = true; // GEO-FAIL-SENTINEL: HTTP 오류는 'nomatch' 로 오인 금지
      _trackKakaoResult(code, `${code} ${t.q}: ${String(e.response?.data?.message || e.message).slice(0, 120)}`);
      logger.debug({ src: 'kakao', q: t.q, err: e.message }, 'Kakao geocode 개별 실패');
    }
  }
  _trackKakaoResult('nomatch');
  if (_diag) _diag.outcome = _diag.hadError ? 'error' : 'nomatch';
  return null;
}

/** GEO-KEY-MERGE-2026-07-14 (Sprint IIIII-2): 키 네임스페이스 2종(kapt:/name:) 공존으로 같은 단지가
 *  다른 키로 이미 지오코딩된 경우(실측 137그룹·잉여 142행) — (apt_name, sigungu, umd_nm) 정확 일치
 *  2차 조회로 기존 좌표 재사용. Kakao 재호출·이중 등록을 원천 차단(uq_apt_geocache_name_combo 와 정합). */
async function getFromDbByNameCombo({ aptName, sigungu, umdNm }) {
  const admin = dbClient();
  if (!admin || !aptName) return null;
  try {
    let q = admin.from('apt_geocache').select('lat,lng,address,place_name').eq('apt_name', aptName);
    q = sigungu ? q.eq('sigungu', sigungu) : q.is('sigungu', null);
    q = umdNm ? q.eq('umd_nm', umdNm) : q.is('umd_nm', null);
    const { data } = await q.limit(1).maybeSingle();
    if (!data || !isValidKoreaCoord(Number(data.lat), Number(data.lng))) return null;
    return { lat: Number(data.lat), lng: Number(data.lng), address: data.address, placeName: data.place_name };
  } catch (_) { return null; }
}

/** DB UPSERT — 쓰기 실패해도 좌표는 반환 (UX 우선) */
async function saveToDb(key, entry) {
  const admin = dbClient();
  if (!admin) return;
  try {
    await admin.from('apt_geocache').upsert({
      apt_key: key,
      apt_name: entry.aptName,
      sigungu: entry.sigungu || null,
      umd_nm: entry.umdNm || null,
      address: entry.address || null,
      place_name: entry.placeName || null,
      lat: entry.lat,
      lng: entry.lng,
      // ADDR-FALLBACK-2026-08-09 (Sprint CCCCCCC): 지번 주소 폴백 저장분은 'kakao-addr' 로 구분 —
      //   사후 품질 분석(이름 매칭 vs 주소 매칭)을 위해. 기존 호출처는 source 미지정 → 'kakao' 불변.
      source: entry.source || 'kakao',
    }, { onConflict: 'apt_key' });
    cache.set(`geo-db:${key}`, { lat: entry.lat, lng: entry.lng, address: entry.address, placeName: entry.placeName }, 3600);
  } catch (e) {
    logger.warn({ err: e.message, key }, 'apt_geocache UPSERT 실패 (무시)');
  }
}

/** GEO-FAIL-SENTINEL-2026-07-25 (Sprint NNNNNN, MMMMMM-3 결함 교체):
 *  Kakao "무매칭 확정"(nomatch) 단지를 **Redis 키**로 기록 → 백필 후보에서 TTL 기간 제외.
 *
 *  [MMMMMM-3(07-22) 실패 원인 — 실측 확정] 당시 (0,0)+source='kakao-fail' 행으로 기록하려 했으나
 *    apt_geocache 에 CHECK 제약(lat 33~39 / lng 124~132)이 있어 INSERT 가 100% 거부됨(무동작 no-op).
 *    NOT NULL 만 확인하고 CHECK 를 확인하지 않은 설계 오류. admin 트리거 실측: sentinelMarked=0.
 *  [교체 설계] apt_geocache 는 "좌표 저장소"라는 스키마 의도(CHECK 가 그 의도를 강제)를 존중하고,
 *    실패 이력은 Redis(이미 rate-limit 에서 사용 중)에 둔다. **DB 스키마·행 변경 0.**
 *  [안전] Redis 미설정이면 항상 false → 기존 동작(매일 재시도)으로 자연 폴백.
 *    TTL 30일이라 매칭 로직이 개선되면 자동 재시도. 즉시 리셋은 Redis 키 삭제(geofail:*).
 *  [호출] 백필 잡의 nomatch 확정 항목만. HTTP 오류('error')·온디맨드 실패는 기록하지 않는다. */
// ADDR-FALLBACK-2026-08-09 (Sprint CCCCCCC): prefix 세대교체 'geofail:' → 'geofail2:' —
//   기존 무매칭 확정 ~4천 건은 **이름 검색만** 실패한 것이고, 새로 추가된 지번 주소 폴백으로는
//   해석될 수 있다(실측: '황골마을주공1' 이름 무매칭 ↔ '영통동 955-1' 주소 매칭). prefix 를 바꾸면
//   구 마킹이 자연 무효화되어 전 후보가 새 로직으로 재시도되고, 구 키는 TTL 30일로 스스로 사라진다.
const GEOFAIL_PREFIX = 'geofail2:';
const GEOFAIL_TTL_SEC = 30 * 24 * 3600;

async function markGeoFail(apt) {
  if (!apt || !apt.aptName) return false;
  try {
    const { getRedis } = require('../redis');
    const redis = getRedis();
    if (!redis) return false;
    await redis.set(`${GEOFAIL_PREFIX}${buildKey(apt)}`, 1, { ex: GEOFAIL_TTL_SEC });
    return true;
  } catch (e) { logger.debug({ err: e.message }, 'geo-fail 기록 실패(무시)'); return false; }
}

/** 후보 목록에서 최근 무매칭 확정(sentinel) 단지를 제외 — 백필 sweep 전용.
 *  Redis 미설정/오류 시 원본 그대로 반환(기존 동작). mget 은 500개씩 청크. */
async function filterOutGeoFailed(items) {
  if (!Array.isArray(items) || !items.length) return { kept: items || [], skipped: 0 };
  try {
    const { getRedis } = require('../redis');
    const redis = getRedis();
    if (!redis) return { kept: items, skipped: 0 };
    const keys = items.map(i => `${GEOFAIL_PREFIX}${buildKey(i)}`);
    const flags = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const vals = await redis.mget(...chunk);
      for (const v of (Array.isArray(vals) ? vals : [])) flags.push(v);
      while (flags.length < i + chunk.length) flags.push(null); // 응답 길이 방어
    }
    const kept = items.filter((_, i) => !flags[i]);
    return { kept, skipped: items.length - kept.length };
  } catch (e) {
    logger.debug({ err: e.message }, 'geo-fail 필터 실패 — 전체 후보 진행');
    return { kept: items, skipped: 0 };
  }
}

/** molit "안양시동안구"(붙임 표기) → Kakao 주소 파서용 "안양시 동안구". 단일어 구("송파구")는 불변 */
function sggWithSpace(sgg) {
  return String(sgg || '').replace(/^(.{2,}?시)(.{2,}구)$/, '$1 $2');
}

/**
 * 실거래 신고 지번으로 만든 주소 — 이름 키워드 검색보다 정확한 지오코딩 근거.
 *
 * JIBUN-FIRST-2026-08-10 (Sprint KKKKKKK-6, 운영자 재지적 "신동아아파트3 위치가 이상한 곳"):
 *   Kakao **장소검색**은 단지명이 짧거나 이형일 때 무관한 업소·다른 단지를 1순위로 잡는다.
 *   실측: 좌표-지번 불일치 1,340건 중 39%가 2글자 단지명(세종→세종통신, 현대→현대자동차블루핸즈).
 *   더 나쁜 건 **같은 이름 계열의 다른 단지**를 잡는 경우다 —
 *   '신동아아파트3'(방학동 530) → "신동아1단지아파트 3동"(방학동 272)으로 잡혀 마커가 남의 단지 안에 찍혔다.
 *   신고 지번은 이름이 전혀 개입하지 않으므로 이 실패 모드에 면역이다.
 * @returns {Promise<string|null>} "서울 도봉구 방학동 530" 형태
 */
async function molitJibunAddress({ aptName, sigungu, umdNm }) {
  const admin = dbClient();
  if (!admin || !aptName || !sigungu || !umdNm) return null;
  try {
    const { data } = await admin.from('molit_transactions')
      .select('jibun')
      .eq('apt_name', aptName).eq('sigungu', sigungu).eq('umd_nm', umdNm)
      .not('jibun', 'is', null).neq('jibun', '')
      .order('deal_date', { ascending: false })
      .limit(40);
    if (!data || !data.length) return null;
    const freq = new Map();
    for (const r of data) {
      const j = String(r.jibun || '').trim();
      if (j) freq.set(j, (freq.get(j) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [j, n] of freq) if (n > bestN) { best = j; bestN = n; }
    return best ? `${sggWithSpace(sigungu)} ${umdNm} ${best}`.trim() : null;
  } catch (_) { return null; }
}

/**
 * 단건 단지 좌표 해결
 * @param {Object} apt - { kaptCode?, aptName, sigungu?, umdNm?, address? }
 * @returns {Promise<{lat, lng}|null>}
 */
async function resolveCoord(apt, _diag) {
  if (!apt || !apt.aptName) return null;
  const key = buildKey(apt);

  // 1) DB 캐시
  const fromDb = await getFromDb(key);
  if (fromDb) return fromDb;

  // 1.5) 다른 키 네임스페이스(kapt:/name:)로 이미 저장된 동일 단지 재사용 (Sprint IIIII-2)
  const fromCombo = await getFromDbByNameCombo(apt);
  if (fromCombo) {
    cache.set(`geo-db:${key}`, fromCombo, 3600);
    return fromCombo;
  }

  // 2) Kakao 폴백 (_diag: GEO-FAIL-SENTINEL — 백필이 무매칭/오류 구분용, 선택 인자)
  //    JIBUN-FIRST-2026-08-10: 호출처가 주소를 안 줬으면 **실거래 신고 지번으로 만들어** 넘긴다.
  //    kakaoGeocode 는 주소를 최우선으로 시도하므로, 이름 검색이 남의 단지를 잡는 사고를 원천 차단한다.
  let target = apt;
  if (!apt.address) {
    const jibunAddr = await molitJibunAddress(apt);
    if (jibunAddr) target = { ...apt, address: jibunAddr };
  }
  const fromKakao = await kakaoGeocode(target, _diag);
  if (fromKakao) {
    // FREEZE-FIX-2026-08-09 (Plan 003): fire-and-forget UPSERT 는 서버리스 동결로 유실될 수 있어
    //   (RATE-WARM-2026-08-08 실측 선례) 저장이 안 되면 같은 단지 재요청마다 Kakao 를 다시 호출한다
    //   — 응답 전에 완주(수십 ms). 실패는 기존대로 삼킨다.
    await saveToDb(key, { ...apt, ...fromKakao }).catch(() => {});
    return fromKakao;
  }

  // 3) 완전 실패 — 음성 캐시 5분 (즉시 재요청 폭주 방지)
  cache.set(`geo-db:${key}`, null, 300);
  return null;
}

/**
 * 배치 단지 좌표 해결 — DB 배치 선조회 + 잔여만 단건 경로
 * GEO-BATCH-2026-07-18 (Sprint DDDDDD): 기존엔 단지당 getFromDb .eq 단건 왕복(15개=15왕복,
 *   iad1→Supabase RTT 누적)이 coords 스테이지 지배 — .in 1왕복으로 캐시 히트를 한 번에 해소하고,
 *   진짜 miss(콤보 재사용·Kakao 폴백·upsert)만 기존 resolveCoord 경로 유지(검증·점수 로직 무변경).
 * @param {Array} apts
 * @returns {Promise<Array<{lat, lng}|null>>}
 */
async function resolveCoordBatch(apts, concurrency = 4, diags) {
  const t0 = Date.now();
  const results = new Array(apts.length).fill(null);
  const keys = apts.map(a => (a && a.aptName) ? buildKey(a) : null);
  // 1) 프로세스 메모 — 양성만 확정 (음성 null 은 기존 semantics 대로 combo/Kakao 재시도 대상)
  const missIdx = [];
  keys.forEach((k, i) => {
    if (!k) return;
    const mem = cache.get(`geo-db:${k}`);
    if (mem) results[i] = mem; else missIdx.push(i);
  });
  const memHits = apts.filter((a, i) => keys[i] && results[i]).length;
  // 2) DB 배치 조회 — 단건 .eq N왕복 → .in 1왕복
  let remain = missIdx;
  let dbMs = 0, dbHits = 0;
  const admin = dbClient();
  if (admin && missIdx.length) {
    const td = Date.now();
    try {
      const { data } = await admin
        .from('apt_geocache')
        .select('apt_key,lat,lng,address,place_name')
        .in('apt_key', [...new Set(missIdx.map(i => keys[i]))]);
      const byKey = new Map((data || []).map(r => [r.apt_key, r]));
      remain = [];
      for (const i of missIdx) {
        const r = byKey.get(keys[i]);
        if (r && isValidKoreaCoord(Number(r.lat), Number(r.lng))) {
          results[i] = { lat: Number(r.lat), lng: Number(r.lng), address: r.address, placeName: r.place_name };
          cache.set(`geo-db:${keys[i]}`, results[i], 3600);
          dbHits += 1;
        } else {
          // 음성 메모 → resolveCoord 내부 getFromDb 단건 재조회만 생략 (combo/Kakao 는 그대로 진행)
          cache.set(`geo-db:${keys[i]}`, null, 300);
          remain.push(i);
        }
      }
    } catch (e) {
      logger.warn({ err: e.message, n: missIdx.length }, 'apt_geocache 배치 조회 실패 — 단건 경로 fallback');
      remain = missIdx;
    }
    dbMs = Date.now() - td;
  }
  // 3) 잔여(진짜 miss)만 기존 단건 경로 (diags: GEO-FAIL-SENTINEL — 백필 전용 선택 인자, 인덱스 정렬)
  const tk = Date.now();
  let p = 0;
  async function worker() {
    while (p < remain.length) {
      const idx = remain[p++];
      const d = Array.isArray(diags) ? (diags[idx] = diags[idx] || {}) : undefined;
      results[idx] = await resolveCoord(apts[idx], d).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, remain.length) }, () => worker()));
  if (apts.length) {
    logger.info({
      src: 'geo-batch', n: apts.length, memHits, dbHits, tail: remain.length,
      dbMs, tailMs: Date.now() - tk, totalMs: Date.now() - t0,
    }, 'resolveCoordBatch 타이밍');
  }
  return results;
}

// buildKey·saveToDb 는 백필의 지번 주소 폴백(Sprint CCCCCCC)이 키 규약·저장 경로를 재사용하기 위해 노출.
module.exports = { resolveCoord, resolveCoordBatch, getKakaoUsageStats, kakaoGeocode, kakaoAddressGeocode, markGeoFail, filterOutGeoFailed, buildKey, saveToDb, NON_APT_PATTERNS, NON_APT_CATEGORY, AMBIGUOUS_SGG,
  // JIBUN-FIRST-2026-08-10: 백필 잡도 같은 헬퍼를 쓰도록 export(복붙 드리프트 방지)
  molitJibunAddress, sggWithSpace };
