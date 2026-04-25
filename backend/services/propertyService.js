/**
 * 단지 검색 서비스 (안정화판 — AI 의존 제거)
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
const { resolveCoordBatch } = require('./geocodeCacheService');
const { isRegulatedRegion, getRegulatedKeywords, SEOUL_GU_KEYWORDS } = require('./regulationsService');
const cache = require('../cache');
const logger = require('../logger');

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
  // Unicode NFC 정규화 — 일부 OS(Mac)/브라우저에서 한글이 NFD(분해형)로 전달돼
  // "강북" 같은 NFC 키워드와 문자열 비교 실패하는 버그 방지
  const r = String(userRegion || '').normalize('NFC').replace(/\s+/g,'');
  const wp = String(workplaceArea || '').normalize('NFC').replace(/\s+/g,'');
  const combined = r + ' ' + wp;
  logger.debug({ userRegion, r, wp, maxBudget }, 'pickRegions 진입');
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

// ── LTV/대출한도 단순 계산 ─────────────────────────────
// 2026-04-25: regulations_snapshot 단일 소스화 (Top-1 P0 핫픽스).
//   - 기존: inline regex `/서울|강남|서초|송파|용산|분당|과천/` →
//     광명·하남·의왕·성남(수정/중원)·수원(영통/장안/팔달)·안양(동안)·
//     용인(수지) 등 10개 경기 규제지역 누락 → LTV 70% 오표기 →
//     사용자가 계약금 걸고 은행 가서 실제 40% 만 나오는 손실 시나리오.
//   - 개선: 호출자가 미리 isRegulatedRegion() 으로 boolean 만 계산해서
//     주입 → per-row 비용은 0 (closure 변수 read 만), 정확도는 snapshot 기준.
function computeLTV(buyAuk, isRegulated, isFirstBuyer, houseStatus) {
  if (houseStatus === '2주택+') return { ltv: '0% (규제)', maxLoan: '0억' };
  // P1 (감사 2-5): 처분조건부 = 무주택 LTV 적용. 1주택 일반은 규제지역 0%.
  const isDispose = houseStatus === '1주택 (처분조건부)';
  if (houseStatus === '1주택' && isRegulated) return { ltv: '0% (1주택 규제지역)', maxLoan: '처분조건부 chip 선택 시 무주택 한도' };
  let pct;
  if (isRegulated) pct = isFirstBuyer ? 0.7 : 0.4;
  else pct = isFirstBuyer ? 0.8 : 0.7;
  const cap = isRegulated ? (buyAuk <= 15 ? 6 : buyAuk <= 25 ? 4 : 2) : Infinity;
  const loan = Math.min(buyAuk * pct, cap);
  return {
    ltv: `${(pct * 100).toFixed(0)}% ${isRegulated ? '(규제)' : '(비규제)'}${isDispose ? ' · 처분조건부' : ''}`,
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
 * 사용자 조건 기반 단지 추천
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

  // NFC 정규화 — Mac(NFD) ↔ Windows(NFC) 캐시 분리 방지
  const normReg = String(region || '').normalize('NFC').trim();
  const normWp = String(workplaceArea || '').normalize('NFC').trim();
  const cacheKey = `rec:v5:${normReg}:${maxBudget}:${houseStatus}:${isFirstBuyer}:${normWp}:${minPy}:${maxPy}`;
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
      logger.warn({
        region: targetRegions[i].name, errMsg: r.reason?.message,
      }, 'PropertyService 지역별 거래 조회 실패');
      return [];
    })),
  ]);
  const allAptList = aptListArrays.flat();
  const allTx = txArrays.flat();
  const analyzed = analyzeTransactions(allTx);
  logger.info({
    aptListTotal: allAptList.length, analyzedCount: analyzed.length,
  }, 'PropertyService 지역 집계 완료');

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

  // ⚠ 2026-04-25: "참고 단지(거래 없는 단지)" 기능 제거
  // 제거 사유:
  //   - 같은 동 평균가로 예상가를 추정하는 로직은 신뢰도 낮음 (최근 거래 없는 단지는
  //     대개 거래 단절 이유가 있음 — 재건축·세대합병·불리한 입지 등).
  //   - 프론트 지도에 섞여 표시되면서 "실거래 근거 있는 추천"과 구분이 어려움 → UX 혼란.
  //   - 좌표 역시 as2/_dong 기반 fallback 으로 구 경계를 넘기는 사례 있음 (Bug #2).
  //   - 재도입 시 별도 섹션/별색 마커로 시각 구분 + 추정가 신뢰구간 표기 필요.

  if (!matched.length) {
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
  // 규제지역 키워드 1회 조회 → 단지별 sigungu 기준으로 정확하게 LTV 계산.
  // (snapshot in-process 캐시 hit 시 비용 무시 가능)
  const { keywords: regKeywords, seoulRegulated } = await getRegulatedKeywords();
  const matchRegulated = (sigunguStr) => {
    const r = String(sigunguStr || '').normalize('NFC').trim();
    if (!r) return false;
    if (seoulRegulated) {
      if (r.includes('서울')) return true;
      for (const gu of SEOUL_GU_KEYWORDS) if (r.includes(gu)) return true;
    }
    for (const kw of regKeywords) if (r.includes(kw)) return true;
    return false;
  };

  const recommendations = ranked.map((apt, i) => {
    const p = apt.primaryPyeong;
    const avgAuk = parseFloat((p.avgPrice / 10000).toFixed(2));
    const minAuk = parseFloat((p.minPrice / 10000).toFixed(2));
    const maxAuk = parseFloat((p.maxPrice / 10000).toFixed(2));
    // 단지 실제 위치(MOLIT sggNm)로 규제 판정 — 사용자 입력 region 보다 정확
    const aptIsRegulated = matchRegulated(apt.sigungu || region || '');
    const ltvInfo = computeLTV(avgAuk, aptIsRegulated, isFirstBuyer, houseStatus);
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
      strategy: `① 최근 거래 ${p.recentTx.length}건 동·층·향 비교 ② 대출 사전심사 ③ 같은 평형 호가 비교 (네이버부동산/직방)`,
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
  // K-apt AptBasisInfoServiceV3는 kaptCode(예: "A10020255")를 요구하지만
  // MOLIT 실거래의 aptSeq(예: "11350-102")와 형식이 다름.
  // → allAptList(getSigunguAptList3)의 kaptName+dong 매칭으로 실제 kaptCode 해결
  const kaptCodeMap = new Map(); // normalizedName+dong → kaptCode
  const normalizeName = (s) => (s || '').replace(/\s/g, '').toLowerCase();
  for (const a of allAptList) {
    const nm = normalizeName(a.kaptName || a.aptName || '');
    if (!nm || !a.kaptCode) continue;
    const dong = a.as4 || a.as3 || '';
    kaptCodeMap.set(`${nm}|${dong}`, a.kaptCode);
    // 동명 없이도 찾을 수 있도록 fallback 키 저장 (같은 이름 여러 개면 첫 매칭 유지)
    if (!kaptCodeMap.has(nm)) kaptCodeMap.set(nm, a.kaptCode);
  }
  // allAptList 인덱스 (kaptCode → 원본 엔트리) — K-apt basis 실패 시 fallback 용
  const allAptByCode = new Map();
  for (const a of allAptList) {
    if (a.kaptCode) allAptByCode.set(a.kaptCode, a);
  }
  const enriched = await Promise.allSettled(
    recommendations.map(async (rec, i) => {
      const apt = ranked[i];
      const nmKey = normalizeName(apt.aptName);
      const kaptCode = kaptCodeMap.get(`${nmKey}|${apt.umdNm || ''}`) || kaptCodeMap.get(nmKey);
      if (!kaptCode) return rec;
      const info = await getAptBasisInfo(kaptCode);
      // Fallback: info 없으면 allAptList 기본 데이터로 최소 facility 구성 (주소·kaptCode 노출)
      if (!info) {
        const basic = allAptByCode.get(kaptCode);
        if (!basic) return rec;
        return {
          ...rec,
          facility: {
            kaptCode,
            totalHouseholds: 0,
            dongCount: 0,
            parkingTotal: 0,
            parkingRatio: null,
            builtDate: null,
            heatType: null,
            mgrType: null,
            address: basic.doroJuso || basic.as1 || null,
            floorAreaRatio: null,
            _partial: true, // 프론트: 부분 데이터 표시 플래그
          },
        };
      }
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
          kaptCode,
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
  ).then(results => results.map((r, idx) => {
    // 부분 실패 시 원본 rec 유지 (facility 전체 손실 방지) — 길이 보장
    if (r.status === 'fulfilled' && r.value) return r.value;
    if (r.reason) {
      logger.warn({
        aptName: recommendations[idx]?.aptName, errMsg: r.reason?.message,
      }, 'PropertyService enrich 실패 (원본 rec 유지)');
    }
    return recommendations[idx];
  }));

  // enrich는 항상 recommendations 와 길이 동일 — 그대로 사용
  const enrichedRecs = enriched;

  // Step 6: 좌표 해결 — DB 캐시 우선, miss 시 Kakao 지오코딩.
  // 여기서 lat/lng 를 채워야 프론트가 fallback/jitter 없이 정확한 위치에 마커를 찍는다.
  // (기존 버그: 프론트 getLat/getLng 의 구명 키워드 매칭 실패 시 서울 중심 근처로 떨어져
  //  은평구 단지가 용산/한강 근처에 표시됨 → Bug #2 의 근본 원인)
  const coordInputs = enrichedRecs.map((rec, i) => {
    const apt = ranked[i];
    return {
      kaptCode: rec.facility?.kaptCode || null,
      aptName: rec.aptName,
      sigungu: apt.sigungu || '',
      umdNm: apt.umdNm || '',
      address: rec.facility?.address || null,
    };
  });
  const coords = await resolveCoordBatch(coordInputs, 4);
  const withCoords = enrichedRecs.map((rec, i) => {
    const c = coords[i];
    return {
      ...rec,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      // 좌표 출처 — 프론트에서 "정확" 마커와 fallback 구분 가능
      coordSource: c ? 'geocache' : null,
    };
  });
  const missingCoords = withCoords.filter(r => r.lat == null).length;
  if (missingCoords > 0) {
    logger.info({ total: withCoords.length, missing: missingCoords },
      'propertyService: 일부 단지 좌표 해결 실패 — 프론트에서 마커 생략');
  }

  const result = {
    recommendations: withCoords,
    targetRegions,
    totalTxAnalyzed: analyzed.length,
    totalAptsInRegion: allAptList.length,
    inBudgetCount: matched.length,
    // 참고단지 기능 제거 (2026-04-25) — 하위 호환 위해 0 유지
    referenceCount: 0,
    coordMissingCount: missingCoords,
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
