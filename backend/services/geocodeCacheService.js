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
const { createClient } = require('@supabase/supabase-js');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');
const { normalizeAptName } = require('../utils/aptName');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;

const DB_ENABLED = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const KAKAO_ENABLED = !!KAKAO_KEY && KAKAO_KEY !== 'your_kakao_rest_key';

const KAKAO_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const KAKAO_ADDRESS = 'https://dapi.kakao.com/v2/local/search/address.json';

// CROSS-CITY-FIX-2026-06-03 (운영자 발견 "좌표와 실제 매물 불일치 검증"):
//   중복 시군구명 — 여러 도시에 같은 이름 자치구가 존재(molit COUNT(DISTINCT lawd_cd)>=2 로 검증).
//   예: "서구"=부산/대구/인천/광주/대전, "중구"=서울/부산/대구/인천/대전/울산.
//   이들은 sigungu 이름만으론 도시 식별 불가 → 지오코딩 시 umd(법정동) 하드 검증 필수.
const AMBIGUOUS_SGG = new Set(['강서구', '남구', '동구', '북구', '서구', '중구']);

function dbClient() {
  if (!DB_ENABLED) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
    const out = data ? {
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

/** Kakao 다중 쿼리 폴백 — 가장 정확한 매칭을 위해 여러 형태로 시도 */
async function kakaoGeocode({ aptName, sigungu, umdNm, address }) {
  if (!KAKAO_ENABLED) return null;
  const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
  // NAMEFIX-2026-05-11: query 시점에 `(고층)/(중층)/(저층)` suffix 제거 — Kakao 검색 매칭률 ↑.
  //   raw apt_name 은 caller (propertyService 등) 가 그대로 전달 → buildKey 의 DB cache 키는 raw 유지.
  const name = normalizeAptName(aptName);
  const sgg = String(sigungu || '').trim();
  const umd = String(umdNm || '').trim();
  const addr = String(address || '').trim();

  // 우선순위: 구+동+단지명(가장 정확) → 구+단지명 → 단지명 → 도로명주소
  const tries = [
    { url: KAKAO_KEYWORD, q: `${sgg} ${umd} ${name}`.trim() },
    { url: KAKAO_KEYWORD, q: `${sgg} ${name}`.trim() },
    { url: KAKAO_KEYWORD, q: name },
    addr ? { url: KAKAO_ADDRESS, q: addr } : null,
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
      // CANON-COORD-FIX-2026-06-03: 하위시설(충전소/주차장/정류장/정문/관리사무소/놀이터) 추가 —
      //   단지 본체에서 오프셋된 좌표 매칭 차단(실측: 풍림아파트A→전기차충전소 158m, B→상가주차장 392m).
      //   "상가"는 주상복합 명칭과 충돌 위험으로 제외(애매), "주차장/충전소" 등 단지명에 없는 명백한 시설만 추가.
      const NON_APT_PATTERNS = /빌라|사우나|어린이집|유치원|학원|마트|편의점|식당|카페|커피|사옥|호텔|모텔|병원|약국|의원|학교|교회|성당|사찰|공원|체육관|주유소|미용실|세탁소|꽃집|충전소|주차장|정류장|정문|후문|관리사무소|경비실|놀이터|공인중개사|중개사|부동산|사무소|은행|노래방/;
      const NON_APT_CATEGORY = /빌라|사우나|어린이집|유치원|학원|마트|편의점|음식점|카페|커피|호텔|모텔|병원|약국|학교|종교|공원|체육|주유소|미용|세탁|꽃집|충전|주차|정류|중개|부동산|은행/;
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
      return {
        lat: chosen.lat, lng: chosen.lng,
        address: chosen.addrText || addr,
        placeName: chosen.d.place_name || name,
      };
    } catch (e) {
      // 일시 실패 — 다음 후보로 계속 진행 (KAKAO-DIAG: 상태코드별 집계, prod 로그 스팸 없이 관측)
      const code = e.response?.status ? `http_${e.response.status}` : (e.code || 'err');
      _trackKakaoResult(code, `${code} ${t.q}: ${String(e.response?.data?.message || e.message).slice(0, 120)}`);
      logger.debug({ src: 'kakao', q: t.q, err: e.message }, 'Kakao geocode 개별 실패');
    }
  }
  _trackKakaoResult('nomatch');
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
      source: 'kakao',
    }, { onConflict: 'apt_key' });
    cache.set(`geo-db:${key}`, { lat: entry.lat, lng: entry.lng, address: entry.address, placeName: entry.placeName }, 3600);
  } catch (e) {
    logger.warn({ err: e.message, key }, 'apt_geocache UPSERT 실패 (무시)');
  }
}

/**
 * 단건 단지 좌표 해결
 * @param {Object} apt - { kaptCode?, aptName, sigungu?, umdNm?, address? }
 * @returns {Promise<{lat, lng}|null>}
 */
async function resolveCoord(apt) {
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

  // 2) Kakao 폴백
  const fromKakao = await kakaoGeocode(apt);
  if (fromKakao) {
    // fire-and-forget UPSERT (응답 지연 최소화)
    saveToDb(key, { ...apt, ...fromKakao });
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
async function resolveCoordBatch(apts, concurrency = 4) {
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
  // 3) 잔여(진짜 miss)만 기존 단건 경로
  const tk = Date.now();
  let p = 0;
  async function worker() {
    while (p < remain.length) {
      const idx = remain[p++];
      results[idx] = await resolveCoord(apts[idx]).catch(() => null);
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

module.exports = { resolveCoord, resolveCoordBatch, getKakaoUsageStats, kakaoGeocode, kakaoAddressGeocode };
