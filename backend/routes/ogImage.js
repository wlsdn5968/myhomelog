/**
 * OG-IMAGE-DYNAMIC-2026-09-02 (Sprint RRRRRRR): GET /api/og/apt/:aptSeq — 단지별 링크 미리보기 PNG.
 *
 * [설계 원칙 — 이 저장소가 비싸게 배운 것들]
 *   ① **사실은 한 곳에서만 만든다.** 카드 숫자는 페이지와 같은 `loadAptFacts()` 에서 나온다.
 *      따로 계산하면 "카드엔 63건, 페이지엔 다른 값" 이 되고 그건 사본 사고의 반복이다.
 *   ② **열화된 응답을 캐시하지 않는다.** 데이터가 없거나 렌더가 실패하면 정적 og.png 로 보내되
 *      `no-store` 로 내린다. 성공했을 때만 긴 s-maxage 를 붙인다
 *      ([[degraded-response-cached-at-edge]]: 빈 응답이 6시간 굳어 지역 선택기가 통째로 사라진 적 있다).
 *   ③ **무거운 의존은 이 경로에서만 로드한다.** satori·resvg 는 renderCard 안에서 지연 로드되므로
 *      앱의 다른 요청은 이 비용을 내지 않는다.
 *   ④ **절대 룰**: 카드에 추천·예측·권유 표현을 넣지 않는다. 과거 실거래 사실과 출처만.
 */
'use strict';

const express = require('express');
const logger = require('../logger');
const router = express.Router();

const FALLBACK = '/og.png';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const comma = (v) => Number(v).toLocaleString('ko-KR');
const eok = (v) => (Number.isFinite(Number(v)) ? (Number(v) / 10000).toFixed(1) + '억' : null);

/** 정적 이미지로 보낸다 — 열화 상태이므로 절대 캐시하지 않는다. */
function fallback(res, why) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Og-Fallback', why);          // 라이브에서 원인을 눈으로 확인할 수 있게 남긴다
  return res.redirect(302, FALLBACK);
}

/**
 * 카드에 실을 문장을 만든다. **stat 이 없으면 숫자를 지어내지 않고** 이름·지역만 낸다.
 * 첫 줄이 가장 크게 그려지므로 가장 확실한 사실(건수·평균)을 놓는다.
 */
function buildCard(af) {
  const { region, aptName, umd, buildYear, stat } = af;
  const eyebrow = [region, umd].filter(Boolean).join(' · ') || '실거래 기록';
  const lines = [];
  if (stat) {
    const cnt = num(stat.dealCount);
    const avg = stat.avgPriceAuk;
    const head = [cnt ? `최근 24개월 ${comma(cnt)}건` : null, avg ? `평균 ${avg}억` : null]
      .filter(Boolean).join(' · ');
    if (head) lines.push(head);
    const range = (eok(stat.minPrice) && eok(stat.maxPrice)) ? `${eok(stat.minPrice)}~${eok(stat.maxPrice)}` : null;
    const sub = [
      eok(stat.medianPrice) ? `중앙값 ${eok(stat.medianPrice)}` : null,
      range,
      stat.recentDeal ? `최근 거래 ${stat.recentDeal}` : null,
    ].filter(Boolean).join(' · ');
    if (sub) lines.push(sub);
  } else {
    lines.push('실거래 기록을 준비 중입니다');
  }
  if (buildYear) lines.push(`${buildYear}년 준공`);
  return {
    eyebrow,
    title: aptName || '단지',
    lines: lines.slice(0, 2),   // 3줄부터는 630px 안에서 답답해진다
    footer: '국토교통부 실거래가 공개시스템 · 층·향 보정 없음',
  };
}

router.get('/apt/:aptSeq', async (req, res) => {
  const seq = String(req.params.aptSeq || '').trim();
  // 형식 검증은 페이지와 같은 규칙 — 이름으로는 절대 조회하지 않는다(동명 단지가 남의 시세를 끌어온다).
  if (!/^\d{5}-\d+$/.test(seq)) return fallback(res, 'bad-seq');

  let af = null;
  try {
    af = await require('./aptPage').loadAptFacts(seq);
  } catch (e) {
    logger.warn({ err: e.message, seq }, 'og: 단지 사실 조회 실패');
    return fallback(res, 'facts-error');
  }
  if (!af) return fallback(res, 'not-found');

  let png;
  try {
    png = await require('../services/ogImageService').renderCard(buildCard(af));
  } catch (e) {
    // 렌더러가 죽어도 링크 미리보기 자체는 살아 있어야 한다 — 정적 이미지로 떨어진다.
    logger.warn({ err: e.message, seq }, 'og: 카드 렌더 실패');
    return fallback(res, 'render-error');
  }

  // 성공했을 때만 길게 캐시한다. 실거래는 하루 단위로 갱신되므로 6시간이면 충분하고,
  // stale-while-revalidate 로 갱신 중에도 크롤러가 기다리지 않게 한다.
  res.set('Cache-Control', 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.set('Content-Type', 'image/png');
  return res.send(png);
});

module.exports = router;
module.exports.buildCard = buildCard;
