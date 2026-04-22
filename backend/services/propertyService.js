/**
 * 매물 검색 서비스 (안정화판 — AI 의존 제거)
 *
 * 변경 이력:
 * - AI 호출 제거 → 응답 속도 25s → ~5s, 매번 안정 작동
 * - 평형별 시세 분리 → 사용자 예산에 맞는 평형만 정확히 노출
 * - LTV/maxLoan 백엔드 단순 계산으로 채워줌 (프론트 표시 일관성)
 * - "현재 시세" = 평형별 최근 5건 거래 노출 → 호가 없이도 시세 파악 가능
 *
 * 데이터 소스: 국토교통부 실거래가 (data.go.kr 공공 API, 무료, 신뢰성 검증됨)
 * 네이버/KB 부동산 호가는 공식 API 부재 + 스크래핑 ToS 위반으로 미사용.
 * 대신 최신 실거래가가 가장 객관적인 시세 지표로 동등하게 기능함.
 */
const { getTransactionsByApt, analyzeTransactions } = require('./transactionService');
const { getAptListBySgg, getAptBasisInfo } = require('./aptInfoService');
const cache = require('../cache');

// ── 지역 키워드 → 법정동코드 매핑 (사용자 입력 우선) ───────
const REGION_KEYWORDS = {
  // 서울 25개 구 별칭
  '강남': ['11680'], '강동': ['11740'], '강북': ['11305'], '강서': ['11500'],
  '관악': ['11620'], '광진': ['11215'], '구로': ['11530'], '금천': ['11545'],
  '노원': ['11350'], '도봉': ['11320'], '동대문': ['11230'], '동작': ['11590'],
  '마포': ['11440'], '서대문': ['11410'], '서초': ['11650'], '성동': ['11200'],
  '성북': ['11290'], '송파': ['11710'], '양천': ['11470'], '영등포': ['11560'],
  '용산': ['11170'], '은평': ['11380'], '종로': ['11110'], '중구': ['11140'],
  '중랑': ['11260'],
  // 경기 인기 지역
  '과천': ['41290'], '광명': ['41210'], '분당': ['41135'], '판교': ['41135'],
  '평촌': ['41173'], '안양': ['41173'], '수지': ['41465'], '용인': ['41465'],
  '하남': ['41450'], '미사': ['41450'], '영통': ['41117'], '수원': ['41117'],
  '일산': ['41281'], '고양': ['41281'], '의왕': ['41430'], '시흥': ['41390'],
  // 인천 8개구
  '미추홀': ['28177'], '연수': ['28185'], '남동': ['28200'], '부평': ['28237'],
  '계양': ['28245'], '송도': ['28185'],
  // 광역 (구 미지정 시 키워드)
  '서울': ['11680','11650','11710','11440','11200'],
  '인천': ['28185','28200','28237','28245'],
  '경기': ['41210','41290','41135','41281'],
};

function pickRegions(userRegion = '', maxBudget = 0, workplaceArea = '') {
  const r = (userRegion || '').replace(/\s+/g,'');
  const wp = (workplaceArea || '').replace(/\s+/g,'');
  const combined = r + ' ' + wp;
  // 1) 사용자 입력에서 구 단위 키워드 매칭 (광역 키워드는 후순위)
  const SKIP_GLOBAL = new Set(['서울','경기','인천']);
  for (const [kw, codes] of Object.entries(REGION_KEYWORDS)) {
    if (!SKIP_GLOBAL.has(kw) && combined.includes(kw)) {
      return codes.map(c => ({ lawdCd: c, name: kw }));
    }
  }
  // 2) 광역만 입력 시 예산 기반 자동 추천 (서울 인기 구)
  if (!r || r.includes('서울')) {
    if (maxBudget <= 6) return [
      { lawdCd: '11350', name: '노원구' },
      { lawdCd: '11320', name: '도봉구' },
      { lawdCd: '11305', name: '강북구' },
    ];
    if (maxBudget <= 9) return [
      { lawdCd: '11530', name: '구로구' },
      { lawdCd: '11545', name: '금천구' },
      { lawdCd: '11380', name: '은평구' },
    ];
    if (maxBudget <= 14) return [
      { lawdCd: '11290', name: '성북구' },
      { lawdCd: '11470', name: '양천구' },
      { lawdCd: '11440', name: '마포구' },
    ];
    return [
      { lawdCd: '11650', name: '서초구' },
      { lawdCd: '11680', name: '강남구' },
      { lawdCd: '11710', name: '송파구' },
    ];
  }
  // 3) 광역 매칭 (인천/경기)
  for (const wide of ['인천', '경기']) {
    if (r.includes(wide)) return REGION_KEYWORDS[wide].map(c => ({ lawdCd: c, name: wide }));
  }
  // 4) 기본 (수도권 인기 지역)
  return [
    { lawdCd: '41210', name: '광명시' },
    { lawdCd: '41290', name: '과천시' },
    { lawdCd: '41135', name: '성남시 분당구' },
  ];
}

// ── LTV/대출한도 단순 계산 (프론트 calcLTV와 일치) ─────────
function computeLTV(buyAuk, region, isFirstBuyer, houseStatus) {
  const isRegulated = /서울|강남|서초|송파|용산|분당|과천/.test(region || '');
  if (houseStatus === '2주택+') return { ltv: '0% (규제)', maxLoan: '0억' };
  if (houseStatus === '1주택' && isRegulated) return { ltv: '0% (1주택 규제지역)', maxLoan: '처분조건부 6개월' };
  let pct;
  if (isRegulated) pct = isFirstBuyer ? 0.7 : 0.4;
  else pct = isFirstBuyer ? 0.8 : 0.7;
  const cap = isRegulated ? (buyAuk <= 15 ? 6 : buyAuk <= 25 ? 4 : 2) : Infinity;
  const loan = Math.min(buyAuk * pct, cap);
  return {
    ltv: `${(pct * 100).toFixed(0)}% ${isRegulated ? '(규제)' : '(비규제)'}`,
    maxLoan: `${loan.toFixed(2)}억`,
  };
}

// ── 단지 태그 자동 산출 (객관적 사실만) ───────────────────
function buildTags(apt) {
  const tags = [];
  const totalDeals = apt.dealCount || 0;
  if (totalDeals >= 50) tags.push('거래활발');
  else if (totalDeals >= 20) tags.push('거래보통');
  if (apt.buildYear >= 2015) tags.push('신축급');
  else if (apt.buildYear >= 2000) tags.push('준신축');
  else if (apt.buildYear < 1995) tags.push('재건축연한');
  const pyeongCount = (apt.pyeongStats || []).length;
  if (pyeongCount >= 4) tags.push('다양평형');
  return tags;
}

/**
 * 사용자 조건 기반 매물 추천
 */
async function getAIRecommendations(userCondition) {
  const {
    maxBudget,
    region,
    houseStatus,
    isFirstBuyer,
    workplaceArea,
    minArea, // 평 단위 (예: 18)
    maxArea, // 평 단위 (예: 35)
  } = userCondition;

  // 기본 최소 15평 (오피스텔·초소형 제외)
  const minPy = parseInt(minArea) || 15;
  const maxPy = parseInt(maxArea) || 60;

  const cacheKey = `rec:v5:${region}:${maxBudget}:${houseStatus}:${isFirstBuyer}:${workplaceArea}:${minPy}:${maxPy}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // Step 1: 키워드 기반 빠른 지역 결정
  const targetRegions = pickRegions(region, maxBudget, workplaceArea).slice(0, 3);

  // Step 2: 병렬 조회 — (a) 시군구 전체 단지 목록 + (b) 실거래 내역
  const [aptListArrays, txArrays] = await Promise.all([
    Promise.allSettled(
      targetRegions.map(r => getAptListBySgg(r.lawdCd))
    ).then(results => results.map(r => r.status === 'fulfilled' ? r.value : [])),
    Promise.allSettled(
      targetRegions.map(r => getTransactionsByApt(r.lawdCd, ''))
    ).then(results => results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      console.error(`[PropertyService] ${targetRegions[i].name} 조회 실패:`, r.reason?.message);
      return [];
    })),
  ]);
  const allAptList = aptListArrays.flat();
  const allTx = txArrays.flat();
  const analyzed = analyzeTransactions(allTx);
  console.log(`[PropertyService] 전체 단지: ${allAptList.length}개, 실거래 있는 단지: ${analyzed.length}개`);

  if (!analyzed || !analyzed.length) {
    return {
      recommendations: getStaticFallback(maxBudget, region),
      targetRegions,
      totalTxAnalyzed: 0,
      inBudgetCount: 0,
      disclaimer: '본 결과는 국토교통부 실거래가 데이터 기반 정보 정리이며, 매수·매도 추천이 아닙니다.',
      fromCache: false,
    };
  }

  // Step 3: 평형별 예산 매칭 — 단지 안에서 사용자 예산에 맞는 평형 1개 이상 있어야 통과
  const budgetMaxMan = maxBudget * 10000 * 1.05; // 5% 여유
  const budgetMinMan = maxBudget * 10000 * 0.5;  // 50% 미만은 너무 작은 평형
  const matched = [];
  for (const apt of analyzed) {
    const fitPyeongs = (apt.pyeongStats || []).filter(p =>
      p.pyeong >= minPy && p.pyeong <= maxPy &&
      p.minPrice <= budgetMaxMan && p.maxPrice >= budgetMinMan
    );
    if (fitPyeongs.length === 0) continue;
    // 사용자 예산 가장 잘 맞는 평형
    const primaryPyeong = fitPyeongs.reduce((best, p) => {
      const diff = Math.abs(p.avgPrice - maxBudget * 10000);
      const bestDiff = Math.abs(best.avgPrice - maxBudget * 10000);
      return diff < bestDiff ? p : best;
    }, fitPyeongs[0]);
    matched.push({ ...apt, fitPyeongs, primaryPyeong });
  }

  // Step 3b: 거래 없는 단지 추가 — K-apt 전체 단지 리스트 중 matched에 없는 항목
  // 주변 단지 시세로 예상가 추정해 "참고 매물"로 노출 (매물 다양성↑)
  const matchedNames = new Set(matched.map(m => m.aptName.replace(/\s/g, '')));
  const dongAvgMan = {}; // umdNm → avgPriceMan (같은 동 실거래 평균)
  for (const apt of matched) {
    const dong = apt.umdNm;
    if (!dong) continue;
    if (!dongAvgMan[dong]) dongAvgMan[dong] = { sum: 0, cnt: 0 };
    dongAvgMan[dong].sum += apt.primaryPyeong.avgPrice;
    dongAvgMan[dong].cnt += 1;
  }
  const dongAvg = Object.fromEntries(
    Object.entries(dongAvgMan).map(([k, v]) => [k, Math.round(v.sum / v.cnt)])
  );
  const noTxApts = [];
  for (const a of allAptList) {
    const nm = (a.kaptName || a.aptName || '').trim();
    if (!nm) continue;
    const nmKey = nm.replace(/\s/g, '');
    if (matchedNames.has(nmKey)) continue;
    // 동명 추정 (as4 또는 as3가 umdNm)
    const dong = a.as4 || a.as3 || '';
    const est = dongAvg[dong] || 0;
    // 예산 맞는 추정가가 있을 때만 포함 (너무 벗어나면 스팸)
    if (!est) continue;
    if (est < budgetMinMan || est > budgetMaxMan) continue;
    noTxApts.push({ ...a, _estPriceMan: est, _dong: dong, _noTx: true });
  }

  if (!matched.length && !noTxApts.length) {
    return {
      recommendations: getStaticFallback(maxBudget, region),
      targetRegions,
      totalTxAnalyzed: analyzed.length,
      inBudgetCount: 0,
      totalAptsInRegion: allAptList.length,
      disclaimer: '본 결과는 국토교통부 실거래가 데이터 기반 정보 정리이며, 매수·매도 추천이 아닙니다.',
      fromCache: false,
    };
  }

  // Step 4: 거래량 가중 정렬 → 실거래 단지 우선 상위 15건
  const ranked = matched
    .map(a => ({ ...a, _score: a.dealCount * 10 + (a.buildYear || 1990) * 0.01 }))
    .sort((x, y) => y._score - x._score)
    .slice(0, 15);

  // Step 5: 결과 카드 생성 (AI 호출 없음, 즉시 응답)
  const recommendations = ranked.map((apt, i) => {
    const p = apt.primaryPyeong;
    const avgAuk = parseFloat((p.avgPrice / 10000).toFixed(2));
    const minAuk = parseFloat((p.minPrice / 10000).toFixed(2));
    const maxAuk = parseFloat((p.maxPrice / 10000).toFixed(2));
    const ltvInfo = computeLTV(avgAuk, region || '서울', isFirstBuyer, houseStatus);
    const tags = buildTags(apt);
    const ageYears = new Date().getFullYear() - (apt.buildYear || 0);

    return {
      rank: i + 1,
      aptName: apt.aptName,
      aptSeq: apt.aptSeq,
      lawdCd: apt.lawdCd,
      area: `${apt.sigungu || ''} ${apt.umdNm || ''}`.trim(),
      avgPrice: avgAuk,
      minPrice: minAuk,
      maxPrice: maxAuk,
      buildYear: apt.buildYear,
      pyeong: `${p.pyeong}평 (전용 ${p.excluUseAr}㎡)`,
      score: Math.min(95, 50 + Math.min(apt.dealCount, 30) * 1.5),
      ltv: ltvInfo.ltv,
      maxLoan: ltvInfo.maxLoan,
      pros: `${p.pyeong}평형 6개월 ${p.dealCount}건 거래 · 평균 ${avgAuk}억 · ${apt.buildYear||'?'}년식`,
      cons: ageYears >= 30 ? `구축(${ageYears}년) — 재건축연한 도래`
            : ageYears >= 20 ? `준구축(${ageYears}년) — 인테리어 점검 필요`
            : `현장 임장으로 동·층·향 확인 필수`,
      strategy: `① 최근 거래 ${p.recentTx.length}건 동·층·향 비교 ② 대출 사전심사 ③ 같은 평형 매물 호가 비교 (네이버부동산/직방)`,
      tags: tags.length ? tags : ['실거래확인'],
      risk: '시세 변동·금리 인상 리스크는 본인 부담 / 미래 가격 예측 불가',
      recommend: false,
      // 평형별 최근 시세 (사용자가 "지금 가격" 파악)
      currentPriceByPyeong: apt.fitPyeongs.map(fp => ({
        pyeong: fp.pyeong,
        excluUseAr: fp.excluUseAr,
        recentAvg: parseFloat((fp.avgPrice / 10000).toFixed(2)),
        range: `${(fp.minPrice / 10000).toFixed(1)}~${(fp.maxPrice / 10000).toFixed(1)}억`,
        dealCount: fp.dealCount,
        latestDeal: fp.recentTx[0] ? `${fp.recentTx[0].date.slice(2)} ${fp.recentTx[0].floor}층 ${(fp.recentTx[0].price / 10000).toFixed(2)}억` : '-',
      })),
      txHistory: apt.rawList || [],
      dealCount6m: apt.dealCount,
      recentDeal: apt.recentDeal,
    };
  });

  // Step 5a: 단지 기본정보 bulk 조회 — 세대수·주차비율·연식·관리방식
  // K-apt AptBasisInfoServiceV3 (이미 캐시됨, 30일) — 첫 호출만 ~3초, 이후 즉시
  const enriched = await Promise.allSettled(
    recommendations.map(async (rec, i) => {
      const seq = ranked[i].aptSeq;
      if (!seq) return rec;
      const info = await getAptBasisInfo(seq);
      if (!info) return rec;
      const totalHouseholds = parseInt(info.kaptdaCnt) || 0;
      const parkingTotal = parseInt(info.kaptdPcnt) || 0;
      const parkingRatio = totalHouseholds > 0 && parkingTotal > 0
        ? parseFloat((parkingTotal / totalHouseholds).toFixed(2)) : null;
      // 추가 태그
      const moreTags = [...(rec.tags || [])];
      if (parkingRatio && parkingRatio >= 1.2) moreTags.push('주차여유');
      if (totalHouseholds >= 1000) moreTags.push('대단지');
      else if (totalHouseholds >= 500) moreTags.push('중대단지');
      return {
        ...rec,
        facility: {
          aptSeq: seq,
          totalHouseholds,
          dongCount: parseInt(info.kaptDongCnt) || 0,
          parkingTotal,
          parkingRatio, // 세대당 주차대수
          builtDate: info.kaptUsedate || null,
          heatType: info.codeHeatNm || null,
          mgrType: info.codeMgrNm || null,
          address: info.doroJuso || info.codeAptNm || null,
          floorAreaRatio: info.kaptTarea || null,
        },
        tags: Array.from(new Set(moreTags)),
      };
    })
  ).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean));

  // 응답에는 enriched 사용 (실패한 것은 원본 rec 유지됨)
  const enrichedRecs = enriched.length === recommendations.length ? enriched : recommendations;

  // Step 5b: 거래 없는 참고 단지 추가 (예산 범위 & 같은 동 평균가 있는 것만)
  const extraRefs = noTxApts.slice(0, 15).map((a, i) => {
    const nm = (a.kaptName || a.aptName || '').trim();
    const estAuk = parseFloat((a._estPriceMan / 10000).toFixed(2));
    const ltvInfo = computeLTV(estAuk, region || '서울', isFirstBuyer, houseStatus);
    return {
      rank: recommendations.length + i + 1,
      aptName: nm,
      area: `${a.as2 || ''} ${a._dong || ''}`.trim(),
      avgPrice: estAuk,
      minPrice: estAuk,
      maxPrice: estAuk,
      buildYear: null,
      pyeong: '평형 정보 없음 (참고가)',
      score: 40, // 추정값이므로 점수 낮게
      ltv: ltvInfo.ltv,
      maxLoan: ltvInfo.maxLoan,
      pros: `${a._dong} 인근 단지 평균가 기준 추정 · 최근 6개월 실거래는 없음`,
      cons: '최근 거래 데이터 부족 — 호가/시세는 별도 확인 필요',
      strategy: '① 네이버부동산·KB시세에서 현재 호가 교차검증 ② 동·평형별 정확한 시세는 중개사 문의 ③ 최근 거래 없는 단지는 매도호가 ≠ 실매매가 격차 클 수 있음',
      tags: ['참고매물', '추정가'],
      risk: '최근 실거래 부재로 추정값 신뢰도 낮음. 반드시 현장·호가 확인.',
      recommend: false,
      aptSeq: a.kaptCode,
      currentPriceByPyeong: [],
      txHistory: [],
      dealCount6m: 0,
      recentDeal: '최근 6개월 거래 없음',
      isReference: true, // 프론트에서 구분 표시 가능
    };
  });

  const finalRecs = [...enrichedRecs, ...extraRefs];

  const result = {
    recommendations: finalRecs,
    targetRegions,
    totalTxAnalyzed: analyzed.length,
    totalAptsInRegion: allAptList.length,
    inBudgetCount: matched.length,
    referenceCount: extraRefs.length,
    disclaimer: '본 결과는 국토교통부 실거래가 데이터 기반 정보 정리이며, 매수·매도 추천이 아닙니다. 모든 의사결정의 책임은 본인에게 있습니다.',
  };
  cache.set(cacheKey, result, 1800);
  return { ...result, fromCache: false };
}

// ── 정적 폴백 (API 완전 실패 시) ─────────────────────────
function getStaticFallback(budget, region) {
  return [{
    rank: 1,
    aptName: '데이터 일시 조회 실패',
    area: `${region || '서울'} 지역에서 예산 ${budget}억 범위 거래 미발견`,
    avgPrice: budget,
    score: 0,
    pros: '국토부 실거래가 API 응답 없음 또는 해당 조건 거래 부재',
    cons: '예산을 ±20% 조정하거나 지역을 변경해 재시도',
    strategy: '잠시 후 다시 시도하거나 지역/예산 조건을 변경하세요. 공공 API는 트래픽이 몰릴 때 일시 지연될 수 있습니다.',
    tags: ['재시도필요'],
    risk: '데이터 조회 실패',
    recommend: false,
    txHistory: [],
    currentPriceByPyeong: [],
  }];
}

module.exports = { getAIRecommendations, pickRegions };
