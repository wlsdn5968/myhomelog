/**
 * 매물 검색 서비스
 * - AI + 실거래가 API 기반 동적 추천
 * - 하드코딩 없이 검색 쿼리 기반으로 추천 생성
 */
const axios = require('axios');
const { callAI } = require('./aiService');
const { getTransactionsByApt, analyzeTransactions, LAWD_CODES } = require('./transactionService');
const cache = require('../cache');

/**
 * 사용자 조건 기반 AI 매물 추천 생성
 * - AI가 조건을 분석해 검색할 지역/단지 결정
 * - 실거래가 API에서 실제 거래 데이터 조회
 * - AI가 각 매물에 대한 투자 의견 생성
 */
async function getAIRecommendations(userCondition) {
  const {
    maxBudget,      // 최대 매수 가격 (억)
    availableLoan,  // 대출 가능 금액 (억)
    myCash,         // 보유 현금 (억)
    region,         // 희망 지역
    houseStatus,    // 주택 보유 상황
    isFirstBuyer,   // 생애 최초 여부
    purpose,        // 실거주/투자
    schoolNeeded,   // 학군 중요도
    childPlan,      // 자녀 계획
    workplaceArea,  // 직장 위치
  } = userCondition;

  const cacheKey = `rec:${JSON.stringify(userCondition).slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // Step 1: AI에게 검색할 지역 목록 결정 요청
  const regionPrompt = `사용자 조건:
- 예산: ${maxBudget}억원 (현금 ${myCash}억 + 대출 ${availableLoan}억)
- 희망 지역: ${region}
- 주택 보유: ${houseStatus} | 생애최초: ${isFirstBuyer ? 'Y' : 'N'}
- 직장: ${workplaceArea || '미입력'} | 학군: ${schoolNeeded ? '중요' : '보통'} | 자녀 계획: ${childPlan || '미입력'}
- 목적: ${purpose || '실거주 + 자산증식'}

위 조건에서 매수를 검토할 만한 서울/경기 구 이름과 법정동코드 5자리를 JSON 배열로 반환해.
형식: [{"gu":"노원구","lawdCd":"11350","reason":"예산 내 역세권 단지 다수"},...]
최대 5개, 코드만 정확하게, JSON만 출력 (```없이).`;

  let targetRegions = [];
  try {
    const regionResult = await callAI([{ role: 'user', content: regionPrompt }], false);
    const cleaned = regionResult.content
      .replace(/```json|```/g, '').trim();
    targetRegions = JSON.parse(cleaned);
  } catch (e) {
    console.error('[PropertyService] 지역 파싱 실패, 기본값 사용', e.message);
    targetRegions = getDefaultRegions(region, maxBudget);
  }

  // Step 2: 각 지역 실거래가 조회
  const now = new Date();
  const dealYm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevYm = `${now.getFullYear()}${String(now.getMonth()).padStart(2, '0') || '01'}`;

  const txPromises = targetRegions.flatMap(r => [
    getTransactionsByApt(r.lawdCd, '').catch(() => []),
  ]);
  const allTxArrays = await Promise.all(txPromises);
  const allTx = allTxArrays.flat();
  const analyzed = analyzeTransactions(allTx);

  if (!analyzed || !analyzed.length) {
    return { recommendations: getStaticFallback(maxBudget, region), fromCache: false };
  }

  // Step 3: 예산 필터링 (± 15% 범위)
  const budgetMin = maxBudget * 0.7;
  const budgetMax = maxBudget * 1.1;
  const inBudget = analyzed.filter(a =>
    a.avgPrice >= budgetMin * 10000 && a.avgPrice <= budgetMax * 10000
  ).slice(0, 8);

  if (!inBudget.length) {
    return { recommendations: getStaticFallback(maxBudget, region), fromCache: false };
  }

  // Step 4: AI에게 최종 추천 분석 요청
  const analysisPrompt = `다음 실거래가 데이터에서 사용자 조건에 맞는 매물 TOP 5를 추천하고 각각 분석해줘.

사용자 조건:
- 예산: ${maxBudget}억원 | 현금: ${myCash}억 | 대출: ${availableLoan}억
- 주택: ${houseStatus} | 지역: ${region}
- 학군 중요: ${schoolNeeded ? 'Y' : 'N'} | 직장: ${workplaceArea || '미입력'}

실거래 데이터:
${inBudget.map((a, i) => `${i + 1}. ${a.aptName} (${a.sigungu} ${a.umdNm})
   - 평균가: ${a.avgPriceAuk}억 (${a.minPrice/10000}~${a.maxPrice/10000}억) | ${a.areas} | ${a.buildYear}년 | 거래 ${a.dealCount}건`).join('\n')}

각 매물에 대해 JSON 배열로 반환해줘:
[{
  "rank": 1,
  "aptName": "단지명",
  "area": "시구동",
  "avgPrice": 숫자(억),
  "minPrice": 숫자(억),
  "maxPrice": 숫자(억),
  "buildYear": 숫자,
  "pyeong": "25평",
  "score": 숫자(0-100),
  "ltv": "40%(규제)" 또는 "70%(비규제)",
  "maxLoan": "6억" 또는 "LTV 기준",
  "pros": "장점 2줄",
  "cons": "단점 1줄",
  "strategy": "매수 전략 2줄",
  "tags": ["역세권","학군우수"],
  "risk": "주요 리스크",
  "recommend": true/false
}]
JSON만 출력 (설명 없이, \`\`\` 없이).`;

  let recommendations = [];
  try {
    const aiResult = await callAI([{ role: 'user', content: analysisPrompt }], false);
    const cleaned = aiResult.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    // rawList 붙이기
    recommendations = parsed.map(r => {
      const matchTx = inBudget.find(a => a.aptName === r.aptName);
      return { ...r, txHistory: matchTx?.rawList || [] };
    });
  } catch (e) {
    console.error('[PropertyService] AI 분석 파싱 실패', e.message);
    recommendations = inBudget.slice(0, 5).map((a, i) => ({
      rank: i + 1,
      aptName: a.aptName,
      area: `${a.sigungu} ${a.umdNm}`,
      avgPrice: parseFloat(a.avgPriceAuk),
      minPrice: parseFloat((a.minPrice / 10000).toFixed(2)),
      maxPrice: parseFloat((a.maxPrice / 10000).toFixed(2)),
      buildYear: a.buildYear,
      score: 70,
      pros: '실거래 데이터 기반 추천',
      cons: '상세 분석 필요',
      strategy: '임장 후 결정 권장',
      tags: ['실거래확인'],
      txHistory: a.rawList || [],
    }));
  }

  const result = { recommendations, targetRegions, totalTxAnalyzed: analyzed.length };
  cache.set(cacheKey, result, 1800);
  return { ...result, fromCache: false };
}

// ── 기본 지역 설정 (AI 실패 시) ──────────────────────────
function getDefaultRegions(region, budget) {
  if (region?.includes('서울') || !region) {
    if (budget <= 7) return [
      { gu: '노원구', lawdCd: '11350', reason: '예산 내 다수 단지' },
      { gu: '도봉구', lawdCd: '11320', reason: '저평가 역세권' },
      { gu: '구로구', lawdCd: '11530', reason: '비규제 LTV 70%' },
    ];
    if (budget <= 10) return [
      { gu: '성북구', lawdCd: '11290', reason: '대단지 학군' },
      { gu: '동대문구', lawdCd: '11230', reason: '뉴타운 수혜' },
      { gu: '마포구', lawdCd: '11440', reason: '업무지구 접근' },
    ];
    return [
      { gu: '서초구', lawdCd: '11650', reason: '상급지' },
      { gu: '강남구', lawdCd: '11680', reason: '상급지' },
    ];
  }
  return [
    { gu: '광명시', lawdCd: '41210', reason: '서울 인접 비규제' },
    { gu: '과천시', lawdCd: '41290', reason: '1호선 역세권' },
  ];
}

// ── 정적 폴백 (API 완전 실패 시) ─────────────────────────
function getStaticFallback(budget, region) {
  return [{
    rank: 1,
    aptName: 'API 연결 필요',
    area: '국토부 실거래가 API 키 설정 후 실제 데이터 조회 가능',
    avgPrice: budget,
    score: 0,
    pros: '.env에 MOLIT_API_KEY 설정 필요',
    cons: 'data.go.kr에서 무료 발급',
    strategy: '공공데이터포털 > 국토교통부 > 아파트매매 실거래가 상세자료 API 신청',
    tags: ['API설정필요'],
    txHistory: [],
  }];
}

module.exports = { getAIRecommendations };
