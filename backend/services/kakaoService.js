/**
 * Kakao 모빌리티 + 로컬 API 서비스
 * - 대중교통 소요시간 추정 (직선거리 + Kakao 길찾기 fallback)
 * - 주변 편의시설 검색 (학교/마트/병원/지하철)
 *
 * 주의: 정식 대중교통 길찾기는 카카오모빌리티 비즈니스 키 필요.
 * 무료 KAKAO_REST_API_KEY 로는 자동차 directions / 좌표→주소 / 카테고리검색 가능.
 * 대중교통 시간은 자동차 시간 × 1.6 으로 근사 (실서비스 검증 필요).
 */
const axios = require('axios');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리 (DB_ENABLED 게이트 의미 유지)
const { getSupabaseAdmin, hasAdminEnv } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');

const KAKAO_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';
const KAKAO_CAT = 'https://dapi.kakao.com/v2/local/search/category.json';
const KAKAO_KEY_SEARCH = 'https://dapi.kakao.com/v2/local/search/keyword.json';

// Phase B-6 (2026-05-01): apt_amenities DB 캐시 — Vercel scale-out 시 fresh 호출 -90%.
//   좌표 4자리(~11m) 정규화 → 인접 단지가 같은 cache 공유.
//   migration 미적용 시 silent fail → in-memory cache 만 동작 (graceful fallback).
const DB_ENABLED = hasAdminEnv();

function _dbClient() {
  if (!DB_ENABLED) return null;
  return getSupabaseAdmin();
}

async function _dbGetAmenityCount(cacheKey) {
  const a = _dbClient();
  if (!a) return null;
  try {
    const { data } = await a.from('apt_amenities').select('count, fetched_at').eq('cache_key', cacheKey).maybeSingle();
    if (!data) return null;
    const ageDays = (Date.now() - new Date(data.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 90) return null;
    return data.count;
  } catch (e) {
    return null;
  }
}

async function _dbSetAmenityCount(cacheKey, lat, lng, category, radius, count) {
  const a = _dbClient();
  if (!a) return;
  try {
    await a.from('apt_amenities').upsert(
      { cache_key: cacheKey, lat, lng, category, radius, count, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'cache_key' }
    );
  } catch (e) {
    // silent fail — DB 미설정 또는 migration 미적용
  }
}

function isKeyMissing() {
  const k = process.env.KAKAO_REST_API_KEY;
  return !k || k === 'your_kakao_rest_key';
}

/**
 * 두 좌표간 자동차 경로 시간(분) — Kakao 모빌리티 v1 directions
 * 대중교통 비즈니스 키가 없을 때 차량 시간 × 1.6 으로 대중교통 추정
 */
async function getCarMinutes(originLat, originLng, destLat, destLng) {
  if (isKeyMissing()) return null;
  const ck = `kkdir:${originLat.toFixed(4)},${originLng.toFixed(4)}->${destLat.toFixed(4)},${destLng.toFixed(4)}`;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  try {
    const r = await axios.get(KAKAO_DIRECTIONS, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
      params: {
        origin: `${originLng},${originLat}`,
        destination: `${destLng},${destLat}`,
        priority: 'RECOMMEND',
      },
      timeout: 6000,
    });
    const sec = r.data?.routes?.[0]?.summary?.duration;
    const mins = sec ? Math.round(sec / 60) : null;
    cache.set(ck, mins, 86400 * 7);
    return mins;
  } catch (e) {
    cache.set(ck, null, 1800);
    return null;
  }
}

/**
 * 대중교통 추정 시간 = 자동차 시간 × 1.6 + 환승 보정 5분
 * (수도권 평균 비율 — 후속에 실제 ODsay/Kakao 모빌리티 비즈니스 연동 필요)
 */
async function getTransitMinutes(originLat, originLng, destLat, destLng) {
  const car = await getCarMinutes(originLat, originLng, destLat, destLng);
  if (car == null || !Number.isFinite(car)) return null;
  const mins = Math.round(car * 1.6 + 5);
  return Number.isFinite(mins) ? mins : null;
}

/**
 * 주변 카테고리 시설 개수 검색 (반경 미터)
 * 카테고리: SC4(학교) MT1(대형마트) HP8(병원) SW8(지하철역) CS2(편의점)
 */
async function countNearby(lat, lng, categoryCode, radius = 800) {
  if (isKeyMissing()) return 0;
  // Phase B-6: 좌표 4자리(~11m) 정규화 → DB cache 공유
  const lat4 = Number(lat.toFixed(4));
  const lng4 = Number(lng.toFixed(4));
  const cacheKey = `${lat4},${lng4}:${categoryCode}:${radius}`;
  const ck = `kkcat:${cacheKey}`;
  // 1) in-memory cache 우선
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  // 2) DB cache (Phase B-6: scale-out 호환)
  const fromDb = await _dbGetAmenityCount(cacheKey);
  if (fromDb !== null) {
    cache.set(ck, fromDb, 86400 * 3);
    return fromDb;
  }
  // 3) Kakao API
  try {
    const r = await axios.get(KAKAO_CAT, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
      params: {
        category_group_code: categoryCode,
        x: lng, y: lat, radius, size: 15,
      },
      timeout: 5000,
    });
    const cnt = r.data?.meta?.total_count || 0;
    cache.set(ck, cnt, 86400 * 3);
    // fire-and-forget DB save
    _dbSetAmenityCount(cacheKey, lat4, lng4, categoryCode, radius, cnt).catch(() => {});
    return cnt;
  } catch (e) {
    return 0;
  }
}

/**
 * 키워드 검색 카운트 (반경 m) — 카테고리 없는 시설 (종합병원·공원 등)
 */
async function countNearbyKeyword(lat, lng, keyword, radius = 1200) {
  if (isKeyMissing()) return 0;
  // Phase B-6: 좌표 정규화 + DB cache
  const lat4 = Number(lat.toFixed(4));
  const lng4 = Number(lng.toFixed(4));
  const cacheKey = `${lat4},${lng4}:kw:${keyword}:${radius}`;
  const ck = `kkkw:cnt:${cacheKey}`;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  const fromDb = await _dbGetAmenityCount(cacheKey);
  if (fromDb !== null) {
    cache.set(ck, fromDb, 86400 * 3);
    return fromDb;
  }
  try {
    const r = await axios.get(KAKAO_KEY_SEARCH, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
      params: { query: keyword, x: lng, y: lat, radius, size: 45 },
      timeout: 5000,
    });
    // AMENITY-KEYWORD-2026-08-30 (Sprint OOOOOOO, 운영자 "보고서가 개판이다" — PDF 실물에서 발각):
    //   여기서 `meta.total_count` 를 그대로 쓰면 **공원 398개** 같은 값이 나온다(동탄 실측 398·420·68·36).
    //   카카오 키워드 검색은 상호명뿐 아니라 **주소·지명 토큰까지** 매칭한다 — '공원'은 근린공원 실체 외에
    //   `○○공원점`(상가·약국·카페)과 `공원로/공원길` 주소를 가진 업소를 전부 총건수에 넣는다.
    //   반대로 '종합병원'은 그 문자열이 상호에 잘 안 붙어 **0** 으로 과소 집계된다(동탄 7곳 중 6곳이 0).
    //   카테고리 검색(countNearby)이 학교 11·마트 6 처럼 현실적인 값을 내는 것과 대조된다 —
    //   차이는 집합이 category_group_code 로 닫혀 있느냐다.
    //   → 총건수 대신 **응답 문서를 category_name 으로 걸러** 센다. 무엇을 센 것인지가 분명해진다.
    //   ⚠ 그래서 이 값은 size(45)로 상한이 생긴다 — 도보권 개수로는 충분하고, '398개' 처럼
    //     사실이 아닌 큰 수를 보여주는 것보다 낫다.
    const docs = Array.isArray(r.data && r.data.documents) ? r.data.documents : [];
    const cnt = docs.filter(d => String((d && d.category_name) || '').includes(keyword)).length;
    cache.set(ck, cnt, 86400 * 3);
    _dbSetAmenityCount(cacheKey, lat4, lng4, `kw:${keyword}`, radius, cnt).catch(() => {});
    return cnt;
  } catch (e) {
    // ⚠ 실패를 0 으로 돌려주면 '없음'과 구분되지 않는다([[unknown-treated-as-value]]).
    //   캐시에는 쓰지 않으니 다음 요청에 재시도되지만, 그동안 빈 catch 라 흔적조차 없었다.
    logger.warn({ keyword, radius, err: e.message }, 'kakao 키워드 주변시설 조회 실패 — 0 으로 표시됨');
    return 0;
  }
}

/**
 * 한 단지 좌표에 대해 주요 시설 카운트 일괄
 * Phase 8+ (2026-04-26): 반경 1200m (도보 15분), 종합병원/공원은 keyword 검색
 */
async function getNearbyAmenities(lat, lng) {
  if (lat == null || lng == null) return null;
  const [school, mart, hospital_general, subway, cvs, park] = await Promise.all([
    countNearby(lat, lng, 'SC4', 1200),         // 학교 (초중고)
    countNearby(lat, lng, 'MT1', 1500),         // 대형마트
    countNearbyKeyword(lat, lng, '종합병원', 2000),  // 종합병원 (HP8 의원 노이즈 제거)
    countNearby(lat, lng, 'SW8', 1200),         // 지하철역
    countNearby(lat, lng, 'CS2', 500),          // 편의점
    countNearbyKeyword(lat, lng, '공원', 1200),  // 공원
  ]);
  return { school, mart, hospital: hospital_general, subway, cvs, park };
}

/**
 * 키워드 → 좌표 (직장 입력값 등 자유로운 텍스트)
 */
async function keywordToCoord(keyword) {
  if (!keyword || isKeyMissing()) return null;
  const q = String(keyword).trim();
  if (!q) return null;
  const ck = `kkkw:${q}`;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  try {
    const r = await axios.get(KAKAO_KEY_SEARCH, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
      params: { query: q, size: 1 },
      timeout: 5000,
    });
    const d = r.data?.documents?.[0];
    let out = null;
    if (d) {
      const lat = parseFloat(d.y);
      const lng = parseFloat(d.x);
      // Phase 1.9: 한반도 범위 검증 — "강남" 같은 키워드가 외국 지명으로 잡히는 경우 차단
      if (isValidKoreaCoord(lat, lng)) {
        out = { lat, lng, name: d.place_name || d.address_name };
      } else {
        logger.warn({ source: 'kakao-keyword', query: q, lat, lng }, 'Kakao 결과 한반도 범위 밖 — 무시');
      }
    }
    // 결과 없음은 짧게만 캐시 (24h) — API 일시 이슈 시 장기 캐시 방지
    cache.set(ck, out, out ? 86400 * 30 : 86400);
    if (!out) {
      logger.warn({
        source: 'kakao-keyword', query: q,
        total: r.data?.meta?.total_count, status: r.status,
      }, 'Kakao 키워드 검색 결과 없음');
    }
    return out;
  } catch (e) {
    logger.error({
      source: 'kakao-keyword', query: q,
      status: e.response?.status, errMsg: e.response?.data?.message || e.message,
    }, 'Kakao 키워드 검색 실패');
    return null;
  }
}

/**
 * TRANSIT-TRUTH-2026-08-30 (Sprint PPPPPPP): **최근접 지하철역까지의 실측 직선거리**.
 *
 * 왜 필요한가 — KAPT `kaptdWtimesub` 는 관리사무소 **자기신고값**이고 검증이 없다.
 *   서동탄역더샵파크시티는 "10~15분이내" 로 신고돼 있으나 카카오 도보 실측은
 *   1,783m / 26.8분 이었다. 신고값을 그대로 점수에 쓰면 순위가 통째로 뒤틀린다.
 *
 * 카카오 카테고리 검색은 x/y 를 주면 `distance`(직선거리 m) 를 돌려준다.
 *   sort=distance 로 최근접 1건만 받는다. 도보 실거리는 직선거리보다 길다(우회) —
 *   그 보정은 소비자(walkBand 판정) 쪽에서 하고, 여기서는 **잰 값 그대로** 돌려준다.
 *
 * @returns {Promise<{name:string,distance:number}|null>} 반경 내 역이 없으면 null
 */
async function nearestSubway(lat, lng, radius = 3000) {
  if (isKeyMissing()) return null;
  const ck = `kknear:${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}:${radius}`;
  const cached = cache.get(ck);
  if (cached !== undefined) return cached;
  try {
    const r = await axios.get(KAKAO_CAT, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_API_KEY}` },
      params: { category_group_code: 'SW8', x: lng, y: lat, radius, sort: 'distance', size: 1 },
      timeout: 5000,
    });
    const d = r.data?.documents?.[0];
    const out = d ? { name: d.place_name, distance: Number(d.distance) } : null;
    cache.set(ck, out, 86400 * 3);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, status: e.response?.status }, 'kakao 최근접 지하철역 조회 실패');
    return undefined; // ⚠ null(역 없음) 과 구분 — 실패를 "역 없음" 으로 읽으면 안 된다
  }
}

module.exports = {
  getCarMinutes,
  getTransitMinutes,
  countNearby,
  countNearbyKeyword,
  getNearbyAmenities,
  keywordToCoord,
  nearestSubway,
};
