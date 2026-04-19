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

const APT_BASIS_URL = 'http://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBassInfoV3';
const APT_LIST_URL = 'http://apis.data.go.kr/1613000/AptListService3/getRoadnameAptList3';

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

module.exports = { getAptBasisInfo, findAptByRoadName };
