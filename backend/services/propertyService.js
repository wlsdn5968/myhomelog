/**
 * 매물 검색 서비스 (개선판)
 * - 사용자 입력 지역(region) 우선 매칭 → 검색 결과의 사용자 기대 일치율↑
 * - MOLIT 페이지네이션 1000건×3페이지로 누락 최소화
 * - AI 지역결정 단계 제거(병목 해소) → 키워드 기반 빠른 매칭
 * - 예산 필터를 평균가 → 최저가 기준으로 변경 (같은 단지 다른 평형 포함)
 * - 거래량 가중 정렬 → 환금성(회전율) 좋은 단지 상위 노출
 */
const { callAI } = require('./aiService');
const { getTransactionsByApt, analyzeTransactions, LAWD_CODES } = require('./transactionService');
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
  '중구인천': ['28110'], '동구인천': ['28140'], '미추홀': ['28177'], '연수': ['28185'],
  '남동': ['28200'], '부평': ['28237'], '계양': ['28245'], '서구인천': ['28260'],
  '송도': ['28185'], // 송도=연수구
  // 지방 광역시 핵심
  '해운대': ['26350'], '수영': ['26500'], '남구부산': ['26290'],
  '수성': ['27260'], '중구대구': ['27110'],
  '유성': ['30200'], '서구대전': ['30170'],
  '서구광주': ['29140'], '남구광주': ['29155'],
  // 광역 (구 미지정 시 키워드)
  '서울': ['11680','11650','11710','11440','11200','11680'],
  '인천': ['28185','28200','28237','28245'], // 연수·남동·부평·계양
  '부산': ['26350','26500','26290'],
  '대구': ['27260','27110'],
  '대전': ['30200','30170'],
  '광주': ['29140','29155'],
};

function pickRegions(userRegion = '', maxBudget = 0, workplaceArea = '') {
  const r = (userRegion || '').replace(/\s+/g,'');
  const wp = (workplaceArea || '').replace(/\s+/g,'');
  const combined = r + ' ' + wp; // workplaceArea도 매칭 후보에 포함
  // 1) 사용자 입력(지역명·직장위치)에 일치하는 구 우선
  const SKIP_GLOBAL = new Set(['서울','경기','인천','부산','대구','대전','광주']);
  for (const [kw, codes] of Object.entries(REGION_KEYWORDS)) {
    if (!SKIP_GLOBAL.has(kw) && combined.includes(kw)) {
      const display = kw.replace(/인천|대구|광주$/,'').replace(/부산$/,'') || kw;
      return codes.map((c, i) => ({ lawdCd: c, name: codes.length > 1 ? `${kw}-${i+1}` : kw }));
    }
  }
  // 2) 광역 매칭 (인천/부산/대구/대전/광주)
  for (const wide of ['인천','부산','대구','대전','광주']) {
    if (r.includes(wide)) {
      return REGION_KEYWORDS[wide].map(c => ({ lawdCd: c, name: `${wide}` }));
    }
  }
  // 3) 예산 기반 자동 추천 (서울 또는 미입력)
  if (!r || r.includes('서울')) {
    if (maxBudget <= 6) return [
      { lawdCd: '11350', name: '노원구' },
      { lawdCd: '11320', name: '도봉구' },
      { lawdCd: '11305', name: '강북구' },
      { lawdCd: '11260', name: '중랑구' },
    ];
    if (maxBudget <= 9) return [
      { lawdCd: '11530', name: '구로구' },
      { lawdCd: '11545', name: '금천구' },
      { lawdCd: '11500', name: '강서구' },
      { lawdCd: '11380', name: '은평구' },
    ];
    if (maxBudget <= 14) return [
      { lawdCd: '11290', name: '성북구' },
      { lawdCd: '11230', name: '동대문구' },
      { lawdCd: '11470', name: '양천구' },
      { lawdCd: '11440', name: '마포구' },
    ];
    return [
      { lawdCd: '11650', name: '서초구' },
      { lawdCd: '11680', name: '강남구' },
      { lawdCd: '11710', name: '송파구' },
      { lawdCd: '11200', name: '성동구' },
    ];
  }
  // 4) 경기/기타 (기본 — region이 '경기'이거나 매칭 실패 시)
  return [
    { lawdCd: '41210', name: '광명시' },
    { lawdCd: '41290', name: '과천시' },
    { lawdCd: '41135', name: '성남시 분당구' },
    { lawdCd: '41281', name: '고양시 일산서구' },
  ];
}

/**
 * 사용자 조건 기반 매물 추천 (개선판)
 */
async function getAIRecommendations(userCondition) {
  const {
    maxBudget,
    availableLoan,
    myCash,
    region,
    houseStatus,
    isFirstBuyer,
    purpose,
    schoolNeeded,
    childPlan,
    workplaceArea,
  } = userCondition;

  const cacheKey = `rec:${JSON.stringify(userCondition).slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // Step 1: 키워드 기반 빠른 지역 결정 (AI 호출 X) — 직장위치도 매칭에 활용
  const targetRegions = pickRegions(region, maxBudget, workplaceArea);

  // Step 2: 병렬 실거래가 조회
  const txArrays = await Promise.all(
    targetRegions.map(r => getTransactionsByApt(r.lawdCd, '').catch(err => {
      console.error(`[PropertyService] ${r.name} 조회 실패:`, err.message);
      return [];
    }))
  );
  const allTx = txArrays.flat();
  const analyzed = analyzeTransactions(allTx);

  if (!analyzed || !analyzed.length) {
    return { recommendations: getStaticFallback(maxBudget, region), targetRegions, fromCache: false };
  }

  // Step 3: 예산 필터 — 최저가 기준 (같은 단지 다른 평형 포함)
  // 예산의 60%~110% 범위 내에 최소 1건이라도 있으면 포함
  const budgetMin = maxBudget * 0.6 * 10000; // 만원
  const budgetMax = maxBudget * 1.1 * 10000;
  const inBudget = analyzed.filter(a =>
    a.minPrice <= budgetMax && a.maxPrice >= budgetMin
  );

  if (!inBudget.length) {
    return { recommendations: getStaticFallback(maxBudget, region), targetRegions, fromCache: false };
  }

  // Step 4: 거래량 가중 정렬 (환금성 우선) — 상위 12건만 AI 분석
  const ranked = inBudget
    .map(a => ({ ...a, score: a.dealCount * 10 + (a.buildYear || 1990) * 0.01 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 12);

  // Step 5: AI 분석 (정보 정리·해석만, 추천/예측 금지)
  const analysisPrompt = `다음 실거래 데이터에서 사용자 조건에 부합하는 단지 5곳을 골라 객관적 정보로 정리해줘. 추천·매수권유·가격예측 표현 절대 금지. 데이터 정리·중립 분석만.

사용자 조건:
- 예산: ${maxBudget}억원 (현금 ${myCash}억 + 대출 ${availableLoan}억)
- 주택: ${houseStatus} | 생애최초: ${isFirstBuyer ? 'Y' : 'N'} | 지역희망: ${region || '서울'}
- 학군: ${schoolNeeded ? '중요' : '보통'} | 직장: ${workplaceArea || '미입력'}

실거래 데이터 (최근 6개월):
${ranked.map((a, i) => `${i + 1}. ${a.aptName} (${a.sigungu} ${a.umdNm}) ${a.buildYear}년식
   평균 ${a.avgPriceAuk}억 (${(a.minPrice/10000).toFixed(2)}~${(a.maxPrice/10000).toFixed(2)}억) | ${a.areas} | 6개월 ${a.dealCount}건`).join('\n')}

JSON 배열로 정확히 5개 반환 (\`\`\` 없이, 설명 없이):
[{
  "rank": 1, "aptName": "단지명", "area": "구 동", "avgPrice": 숫자(억),
  "minPrice": 숫자, "maxPrice": 숫자, "buildYear": 숫자, "pyeong": "25평",
  "score": 숫자(0-100, 거래활발도+입지+컨디션 종합),
  "ltv": "40%(규제)" 또는 "70%(비규제)",
  "maxLoan": "한도 문자열",
  "pros": "객관적 장점 2줄 (역세권/대단지 등 사실)",
  "cons": "객관적 단점 1줄 (구축/소형 등 사실)",
  "strategy": "검토 시 확인할 사항 2줄 (임장 포인트, 사전심사 등)",
  "tags": ["역세권","대단지"],
  "risk": "주요 리스크 (가격하락 가능성·전세시세 등)",
  "recommend": false
}]
중요: "recommend"는 항상 false. "pros/cons"는 사실만 (예: "총 2,500세대" "준공 1995년"). 가격예측 표현 금지.`;

  let recommendations = [];
  try {
    const aiResult = await callAI([{ role: 'user', content: analysisPrompt }], false);
    const cleaned = aiResult.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    recommendations = parsed.map(r => {
      const matchTx = ranked.find(a => a.aptName === r.aptName);
      return { ...r, txHistory: matchTx?.rawList || [], dealCount6m: matchTx?.dealCount || 0 };
    });
  } catch (e) {
    console.error('[PropertyService] AI 분석 파싱 실패, 데이터 폴백', e.message);
    recommendations = ranked.slice(0, 5).map((a, i) => ({
      rank: i + 1,
      aptName: a.aptName,
      area: `${a.sigungu} ${a.umdNm}`,
      avgPrice: parseFloat(a.avgPriceAuk),
      minPrice: parseFloat((a.minPrice / 10000).toFixed(2)),
      maxPrice: parseFloat((a.maxPrice / 10000).toFixed(2)),
      buildYear: a.buildYear,
      pyeong: a.areas,
      score: Math.min(95, 50 + a.dealCount * 3),
      pros: `최근 6개월 ${a.dealCount}건 거래 / ${a.buildYear}년식 / ${a.areas}`,
      cons: '상세 임장 필요',
      strategy: '국토부 실거래가 동호수별 비교, 대출 사전심사, RR 동·층·향 확인',
      tags: ['실거래확인'],
      risk: '시세 변동·금리 인상 리스크는 본인 부담',
      recommend: false,
      txHistory: a.rawList || [],
      dealCount6m: a.dealCount,
    }));
  }

  const result = {
    recommendations,
    targetRegions,
    totalTxAnalyzed: analyzed.length,
    inBudgetCount: inBudget.length,
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
  }];
}

module.exports = { getAIRecommendations, pickRegions };
