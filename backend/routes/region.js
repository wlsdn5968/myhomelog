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
  const ck = `region:dash:v1:${region.lawdCd}`;
  const hit = cache.get(ck);
  if (hit !== undefined && hit) return res.json(hit);

  const started = Date.now();
  const [priceIndex, txTrend, unsold, regulation] = await Promise.all([
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
    regulation,
    generatedAt: new Date().toISOString(),
    disclaimer: '공식 통계 수치를 정리한 정보이며, 매수·매도 추천이나 가격 예측이 아닙니다.',
  };
  logger.info({
    src: 'region-dash', lawdCd: region.lawdCd,
    has: { priceIndex: !!priceIndex, txTrend: !!txTrend, unsold: !!unsold, regulation: !!regulation },
    ms: Date.now() - started,
  }, '지역 대시보드 조립');

  cache.set(ck, payload, TTL);
  res.json(payload);
});

module.exports = router;
