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
// 2026-04-25 P1 (감사 보고서 1-2): 임의 4/10/30 임계값 → Wilson 95% CI 근사 기반
//   - HIGH (n>=60): ±5% 폭 보장
//   - MED  (n>=25): ±10% 폭
//   - LOW  (n>=8):  ±20% 폭 (신호 숨김)
//   - NONE (n<8):   통계적 의미 없음
// jeonseTxCount 도 검사 — 매매만 충분해도 전세 표본 부족 시 jeonseRate 무의미.
function getDataReliability(saleTxCount, jeonseTxCount) {
  if (saleTxCount < 8)  return 'NONE';
  if (saleTxCount < 25) return 'LOW';
  if (saleTxCount < 60) return 'MED';
  return 'HIGH';
}
// 전세 표본 별도 등급 — calcGap 신뢰성 판정용
function getJeonseReliability(jeonseTxCount) {
  if (!jeonseTxCount || jeonseTxCount < 4)  return 'NONE';
  if (jeonseTxCount < 12) return 'LOW';
  if (jeonseTxCount < 30) return 'MED';
  return 'HIGH';
}

// ── 이상 거래 필터 ────────────────────────────────────────
// P1 (2026-04-25): MAD 기반 + 평형(전용면적) 그룹화로 정확도 ↑
//   - 기존: 전체 거래 median ±30% 고정. 소형/대형 평형 섞이면 정상 거래도 필터.
//   - 개선:
//     1) 평형(3.3㎡ 단위)별 그룹화 → 같은 평형끼리만 비교
//     2) MAD (median absolute deviation) 기반 — 분포 폭 적응형
//     3) 표본 작으면 (5건 미만) 기존 ±30% fallback (MAD 신뢰 어려움)
//   - 효과: 강남 단지 84㎡ + 39㎡ 혼재 시 39㎡가 outlier 로 잘못 제거되던 문제 해결.
//          시세 ±5천만원 오판 가능성 차단 (감사 보고서 2-2).
function filterAnomalies(transactions) {
  if (!transactions || transactions.length < 3) {
    return { filtered: transactions || [], anomalyCount: 0 };
  }

  // 평형별 그룹화 (3.3㎡ = 1평 기준 반올림)
  const groups = {};
  for (const t of transactions) {
    const py = Math.round((t.excluUseAr || 0) / 3.3);
    if (!groups[py]) groups[py] = [];
    groups[py].push(t);
  }

  const allFiltered = [];
  for (const py of Object.keys(groups)) {
    const group = groups[py];
    if (group.length < 3) {
      // 표본 너무 작음 — 필터 적용 시 더 왜곡, 그대로 통과
      allFiltered.push(...group);
      continue;
    }
    const prices = group.map(t => t.dealAmount).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    // MAD 계산
    const deviations = prices.map(p => Math.abs(p - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)];

    // MAD=0 (모두 동일가) 또는 표본 5건 미만 → 기존 ±30% fallback
    if (mad === 0 || group.length < 5) {
      const lower = median * 0.7;
      const upper = median * 1.3;
      allFiltered.push(...group.filter(t => t.dealAmount >= lower && t.dealAmount <= upper));
    } else {
      // 표본 클수록 엄격(2.5×MAD), 작을수록 보수적(3.5×MAD)
      const k = group.length >= 20 ? 2.5 : 3.5;
      const threshold = mad * k;
      allFiltered.push(...group.filter(t => Math.abs(t.dealAmount - median) <= threshold));
    }
  }

  return { filtered: allFiltered, anomalyCount: transactions.length - allFiltered.length };
}

// ── 가격 위치 백분위 ──────────────────────────────────────
// P1 (2026-04-25): 표본 크기 기반 신뢰 구간 동시 반환 (감사 보고서 1-1, T3)
//   - 기존: 단일 % 반환 → "하위 28%" 정밀도 착시
//   - 개선: { value, low, high, n } — 표본별 ±5% (n≥30) / ±15% (10≤n<30)
//   - 호출 측: percentileObj.value 만 쓰면 기존 동작 유지
//   - 사용자 노출: low~high 범위로 "하위 13~43%" 식 표기 → 표본 부족 정직 노출
function calcPricePercentile(transactions, currentPrice) {
  // 2026-04-25 P1 (감사 1-2): 최소 8건 (Wilson 95% CI ±20%) 확보 시만 계산.
  if (!transactions || transactions.length < 8) return null;
  const { filtered } = filterAnomalies(transactions);
  if (filtered.length < 8) return null;
  const prices = filtered.map(t => t.dealAmount).sort((a, b) => a - b);
  const below = prices.filter(p => p <= currentPrice).length;
  const value = Math.round((below / prices.length) * 100);
  const n = filtered.length;
  // 표본 크기 → 신뢰 폭 (Wilson 95% CI 근사):
  //   n>=60: ±5%, n>=25: ±10%, n>=8: ±20%
  let margin;
  if (n >= 60)      margin = 5;
  else if (n >= 25) margin = 10;
  else              margin = 20;
  return {
    value,
    low: Math.max(0, value - margin),
    high: Math.min(100, value + margin),
    n,
  };
}

// ── 계절 성수기 여부 감지 ─────────────────────────────────
// 이사 성수기(3·4·9·10월) 포함 시 거래량 추이에 편향 가능
function detectSeasonalBias(anchor) {
  const peakMonths = [3, 4, 9, 10];
  // anchor 기준 최근 3개월 구간 vs 이전 3개월 구간의 성수기 포함 여부
  const recentMonths = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
    recentMonths.push(d.getMonth() + 1);
  }
  const hasPeak = recentMonths.some(m => peakMonths.includes(m));
  const prevMonths = [];
  for (let i = 3; i < 6; i++) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
    prevMonths.push(d.getMonth() + 1);
  }
  const prevHasPeak = prevMonths.some(m => peakMonths.includes(m));
  // 한쪽만 성수기면 편향 가능
  return hasPeak !== prevHasPeak;
}

// ── 거래량 추이 신호 ──────────────────────────────────────
// P1 (2026-04-25): MOLIT 시차 보정 — now() 대신 데이터 최신 deal_date 를 anchor.
//   - 이유: MOLIT 신고 의무 30일 + 반영 ~2주 → "now-3개월" 윈도우엔 최근 1개월이 비어
//     "4월 거래량 ↓" 같은 시차 착시. anchor 기준으로 비교 윈도우 자동 shift.
//   - anchor 60일 이상 옛날이면 dataStale=true → 신호 보류, 신뢰도 LOW 처리.
function calcVolumeSignal(transactions) {
  if (!transactions || transactions.length < 2) return { signal: 'neutral', seasonalBias: false };

  // 데이터 최신 거래일 = anchor
  let anchorMs = 0;
  for (const t of transactions) {
    const ms = new Date(t.dealYear, (t.dealMonth || 1) - 1, t.dealDay || 1).getTime();
    if (ms > anchorMs) anchorMs = ms;
  }
  const anchor = new Date(anchorMs);
  const daysSinceAnchor = Math.round((Date.now() - anchorMs) / (1000 * 60 * 60 * 24));

  // anchor 가 60일 이상 옛날 → 데이터 자체 stale, 신호 의미 없음
  if (daysSinceAnchor > 60) {
    return { signal: 'neutral', seasonalBias: false, dataStale: true,
             anchorDate: anchor.toISOString().slice(0, 10), daysSinceAnchor };
  }

  const seasonalBias = detectSeasonalBias(anchor);

  function monthsBeforeAnchor(t) {
    const d = new Date(t.dealYear, (t.dealMonth || 1) - 1, t.dealDay || 1);
    return (anchorMs - d.getTime()) / (1000 * 60 * 60 * 24 * 30);
  }

  const recent = transactions.filter(t => {
    const m = monthsBeforeAnchor(t);
    return m >= 0 && m <= 3;
  }).length;
  const prev = transactions.filter(t => {
    const m = monthsBeforeAnchor(t);
    return m > 3 && m <= 6;
  }).length;

  let signal;
  if (prev === 0) signal = recent > 0 ? 'up' : 'neutral';
  else {
    const ratio = recent / prev;
    signal = ratio >= 1.2 ? 'up' : ratio <= 0.7 ? 'down' : 'neutral';
  }
  return { signal, seasonalBias, dataStale: false,
           anchorDate: anchor.toISOString().slice(0, 10), daysSinceAnchor };
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
  // P1 (2026-04-25): seasonalBias=true 면 up 신호 자동 감쇄 (감사 보고서 1-3)
  //   - 이사철(3·4·9·10월) 거래량 ↑ 는 시장 추세가 아닌 계절 효과
  //   - 사용자가 봄·가을 매수 사이클 잘못 진입 방지
  const volMap = {
    up:      { score: 2, status: 'green',  desc: '최근 3개월 거래 증가' },
    neutral: { score: 1, status: 'yellow', desc: '거래량 변화 없음 — 관망세' },
    down:    { score: 0, status: 'red',    desc: '거래량 감소' },
  };
  const vol = volMap[volSignal] || volMap.neutral;
  let volScore = vol.score;
  let volStatus = vol.status;
  let volDesc = vol.desc;
  if (seasonalBias && volSignal === 'up') {
    // up → neutral 수준으로 감쇄. green → yellow.
    volScore = 1;
    volStatus = 'yellow';
    volDesc = '최근 3개월 거래 증가 (성수기 영향 감쇄)';
  } else if (seasonalBias) {
    volDesc += ' ⚠️ 이사 성수기 영향 가능';
  }
  score += volScore;
  conditions.push({ label: '거래량 추이', status: volStatus, desc: volDesc, seasonalBias });

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

  // ── P1 핫픽스 (2026-04-25): 가격 veto rule ─────────────────
  // 가격 상단(percentile>65)이면:
  //   1) green 신호여도 최대 yellow 로 강등 (vetoApplied=true)
  //   2) signal 등급과 무관하게 "시세 상단" 경고 desc 추가 — 사용자가 "왜 yellow 인지" 인지
  // 이유: "시세 상단 매수는 아무리 좋은 신호여도 비싸게 사는 것" — 사용자 출구 막힘.
  // disclaimer 만으로 방어되지 않는 confidence 트리거 차단 (감사 보고서 Top-4 리스크).
  const originalSignal = signal;
  let vetoApplied = false;
  if (percentile !== null && percentile > 65) {
    if (signal === 'green') {
      signal = 'yellow';
      vetoApplied = signal !== originalSignal;
    }
    // green/yellow 모두 사용자에게 시세 상단 경고 (red 는 이미 강한 경고이므로 중복 회피)
    if (signal !== 'red') {
      signalDesc += ' · ⚠ 시세 상단 — 매수 단가 주의';
    }
  }

  return { signal, signalDesc, score, maxScore, conditions, metCount, totalCount, vetoApplied };
}

// ── 실투자금 총비용 계산 ──────────────────────────────────
// P1 (2026-04-25): regulations_snapshot('acquisition_tax_2025') 단일 소스화.
//   - taxConfig 인자 (snapshot.data) 가 있으면 그 값 사용
//   - 없으면 기존 하드코딩 fallback (backwards-compat — frontend sync 호출 등)
// price: 억 / loanAmount: 억
function calcTotalCost(price, loanAmount, houseStatus, isFirstBuyer, taxConfig) {
  const priceW = price * 10000; // 만원

  // ── 취득세율 ──
  let rate;
  if (taxConfig?.acquisitionTax) {
    const at = taxConfig.acquisitionTax;
    if (houseStatus === '2주택+') {
      rate = at.twoHousePlus?.rate ?? 0.08;
    } else if (houseStatus === '1주택') {
      const tiers = at.oneHouse?.tiers || [];
      rate = pickTierRate(tiers, price, 0.03);
    } else { // 무주택
      const fb = at.noHouse?.firstBuyerDiscount;
      if (isFirstBuyer && fb && price <= fb.underAuk) {
        rate = fb.rate;
      } else {
        rate = pickTierRate(at.noHouse?.tiers || [], price, 0.03);
      }
    }
  } else {
    // ── 하드코딩 fallback ──
    if (houseStatus === '2주택+') rate = 0.08;
    else if (houseStatus === '1주택') rate = price <= 6 ? 0.01 : price <= 9 ? 0.02 : 0.03;
    else {
      if (isFirstBuyer && price <= 1.5) rate = 0.008;
      else if (price <= 6) rate = 0.01;
      else if (price <= 9) rate = 0.02;
      else rate = 0.03;
    }
  }

  const eduRate  = taxConfig?.eduTaxRate       ?? 0.1;
  const spclRate = taxConfig?.spclTaxRate      ?? 0.002;
  const spclThr  = taxConfig?.spclTaxThreshold ?? 0.01;

  const acqTax  = Math.round(priceW * rate);
  const eduTax  = Math.round(acqTax * eduRate);
  const spclTax = rate <= spclThr ? 0 : Math.round(priceW * spclRate);

  // ── 중개 수수료 ──
  let commRate;
  if (taxConfig?.commission) {
    commRate = pickTierRate(taxConfig.commission, price, 0.007);
  } else {
    if (price < 0.5) commRate = 0.006;
    else if (price < 2)  commRate = 0.005;
    else if (price < 9)  commRate = 0.004;
    else if (price < 12) commRate = 0.005;
    else if (price < 15) commRate = 0.006;
    else commRate = 0.007;
  }
  const commission = Math.round(priceW * commRate);

  // ── 등기비 ──
  const regRate  = taxConfig?.regFee?.rate       ?? 0.0015;
  const regBase  = taxConfig?.regFee?.baseManwon ?? 20;
  const regFee = Math.round(priceW * regRate + regBase);

  const loan = loanAmount || 0;
  const gap = Math.max(0, price - loan);
  const gapW = Math.round(gap * 10000);
  const totalW = gapW + acqTax + eduTax + spclTax + commission + regFee;

  // 추정 신뢰 폭 — disclaimer 와 일관 (±1,500만원)
  const marginW = 1500;

  return {
    gap:        parseFloat(gap.toFixed(2)),
    acqTax:     parseFloat((acqTax / 10000).toFixed(2)),
    eduTax:     parseFloat((eduTax / 10000).toFixed(2)),
    spclTax:    parseFloat((spclTax / 10000).toFixed(2)),
    commission: parseFloat((commission / 10000).toFixed(2)),
    regFee:     parseFloat((regFee / 10000).toFixed(2)),
    total:      parseFloat((totalW / 10000).toFixed(2)),
    totalLow:   parseFloat(((totalW - marginW) / 10000).toFixed(2)),
    totalHigh:  parseFloat(((totalW + marginW) / 10000).toFixed(2)),
    taxRate:    Math.round(rate * 1000) / 10,
    source:     taxConfig ? 'snapshot' : 'fallback',
  };
}

// 가격(억)이 들어맞는 첫 tier 의 rate 반환
function pickTierRate(tiers, priceAuk, fallbackRate) {
  for (const t of tiers || []) {
    if (priceAuk < (t.underAuk ?? 0)) return t.rate ?? fallbackRate;
  }
  return fallbackRate;
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

  // 신뢰도 등급 (매매 + 전세 별도)
  const reliability = getDataReliability(saleTx.length, jeonseT.length);
  const jeonseReliability = getJeonseReliability(jeonseT.length);

  // 가격 단위: currentPrice=억 → 만원 변환
  const priceW = (currentPrice || 0) * 10000;

  // 이상거래 필터 (±30%)
  const { filtered: filteredTx, anomalyCount } = filterAnomalies(saleTx);

  // 신뢰도가 NONE이면 백분위·신호 계산 불가
  const percentileObj = reliability !== 'NONE' ? calcPricePercentile(filteredTx, priceW) : null;
  const percentile = percentileObj?.value ?? null;
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
    jeonseReliability,
    anomalyCount,
    percentile,
    // P1 (2026-04-25): 표본 기반 신뢰 구간 — 프론트가 "하위 13~43% 범위" 표기
    percentileLow:  percentileObj?.low  ?? null,
    percentileHigh: percentileObj?.high ?? null,
    percentileN:    percentileObj?.n    ?? null,
    volumeSignal: volumeSignalObj.signal,
    volumeSeasonalBias: volumeSignalObj.seasonalBias,
    // P1 (2026-04-25): MOLIT 시차 보정 결과 노출 — 프론트가 "최근 거래일 N일 전" 표시
    volumeAnchorDate: volumeSignalObj.anchorDate || null,
    volumeDaysSinceAnchor: volumeSignalObj.daysSinceAnchor != null ? volumeSignalObj.daysSinceAnchor : null,
    volumeDataStale: !!volumeSignalObj.dataStale,
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

module.exports = {
  analyzeApt, calcTotalCost, getLawdCdFromArea,
  // 테스트·디버그 용 — 외부 호출 금지
  _internals: { calcBuySignal, calcVolumeSignal, calcPricePercentile, filterAnomalies, detectSeasonalBias, getDataReliability, calcGap },
};
