/**
 * 학군 데이터 서비스 — 단지 반경 1km 학교 목록
 *
 * 설계:
 *   - 카카오맵 keyword API 로 단지 좌표 기준 "초등학교/중학교/고등학교" 검색
 *   - DB 캐시 (apt_schools) — 같은 단지 재호출 시 0 호출
 *   - 학교명/종류/거리만 반환 (학업성취도는 차후 학교알리미 API 별도 통합)
 *
 * 왜 카카오맵으로:
 *   - 무료 (이미 키 사용 중)
 *   - 한국 학교 위치 데이터 정확 (지도 기반)
 *   - 학교알리미 API 는 키 별도 발급 필요 + 학업성취도 가공 필요 → Phase 3
 *
 * 한계:
 *   - 카카오는 "학교명 + 위치" 만 — 진학률/학업성취도/특목고 여부 X
 *   - "학군 좋다" 의 정성적 평가는 못 함 → AI 답변에서 명시 X
 *   - frontend 에는 사실 나열만 ("○○초 0.4km, ○○중 0.7km")
 */
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;

const DB_ENABLED = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const KAKAO_ENABLED = !!KAKAO_KEY && KAKAO_KEY !== 'your_kakao_rest_key';

const KAKAO_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const SEARCH_RADIUS_M = 1000; // 1km

// 학교 종류별 검색 키워드 (한국 표준)
const SCHOOL_TYPES = [
  { type: '초', keyword: '초등학교' },
  { type: '중', keyword: '중학교' },
  { type: '고', keyword: '고등학교' },
];

// 캐시 TTL — 학교 위치는 거의 안 변함 (개교/폐교는 분기 단위)
const CACHE_TTL_DAYS = 90;

function dbClient() {
  if (!DB_ENABLED) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function buildKey({ kaptCode, aptName, sigungu, umdNm }) {
  if (kaptCode) return `kapt:${kaptCode}`;
  return `name:${String(aptName||'').replace(/\s+/g,'').toLowerCase()}|${sigungu||''}|${umdNm||''}`;
}

/** 두 좌표 간 거리 (m) — Haversine 근사 (단거리에선 평면 충분) */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** DB 캐시 조회 — 90일 이내 유효 */
async function getFromDb(key) {
  const memKey = `schools:${key}`;
  const mem = cache.get(memKey);
  if (mem !== undefined) return mem;

  const admin = dbClient();
  if (!admin) return null;
  try {
    const { data } = await admin
      .from('apt_schools')
      .select('schools, fetched_at')
      .eq('apt_key', key)
      .maybeSingle();
    if (!data) {
      cache.set(memKey, null, 300); // 5분 음성 캐시
      return null;
    }
    // 90일 만료 검사
    const ageDays = (Date.now() - new Date(data.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > CACHE_TTL_DAYS) {
      cache.set(memKey, null, 300);
      return null;
    }
    const out = Array.isArray(data.schools) ? data.schools : [];
    cache.set(memKey, out, 3600);
    return out;
  } catch (e) {
    logger.warn({ err: e.message, key }, 'apt_schools DB 조회 실패');
    return null;
  }
}

/** 카카오맵 keyword API — 좌표 반경 학교 검색 */
async function kakaoSearchSchools(lat, lng) {
  if (!KAKAO_ENABLED) return [];
  const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
  const all = [];

  for (const { type, keyword } of SCHOOL_TYPES) {
    try {
      const r = await axios.get(KAKAO_KEYWORD, {
        headers,
        params: {
          query: keyword,
          x: lng,        // 카카오는 x=lng, y=lat
          y: lat,
          radius: SEARCH_RADIUS_M,
          size: 5,       // 종류당 최대 5개 — 12,000+개 학교 중 가까운 것만
          sort: 'distance',
        },
        timeout: 5000,
      });
      const docs = r.data?.documents || [];
      for (const d of docs) {
        const sLat = parseFloat(d.y);
        const sLng = parseFloat(d.x);
        if (!isValidKoreaCoord(sLat, sLng)) continue;
        // 카카오 keyword 결과는 키워드 일치 필수가 아님 (학원 등 섞일 수 있음)
        // category_name 으로 필터: "교육,학교"
        const cat = d.category_name || '';
        if (!cat.includes('학교')) continue;
        all.push({
          name: d.place_name,
          type,
          distance_m: distanceM(lat, lng, sLat, sLng),
          lat: sLat,
          lng: sLng,
          address: d.address_name || d.road_address_name || null,
        });
      }
    } catch (e) {
      logger.debug({ err: e.message, type }, '카카오 학교 검색 개별 실패');
    }
  }

  // 거리순 정렬, 종류별 최대 3개씩 = 9개 이내
  const byType = { 초: [], 중: [], 고: [] };
  for (const s of all.sort((a,b) => a.distance_m - b.distance_m)) {
    if (byType[s.type] && byType[s.type].length < 3) byType[s.type].push(s);
  }
  return [...byType.초, ...byType.중, ...byType.고];
}

/** DB UPSERT */
async function saveToDb(key, apt, schools) {
  const admin = dbClient();
  if (!admin) return;
  try {
    await admin.from('apt_schools').upsert({
      apt_key: key,
      apt_name: apt.aptName || null,
      sigungu: apt.sigungu || null,
      umd_nm: apt.umdNm || null,
      schools,
      source: 'kakao',
      fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'apt_key' });
    cache.set(`schools:${key}`, schools, 3600);
  } catch (e) {
    logger.warn({ err: e.message, key }, 'apt_schools UPSERT 실패 (무시)');
  }
}

/**
 * 단지 학교 목록 해결
 * @param {Object} apt - { kaptCode?, aptName, sigungu?, umdNm?, lat, lng }
 * @returns {Promise<Array<{name,type,distance_m,...}>>}
 */
async function resolveSchools(apt) {
  if (!apt || !apt.aptName) return [];
  const key = buildKey(apt);

  // 1) DB 캐시
  const fromDb = await getFromDb(key);
  if (fromDb !== null) return fromDb; // 빈 배열도 캐시 (해당 좌표 학교 없음)

  // 2) 좌표 필수 — 단지 좌표 없으면 학군 검색 불가
  if (!isValidKoreaCoord(apt.lat, apt.lng)) {
    logger.debug({ key }, 'resolveSchools: 단지 좌표 없음 — skip');
    return [];
  }

  // 3) 카카오 검색
  const schools = await kakaoSearchSchools(apt.lat, apt.lng);

  // 4) 캐시 (빈 배열도 90일 — 시골 단지는 학교 없을 수 있음)
  saveToDb(key, apt, schools);
  return schools;
}

/** 배치 — 동시성 제한 */
async function resolveSchoolsBatch(apts, concurrency = 3) {
  const results = new Array(apts.length).fill([]);
  let i = 0;
  async function worker() {
    while (i < apts.length) {
      const idx = i++;
      results[idx] = await resolveSchools(apts[idx]).catch(() => []);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, apts.length) }, () => worker()));
  return results;
}

module.exports = { resolveSchools, resolveSchoolsBatch };
