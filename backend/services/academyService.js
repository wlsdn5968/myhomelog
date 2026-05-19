/**
 * 학원가 정보 서비스 — 단지 반경 500m 학원 검색
 *
 * Sprint OO (2026-05-19, 운영자 요청 "강연 자료 적용 B"):
 *   - 강연 자료 핵심 포인트 #3 "학원 인프라" 반영
 *   - schoolService.js 패턴 mirror — 학교 검색 = 카카오 keyword + DB cache 와 동일 구조
 *   - 학원 = "학원 인프라" 강도 proxy → 매수 추천 X / 객관 카운트만
 *
 * 설계:
 *   - 카카오맵 keyword "학원" 검색 (카테고리 AC1 와 동등 효과 + 정확도 비교 후 keyword 선택)
 *   - 단지 좌표 반경 500m
 *   - 메모리 cache only (1시간 TTL) — DB 부담 차단
 *   - 학원 입시/영어/수학 분류 — place_name 키워드 매칭 (소프트 분류, 환각 위험 미만)
 *
 * 한계:
 *   - 카카오는 "학원명 + 위치" 만 — 학원 평판/규모/난이도 X
 *   - "학원가 좋다" 정성적 평가 X → frontend 에는 사실 카운트만
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');
const { isValidKoreaCoord } = require('../utils/geo');

const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_ENABLED = !!KAKAO_KEY && KAKAO_KEY !== 'your_kakao_rest_key';
const KAKAO_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const SEARCH_RADIUS_M = 500;
const MEMORY_TTL_S = 3600; // 1시간

// 학원 분류 — place_name 부분 매칭 (정확도 낮은 케이스는 '기타' 로)
const CATEGORY_PATTERNS = [
  { key: '입시', re: /입시|수능|논술|학년|중등|고등|초등/ },
  { key: '영어', re: /영어|english|토익|토플|회화/i },
  { key: '수학', re: /수학|math|연산|올림피아드/i },
  { key: '국어', re: /국어|문법|독해/ },
  { key: '예체능', re: /피아노|미술|태권도|발레|음악|체육|미술학원/ },
  { key: '코딩', re: /코딩|컴퓨터|소프트웨어/ },
];

function classify(placeName) {
  for (const c of CATEGORY_PATTERNS) {
    if (c.re.test(placeName)) return c.key;
  }
  return '기타';
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function cacheKey({ kaptCode, aptName, sigungu, umdNm }) {
  if (kaptCode) return `acad:kapt:${kaptCode}`;
  return `acad:${String(aptName||'').replace(/\s+/g,'')}|${sigungu||''}|${umdNm||''}`;
}

/**
 * 단지 인근 학원 list
 * @returns {Promise<{ total, byCategory, top }>}
 */
async function resolveAcademies({ kaptCode, aptName, sigungu, umdNm, lat, lng }) {
  if (!isValidKoreaCoord(lat, lng)) return null;
  const key = cacheKey({ kaptCode, aptName, sigungu, umdNm });
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (!KAKAO_ENABLED) {
    logger.debug('Kakao 키 미설정 — 학원 검색 skip');
    return null;
  }

  try {
    const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
    // page 1~3 (최대 45개) — 1km 학원이 많은 학군지 (대치동 등) cover
    const docs = [];
    for (let page = 1; page <= 3; page++) {
      const r = await axios.get(KAKAO_KEYWORD, {
        headers,
        params: {
          query: '학원',
          x: lng, y: lat,
          radius: SEARCH_RADIUS_M,
          size: 15,
          page,
          sort: 'distance',
        },
        timeout: 5000,
      });
      const pageDocs = r.data?.documents || [];
      docs.push(...pageDocs);
      // is_end 면 stop
      if (r.data?.meta?.is_end) break;
    }

    const academies = [];
    const seen = new Set();
    for (const d of docs) {
      const aLat = parseFloat(d.y);
      const aLng = parseFloat(d.x);
      if (!isValidKoreaCoord(aLat, aLng)) continue;
      // category 필터: "교육,학문 > 학원" 만
      const cat = d.category_name || '';
      if (!cat.includes('학원')) continue;
      const placeName = String(d.place_name || '').trim();
      if (!placeName) continue;
      // dedupe by name + address (같은 학원 중복 row 차단)
      const dKey = `${placeName}|${d.road_address_name || d.address_name || ''}`;
      if (seen.has(dKey)) continue;
      seen.add(dKey);
      academies.push({
        name: placeName,
        category: classify(placeName + ' ' + cat),
        distance_m: distanceM(lat, lng, aLat, aLng),
        address: d.road_address_name || d.address_name || null,
      });
    }

    // 거리순 정렬
    academies.sort((a, b) => a.distance_m - b.distance_m);

    // 카테고리별 카운트
    const byCategory = {};
    for (const a of academies) {
      byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    }

    const result = {
      total: academies.length,
      byCategory,
      top: academies.slice(0, 10), // 거리 가까운 상위 10개만 응답
      radius_m: SEARCH_RADIUS_M,
    };

    cache.set(key, result, MEMORY_TTL_S);
    return result;
  } catch (e) {
    logger.warn({ err: e.message, aptName, lat, lng }, '학원 검색 실패');
    return null;
  }
}

module.exports = { resolveAcademies };
