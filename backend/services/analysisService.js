/**
 * 매수 의사결정 분석 엔진
 * - 가격 위치 백분위 (최근 1년 거래 대비)
 * - 전세가율 + 갭 계산
 * - 거래량 추이 신호
 * - 3개 지표 종합 매수 신호
 * - 실투자금 총비용 계산
 */
const { getTransactionsByApt, LAWD_CODES } = require('./transactionService');
const { getJeonseByApt } = require('./rentService');
const cache = require('../cache');

// ── 지역명 → lawdCd 역조회 ────────────────────────────────
function getLawdCdFromArea(area) {
  if (!area) return null;
  for (const [gu, code] of Object.entries(LAWD_CODES)) {
    if (area.includes(gu)) return code;
  }
  return null;
}

// ── 가격 위치 백분위 ──────────────────────────────────────
// transactions: dealAmount 만원 단위 배열
// currentPrice: 만원 단위
function calcPricePercentile(transactions, currentPrice) {
  if (!transactions || transactions.length < 3) return null;
  const prices = transactions.map(t => t.dealAmount).sort((a, b) => a - b);
  const below = prices.filter(p => p <= currentPrice).length;
  return Math.round((below / prices.length) * 100);
}

// ── 거래량 추이 신호 ──────────────────────────────────────
// 최근 3개월 vs 이전 3개월 비교
function calcVolumeSignal(transactions) {
  if (!transactions || transactions.length < 2) return 'neutral';
  const now = new Date();

  function monthsAgo(t) {
    const d = new Date(t.dealYear, t.dealMonth - 1);
    return (now - d) / (1000 * 60 * 60 * 24 * 30);
  }

  const recent = transactions.filter(t => monthsAgo(t) <= 3).length;
  const prev = transactions.filter(t => {
    const m = monthsAgo(t);
    return m > 3 && m <= 6;
  }).length;

  if (prev === 0) return recent > 0 ? 'up' : 'neutral';
  const ratio = recent / prev;
  if (ratio >= 1.2) return 'up';
  if (ratio <= 0.7) return 'down';
  return 'neutral';
}

// ── 전세가율 + 갭 계산 ────────────────────────────────────
// saleTx.dealAmount: 만원 / jeonseT.deposit: 만원
function calcGap(saleTx, jeonseT) {
  const EMPTY = { jeonseRate: null, gap: null, avgSale: null, avgJeonse: null };
  if (!saleTx?.length || !jeonseT?.length) return EMPTY;

  const avgSaleW = saleTx.slice(0, 10).reduce((s, t) => s + t.dealAmount, 0) / Math.min(saleTx.length, 10);
  const avgJeonseW = jeonseT.slice(0, 10).reduce((s, t) => s + t.deposit, 0) / Math.min(jeonseT.length, 10);

  if (!avgSaleW || !avgJeonseW) return EMPTY;

  const avgSale = parseFloat((avgSaleW / 10000).toFixed(2));   // 억
  const avgJeonse = parseFloat((avgJeonseW / 10000).toFixed(2)); // 억
  const jeonseRate = Math.round((avgJeonse / avgSale) * 100);
  const gap = parseFloat((avgSale - avgJeonse).toFixed(2));

  return { jeonseRate, gap, avgSale, avgJeonse };
}

// ── 3개 지표 종합 매수 신호 ───────────────────────────────
function calcBuySignal(percentile, volumeSignal, jeonseRate) {
  let score = 0;
  const conditions = [];

  // ① 가격 위치 백분위
  if (percentile !== null) {
    if (percentile <= 30) {
      score += 2;
      conditions.push({ label: '가격 위치', status: 'green', desc: `최근 1년 하위 ${percentile}% — 저렴한 구간` });
    } else if (percentile <= 65) {
      score += 1;
      conditions.push({ label: '가격 위치', status: 'yellow', desc: `최근 1년 ${percentile}% — 시세 수준` });
    } else {
      conditions.push({ label: '가격 위치', status: 'red', desc: `최근 1년 상위 ${100 - percentile}% — 고가 구간` });
    }
  }

  // ② 거래량 추이
  const volMap = {
    up:      { score: 2, status: 'green',  desc: '최근 3개월 거래 증가 — 매수세 확대' },
    neutral: { score: 1, status: 'yellow', desc: '거래량 변화 없음 — 관망세' },
    down:    { score: 0, status: 'red',    desc: '거래량 감소 — 가격 하락 선행 가능성' },
  };
  const vol = volMap[volumeSignal] || volMap.neutral;
  score += vol.score;
  conditions.push({ label: '거래량 추이', status: vol.status, desc: vol.desc });

  // ③ 전세가율
  if (jeonseRate !== null) {
    if (jeonseRate >= 60) {
      score += 2;
      conditions.push({ label: '전세가율', status: 'green', desc: `${jeonseRate}% — 실수요 탄탄, 갭투자 리스크 낮음` });
    } else if (jeonseRate >= 45) {
      score += 1;
      conditions.push({ label: '전세가율', status: 'yellow', desc: `${jeonseRate}% — 보통 수준` });
    } else {
      conditions.push({ label: '전세가율', status: 'red', desc: `${jeonseRate}% — 낮음. 역전세 주의` });
    }
  }

  const maxScore = conditions.length * 2;
  const ratio = maxScore > 0 ? score / maxScore : 0.5;
  let signal, signalDesc;
  if (ratio >= 0.67) { signal = 'green';  signalDesc = '매수 검토 구간'; }
  else if (ratio >= 0.34) { signal = 'yellow'; signalDesc = '관망 권장'; }
  else { signal = 'red'; signalDesc = '리스크 주의'; }

  return { signal, signalDesc, score, maxScore, conditions };
}

// ── 실투자금 총비용 계산 ──────────────────────────────────
// price: 억 / loanAmount: 억
function calcTotalCost(price, loanAmount, houseStatus, isFirstBuyer) {
  const priceW = price * 10000; // 만원

  // 취득세율 (2025년 기준)
  let rate;
  if (houseStatus === '2주택+') {
    rate = 0.08; // 중과
  } else if (houseStatus === '1주택') {
    rate = price <= 6 ? 0.01 : price <= 9 ? 0.02 : 0.03;
  } else { // 무주택
    if (isFirstBuyer && price <= 1.5) rate = 0.008; // 생초 50% 감면
    else if (price <= 6) rate = 0.01;
    else if (price <= 9) rate = 0.02;
    else rate = 0.03;
  }

  const acqTax  = Math.round(priceW * rate);          // 취득세 (만원)
  const eduTax  = Math.round(acqTax * 0.1);           // 지방교육세 10%
  const spclTax = rate <= 0.01 ? 0 : Math.round(priceW * 0.002); // 농특세

  // 공인중개사 복비 (법정 상한)
  let commRate;
  if (price < 0.5) commRate = 0.006;
  else if (price < 2)  commRate = 0.005;
  else if (price < 9)  commRate = 0.004;
  else if (price < 12) commRate = 0.005;
  else if (price < 15) commRate = 0.006;
  else commRate = 0.007;
  const commission = Math.round(priceW * commRate); // 만원

  // 등기비 추정 (법무사 수수료 + 등록면허세 등)
  const regFee = Math.round(priceW * 0.0015 + 20); // ~0.15% + 20만원 기본

  const loan = loanAmount || 0;
  const gap = Math.max(0, price - loan);             // 갭 (억)
  const gapW = Math.round(gap * 10000);              // 만원
  const totalW = gapW + acqTax + eduTax + spclTax + commission + regFee;

  return {
    gap:        parseFloat(gap.toFixed(2)),
    acqTax:     parseFloat((acqTax / 10000).toFixed(2)),    // 억
    eduTax:     parseFloat((eduTax / 10000).toFixed(2)),
    spclTax:    parseFloat((spclTax / 10000).toFixed(2)),
    commission: parseFloat((commission / 10000).toFixed(2)),
    regFee:     parseFloat((regFee / 10000).toFixed(2)),
    total:      parseFloat((totalW / 10000).toFixed(2)),    // 억
    taxRate:    Math.round(rate * 1000) / 10,               // %
  };
}

// ── 월별 거래량 집계 ──────────────────────────────────────
function buildMonthlyVolume(transactions, monthCount = 6) {
  const vol = {};
  transactions.forEach(t => {
    const key = `${t.dealYear}-${String(t.dealMonth).padStart(2, '0')}`;
    vol[key] = (vol[key] || 0) + 1;
  });
  return Object.entries(vol)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-monthCount)
    .map(([month, count]) => ({ month, count }));
}

// ── 단지 종합 분석 (메인) ─────────────────────────────────
async function analyzeApt(lawdCd, aptName, currentPrice) {
  if (!lawdCd) lawdCd = '11350'; // fallback

  const cacheKey = `analysis:${lawdCd}:${aptName}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  let saleTx = [], jeonseT = [], molitAvailable = true;
  try {
    [saleTx, jeonseT] = await Promise.all([
      getTransactionsByApt(lawdCd, aptName),
      getJeonseByApt(lawdCd, aptName).catch(() => []),
    ]);
  } catch (err) {
    if (err.code === 'MOLIT_KEY_MISSING') {
      molitAvailable = false;
    } else {
      throw err;
    }
  }

  // 가격 단위: currentPrice=억 → 만원 변환
  const priceW = (currentPrice || 0) * 10000;
  const percentile = saleTx.length >= 3 ? calcPricePercentile(saleTx, priceW) : null;
  const volumeSignal = calcVolumeSignal(saleTx);
  const gapData = calcGap(saleTx, jeonseT);
  const buySignal = calcBuySignal(percentile, volumeSignal, gapData.jeonseRate);
  const monthlyVolume = buildMonthlyVolume(saleTx);

  const result = {
    aptName,
    lawdCd,
    currentPrice,
    molitAvailable,
    percentile,
    volumeSignal,
    gapData,
    buySignal,
    monthlyVolume,
    txCount: saleTx.length,
    jeonseCount: jeonseT.length,
    recentJeonseTx: jeonseT.slice(0, 5),
  };

  if (molitAvailable) cache.set(cacheKey, result, 3600);
  return { ...result, fromCache: false };
}

module.exports = { analyzeApt, calcTotalCost, getLawdCdFromArea };
