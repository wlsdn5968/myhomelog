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
const { createClient } = require('@supabase/supabase-js');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');

const KAKAO_DIRECTIONS = 'https://apis-navi.kakaomobility.com/v1/directions';
const KAKAO_CAT = 'https://dapi.kakao.com/v2/local/search/category.json';
const KAKAO_KEY_SEARCH = 'https://dapi.kakao.com/v2/local/search/keyword.json';

// Phase B-6 (2026-05-01): apt_amenities DB 캐시 — Vercel scale-out 시 fresh 호출 -90%.
//   좌표 4자리(~11m) 정규화 → 인접 단지가 같은 cache 공유.
//   migration 미적용 시 silent fail → in-memory cache 만 동작 (graceful fallback).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const DB_ENABLED = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;

function _dbClient() {
  if (!DB_ENABLED) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
      params: { query: keyword, x: lng, y: lat, radius, size: 15 },
      timeout: 5000,
    });
    const cnt = r.data?.meta?.total_count || 0;
    cache.set(ck, cnt, 86400 * 3);
    _dbSetAmenityCount(cacheKey, lat4, lng4, `kw:${keyword}`, radius, cnt).catch(() => {});
    return cnt;
  } catch (e) {
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

module.exports = {
  getCarMinutes,
  getTransitMinutes,
  countNearby,
  countNearbyKeyword,
  getNearbyAmenities,
  keywordToCoord,
};
