/**
 * 공동주택 단지 기본정보 서비스
 * 공공데이터포털 - 국토교통부 아파트 단지 기본정보
 * - aptSeq(단지일련번호) 기반 상세 조회
 * - 캐시: 30일 (단지 기본정보는 거의 안 바뀜)
 *
 * 주의: 같은 MOLIT_API_KEY 사용 가능. data.go.kr 활용신청 시
 * 'AptBasisInfoService' 함께 신청 권장.
 */
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): 직접+Edge 릴레이
const cache = require('../cache');
const logger = require('../logger');

// BASIS-V4-2026-05-13 (Sprint BB): aptFacilityService.fetchFromApi 는 이미 V4 사용 중.
//   getAptBasisInfo (propertyService 추천 path) 만 V3 단일 사용 — V4 미사용.
//   V4 가 더 완전한 데이터 (kaptMparea60~136 평형 구간 등) → V4 / V3 fallback chain.
// KAPT-V5-2026-08-30 (Sprint OOOOOOO, 운영자 "500세대+ 필터에 아무것도 안 나온다"):
//   ⚠ **K-apt 계열 V1~V4 가 전부 폐기됐다** — 실호출 실측(2026-08-30):
//     AptListService3/getSigunguAptList3      → 400 returnReasonCode 12 (NO_OPENAPI_SERVICE_ERROR)
//     AptListService3/getRoadnameAptList3     → 400 / 12
//     AptBasisInfoServiceV2·V3·V4             → 400 / 12
//     AptBasisInfoServiceV4/getAphusDtlInfoV4 → 400 / 12
//   살아있는 것: **AptListService4** · **AptBasisInfoServiceV5**(응답 필드명은 V3 와 동일 —
//   kaptCode·kaptName·kaptdaCnt·hoCnt·kaptdPcnt·codeSaleNm·as1~as4·bjdCode, 실측 대조).
//   그래서 URL 교체만으로 복구된다(파서 변경 불요. List4 는 body.items 가 직접 배열 — 기존 분기 그대로).
//
//   ⚠ 이 고장은 **조용했다**: dgk 릴레이는 returnReasonCode '10'(IP 거부)만 폴백 대상이라
//     '12'(서비스 폐기)는 그대로 throw → getAptListBySgg 가 [] 를 반환 → 필터가 전건 제외.
//     "폐기"는 릴레이로 못 고친다. 그래서 소비자 쪽에 DB 폴백을 함께 넣었다(propertyService).
//   과거 버전은 뒤에 남긴다 — 되살아나도 손해가 없고, 되돌리기 이력이 된다.
const APT_BASIS_URLS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3',
];
const APT_LIST_URL = 'https://apis.data.go.kr/1613000/AptListService4/getRoadnameAptList4';
const APT_LIST_SGG_URL = 'https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4';
// DTL-INFO-2026-05-13 (Sprint X): KAPT detail endpoint (주차/승강기/CCTV/편의시설 정보)
//   BasisInfo 와 별개 endpoint. V5 → V4 → V3 fallback (위 KAPT-V5 주석 참조).
const APT_DTL_URLS = [
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusDtlInfoV5',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4',
  'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusDtlInfoV3',
];

function isKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * aptSeq로 단지 기본정보 조회
 * 반환: { kaptName, kaptDongCnt, kaptdaCnt, kaptUsedate, doroJuso, ... }
 */
async function getAptBasisInfo(aptSeq) {
  if (!aptSeq || isKeyMissing()) return null;

  const cacheKey = `aptbas:${aptSeq}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // BASIS-V4-2026-05-13 (Sprint BB): V4 → V3 fallback chain (V4 가 더 완전).
  //   1회 재시도 per endpoint — K-apt 서버 간헐적 5xx (피크시간 등).
  const tryEndpoint = async (url) => {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await dgk.get(url, {
          params: { serviceKey: process.env.MOLIT_API_KEY, kaptCode: aptSeq, _type: 'json' },
          timeout: 8000,
        });
        const item = r.data?.response?.body?.item || null;
        const resultCode = r.data?.response?.header?.resultCode;
        if (item && (!resultCode || ['00','000'].includes(resultCode))) {
          // V4: 의미있는 값 1개 이상 (kaptName / kaptdaCnt) 검증 — empty schema 방지
          const meaningful = item.kaptName || item.kaptdaCnt || item.kaptUsedate;
          if (meaningful) return { ok: true, item };
        }
        return { ok: false, reason: `code ${resultCode || 'empty'}` };
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if (status && status >= 400 && status < 500) return { ok: false, reason: `HTTP ${status}` };
        if (i === 0) await new Promise(res => setTimeout(res, 400));
      }
    }
    return { ok: false, reason: lastErr?.message || 'unknown' };
  };

  for (const url of APT_BASIS_URLS) {
    const r = await tryEndpoint(url);
    if (r.ok) {
      cache.set(cacheKey, r.item, 86400 * 30);
      return r.item;
    }
  }
  logger.warn({ source: 'kapt-basis', aptSeq }, 'K-apt BasisInfo V4+V3 모두 실패');
  cache.set(cacheKey, null, 600);
  return null;
}

/**
 * 도로명 주소 기반 단지 검색 (kaptCode 찾기)
 */
async function findAptByRoadName(bjdCode) {
  if (!bjdCode || isKeyMissing()) return [];
  const cacheKey = `aptlist:${bjdCode}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const r = await dgk.get(APT_LIST_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        bjdCode,
        numOfRows: 100,
        _type: 'json',
      },
      timeout: 8000,
    });
    const items = r.data?.response?.body?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];
    cache.set(cacheKey, list, 86400 * 7); // 7일
    return list;
  } catch (e) {
    return [];
  }
}

/**
 * 시군구 단위 전체 단지 목록 조회 (핵심 신규)
 * 거래 없는 단지까지 포함한 완전한 목록 — 단지 다양성 확보
 *
 * @param {string} sigunguCode 법정동 5자리 (예: '11350')
 * @returns {Promise<Array<{kaptCode,kaptName,as1,as2,as3,as4,bjdCode,doroJuso}>>}
 */
async function getAptListBySgg(sigunguCode) {
  if (!sigunguCode || isKeyMissing()) return [];
  const cacheKey = `aptlist-sgg:${sigunguCode}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached || []; // 빈 배열 캐시도 hit 처리

  try {
    const all = [];
    // 페이지당 최대 200건, 강남·송파 등 대단지 구는 1500개 이상이므로 10페이지까지
    for (let pageNo = 1; pageNo <= 10; pageNo++) {
      const r = await dgk.get(APT_LIST_SGG_URL, {
        params: {
          serviceKey: process.env.MOLIT_API_KEY,
          sigunguCode,
          numOfRows: 200,
          pageNo,
          _type: 'json',
        },
        timeout: 8000,
        headers: { Accept: 'application/json' },
      });
      const body = r.data?.response?.body;
      // BUG-FIX-2026-05-12 (Sprint Q — Chrome MCP audit 후 코드 비교 발견):
      //   KAPT AptListService3/getSigunguAptList3 응답은 XML 의 <items><item>...</item></items> 구조.
      //   JSON 변환 시 body.items (array) 또는 body.items.item (1 → 단일 객체) 로 옴.
      //   기존: body.item (S 빠진 key) 로 읽어서 늘 undefined → list=[] → 모든 lawdCd 가 무한 [].
      //   aptMasterSync.js 는 정확히 body.items 로 읽기 때문에 apt_master 는 일부 구만 채워짐.
      //   propertyService 의 allAptList 도 본 bug 영향 → recommendation facility 미동작 (송파구 etc).
      //   해결: aptMasterSync 와 동일 parse 로직.
      const itemsRaw = body?.items;
      const list = Array.isArray(itemsRaw)
        ? itemsRaw
        : (itemsRaw?.item
            ? (Array.isArray(itemsRaw.item) ? itemsRaw.item : [itemsRaw.item])
            : []);
      const resultCode = r.data?.response?.header?.resultCode;
      if (!list.length && resultCode && resultCode !== '00' && resultCode !== '000') {
        logger.warn({
          source: 'kapt-list-sgg', sigunguCode, pageNo, resultCode,
          resultMsg: r.data?.response?.header?.resultMsg,
        }, 'K-apt 시군구 단지목록 비정상 응답코드');
      }
      if (!list.length) break;
      all.push(...list);
      if (list.length < 200) break; // 마지막 페이지
    }
    cache.set(cacheKey, all, 86400 * 7); // 7일 — 단지 리스트는 거의 안 바뀜
    return all;
  } catch (e) {
    logger.error({
      source: 'kapt-list-sgg', sigunguCode, err: e,
    }, 'K-apt 시군구 단지목록 조회 실패');
    cache.set(cacheKey, [], 1800); // 실패 시 30분 짧게 캐시
    return [];
  }
}

/**
 * DTL-INFO-2026-05-13 (Sprint X): KAPT V4 detail 정보 (주차/승강기/CCTV/편의시설/난방).
 *   BasisInfo (이미 사용) 는 단지 기본정보만 — 주차 필드 없음.
 *   Detail 은 별개 endpoint — V4 → V3 fallback.
 *   동일 kaptCode 사용. 캐시 30일 (단지 시설은 거의 안 바뀜).
 */
async function getAptDtlInfo(kaptCode) {
  if (!kaptCode || isKeyMissing()) return null;
  const cacheKey = `aptdtl:${kaptCode}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  for (const url of APT_DTL_URLS) {
    let r;
    try {
      r = await dgk.get(url, {
        params: { serviceKey: process.env.MOLIT_API_KEY, kaptCode, _type: 'json' },
        timeout: 8000,
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      const status = e?.response?.status;
      if (status && status >= 400 && status < 500) continue; // 404 등 → 다음 endpoint
      continue;
    }
    const item = r.data?.response?.body?.item || null;
    if (item && typeof item === 'object' && Object.keys(item).length > 0) {
      // 의미 있는 값 1개 이상 있어야 (모두 null 인 경우 차단 — Sprint O 와 같은 보호)
      // FIELD-FIX-2026-05-13 (Sprint AA): V4 진짜 필드 — kaptdPcntu (지하) / kaptdEcnt (승강기, detail)
      const meaningful = item.kaptdPcnt || item.kaptdPcntu || item.kaptdEcnt || item.kaptdCccnt;
      if (meaningful) {
        cache.set(cacheKey, item, 86400 * 30);
        return item;
      }
    }
  }
  cache.set(cacheKey, null, 600); // 10분 short cache (실패)
  return null;
}

module.exports = { getAptBasisInfo, getAptDtlInfo, findAptByRoadName, getAptListBySgg };
