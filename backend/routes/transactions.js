const express = require('express');
const router = express.Router();
const { getTransactions, getTransactionsByApt, analyzeTransactions, LAWD_CODES } = require('../services/transactionService');
const { validateTransactionQuery } = require('../middleware/validation');
const { normalizeAptName } = require('../utils/aptName');

function handleMolitError(err, res) {
  if (err.code === 'MOLIT_KEY_MISSING') {
    return res.status(503).json({
      error: '실거래가 API 미연동',
      code: 'MOLIT_KEY_MISSING',
      message: '국토부 실거래가 API 키가 설정되지 않았습니다.',
      guide: 'data.go.kr → "아파트매매 실거래가 상세자료" 검색 → 활용신청 (무료, 자동승인)',
    });
  }
  // MOB-AUDIT-2026-05-03: production 에선 generic — 내부 에러 누출 차단
  const isProd = process.env.NODE_ENV === 'production';
  // SENTRY-GAP-2026-07-17 (Sprint XXXXX): 5xx 만 캡처(KEY_MISSING 503 은 의도된 안내 상태라 위에서 return 됨,
  //   err.status 4xx 는 클라이언트성이라 제외). MOLIT 타임아웃류는 헬퍼가 upstream fingerprint 로 그룹핑.
  if (!err.status || err.status >= 500) require('../utils/captureError').captureRouteError(err, 'transactions');
  return res.status(err.status || 500).json({
    error: isProd ? '실거래 데이터 조회 실패. 잠시 후 다시 시도해주세요.' : err.message,
  });
}

// GET /api/transactions?lawdCd=11350&dealYm=202503&sigungu=노원구&umdNm=공릉동
// Sprint MM (2026-05-17, 운영자 발견 "공릉풍림아이원 실거래가 미반영"):
//   sigungu + umdNm 옵션 필터 추가. 미지정 시 기존 동작 유지 (회귀 0).
//   이유: aptName substring 매칭만으로는 동/단지 구분 불가 (예: "공릉풍림아이원" query 가 월계동 "풍림아이원" 7건 잘못 반환).
router.get('/', validateTransactionQuery, async (req, res) => {
  const { lawdCd, dealYm, aptName, sigungu, umdNm, monthsBack } = req.query;
  if (!lawdCd || !dealYm) return res.status(400).json({ error: 'lawdCd, dealYm 필수' });

  try {
    // SHARECARD-2026-08-19 (Sprint NNNNNNN-7A): 공유 카드 장기 창 — 화이트리스트만(캐시 키 폭발·과도 조회 방지).
    //   그 외 값·미전달은 기존 6개월(회귀 0). 서비스 cacheKey 에 monthsBack 포함돼 분리 캐시(COMPARE-12MO 검증 완료).
    const _mb = aptName && ['12', '15'].includes(String(monthsBack || '')) ? Number(monthsBack) : undefined;
    let list = aptName
      ? await getTransactionsByApt(lawdCd, aptName, _mb)
      : await getTransactions(lawdCd, dealYm);
    // Sprint MM: sigungu/umdNm 지정 시 결과 추가 필터 — 다른 동 단지 환각 매칭 차단.
    if (sigungu || umdNm) {
      list = list.filter(t => {
        if (sigungu && t.sigungu && t.sigungu !== sigungu) return false;
        if (umdNm && t.umdNm && t.umdNm !== umdNm) return false;
        return true;
      });
    }
    // NAMEFIX-2026-05-11: 사용자 응답 시점에 aptName 정규화 — MOLIT raw "(고층)/(중층)/(저층)" suffix 제거.
    //   DB raw 는 그대로 유지 (transactionService 내부 매칭 호환).
    const items = list.map(t => ({ ...t, aptName: normalizeAptName(t.aptName) }));
    res.json({ count: items.length, items, isMock: false });
  } catch (err) {
    handleMolitError(err, res);
  }
});

// DEAD-ROUTE-2026-07-15 (Sprint LLLLL): GET /analyze 삭제 — 프론트 호출 0 실측(grep 전수).
//   analyzeTransactions 는 propertyService(추천)가 내부 사용 — 함수 자체는 유지, 라우트만 제거.

// GET /api/transactions/codes
router.get('/codes', (req, res) => {
  res.json({ codes: LAWD_CODES });
});

// GET /api/transactions/records
// PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 최근 N일 실거래 중 같은 단지·같은 전용면적의
//   직전 최고/최저를 넘은 거래. 브리핑 카드와 /briefing/:date 아카이브가 같은 함수를 쓴다(사본 금지).
//   ⚠ 계산은 DB 함수가 하고 하루 1회만 갱신된다 — 캐시 미스 시에도 2.5초대라 s-maxage 로 엣지에 얹는다.
//   ?lawdCd=11680  → 그 시군구만(창 30일). 지역별을 7일로 쪼개면 표본이 없다 — 실측: 7일 기준
//                    107개 지역 중 54곳이 경신 0~2건. 30일이면 118곳 중 110곳이 3건 이상.
//   ?withRegions=1 → 드롭다운용 지역 목록 동봉. 랜딩은 숫자 3개만 쓰므로 기본은 빼서 가볍게 둔다.
router.get('/records', async (req, res) => {
  try {
    const svc = require('../services/priceRecordsService');
    // 원자료는 daily cron 으로만 바뀐다 — 엣지 6시간, 그 뒤 하루까지는 낡은 값이라도 준다.
    const CC = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';

    const lawdCd = String(req.query.lawdCd || '').trim();
    if (lawdCd) {
      if (!/^\d{5}$/.test(lawdCd)) return res.status(400).json({ error: 'lawdCd 형식 오류' });
      const blob = await svc.getPriceRecordsByRegion();
      if (!blob) return res.status(503).json({ error: '지역별 경신 집계 조회 실패' });
      const slice = svc.sliceRegion(blob, lawdCd);
      // 없는 지역을 0 으로 지어내지 않는다 — 비교 가능한 거래가 아예 없는 지역이 실제로 있다.
      if (!slice) return res.status(404).json({ error: '이 지역은 비교 가능한 최근 거래가 없습니다.' });
      res.set('Cache-Control', CC);
      return res.json(slice);
    }

    const data = await svc.getPriceRecords();
    if (!data) return res.status(503).json({ error: '실거래 경신 집계 조회 실패' });
    let regions = [];
    if (String(req.query.withRegions || '') === '1') {
      try { regions = svc.regionMenu(await svc.getPriceRecordsByRegion()); } catch (_) { regions = []; }
    }
    res.set('Cache-Control', CC);
    res.json({ ...data, scope: 'national', regions });
  } catch (err) {
    require('../utils/captureError').captureRouteError(err, 'transactions');
    res.status(500).json({ error: '실거래 경신 집계 조회 실패' });
  }
});

module.exports = router;
