/**
 * 국토교통부 실거래가 API 서비스
 * 공공데이터포털 (data.go.kr) 무료 API
 * API 신청: data.go.kr → '아파트매매 실거래가 상세자료' 검색 → 활용신청
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const MOLIT_DETAIL_URL = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';
// MOLIT API 성공 코드: '00'(구버전) 또는 '000'(신버전) — 다른 서비스에서도 재사용
const MOLIT_OK_CODES = new Set(['00', '000']);

// 서울/경기 주요 구 법정동코드 (앞 5자리)
const LAWD_CODES = {
  '종로구': '11110', '중구': '11140', '용산구': '11170', '성동구': '11200',
  '광진구': '11215', '동대문구': '11230', '중랑구': '11260', '성북구': '11290',
  '강북구': '11305', '도봉구': '11320', '노원구': '11350', '은평구': '11380',
  '서대문구': '11410', '마포구': '11440', '양천구': '11470', '강서구': '11500',
  '구로구': '11530', '금천구': '11545', '영등포구': '11560', '동작구': '11590',
  '관악구': '11620', '서초구': '11650', '강남구': '11680', '송파구': '11710',
  '강동구': '11740',
  '과천시': '41290', '광명시': '41210', '성남시분당구': '41135',
  '수원시영통구': '41117', '안양시동안구': '41173', '하남시': '41450',
  '용인시수지구': '41465',
};

function isMolitKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * 실거래가 조회 (월별)
 */
async function getTransactions(lawdCd, dealYm) {
  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키가 설정되지 않았습니다. data.go.kr에서 무료 발급 후 환경변수 MOLIT_API_KEY에 설정하세요.');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `tx:${lawdCd}:${dealYm}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached || []; // null/[] 캐시도 hit 처리

  try {
    // 1페이지(1000건)만 조회 — 대부분 한 달 단일 구 거래는 1000건 미만
    // (강남 같은 예외 케이스는 다른 페이지에서 누락되지만 timeout 보호 우선)
    const response = await axios.get(MOLIT_DETAIL_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        LAWD_CD: lawdCd,
        DEAL_YMD: dealYm,
        pageNo: 1,
        numOfRows: 1000,
        _type: 'json',
      },
      timeout: 7000,
      headers: { Accept: 'application/json' },
    });

    const body = response.data?.response?.body;
    const header = response.data?.response?.header;
    const items = body?.items?.item;
    const allItems = Array.isArray(items) ? items : items ? [items] : [];
    // MOLIT API 결과 코드 확인 — 성공 코드 '00'(구) / '000'(신) 외에는 명확히 로깅
    if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
      logger.warn({
        source: 'molit', lawdCd, dealYm,
        resultCode: header.resultCode, resultMsg: header.resultMsg,
      }, 'MOLIT 거래 조회 비정상 응답코드');
    } else if (!header && typeof response.data === 'string') {
      logger.warn({
        source: 'molit', lawdCd, dealYm,
        sample: String(response.data).slice(0, 200),
      }, 'MOLIT 거래 비-JSON 응답');
    }

    const result = allItems.map(item => ({
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

    cache.set(cacheKey, result, 86400);
    return result;
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') throw err;
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.set(cacheKey, [], 300);
    const apiErr = new Error(`국토부 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
}

/**
 * 단지명 기반 최근 6개월 실거래가 조회
 */
async function getTransactionsByApt(lawdCd, aptName) {
  if (isMolitKeyMissing()) {
    const err = new Error('국토부 실거래가 API 키 미설정');
    err.code = 'MOLIT_KEY_MISSING';
    err.status = 503;
    throw err;
  }

  const cacheKey = `txapt:${lawdCd}:${aptName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const months = [];
  // 최근 6개월 조회 — 거래 희소 단지까지 커버
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
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
 * 지역별 시세 분석 — 단지 + 평형별 분리
 * 같은 단지여도 평형별 가격차가 크므로(예: 41㎡ 4억 vs 84㎡ 12억)
 * 평형별 시세를 별도 산출해 예산 매칭 정확도↑
 */
function analyzeTransactions(transactions) {
  if (!transactions || !transactions.length) return [];

  const byApt = {};
  for (const t of transactions) {
    if (!byApt[t.aptName]) byApt[t.aptName] = [];
    byApt[t.aptName].push(t);
  }

  return Object.entries(byApt).map(([name, list]) => {
    // 정렬: 최신 거래가 먼저
    const sorted = [...list].sort((a, b) => {
      const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
      const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
      return db - da;
    });
    const prices = sorted.map(t => t.dealAmount);
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    // 평형별 그룹화 (평 단위로 반올림)
    const byPyeong = {};
    for (const t of sorted) {
      const py = Math.round(t.excluUseAr / 3.3);
      if (!byPyeong[py]) byPyeong[py] = [];
      byPyeong[py].push(t);
    }
    const pyeongStats = Object.entries(byPyeong).map(([py, txs]) => {
      const ps = txs.map(t => t.dealAmount);
      return {
        pyeong: parseInt(py),
        excluUseAr: parseFloat((txs[0].excluUseAr).toFixed(2)),
        dealCount: txs.length,
        avgPrice: Math.round(ps.reduce((a, b) => a + b, 0) / ps.length), // 만원
        minPrice: Math.min(...ps),
        maxPrice: Math.max(...ps),
        recentTx: txs.slice(0, 5).map(t => ({
          date: `${t.dealYear}.${String(t.dealMonth).padStart(2, '0')}.${String(t.dealDay).padStart(2, '0')}`,
          floor: t.floor,
          price: t.dealAmount, // 만원
          excluUseAr: t.excluUseAr,
        })),
      };
    }).sort((a, b) => a.pyeong - b.pyeong);

    return {
      aptName: name,
      sigungu: sorted[0].sigungu,
      umdNm: sorted[0].umdNm,
      buildYear: sorted[0].buildYear,
      lawdCd: sorted[0].lawdCd,
      aptSeq: sorted[0].aptSeq,
      dealCount: sorted.length,
      avgPrice: avg,
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      avgPriceAuk: (avg / 10000).toFixed(2),
      areas: pyeongStats.map(p => p.pyeong).join('·') + '평',
      recentDeal: `${sorted[0].dealYear}.${String(sorted[0].dealMonth).padStart(2, '0')}.${String(sorted[0].dealDay).padStart(2, '0')}`,
      pyeongStats,
      rawList: sorted.slice(0, 10),
    };
  }).sort((a, b) => b.dealCount - a.dealCount);
}

module.exports = { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES };
