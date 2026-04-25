/**
 * 국토교통부 아파트 전월세 실거래가 API
 * 전세가율·갭 계산의 핵심 데이터 소스
 *
 * 2026-04-25 수정 (Bug #3 연장):
 *   - 기존: pageNo=1, numOfRows=200 1회 호출 → 강남·마포 등 월 200건+ 구의
 *           최근 전세 거래 누락 → 갭/전세가율 계산이 옛 데이터로 왜곡되어
 *           역전세 위험 잘못 표기될 수 있음.
 *   - 개선: transactionService.getTransactions 와 동일한 paging 패턴 적용
 *          (MAX_PAGES=10, NUM_ROWS=1000, totalCount 조기 종료, cdealType 해제 거래 제외).
 *   - 왜 이렇게: 매매 API 와 응답 스키마/페이징 동작이 동일 — 검증된 패턴 재사용.
 */
const axios = require('axios');
const cache = require('../cache');
const logger = require('../logger');

const MOLIT_RENT_URL =
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent';
// MOLIT API 성공 코드: '00'(구버전) 또는 '000'(신버전)
const MOLIT_OK_CODES = new Set(['00', '000']);

function isMolitKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

/**
 * 특정 지역·월 전월세 실거래 조회 (페이징 완전 구현)
 *   - 강남·마포 등 월 거래량 많은 구에서 최근 전세 거래 누락 방지.
 *   - cdealType 해제 거래 제외 — 네이버와 시세 불일치 원인 차단.
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
  if (cached !== undefined) return cached || [];

  try {
    // ── 페이징 완전 구현 (transactionService 와 동일 패턴) ──
    // 왜 10페이지 상한: 서울 최대 월 전세 거래 구도 통상 1500~2500건 수준
    //                  → 10페이지(1만건) 충분한 안전마진. Serverless 타임아웃 방어.
    const MAX_PAGES = 10;
    const NUM_ROWS = 1000;
    const allItems = [];
    let header = null;
    let totalCount = null;
    let cancelledCount = 0;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const response = await axios.get(MOLIT_RENT_URL, {
        params: {
          serviceKey: process.env.MOLIT_API_KEY,
          LAWD_CD: lawdCd,
          DEAL_YMD: dealYm,
          pageNo,
          numOfRows: NUM_ROWS,
          _type: 'json',
        },
        timeout: 10000,
        headers: { Accept: 'application/json' },
      });

      const body = response.data?.response?.body;
      header = response.data?.response?.header || header;
      totalCount = body?.totalCount != null ? parseInt(body.totalCount, 10) : totalCount;
      const items = body?.items?.item;
      const pageItems = Array.isArray(items) ? items : items ? [items] : [];

      if (header && header.resultCode && !MOLIT_OK_CODES.has(header.resultCode)) {
        logger.warn({
          source: 'molit-rent', lawdCd, dealYm, pageNo,
          resultCode: header.resultCode, resultMsg: header.resultMsg,
        }, 'MOLIT 전월세 비정상 응답코드');
        break;
      } else if (!header && typeof response.data === 'string') {
        logger.warn({
          source: 'molit-rent', lawdCd, dealYm, pageNo,
          sample: String(response.data).slice(0, 200),
        }, 'MOLIT 전월세 비-JSON 응답');
        break;
      }

      allItems.push(...pageItems);

      // 페이지가 덜 채워졌거나 totalCount 초과 시 종료
      if (pageItems.length < NUM_ROWS) break;
      if (totalCount != null && allItems.length >= totalCount) break;
    }

    if (totalCount != null && allItems.length < totalCount) {
      logger.warn({
        source: 'molit-rent', lawdCd, dealYm,
        fetched: allItems.length, total: totalCount, maxPages: MAX_PAGES,
      }, 'MOLIT 전월세 일부 페이징 미완료 — MAX_PAGES 상한 도달');
    }

    // ── 해제(취소) 거래 필터링 ──
    // 매매와 동일하게 cdealType 비어있지 않으면 해제 거래로 간주, 제외.
    const result = allItems
      .filter(item => {
        const cancelled = String(item.cdealType || '').trim();
        if (cancelled) {
          cancelledCount++;
          return false;
        }
        return true;
      })
      .map(item => ({
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

    if (cancelledCount > 0) {
      logger.info({
        source: 'molit-rent', lawdCd, dealYm,
        cancelledCount, activeCount: result.length,
      }, 'MOLIT 전월세 해제 거래 필터링');
    }

    cache.set(cacheKey, result, 86400);
    return result;
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') throw err;
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.set(cacheKey, [], 300);
    const apiErr = new Error(`국토부 전월세 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_RENT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
}

/**
 * 단지별 최근 6개월 전세 거래 조회 (월세=0인 건만)
 *
 * 한계: 반전세(monthlyRent > 0) 는 제외 — 환산보증금 계산 별도 필요.
 *       강남·마포 같은 반전세 비중 높은 구는 표본 축소될 수 있음.
 *       (향후 개선: 반전세를 환산보증금으로 포함하는 옵션)
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
