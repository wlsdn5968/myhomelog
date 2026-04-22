/**
 * 공동주택 단지 기본정보 서비스
 * 공공데이터포털 - 국토교통부 아파트 단지 기본정보
 * - aptSeq(단지일련번호) 기반 상세 조회
 * - 캐시: 30일 (단지 기본정보는 거의 안 바뀜)
 *
 * 주의: 같은 MOLIT_API_KEY 사용 가능. data.go.kr 활용신청 시
 * 'AptBasisInfoService' 함께 신청 권장.
 */
const axios = require('axios');
const cache = require('../cache');

const APT_BASIS_URL = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3';
const APT_LIST_URL = 'https://apis.data.go.kr/1613000/AptListService3/getRoadnameAptList3';
const APT_LIST_SGG_URL = 'https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3';

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

  try {
    const r = await axios.get(APT_BASIS_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        kaptCode: aptSeq,
        _type: 'json',
      },
      timeout: 8000,
    });
    const item = r.data?.response?.body?.item || null;
    cache.set(cacheKey, item, 86400 * 30); // 30일
    return item;
  } catch (e) {
    cache.set(cacheKey, null, 3600); // 실패도 1시간 캐시 (스팸 방지)
    return null;
  }
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
    const r = await axios.get(APT_LIST_URL, {
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
 * 거래 없는 단지까지 포함한 완전한 목록 — 매물 다양성 확보
 *
 * @param {string} sigunguCode 법정동 5자리 (예: '11350')
 * @returns {Promise<Array<{kaptCode,kaptName,as1,as2,as3,as4,bjdCode,doroJuso}>>}
 */
async function getAptListBySgg(sigunguCode) {
  if (!sigunguCode || isKeyMissing()) return [];
  const cacheKey = `aptlist-sgg:${sigunguCode}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const all = [];
    // 페이지당 최대 200건, 강남·송파 등 대단지 구는 1500개 이상이므로 10페이지까지
    for (let pageNo = 1; pageNo <= 10; pageNo++) {
      const r = await axios.get(APT_LIST_SGG_URL, {
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
      const items = body?.item;
      const list = Array.isArray(items) ? items : items ? [items] : [];
      if (!list.length) break;
      all.push(...list);
      if (list.length < 200) break; // 마지막 페이지
    }
    cache.set(cacheKey, all, 86400 * 7); // 7일 — 단지 리스트는 거의 안 바뀜
    return all;
  } catch (e) {
    console.error(`[aptInfoService] getAptListBySgg 실패 (${sigunguCode}):`, e.message);
    cache.set(cacheKey, [], 1800); // 실패 시 30분 짧게 캐시
    return [];
  }
}

module.exports = { getAptBasisInfo, findAptByRoadName, getAptListBySgg };
