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
// V3 가 표준이지만 일부 키는 V1/V2 만 활성. 실패 시 다음으로 fallback.
const FACILITY_ENDPOINTS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'http://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBassInfoV2',
  'https://apis.data.go.kr/1613000/AptBasisInfoService/getAphusBassInfo',
];
const CACHE_TTL_DAYS = 90;
let _diagLogged = false;
let _workingEndpoint = null; // 최초 1회 발견 시 캐시 (cold start 마다 재탐색)

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
    attempts.push({ url: url.split('/').slice(-2).join('/'), ok: r.ok, reason: r.reason });
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
