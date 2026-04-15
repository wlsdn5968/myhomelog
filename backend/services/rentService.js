/**
 * 국토교통부 아파트 전월세 실거래가 API
 * 전세가율·갭 계산의 핵심 데이터 소스
 */
const axios = require('axios');
const cache = require('../cache');

const MOLIT_RENT_URL =
  'http://openapi.molit.go.kr:8081/OpenAPI_ToolInstallPackage/service/rest/RTMSOBJSvc/getRTMSDataSvcAptRent';

function isMolitKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * 특정 지역·월 전월세 실거래 조회
 */
async function getRentTransactions(lawdCd, dealYm) {
  if (isMolitKeyMissing()) {
    const err = new Error('MOLIT API 키 미설정');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `rent:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await axios.get(MOLIT_RENT_URL, {
    params: {
      serviceKey: process.env.MOLIT_API_KEY,
      LAWD_CD: lawdCd,
      DEAL_YM: dealYm,
      pageNo: 1,
      numOfRows: 200,
    },
    timeout: 10000,
    headers: { Accept: 'application/json' },
  });

  const items = response.data?.response?.body?.items?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];

  const result = list.map(item => ({
    aptName: item.aptNm?.trim() || '',
    umdNm: item.umdNm?.trim() || '',
    excluUseAr: parseFloat(item.excluUseAr) || 0,
    floor: parseInt(item.floor) || 0,
    dealYear: parseInt(item.dealYear) || 0,
    dealMonth: parseInt(item.dealMonth) || 0,
    dealDay: parseInt(item.dealDay) || 0,
    // 보증금·월세 모두 만원 단위
    deposit: parseInt((item.deposit || '0').replace(/,/g, '')) || 0,
    monthlyRent: parseInt((item.monthlyRent || '0').replace(/,/g, '')) || 0,
  }));

  cache.set(cacheKey, result, 86400);
  return result;
}

/**
 * 단지별 최근 6개월 전세 거래 조회 (월세=0인 건만)
 */
async function getJeonseByApt(lawdCd, aptName) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const allResults = await Promise.all(
    months.map(m => getRentTransactions(lawdCd, m).catch(() => []))
  );

  const flat = allResults.flat();
  const query = aptName.replace(/\s/g, '');

  const filtered = flat.filter(t =>
    t.monthlyRent === 0 && // 전세만
    t.aptName.replace(/\s/g, '').includes(query)
  );

  return filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });
}

module.exports = { getRentTransactions, getJeonseByApt };
