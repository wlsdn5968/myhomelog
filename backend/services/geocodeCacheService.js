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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;

const DB_ENABLED = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const KAKAO_ENABLED = !!KAKAO_KEY && KAKAO_KEY !== 'your_kakao_rest_key';

const KAKAO_KEYWORD = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const KAKAO_ADDRESS = 'https://dapi.kakao.com/v2/local/search/address.json';

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

/** Kakao 다중 쿼리 폴백 — 가장 정확한 매칭을 위해 여러 형태로 시도 */
async function kakaoGeocode({ aptName, sigungu, umdNm, address }) {
  if (!KAKAO_ENABLED) return null;
  const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
  const name = String(aptName || '').trim();
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
      const r = await axios.get(t.url, {
        headers, params: { query: t.q, size: 1 }, timeout: 5000,
      });
      const d = r.data?.documents?.[0];
      if (!d) continue;
      const lat = parseFloat(d.y);
      const lng = parseFloat(d.x);
      if (!isValidKoreaCoord(lat, lng)) continue;  // 한반도 범위 밖 차단
      return {
        lat, lng,
        address: d.address_name || d.address?.address_name || addr,
        placeName: d.place_name || name,
      };
    } catch (e) {
      // 일시 실패 — 다음 후보로 계속 진행
      logger.debug({ src: 'kakao', q: t.q, err: e.message }, 'Kakao geocode 개별 실패');
    }
  }
  return null;
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
 * 배치 단지 좌표 해결 — 동시성 제한
 * @param {Array} apts
 * @returns {Promise<Array<{lat, lng}|null>>}
 */
async function resolveCoordBatch(apts, concurrency = 4) {
  const results = new Array(apts.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < apts.length) {
      const idx = i++;
      results[idx] = await resolveCoord(apts[idx]).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, apts.length) }, () => worker()));
  return results;
}

module.exports = { resolveCoord, resolveCoordBatch };
