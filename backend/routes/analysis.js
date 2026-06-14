/**
 * GET  /api/analysis?aptName=래미안&area=노원구&price=8.5
 * POST /api/analysis/total-cost
 */
const express = require('express');
const router = express.Router();
const { analyzeApt, calcTotalCost, getLawdCdFromArea } = require('../services/analysisService');

// GET /api/analysis
router.get('/', async (req, res) => {
  const { aptName, area, price, sigungu, umdNm } = req.query;
  let { lawdCd } = req.query;

  if (!aptName) return res.status(400).json({ error: 'aptName 필수' });

  // lawdCd 없으면 area 문자열에서 역조회
  if (!lawdCd && area) lawdCd = getLawdCdFromArea(area);

  // DIAG-2026-06-14 (임시): 전세가율/갭 전면 null 원인 규명 — MOLIT 전월세 API raw 응답 노출. 진단 후 제거. (키 미노출 — 길이만)
  if (req.query.rentDebug === '1') {
    const axios = require('axios');
    const dealYm = String(req.query.ym || '202604');
    const key = process.env.MOLIT_API_KEY;
    const lc = lawdCd || '11710';
    try {
      const r = await axios.get('https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent', {
        params: { serviceKey: key, LAWD_CD: lc, DEAL_YMD: dealYm, pageNo: 1, numOfRows: 5, _type: 'json' },
        timeout: 10000, headers: { Accept: 'application/json' },
      });
      const body = r.data?.response?.body; const header = r.data?.response?.header;
      const itemsRaw = body?.items?.item;
      const items = Array.isArray(itemsRaw) ? itemsRaw : (itemsRaw ? [itemsRaw] : []);
      // 서비스 함수 직접 호출 — raw 는 되는데 서비스가 0 인지 확인 (로직 vs API 분리)
      const { getRentTransactions, getJeonseByApt } = require('../services/rentService');
      let svcCount = null, svcErr = null, jeonseCount = null, jeonseErr = null, jeonseMonths = null;
      try { const svc = await getRentTransactions(lc, dealYm); svcCount = svc.length; } catch (e) { svcErr = e.message; }
      try {
        const ja = String(req.query.aptName || '은마');
        const jb = await getJeonseByApt(lc, ja);
        jeonseCount = jb.length;
      } catch (e) { jeonseErr = e.message; }
      return res.json({ rentDebug: true, lawdCd: lc, dealYm, httpStatus: r.status,
        resultCode: header?.resultCode, totalCount: body?.totalCount, keyLen: key ? key.length : 0,
        rawSample: items.slice(0, 3).map(it => it.aptNm),
        svc_getRentTransactions_count: svcCount, svcErr,
        jeonse_getJeonseByApt_count: jeonseCount, jeonseErr,
        serverNow: new Date().toISOString() });
    } catch (e) {
      return res.json({ rentDebug: true, lawdCd: lc, dealYm, errStatus: e.response?.status || null, errMsg: e.message,
        keyLen: key ? key.length : 0, keySet: !!key,
        body: e.response?.data ? (typeof e.response.data === 'string' ? e.response.data.slice(0, 400) : JSON.stringify(e.response.data).slice(0, 400)) : null });
    }
  }

  try {
    // CROSS-REGION-FIX-2026-06-03: sigungu/umdNm 전달 → 가격시그널 표본을 실거래가 탭과 동일 동(umd) 스코프
    const result = await analyzeApt(lawdCd, aptName, parseFloat(price) || 0, sigungu || null, umdNm || null);
    res.json(result);
  } catch (err) {
    // MOB-AUDIT-2026-05-03: production 에선 generic 메시지 — 내부 에러 노출 차단
    const isProd = process.env.NODE_ENV === 'production';
    res.status(err.status || 500).json({
      error: isProd ? '분석 중 오류가 발생했어요.' : err.message,
      code: err.code,
    });
  }
});

// POST /api/analysis/total-cost
router.post('/total-cost', (req, res) => {
  const { price, loanAmount, houseStatus, isFirstBuyer } = req.body;
  if (!price) return res.status(400).json({ error: 'price 필수' });

  const result = calcTotalCost(
    parseFloat(price),
    parseFloat(loanAmount) || 0,
    houseStatus || '무주택',
    !!isFirstBuyer,
  );
  res.json(result);
});

module.exports = router;
