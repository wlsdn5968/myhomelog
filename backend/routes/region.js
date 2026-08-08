/**
 * 지역 대시보드 — "한 화면에 그 동네 시장 전체" (블룸버그 Phase 2 / Sprint TTTTTT)
 *
 * GET /api/region/dashboard?lawdCd=11680  (또는 ?name=강남구)
 *
 * 6칸 구성 — 전부 **공식 통계 실측치만**. 판단어·예측 없음(절대 룰 ①②).
 *   ① 가격지수 추이   R-ONE 부동산원 (매매·전세, 월)      ← 신규
 *   ② 거래량 추이     자체 molit DB 월별 집계              ← 기존 재사용
 *   ③ 미분양 추이     KOSIS                                 ← 기존 재사용
 *   ④ 평당가(연차별)  자체 molit 집계                       ← 기존 재사용
 *   ⑤ 규제 상태       regulations_snapshot                  ← 기존 재사용
 *   ⑥ (예정) 인구 순이동 — 운영자 data.go.kr 승인 후
 *
 * 설계 원칙:
 *   - 각 칸은 독립 graceful — 하나가 실패해도 나머지는 나온다. 실패한 칸은 **null 로 생략**
 *     (틀린 값·추정치 대신 미표시. Sprint PPPPPP 의 교훈).
 *   - 지역 식별은 **lawd_cd 우선**. 이름은 표시용일 뿐 판정 근거로 쓰지 않는다
 *     ('중구'·'서구' 동명 — Sprint PPPPPP P0 재발 방지).
 *   - AI 호출 0 · DB 스키마 변경 0 · 외부는 무료 공공 API + 6h 캐시.
 */
const express = require('express');
const cache = require('../cache');
const logger = require('../logger');
const { LAWD_CODES, LAWD_CODE_TO_NAME } = require('../services/transactionService');

const router = express.Router();
const TTL = 6 * 3600;

/** 입력(lawdCd 또는 name) → { lawdCd, name } 정규화. 이름은 표시용. */
function resolveRegion({ lawdCd, name }) {
  const code = String(lawdCd || '').trim();
  if (code && LAWD_CODE_TO_NAME[code]) return { lawdCd: code, name: LAWD_CODE_TO_NAME[code] };
  const n = String(name || '').trim();
  if (n) {
    // 정확 키 일치만 허용 — 부분일치는 동명 오매칭 위험(‘중구’)이라 쓰지 않는다.
    if (LAWD_CODES[n]) return { lawdCd: String(LAWD_CODES[n]), name: n };
  }
  return null;
}

router.get('/dashboard', async (req, res) => {
  const region = resolveRegion({ lawdCd: req.query.lawdCd, name: req.query.name });
  if (!region) {
    return res.status(400).json({ error: '지역을 찾을 수 없어요. lawdCd(권장) 또는 정확한 지역명을 지정해주세요.' });
  }
  const ck = `region:dash:v2:${region.lawdCd}`; // v2 — netMigration 추가로 구 캐시 재사용 방지
  // CACHE-2026-07-25 (Sprint TTTTTT-3, 실측): Vercel 서버리스는 요청마다 다른 인스턴스일 수 있어
  //   node-cache(인메모리)만으로는 재요청도 콜드였다 — 병렬화 후 재측정에서 캐시 히트가 4.1s 로
  //   콜드와 동일. Sprint AAAAAA 가 추천 경로에 쓴 것과 같은 **Redis 2차 캐시**를 적용해
  //   인스턴스 간 공유. Redis 미설정 시 rget/rset 이 no-op → 기존 동작으로 자연 폴백.
  const memHit = cache.get(ck);
  if (memHit !== undefined && memHit) return res.json(memHit);
  try {
    const rHit = await require('../services/redisCache').rget(ck);
    if (rHit) { cache.set(ck, rHit, TTL); return res.json(rHit); }
  } catch (_) { /* Redis 실패는 무시하고 계산 경로로 */ }

  const started = Date.now();
  const [priceIndex, txTrend, unsold, netMigration, regulation] = await Promise.all([
    // ① R-ONE 가격지수 (신규)
    (async () => {
      try { return await require('../services/roneService').getRegionIndex(region.lawdCd, { months: 6 }); }
      catch (_) { return null; }
    })(),
    // ② 월별 거래량 + ④ 연차별 평당가 — 자체 DB (report.js 와 동일 소스·캐시 공유)
    (async () => {
      try {
        const { getRegionRecentTransactions } = require('../services/transactionService');
        const txs = await getRegionRecentTransactions(region.lawdCd, 6);
        if (!txs || !txs.length) return null;
        const byMonth = {};
        for (const t of txs) {
          const ym = `${t.dealYear}${String(t.dealMonth).padStart(2, '0')}`;
          byMonth[ym] = (byMonth[ym] || 0) + 1;
        }
        const months = Object.keys(byMonth).sort().map(ym => ({ ym, n: byMonth[ym] }));
        return { months, note: '최근 월은 신고 지연으로 집계 중일 수 있어요', source: '국토교통부 실거래 신고' };
      } catch (_) { return null; }
    })(),
    // ③ KOSIS 미분양
    (async () => {
      try { return await require('../services/kosisService').getUnsoldTrend('', region.name); }
      catch (_) { return null; }
    })(),
    // ⑥ 인구 순이동 — KOSIS 국내인구이동통계(Sprint YYYYYY, 실호출로 명세 확정 후 배선)
    //    ★ lawd_cd 를 그대로 키로 쓴다(KOSIS C1 = 우리 lawd_cd 5자리 동일) — 이름 매칭 없음.
    (async () => {
      try { return await require('../services/kosisService').getNetMigration(region.lawdCd); }
      catch (_) { return null; }
    })(),
    // ⑤ 규제 상태 — 스냅샷 기준(서울은 lawd_cd 11 prefix 로 확정, 그 외는 스냅샷 키워드)
    (async () => {
      try {
        const { getRegulatedKeywords } = require('../services/regulationsService');
        const { keywords, seoulRegulated } = await getRegulatedKeywords();
        if (seoulRegulated && region.lawdCd.startsWith('11')) return { status: '규제지역', basis: '서울 전 지역' };
        for (const kw of (keywords || [])) if (region.name.includes(kw)) return { status: '규제지역', basis: kw };
        return { status: '확인 필요', basis: null }; // 단정하지 않음
      } catch (_) { return null; }
    })(),
  ]);

  const payload = {
    region: { lawdCd: region.lawdCd, name: region.name },
    priceIndex,   // null 이면 프론트에서 해당 칸 생략
    txTrend,
    unsold,
    netMigration,
    regulation,
    generatedAt: new Date().toISOString(),
    disclaimer: '공식 통계 수치를 정리한 정보이며, 매수·매도 추천이나 가격 예측이 아닙니다.',
  };
  logger.info({
    src: 'region-dash', lawdCd: region.lawdCd,
    has: { priceIndex: !!priceIndex, txTrend: !!txTrend, unsold: !!unsold, netMigration: !!netMigration, regulation: !!regulation },
    ms: Date.now() - started,
  }, '지역 대시보드 조립');

  cache.set(ck, payload, TTL);
  require('../services/redisCache').rset(ck, payload, TTL).catch(() => {}); // 인스턴스 간 공유(fire-and-forget)
  res.json(payload);
});

// GWCHECK-TEMP-2026-08-08 (Sprint AAAAAAA-5): data.go.kr 게이트웨이 진단 — **임시, 진단 후 즉시 삭제**.
//   08-02 부터 프로덕션발 요청만 400 INVALID_REQUEST_PARAMETER(code=10). 원인 후보가 "발신 IP(AWS) 거부"와
//   "실키 값 형태" 둘로 좁혀졌고, 이 라우트는 **더미 키 리터럴('test')만** 보내 그 둘을 가른다:
//   403/30(등록되지 않은 서비스키) = 서버 IP 는 정상 취급 → 키 값 문제. 400/10 = IP 자체 거부.
//   env 접근 0 · 비밀 0 · 응답은 상태코드·게이트웨이 사유 필드만( _kosischk 전례와 동일 수명).
router.get('/_gwcheck', async (req, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get('https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev', {
      params: { serviceKey: 'test', LAWD_CD: '11680', DEAL_YMD: '202606', pageNo: 1, numOfRows: 1, _type: 'json' },
      timeout: 12000, headers: { Accept: 'application/json' },
      validateStatus: () => true, // 4xx 도 응답으로 받는다
    });
    const hdr = r.data && r.data.OpenAPI_ServiceResponse && r.data.OpenAPI_ServiceResponse.cmmMsgHeader;
    res.json({ status: r.status, errMsg: hdr && hdr.errMsg || null, code: hdr && hdr.returnReasonCode || null });
  } catch (e) {
    res.json({ status: null, netErr: String(e.code || e.message).slice(0, 60) });
  }
});

// KOSISCHK-REMOVED-2026-07-25 (Sprint YYYYYY): 임시 검증 endpoint `_kosischk` 삭제.
//   목적(인구이동 통계표의 itmId·objL·prdSe 확정)을 달성했고, 확정 명세는 kosisService 주석과
//   memory/popmove-api-pairwise-blocked 에 기록했다. 재검증이 필요하면 git history 에서 되살린다.
//   ⚠ 이 표에서 배운 것: **objL2 를 넣으면 err21** (미분양표는 반대로 objL2 누락 시 err20) —
//     표마다 분류 단계가 달라 파라미터 조합은 표별 실호출로만 확정된다.

module.exports = router;
