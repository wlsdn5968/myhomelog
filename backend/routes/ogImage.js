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

// ── OG-REGION-2026-09-05 (감사 P3-14): GET /api/og/region/:lawdCd ────────────────────────────
//   사실 문장은 regionPage.regionFacts() — 페이지 description 과 같은 함수(사본 금지).
//   첫 줄(가장 크게)에는 가장 확실하고 짧은 사실인 "월 실거래 건수"를 놓고, 나머지는 둘째 줄에 최대 2개.
function buildRegionCard(label, facts) {
  const tx = facts.find(f => / 실거래 [\d,]+건$/.test(f)) || facts[0];
  const rest = facts.filter(f => f !== tx).slice(0, 2).join(' · ');
  return {
    eyebrow: '지역 실거래 · 공식 통계',
    title: label || '지역',
    lines: [tx, rest].filter(Boolean),
    footer: '국토교통부 · 한국부동산원 · KOSIS 공식 통계 정리 — 매수 추천이 아닙니다',
  };
}

router.get('/region/:lawdCd', async (req, res) => {
  const code = String(req.params.lawdCd || '').trim();
  if (!/^\d{5}$/.test(code)) return fallback(res, 'bad-code');
  let region = null;
  try { region = require('./region').resolveRegion({ lawdCd: code }); } catch (e) { logger.warn({ err: e.message, code }, 'og: 지역 해석 실패'); }
  if (!region) return fallback(res, 'not-found');

  let facts = [], label = '';
  try {
    const rp = require('./regionPage');
    const { dash, rec, weekly } = await rp.loadRegionData(region);
    facts = rp.regionFacts(dash, rec, weekly);
    label = require('../services/priceRecordsService').regionLabel(region.lawdCd, region.name);
  } catch (e) {
    logger.warn({ err: e.message, code }, 'og: 지역 사실 조회 실패');
    return fallback(res, 'facts-error');
  }
  if (!facts.length) return fallback(res, 'no-facts');   // 통계를 하나도 못 불러온 상태 — 캐시하지 않는다

  let png;
  try {
    png = await require('../services/ogImageService').renderCard(buildRegionCard(label, facts));
  } catch (e) {
    logger.warn({ err: e.message, code }, 'og: 지역 카드 렌더 실패');
    return fallback(res, 'render-error');
  }
  res.set('Cache-Control', 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400');
  res.set('Content-Type', 'image/png');
  return res.send(png);
});

// ── OG-BRIEFING-2026-09-05 (감사 P3-14): GET /api/og/briefing/:day ───────────────────────────
//   티커 문장은 briefing.briefingTicker() — 페이지와 같은 함수. 시황 첫 줄은 길면 싣지 않는다(잘라서 숫자를 훼손하지 않는다).
function buildBriefingCard(day, snap) {
  const tk = require('./briefing').briefingTicker(snap || {});
  const yo = '일월화수목금토'[new Date(day + 'T00:00:00Z').getUTCDay()];
  const lines = [];
  const rates = tk.filter(t => t.label === '기준금리' || t.label === '주담대 평균').map(t => `${t.label} ${t.value}`).join(' · ');
  if (rates) lines.push(rates);
  // 시황 줄은 첫 줄(금리)과 겹치지 않는 것 중 첫 번째 — 라이브 실측(2026-09-05): 첫 시황이 금리 문장이라 카드에 금리가 두 번 찍혔다.
  //   40자를 넘는 시황은 싣지 않는다(잘라서 숫자를 훼손하지 않는다 · 둘째 줄이 두 줄로 접히지 않게).
  const texts = (snap && Array.isArray(snap.lines2) && snap.lines2.length)
    ? snap.lines2.map(it => (it && it.text) || '')
    : ((snap && Array.isArray(snap.lines)) ? snap.lines : []);
  const first = texts.map(s => (s == null ? '' : String(s))).find(s => s && !/기준금리|주담대/.test(s)) || null;
  const tx = tk.find(t => t.label === '실거래 누적');
  const sub = [tx ? `${tx.label} ${tx.value}` : null, (first && first.length <= 40) ? first : null].filter(Boolean).join(' · ');
  if (sub) lines.push(sub);
  return {
    eyebrow: '일일 부동산 데이터 브리핑',
    title: `${day.replace(/-/g, '.')}(${yo}) 브리핑`,
    lines,
    footer: '국토교통부 실거래가 · 한국은행 ECOS · 공식 통계 — 매수·매도 추천이 아닙니다',
  };
}

router.get('/briefing/:day', async (req, res) => {
  const day = String(req.params.day || '').trim();
  const { kstDayString, getOrCreateSnapshot } = require('../services/briefingService');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z')) || day < '2026-01-01' || day > kstDayString()) {
    return fallback(res, 'bad-day');
  }
  let snap = null;
  try { snap = await getOrCreateSnapshot(day); } catch (e) { logger.warn({ err: e.message, day }, 'og: 브리핑 스냅샷 실패'); }
  if (!snap || !Array.isArray(snap.lines) || !snap.lines.length) return fallback(res, 'no-snapshot');

  let png;
  try {
    png = await require('../services/ogImageService').renderCard(buildBriefingCard(day, snap));
  } catch (e) {
    logger.warn({ err: e.message, day }, 'og: 브리핑 카드 렌더 실패');
    return fallback(res, 'render-error');
  }
  // 과거 날짜는 불변 기록 — 길게. 오늘은 페이지와 같은 30분.
  res.set('Cache-Control', day === kstDayString()
    ? 'public, max-age=0, s-maxage=1800'
    : 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  res.set('Content-Type', 'image/png');
  return res.send(png);
});

module.exports = router;
module.exports.buildCard = buildCard;
module.exports.buildRegionCard = buildRegionCard;
module.exports.buildBriefingCard = buildBriefingCard;
