/**
 * 국토교통부 실거래가 API 서비스
 * 공공데이터포털 (data.go.kr) 무료 API
 * API 주소: http://openapi.molit.go.kr/OpenAPI_ToolInstallPackage/service/rest/RTMSOBJSvc/getRTMSDataSvcAptTrade
 */
const axios = require('axios');
const cache = require('../cache');

const MOLIT_BASE_URL = 'http://openapi.molit.go.kr:8081/OpenAPI_ToolInstallPackage/service/rest/RTMSOBJSvc/getRTMSDataSvcAptTrade';
const MOLIT_DETAIL_URL = 'http://openapi.molit.go.kr/OpenAPI_ToolInstallPackage/service/rest/RTMSOBJSvc/getRTMSDataSvcAptTradeDev';

// 서울 주요 구 법정동코드 (앞 5자리)
const LAWD_CODES = {
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
  // 경기 주요
  '과천시': '41290', '광명시': '41210', '성남시분당구': '41135',
  '수원시영통구': '41117', '안양시동안구': '41173', '하남시': '41450',
  '용인시수지구': '41135',
};

/**
 * 실거래가 조회 (월별)
 * @param {string} lawdCd - 법정동코드 5자리
 * @param {string} dealYm - 거래년월 YYYYMM
 */
async function getTransactions(lawdCd, dealYm) {
  const cacheKey = `tx:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[MOLIT] 캐시 히트: ${cacheKey}`);
    return cached;
  }

  if (!process.env.MOLIT_API_KEY || process.env.MOLIT_API_KEY === 'your_molit_api_key') {
    console.warn('[MOLIT] API 키 미설정 — 목업 데이터 반환');
    return getMockTransactions(lawdCd, dealYm);
  }

  try {
    const params = {
      serviceKey: process.env.MOLIT_API_KEY,
      LAWD_CD: lawdCd,
      DEAL_YM: dealYm,
      pageNo: 1,
      numOfRows: 100,
    };

    const response = await axios.get(MOLIT_DETAIL_URL, {
      params,
      timeout: 10000,
      headers: { Accept: 'application/json' },
    });

    const items = response.data?.response?.body?.items?.item;
    const list = Array.isArray(items) ? items : items ? [items] : [];

    const result = list.map(item => ({
      aptName: item.aptNm?.trim() || '',
      sigungu: item.sggNm?.trim() || '',
      umdNm: item.umdNm?.trim() || '',
      excluUseAr: parseFloat(item.excluUseAr) || 0,
      buildYear: parseInt(item.buildYear) || 0,
      floor: parseInt(item.floor) || 0,
      dealYear: parseInt(item.dealYear) || 0,
      dealMonth: parseInt(item.dealMonth) || 0,
      dealDay: parseInt(item.dealDay) || 0,
      dealAmount: parseInt((item.dealAmount || '0').replace(/,/g, '')) || 0,
      lawdCd: item.regionCode || lawdCd,
      aptSeq: item.aptSeq || '',
    }));

    cache.set(cacheKey, result, 86400); // 하루 캐시 (실거래가는 월 1회 갱신)
    return result;
  } catch (err) {
    console.error(`[MOLIT] API 오류: ${err.message}`);
    return getMockTransactions(lawdCd, dealYm);
  }
}

/**
 * 단지명 기반 최근 6개월 실거래가 조회
 */
async function getTransactionsByApt(lawdCd, aptName) {
  const cacheKey = `txapt:${lawdCd}:${aptName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    );
  }

  const allResults = await Promise.all(
    months.map(m => getTransactions(lawdCd, m).catch(() => []))
  );

  const flat = allResults.flat();
  const filtered = aptName
    ? flat.filter(t => t.aptName.includes(aptName.replace(/\s/g, '')))
    : flat;

  const sorted = filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });

  cache.set(cacheKey, sorted, 3600);
  return sorted;
}

/**
 * 지역별 평균 시세 분석
 */
function analyzeTransactions(transactions) {
  if (!transactions.length) return null;

  const byApt = {};
  for (const t of transactions) {
    if (!byApt[t.aptName]) byApt[t.aptName] = [];
    byApt[t.aptName].push(t);
  }

  const summaries = Object.entries(byApt).map(([name, list]) => {
    const prices = list.map(t => t.dealAmount);
    const areas = [...new Set(list.map(t => Math.round(t.excluUseAr / 3.3)))];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return {
      aptName: name,
      sigungu: list[0].sigungu,
      umdNm: list[0].umdNm,
      buildYear: list[0].buildYear,
      dealCount: list.length,
      avgPrice: avg,
      minPrice: min,
      maxPrice: max,
      avgPriceAuk: (avg / 10000).toFixed(2),
      areas: areas.join('·') + '평',
      recentDeal: `${list[0].dealYear}.${String(list[0].dealMonth).padStart(2, '0')}`,
      rawList: list.slice(0, 10),
    };
  });

  return summaries.sort((a, b) => b.dealCount - a.dealCount);
}

// ── 목업 데이터 (API 키 없을 때) ─────────────────────────
function getMockTransactions(lawdCd, dealYm) {
  const year = parseInt(dealYm.slice(0, 4));
  const month = parseInt(dealYm.slice(4, 6));
  return [
    { aptName: '목업아파트A', sigungu: '테스트구', umdNm: '테스트동', excluUseAr: 84.9, buildYear: 2005, floor: 10, dealYear: year, dealMonth: month, dealDay: 15, dealAmount: 70000, lawdCd },
    { aptName: '목업아파트B', sigungu: '테스트구', umdNm: '테스트동', excluUseAr: 59.9, buildYear: 2001, floor: 5, dealYear: year, dealMonth: month, dealDay: 20, dealAmount: 52000, lawdCd },
  ];
}

module.exports = { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES };
