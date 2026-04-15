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

// ── 데이터 신뢰도 등급 ────────────────────────────────────
// NONE: 신호 불가 / LOW: 신호 숨기고 범위만 / MED: 경고 포함 / HIGH: 풀 표시
function getDataReliability(saleTxCount, jeonseTxCount) {
  if (saleTxCount < 4)  return 'NONE';
  if (saleTxCount < 10) return 'LOW';
  if (saleTxCount < 30) return 'MED';
  return 'HIGH';
}

// ── 이상 거래 필터 (±30% 초과 제거) ─────────────────────
function filterAnomalies(transactions) {
  if (!transactions || transactions.length < 3) return { filtered: transactions || [], anomalyCount: 0 };
  const prices = transactions.map(t => t.dealAmount).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const lower = median * 0.7;
  const upper = median * 1.3;
  const filtered = transactions.filter(t => t.dealAmount >= lower && t.dealAmount <= upper);
  return { filtered, anomalyCount: transactions.length - filtered.length };
}

// ── 가격 위치 백분위 ──────────────────────────────────────
// transactions: dealAmount 만원 단위 배열
// currentPrice: 만원 단위
function calcPricePercentile(transactions, currentPrice) {
  if (!transactions || transactions.length < 10) return null;
  const { filtered } = filterAnomalies(transactions);
  if (filtered.length < 10) return null;
  const prices = filtered.map(t => t.dealAmount).sort((a, b) => a - b);
  const below = prices.filter(p => p <= currentPrice).length;
  return Math.round((below / prices.length) * 100);
}

// ── 계절 성수기 여부 감지 ─────────────────────────────────
// 이사 성수기(3·4·9·10월) 포함 시 거래량 추이에 편향 가능
function detectSeasonalBias(transactions) {
  const peakMonths = [3, 4, 9, 10];
  const now = new Date();
  // 최근 3개월 구간에 성수기 월이 있는지 확인
  const recentMonths = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    recentMonths.push(d.getMonth() + 1);
  }
  const hasPeak = recentMonths.some(m => peakMonths.includes(m));
  const prevMonths = [];
  for (let i = 3; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    prevMonths.push(d.getMonth() + 1);
  }
  const prevHasPeak = prevMonths.some(m => peakMonths.includes(m));
  // 한쪽만 성수기면 편향 가능
  return hasPeak !== prevHasPeak;
}

// ── 거래량 추이 신호 ──────────────────────────────────────
// 최근 3개월 vs 이전 3개월 비교
function calcVolumeSignal(transactions) {
  if (!transactions || transactions.length < 2) return { signal: 'neutral', seasonalBias: false };
  const now = new Date();
  const seasonalBias = detectSeasonalBias(transactions);

  function monthsAgo(t) {
    const d = new Date(t.dealYear, t.dealMonth - 1);
    return (now - d) / (1000 * 60 * 60 * 24 * 30);
  }

  const recent = transactions.filter(t => monthsAgo(t) <= 3).length;
  const prev = transactions.filter(t => {
    const m = monthsAgo(t);
    return m > 3 && m <= 6;
  }).length;

  let signal;
  if (prev === 0) signal = recent > 0 ? 'up' : 'neutral';
  else {
    const ratio = recent / prev;
    signal = ratio >= 1.2 ? 'up' : ratio <= 0.7 ? 'down' : 'neutral';
  }
  return { signal, seasonalBias };
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

// ── 3개 지표 종합 신호 ────────────────────────────────────
// volumeSignalObj: { signal, seasonalBias }
function calcBuySignal(percentile, volumeSignalObj, jeonseRate) {
  let score = 0;
  const conditions = [];
  const vs = typeof volumeSignalObj === 'object' ? volumeSignalObj : { signal: volumeSignalObj, seasonalBias: false };
  const { signal: volSignal, seasonalBias } = vs;

  // ① 가격 위치 백분위
  if (percentile !== null) {
    if (percentile <= 30) {
      score += 2;
      conditions.push({ label: '가격 위치', status: 'green', desc: `최근 1년 하위 ${percentile}% — 시세 하단 구간` });
    } else if (percentile <= 65) {
      score += 1;
      conditions.push({ label: '가격 위치', status: 'yellow', desc: `최근 1년 ${percentile}% 구간 — 시세 수준` });
    } else {
      conditions.push({ label: '가격 위치', status: 'red', desc: `최근 1년 상위 ${100 - percentile}% — 시세 상단 구간` });
    }
  }

  // ② 거래량 추이
  const volMap = {
    up:      { score: 2, status: 'green',  desc: '최근 3개월 거래 증가' },
    neutral: { score: 1, status: 'yellow', desc: '거래량 변화 없음 — 관망세' },
    down:    { score: 0, status: 'red',    desc: '거래량 감소' },
  };
  const vol = volMap[volSignal] || volMap.neutral;
  score += vol.score;
  const volDesc = seasonalBias ? vol.desc + ' ⚠️ 이사 성수기 영향 가능' : vol.desc;
  conditions.push({ label: '거래량 추이', status: vol.status, desc: volDesc, seasonalBias });

  // ③ 전세가율
  if (jeonseRate !== null) {
    if (jeonseRate >= 60) {
      score += 2;
      conditions.push({ label: '전세가율', status: 'green', desc: `${jeonseRate}% — 실수요 비중 높음` });
    } else if (jeonseRate >= 45) {
      score += 1;
      conditions.push({ label: '전세가율', status: 'yellow', desc: `${jeonseRate}% — 보통 수준` });
    } else {
      conditions.push({ label: '전세가율', status: 'red', desc: `${jeonseRate}% — 낮음. 역전세 위험 확인 필요` });
    }
  }

  const maxScore = conditions.length * 2;
  const ratio = maxScore > 0 ? score / maxScore : 0.5;
  const metCount = conditions.filter(c => c.status === 'green').length;
  const totalCount = conditions.length;

  // 법적 리스크 줄인 중립 문구 — 투자 권유 표현 제거
  let signal, signalDesc;
  if (ratio >= 0.67) { signal = 'green';  signalDesc = `${totalCount}개 조건 중 ${metCount}개 긍정`; }
  else if (ratio >= 0.34) { signal = 'yellow'; signalDesc = `${totalCount}개 조건 중 ${metCount}개 긍정`; }
  else { signal = 'red'; signalDesc = `${totalCount}개 조건 중 ${metCount}개 긍정`; }

  return { signal, signalDesc, score, maxScore, conditions, metCount, totalCount };
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

  // 신뢰도 등급
  const reliability = getDataReliability(saleTx.length, jeonseT.length);

  // 가격 단위: currentPrice=억 → 만원 변환
  const priceW = (currentPrice || 0) * 10000;

  // 이상거래 필터 (±30%)
  const { filtered: filteredTx, anomalyCount } = filterAnomalies(saleTx);

  // 신뢰도가 NONE이면 백분위·신호 계산 불가
  const percentile = reliability !== 'NONE' ? calcPricePercentile(filteredTx, priceW) : null;
  const volumeSignalObj = calcVolumeSignal(saleTx);
  const gapData = calcGap(saleTx, jeonseT);

  // LOW 이상일 때만 신호 계산 (NONE은 null)
  const buySignal = reliability !== 'NONE'
    ? calcBuySignal(percentile, volumeSignalObj, gapData.jeonseRate)
    : null;

  const monthlyVolume = buildMonthlyVolume(saleTx);

  const result = {
    aptName,
    lawdCd,
    currentPrice,
    molitAvailable,
    reliability,
    anomalyCount,
    percentile,
    volumeSignal: volumeSignalObj.signal,
    volumeSeasonalBias: volumeSignalObj.seasonalBias,
    gapData,
    buySignal,
    monthlyVolume,
    txCount: saleTx.length,
    filteredTxCount: filteredTx.length,
    jeonseCount: jeonseT.length,
    recentJeonseTx: jeonseT.slice(0, 5),
  };

  if (molitAvailable) cache.set(cacheKey, result, 3600);
  return { ...result, fromCache: false };
}

module.exports = { analyzeApt, calcTotalCost, getLawdCdFromArea };
