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
const dgk = require('./dataGoKrClient'); // RELAY-2026-08-08 (Sprint BBBBBBB): 직접+Edge 릴레이
const cache = require('../cache');
const logger = require('../logger');
const { itemArray, parseAmountManwon, isCanceled } = require('../utils/molitParse');

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
      const _fetch = () => dgk.get(MOLIT_RENT_URL, { // RELAY (Sprint BBBBBBB)
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
      // RENT-429-RETRY-2026-08-12 (Sprint KKKKKKK-13): 국토부 게이트웨이 **초당** 요청 한도
      //   (HTTP 429 code=23, health 실측)는 다음 초에 자연 해제되는 순간 한도다. 그런데 종전엔
      //   429 도 일반 실패로 떨어져 이 (lawd,월)이 빈 배열로 5분 캐시됐다 — **일시 한도가
      //   5분짜리 표본 구멍으로 확대**되는 구조. 1.2s 대기 후 1회만 재시도한다(그래도 429 면
      //   기존 실패 경로 그대로 — 무한 재시도 없음).
      let response;
      try {
        response = await _fetch();
      } catch (e) {
        if (e.response && e.response.status === 429) {
          await new Promise(r => setTimeout(r, 1200));
          response = await _fetch();
        } else { throw e; }
      }

      const body = response.data?.response?.body;
      header = response.data?.response?.header || header;
      totalCount = body?.totalCount != null ? parseInt(body.totalCount, 10) : totalCount;
      const pageItems = itemArray(body?.items?.item);

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
        if (isCanceled(item)) {
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
        // 보증금·월세 모두 만원 단위. 숫자·문자열 양쪽 안전 파싱은 utils/molitParse 로 통합
        // (RENT-TYPE-FIX-2026-06-14 실장애 근거는 parseAmountManwon 주석 참조 — Plan 006)
        deposit: parseAmountManwon(item.deposit),
        monthlyRent: parseAmountManwon(item.monthlyRent),
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
    // EXT-OBSERV-2026-08-08 (Sprint AAAAAAA-4): 실패 사유(게이트웨이 errMsg·code)를 health.crons 에 기록 —
    //   08-02 부터 전월세 라이브가 조용히 0건이 되는 동안 사유를 어디서도 볼 수 없었다.
    //   molitErrReason 은 화이트리스트 추출이라 키 에코 없음(테스트 고정). 실패 기록은 관측이 본 기능을 막지 않게 삼킨다.
    try {
      const brief = require('../jobs/molitIngest').molitErrReason(err);
      require('./cronStats').recordCronRun('rent-live', { ok: false, error: brief }).catch(() => {});
    } catch (_) {}
    // 에러 캐시 5분 — 일시적 5xx/timeout 시 매 요청마다 외부 API 두드리는 부하 방지
    cache.set(cacheKey, [], 300);
    const apiErr = new Error(`국토부 전월세 API 호출 실패: ${err.message}`);
    apiErr.code = 'MOLIT_RENT_API_ERROR';
    apiErr.status = 502;
    throw apiErr;
  }
}

/**
 * 단지별 최근 6개월 전세 거래 조회 (전세 + 환산 반전세)
 *
 * P2-6 (2026-05-04): 반전세 (monthlyRent > 0) 환산보증금으로 포함
 *   환산공식: 환산보증금 = 보증금 + (월세 × 100)  — 일반 시장 표준
 *   강남·마포 같은 반전세 비중 높은 구의 표본 ↑ → 갭 계산 정확도 향상
 *   t.deposit (만원) → t._convertedDeposit 필드 추가 (호출자가 사용)
 */
async function getJeonseByApt(lawdCd, aptName) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  // RENT-429-2026-08-12 (Sprint KKKKKKK-13): 6개월 일괄 병렬(Promise.all)이 캐시 콜드 지역에서
  //   국토부 초당 한도(429 code=23)를 정면으로 때렸다 — health.crons.rent-live 실측. 걸린 달은
  //   catch(()=>[]) 로 **조용히 빈 배열**이 되어 전세가율 표본이 소리 없이 얇아진다(정확도 USP 훼손).
  //   동시 2개 청크로 초당 요청을 한도 아래로 낮춘다. 웜 경로(24h 캐시 히트)는 체감 차이 없음.
  const CONC = 2;
  const allResults = [];
  for (let i = 0; i < months.length; i += CONC) {
    const chunk = await Promise.all(
      months.slice(i, i + CONC).map(m => getRentTransactions(lawdCd, m).catch(() => []))
    );
    allResults.push(...chunk);
  }

  const flat = allResults.flat();
  const query = aptName.replace(/\s/g, '');

  // P2-6: 전세 + 반전세 모두 포함 — 반전세는 환산보증금으로 변환
  const filtered = flat
    .filter(t => t.aptName.replace(/\s/g, '').includes(query))
    .map(t => {
      const isJeonse = t.monthlyRent === 0;
      const convertedDeposit = isJeonse
        ? (t.deposit || 0)
        : (t.deposit || 0) + (t.monthlyRent || 0) * 100; // 환산공식
      return { ...t, _convertedDeposit: convertedDeposit, _isHalfJeonse: !isJeonse };
    });

  return filtered.sort((a, b) => {
    const da = a.dealYear * 10000 + a.dealMonth * 100 + a.dealDay;
    const db = b.dealYear * 10000 + b.dealMonth * 100 + b.dealDay;
    return db - da;
  });
}

module.exports = { getRentTransactions, getJeonseByApt };
