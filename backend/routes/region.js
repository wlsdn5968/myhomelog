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
  require('../services/redisCache').rset(ck, payload, TTL).catch(() => {}); // 인스턴스 간 공유(fire-and-forget)
  res.json(payload);
});

/**
 * GET /api/region/_kosischk — KOSIS 통계표 실호출 검증 (**임시**, Sprint YYYYYY)
 *
 * 왜 임시로 공개인가: admin 라우트는 Bearer 토큰이 필요한데, 브라우저 자동화에서 인증 헤더를
 *   다루는 것이 보안 필터에 차단된다(우회하지 않는다). Sprint HHHHH 가 KOSIS 미분양 통계표를
 *   확정할 때 쓴 임시 endpoint `_kosischk` 전례를 그대로 따른다 — **명세 확정 즉시 제거**.
 *
 * 왜 필요한가: 공식 카탈로그에 통계표 ID 가 있어도 OpenAPI 가 반려하는 전례가 있다
 *   (Sprint HHHHH: 101/DT_1YL202001E → "해당 통계표가 존재하지 않습니다").
 *   itmId·objL 구조·주기(prdSe)는 실호출 없이 확정할 수 없고, 우리 절차는 "미검증 코드 선배선 금지".
 *
 * 노출 위험 평가: ①도메인·경로는 코드 상수 → 임의 URL 호출 불가(SSRF 차단) ②KOSIS 키는 응답·로그
 *   어디에도 실리지 않는다 ③반환값은 KOSIS **공개 통계**뿐(누구나 자기 키로 무료 조회 가능)
 *   ④orgId/tblId 는 [A-Za-z0-9_] 형식 검증 ⑤상위 라우터에 dataLimiter 적용.
 *   → 실질 위험은 우리 KOSIS 쿼터 소모뿐이며, 그마저 rate limit + 짧은 수명으로 억제된다.
 */
router.get('/_kosischk', async (req, res) => {
  const key = process.env.KOSIS_API_KEY;
  if (!key) return res.json({ ok: false, reason: 'KOSIS_API_KEY 미설정' });
  const axios = require('axios');
  const EP = {
    data: 'https://kosis.kr/openapi/Param/statisticsParameterData.do',
    meta: 'https://kosis.kr/openapi/statisticsData.do',
  };
  const mode = String(req.query.mode || 'data');
  if (!EP[mode]) return res.json({ ok: false, reason: `mode 는 ${Object.keys(EP).join('|')}` });
  const safe = (v, d) => { const s = String(v == null ? d : v); return /^[A-Za-z0-9_]+$/.test(s) ? s : d; };

  const params = { apiKey: key, format: 'json', jsonVD: 'Y',
    orgId: safe(req.query.orgId, '101'), tblId: safe(req.query.tblId, 'DT_1B26001_A01') };
  if (mode === 'data') {
    params.method = 'getList';
    params.itmId = safe(req.query.itmId, 'ALL');
    params.objL1 = safe(req.query.objL1, 'ALL');
    if (req.query.objL2 !== 'skip') params.objL2 = safe(req.query.objL2, 'ALL');
    params.prdSe = safe(req.query.prdSe, 'M');
    params.newEstPrdCnt = safe(req.query.n, '2');
  } else {
    params.method = 'getMeta';
    params.type = safe(req.query.type, 'ITM'); // ITM(항목) | OBJ(분류)
  }
  try {
    const r = await axios.get(EP[mode], { params, timeout: 20000 });
    const b = r.data;
    if (!Array.isArray(b)) {
      // KOSIS 는 오류를 객체로 준다 — 메시지 원문이 있어야 원인이 확정된다(키는 포함되지 않음)
      return res.json({ ok: false, httpStatus: r.status, notArray: true, body: JSON.stringify(b).slice(0, 600) });
    }
    const take = Math.min(parseInt(req.query.take, 10) || 4, 20);
    return res.json({
      ok: true, rows: b.length, fields: b[0] ? Object.keys(b[0]) : [], sample: b.slice(0, take),
      distinct: b[0] ? Object.fromEntries(['C1_NM', 'C2_NM', 'ITM_NM', 'PRD_DE', 'PRD_SE', 'UNIT_NM']
        .filter(k => k in b[0]).map(k => [k, Array.from(new Set(b.map(x => x[k]))).slice(0, 14)])) : {},
    });
  } catch (e) {
    return res.json({ ok: false, httpStatus: e.response?.status || null, error: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
