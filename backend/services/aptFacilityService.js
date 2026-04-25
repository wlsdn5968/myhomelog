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
const FACILITY_URL = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3';
const CACHE_TTL_DAYS = 90;
let _diagLogged = false;

function admin() { return getSupabaseAdmin(); }

/** apt_name + sigungu + umd_nm 으로 apt_master 매칭 → kapt_code */
async function findMaster(aptName, sigungu, umdNm) {
  const a = admin();
  if (!a || !aptName) return null;
  // 정확 매칭 우선
  let q = a.from('apt_master')
    .select('kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at')
    .eq('apt_name', aptName);
  if (sigungu) q = q.eq('sigungu', sigungu);
  if (umdNm) q = q.eq('umd_nm', umdNm);
  const { data } = await q.maybeSingle();
  if (data) return data;
  // 정확 매칭 실패 — 같은 (sigungu, umd_nm) 의 부분 매칭 시도 (apt_name 부분 ILIKE)
  if (sigungu && umdNm) {
    const { data: partial } = await a.from('apt_master')
      .select('kapt_code, apt_name, sigungu, umd_nm, facility, facility_fetched_at')
      .eq('sigungu', sigungu).eq('umd_nm', umdNm)
      .ilike('apt_name', `%${aptName}%`)
      .limit(1).maybeSingle();
    return partial || null;
  }
  return null;
}

/** AptInfo 단지 기본정보 호출 — 응답 구조 raw 그대로 jsonb 저장 */
async function fetchFromApi(kaptCode) {
  if (!APT_INFO_KEY) return null;
  let r;
  try {
    r = await axios.get(FACILITY_URL, {
      params: { serviceKey: APT_INFO_KEY, kaptCode, _type: 'json' },
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    if (!_diagLogged) {
      _diagLogged = true;
      const rd = e?.response?.data;
      logger.error({
        kaptCode, status: e?.response?.status, msg: e.message,
        bodyPreview: typeof rd === 'string' ? rd.slice(0,400) : JSON.stringify(rd||{}).slice(0,400),
      }, 'facility API 진단 (1회)');
    }
    return null;
  }
  // 진단 1회: 응답 구조
  if (!_diagLogged) {
    _diagLogged = true;
    const preview = JSON.stringify(r.data || {}).slice(0, 600);
    logger.warn({ kaptCode, contentType: r.headers?.['content-type'], preview }, 'facility 응답 진단 (1회)');
  }
  const header = r.data?.response?.header;
  if (header?.resultCode && !['00','000'].includes(header.resultCode)) {
    logger.warn({ kaptCode, code: header.resultCode, msg: header.resultMsg }, 'facility 응답 비정상');
    return null;
  }
  // body.item 또는 body.items 직접 — AptInfo 형식 다양
  const body = r.data?.response?.body;
  const item = body?.item || (Array.isArray(body?.items) ? body.items[0] : body?.items?.item);
  return item || null;
}

/**
 * 단지 facility 해결 — { aptName, sigungu, umdNm } 로 호출
 * @returns {{ kaptCode, official, raw }|null}
 */
async function resolveFacility({ aptName, sigungu, umdNm }) {
  if (!aptName) return null;
  const memKey = `facility:${aptName}|${sigungu||''}|${umdNm||''}`;
  const mem = cache.get(memKey);
  if (mem !== undefined) return mem;

  const m = await findMaster(aptName, sigungu, umdNm);
  if (!m?.kapt_code) {
    cache.set(memKey, null, 300);
    return null;
  }

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

module.exports = { resolveFacility };
