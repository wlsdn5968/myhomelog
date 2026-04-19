/**
 * 청약 캘린더 라우트
 * 공공데이터포털 - 한국부동산원 청약Home APT 분양정보
 *  https://www.data.go.kr/data/15101046/openapi.do
 *  엔드포인트: apis.data.go.kr/1613000/SubscriptAreaInfoSvc/getAPTLttotPblancDetail
 *  대안: B552555/HthrIdLttotPblancInfo (간소화 정보)
 *
 * MOLIT_API_KEY와 동일한 data.go.kr 인증키 사용 가능
 * 캐시: 6시간 (분양 일정은 자주 안 바뀜)
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const cache = require('../cache');

const APT_LTTOT_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';

function isKeyMissing() {
  const key = process.env.MOLIT_API_KEY;
  return !key || key === 'your_molit_api_key';
}

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * GET /api/subscription?sido=서울&days=60
 * 향후 N일 이내 분양 공고 목록 (시도별 필터)
 */
router.get('/', async (req, res) => {
  const sido = (req.query.sido || '').trim();
  const days = Math.min(180, Math.max(7, parseInt(req.query.days || '60')));
  const cacheKey = `subs:${sido}:${days}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json({ ...hit, fromCache: true });

  if (isKeyMissing()) {
    return res.status(503).json({
      error: '청약 데이터 조회 API 키 미설정',
      hint: '관리자: data.go.kr에서 MOLIT_API_KEY 발급 후 환경변수 설정 필요',
    });
  }

  const today = new Date();
  const end = new Date(today.getTime() + days * 86400000);
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  try {
    const r = await axios.get(APT_LTTOT_URL, {
      params: {
        serviceKey: process.env.MOLIT_API_KEY,
        page: 1,
        perPage: 100,
        'cond[RCEPT_BGNDE::GTE]': fmt(today),
        'cond[RCEPT_BGNDE::LTE]': fmt(end),
      },
      timeout: 8000,
    });

    let items = r.data?.data || [];
    if (sido) {
      items = items.filter(it => (it.SUBSCRPT_AREA_CODE_NM || it.HSSPLY_ADRES || '').includes(sido));
    }

    const list = items.map(it => ({
      name: it.HOUSE_NM || '미상',
      address: it.HSSPLY_ADRES || '',
      area: it.SUBSCRPT_AREA_CODE_NM || '',
      receiveStart: it.RCEPT_BGNDE || '',
      receiveEnd: it.RCEPT_ENDDE || '',
      announceDate: it.PRZWNER_PRESNATN_DE || '',
      contractStart: it.CNTRCT_CNCLS_BGNDE || '',
      contractEnd: it.CNTRCT_CNCLS_ENDDE || '',
      moveInPlanned: it.MVN_PREARNGE_YM || '',
      sales: it.HSSPLY_HSCNT || 0,
      builder: it.BSNS_MBY_NM || '',
      detailUrl: it.PBLANC_URL || '',
    })).sort((a, b) => (a.receiveStart || '').localeCompare(b.receiveStart || ''));

    const out = {
      sido: sido || '전국',
      days,
      count: list.length,
      items: list,
      updatedAt: new Date().toISOString(),
      disclaimer: '청약 정보는 한국부동산원 공식 발표를 기준으로 갱신되나, 실제 신청 전 청약Home(applyhome.co.kr)에서 최종 확인 필수. 본 서비스는 정보 인덱싱만 제공합니다.',
    };
    cache.set(cacheKey, out, 21600); // 6시간
    res.json({ ...out, fromCache: false });
  } catch (e) {
    const status = e.response?.status;
    const data = e.response?.data || {};
    const detail = status ? `HTTP ${status} ${JSON.stringify(data).slice(0,200)}` : (e.code || e.message);
    console.error('[Subscription] API 실패:', detail);

    // odcloud "등록되지 않은 인증키" (-4) → 청약 데이터셋 별도 구독 필요
    if (status === 400 && (data.code === -4 || /등록되지 않은/.test(data.msg || ''))) {
      return res.status(503).json({
        error: '청약 데이터 API 별도 구독 필요',
        hint: '관리자: data.go.kr에서 "한국부동산원_청약Home APT 분양정보 조회 서비스" 활용신청 후 동일 MOLIT_API_KEY 사용 가능',
        externalLink: 'https://www.applyhome.co.kr',
      });
    }
    res.status(502).json({
      error: '청약 정보 조회 일시 실패',
      hint: '잠시 후 다시 시도하거나 청약Home(applyhome.co.kr)에서 직접 확인',
    });
  }
});

module.exports = router;
