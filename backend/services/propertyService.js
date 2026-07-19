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
const { getTransactionsByApt, analyzeTransactions, getAliasCanonicalMap, getRegionRecentTransactions } = require('./transactionService');
const { getAptListBySgg, getAptBasisInfo, getAptDtlInfo } = require('./aptInfoService');
const { resolveCoordBatch } = require('./geocodeCacheService');
const { resolveSchoolsBatch, getCachedSchoolsBatch } = require('./schoolService');
const { isRegulatedRegion, getRegulatedKeywords, SEOUL_GU_KEYWORDS } = require('./regulationsService');
const { normalizeAptName } = require('../utils/aptName');
const { buildFacility } = require('../utils/buildFacility');
// REC-PERF-2026-07-10 (Sprint FFFF): apt_master.facility 배치 조회 — 콜드 KAPT 30콜 제거
const { getFacilitiesByKaptCodes } = require('./aptFacilityService');
const { getBuildingTitle } = require('./buildingRegisterService'); // LLLLLL-3: KAPT 미매칭 단지 세대수 = 건축물대장(SSSS 연동)으로 보강
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
  // 지방 광역시 세부 — METRO-SUB-2026-07-17 (Sprint UUUUU): REGION_SUB['지방'](해운대·수영·수성·유성·광주서구)
  //   5개 구는 transactionService.LAWD_CODES 에 이미 적재(실측 각 2,445~5,677건, 최신 2026-07-14) 인데
  //   pickRegions 검색 키워드 매핑이 없어 경기/서울로 조용히 오귀속되던 것 수정(커버리지 확장 아님 — 기존 적재분 도달).
  //   '광주서'는 경기 '광주'(41610)보다 반드시 먼저 나열해야 정확 매칭(combined.includes 첫 매칭 반환).
  '해운대': ['26350'], '수영': ['26500'], '수성': ['27260'], '유성': ['30200'], '광주서': ['29140'],
  // 경기 — COVERAGE-EXPAND-2026-07-12 (Sprint VVVV). 구 단위 세부를 도시 키워드보다 먼저 나열:
  //   pickRegions 는 combined.includes(kw) 첫 매칭을 반환하므로 세부 구가 우선돼야 정확히 해석됨.
  '덕양': ['41281'], '일산동': ['41285'], '일산서': ['41287'],
  '만안': ['41171'], '동안': ['41173'], '평촌': ['41173'],
  '처인': ['41461'], '기흥': ['41463'], '수지': ['41465'],
  '장안': ['41111'], '권선': ['41113'], '팔달': ['41115'], '영통': ['41117'],
  '수정': ['41131'], '중원': ['41133'], '분당': ['41135'], '판교': ['41135'],
  '원미': ['41192'], '소사': ['41194'], '오정': ['41196'],
  '상록': ['41271'], '단원': ['41273'], '동탄': ['41597'], '미사': ['41450'],
  // 경기 — 도시 단위 (다구 도시는 대표 3구 = pickRegions slice(0,3) 반영). '남양주'는 '양주'보다 먼저.
  '수원': ['41117','41113','41111'], '성남': ['41135','41131','41133'],
  '고양': ['41281','41285','41287'], '일산': ['41285','41287'],
  '용인': ['41465','41463','41461'], '안양': ['41173','41171'],
  '부천': ['41192','41194','41196'], '안산': ['41273','41271'],
  '남양주': ['41360'], '평택': ['41220'], '의정부': ['41150'], '파주': ['41480'],
  '김포': ['41570'], '군포': ['41410'], '이천': ['41500'], '오산': ['41370'],
  '안성': ['41550'], '동두천': ['41250'], '포천': ['41650'], '여주': ['41670'],
  '양평': ['41830'], '가평': ['41820'], '연천': ['41800'], '양주': ['41630'],
  '광주': ['41610'], '과천': ['41290'], '광명': ['41210'], '하남': ['41450'],
  '의왕': ['41430'], '시흥': ['41390'],
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
  // P1-2 (2026-05-04): 처분조건부면 isFirstBuyer 와 무관하게 무주택 LTV 적용
  //   기존: 처분조건부 + isFirstBuyer X → pct=0.4 (잘못 — 처분조건부는 무주택 70%)
  //   변경: isDispose 우선 분기
  if (isDispose) {
    pct = isRegulated ? 0.7 : 0.8; // 처분조건부 = 무주택 LTV
  } else if (isRegulated) {
    pct = isFirstBuyer ? 0.7 : 0.4;
  } else {
    pct = isFirstBuyer ? 0.8 : 0.7;
  }
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
  // TAG-AGE-FIX-2026-07-11 (Sprint OOOO): 절대연도 하드코딩(≥2015/≥2000/<1995)은 시간이 지나며 오라벨 —
  //   2026 기준 2000~2004년식(22~26년차)이 '준신축'으로 잡혀 cons '준구축(20년+)'과 모순됐음.
  //   현재연도 기준 상대 나이로 교체(재건축연한도 상세 배지·_isReconAge 와 동일한 30년 기준으로 정렬).
  const _age = apt.buildYear ? (new Date().getFullYear() - apt.buildYear) : null;
  if (_age !== null && _age <= 10) tags.push('신축급');
  else if (_age !== null && _age <= 15) tags.push('준신축');
  else if (_age !== null && _age >= 30) tags.push('재건축연한');
  const pyeongCount = (apt.pyeongStats || []).length;
  if (pyeongCount >= 4) tags.push('다양평형');
  return tags;
}

// ── 종합 점수 (Sprint Y 2026-05-13 — 운영자 발견 "왜 다 95점?") ──
// 기존: `min(95, 50 + min(dealCount,30)*1.5)` 은 cap 으로 단지 차등 부족.
// 다요인: 거래량/신축도/평형다양 (recommendations 단계, facility 없음)
function _calcBaseScore(apt) {
  let s = 30; // 기본
  // 1) 거래량 (max 30점) — 50건+ cap
  s += Math.min(apt.dealCount || 0, 50) * 0.6;
  // 2) 신축도 (max 18점) — age 단계
  const yr = parseInt(apt.buildYear) || 0;
  const age = yr ? (new Date().getFullYear() - yr) : 30;
  if (age <= 5) s += 18;
  else if (age <= 10) s += 14;
  else if (age <= 20) s += 10;
  else if (age <= 30) s += 5;
  // 3) 평형 다양 (max 8점)
  const distinctP = Array.isArray(apt.pyeongStats) ? new Set(apt.pyeongStats.map(p => p.pyeong)).size : 0;
  s += Math.min(distinctP, 4) * 2;
  return Math.max(20, Math.min(86, Math.round(s))); // facility 보정 12점 여유
}

// enriched 단계에서 facility 받은 후 추가 보정
//   기본 (Sprint Y): 단지 규모 (max 8) + 주차 (max 4) = +12점
//   확장 (Sprint CC+): 위치 가치 (지하철 도보 + 교육시설) = +6점
function _applyFacilityToScore(baseScore, facility) {
  let s = baseScore || 30;
  const th = facility?.totalHouseholds || 0;
  if (th >= 3000) s += 8;
  else if (th >= 1000) s += 6;
  else if (th >= 500) s += 3;
  const pr = facility?.parkingRatio || 0;
  if (pr >= 1.2) s += 4;
  else if (pr >= 0.8) s += 2;
  // LOC-SCORE-2026-05-13 (Sprint CC+): 위치 가치 (지하철 도보 + 교육시설)
  //   KAPT detail 의 정성 정보 활용 — 사용자 입지 가치 인식 반영.
  const sub = String(facility?.walkSubwayMin || '');
  if (sub.includes('5분이내')) s += 4;
  else if (sub.includes('5~10분')) s += 2;
  const edu = String(facility?.educationFacility || '');
  // 빈 괄호 noise 제거 후 길이 검사
  const eduMeaningful = edu.replace(/[가-힣A-Za-z]+\(\s*\)/g, '').replace(/[,\s]/g, '');
  if (eduMeaningful.length >= 5) s += 2; // 학교 정보 있으면 가산
  return Math.max(20, Math.min(98, Math.round(s)));
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
    minHouseholds,   // FILTER-2026-07-12: 세대수 하한 (예: 500)
    minParkingRatio, // FILTER-2026-07-12: 세대당 주차 하한 (예: 1.5)
    saleOnly,        // FILTER-2026-07-12: 분양만(임대·혼합 제외)
  } = userCondition;

  // 기본 최소 15평 (오피스텔·초소형 제외)
  const minPy = parseInt(minArea) || 15;
  const maxPy = parseInt(maxArea) || 60;
  // FILTER-2026-07-12 (Sprint TTTT): 좋은-아파트 조건 필터 (KAPT facility 기준). 미설정 시 0/false = 무필터.
  const fMinHh = parseInt(minHouseholds) || 0;
  const fMinPark = parseFloat(minParkingRatio) || 0;
  const fSaleOnly = saleOnly === true || saleOnly === 'true';

  // NFC 정규화 — Mac(NFD) ↔ Windows(NFC) 캐시 분리 방지
  const normReg = String(region || '').normalize('NFC').trim();
  const normWp = String(workplaceArea || '').normalize('NFC').trim();
  const cacheKey = `rec:v15:${normReg}:${maxBudget}:${houseStatus}:${isFirstBuyer}:${normWp}:${minPy}:${maxPy}:${fMinHh}:${fMinPark}:${fSaleOnly}`; // v15: LLLLLL-6 가격하한 0.5→0.7 (보고서와 통일) — 구버전 캐시 차단
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };
  // REC-REDIS-2026-07-17 (Sprint AAAAAA, 운영자 "검색 더 빨리" — 실측: cold 12.6s vs warm 1.4s):
  //   recommend 결과가 node-cache(인스턴스 로컬)뿐이라 Vercel 스케일아웃 시 같은 인기 검색도 인스턴스마다
  //   cold 12초 반복(뉴스 summary KKKKK 와 동일 구조). Redis 2차 조회로 인스턴스 간 공유 → 전역 첫 1회만
  //   콜드, 이후 모든 인스턴스가 Redis hit. 로직·결과 shape 불변, fail-open(Redis 없으면 로컬만).
  const _rHit = await require('./redisCache').rget(cacheKey);
  if (_rHit) { cache.set(cacheKey, _rHit, 10800); return { ..._rHit, fromCache: true }; }

  // STAGE-TIMING-2026-07-17 (Sprint BBBBBB, 운영자 "enrichment 6.15s 단축" — 추측 금지·단계별 실측):
  //   cold 경로의 스테이지별 소요를 1줄 로그로 노출 → 병목을 숫자로 확정 후 타깃 최적화.
  const _tt = { start: Date.now() };
  const _mark = (k) => { _tt[k] = Date.now(); };

  // Step 1: 키워드 기반 빠른 지역 결정
  const targetRegions = pickRegions(region, maxBudget, workplaceArea).slice(0, 3);

  // Step 2: 병렬 조회 — (a) 시군구 전체 단지 목록 + (b) 실거래 내역
  // COLLECT-PAR-2026-07-18 (Sprint DDDDDD): aliasMap 이 대형 병렬 조회 뒤 직렬 1왕복이던 것 — 동시 시작
  const aliasMapPromise = getAliasCanonicalMap(targetRegions.map(r => r.lawdCd));
  const [aptListArrays, txArrays] = await Promise.all([
    Promise.allSettled(
      targetRegions.map(r => getAptListBySgg(r.lawdCd))
    ).then(results => results.map(r => r.status === 'fulfilled' ? r.value : [])),
    Promise.allSettled(
      // REC-PERF-2026-07-10 (Sprint EEEE): 지역 단일쿼리 우선(12왕복→1왕복/지역, 131ms 실측) —
      //   null(미ingest·실패)이면 기존 월별 경로(MOLIT API 폴백 포함)로 안전 fallback.
      targetRegions.map(async r => (await getRegionRecentTransactions(r.lawdCd)) ?? await getTransactionsByApt(r.lawdCd, ''))
    ).then(results => results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn({
        region: targetRegions[i].name, errMsg: r.reason?.message,
      }, 'PropertyService 지역별 거래 조회 실패');
      return [];
    })),
  ]);
  _mark('collectQ');
  const allAptList = aptListArrays.flat();
  const allTx = txArrays.flat();
  // ALIAS-MERGE-2026-05-21 (전수조사: BUG2 동일 클래스): raw MOLIT명(풍림아파트A/B)을
  //   canonical master명(공릉풍림아이원)으로 relabel → analyzeTransactions 그룹화 시 1개 단지로 병합
  //   (검색/지도와 동일 식별). molit_aliases 보유 단지만 영향 (그 외 무변동).
  // ALIAS-REGION-FIX-2026-07-12 (Sprint RRRR): r.name(REGION_KEYWORDS 축약명 '노원')이 아니라
  //   r.lawdCd 를 넘김 — apt_master.sigungu('노원구') 불일치로 맵이 비어 풍림A/B relabel 이 안 되던 버그.
  const aliasMap = await aliasMapPromise;
  _mark('alias');
  const relabeledTx = aliasMap.size
    ? allTx.map(t => { const c = aliasMap.get(`${t.aptName}|${t.umdNm || ''}`); return c ? { ...t, aptName: c } : t; })
    : allTx;
  const analyzed = analyzeTransactions(relabeledTx);
  _mark('collect');
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
  // PRICE-FLOOR-2026-07-19 (Sprint LLLLLL-6, 운영자 "25억 검색에 14.5억이 뜨는 게 어색"):
  //   하한 0.5→0.7 배 — 보고서(fetchCandidateApts minAmt=buy*0.7)와 동일 기준으로 통일(기존 추천만 0.5로 느슨했음).
  //   보고서가 0.7 로 이미 전 지역 정상 동작(공백 없음) = 0.7 viable 실증. 예산의 70~105% 평균시세 단지만 노출.
  const budgetMinMan = maxBudget * 10000 * 0.7;  // 70% 미만은 예산대와 괴리 (보고서와 통일)
  const matched = [];
  for (const apt of analyzed) {
    const fitPyeongs = (apt.pyeongStats || []).filter(p =>
      p.pyeong >= minPy && p.pyeong <= maxPy &&
      // PRICE-FIT-FIX-2026-05-21 (운영자 "7억인데 최소금액 10억대"):
      //   기존 minPrice 기준 → 이상치-저가 1건만 예산 내면 통과하나, 카드에 표시되는 avgPrice 는
      //   예산을 크게 초과 (예: 한진한화그랑빌 26평 min 7.0억 / avg 10.43억 → 7억 검색 top 에 10.43억 노출).
      //   표시값(avgPrice) 기준으로 필터 → 단지의 "평균 시세"가 예산 범위(0.5~1.05배)인 단지만 노출.
      p.avgPrice <= budgetMaxMan && p.avgPrice >= budgetMinMan
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

  // FILTER-2026-07-12 (Sprint TTTT): 좋은-아파트 조건 필터 (세대수/세대당주차/분양) — KAPT facility 기준.
  //   정렬(Step 4) 전에 후보 pool 을 걸러 downstream(enrich→좌표→학군)의 ranked[i] 인덱스 정렬을 안 깨뜨림.
  //   facility 없는(KAPT 미등록) 단지는 조건 확인 불가 → 필터 활성 시 제외. 미필터 시 전체 유지(무영향).
  let candidatePool = matched;
  if (fMinHh > 0 || fMinPark > 0 || fSaleOnly) {
    const _norm = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    // NAME-CANON-2026-07-12 (Sprint UUUU, 전수조사 실측 정정): MOLIT 실거래명은 "상계주공9(고층)/(저층)"
    //   처럼 층구분 괄호 접미를 씀(전국 25개·1,984거래) — KAPT "상계주공9단지"와 불일치.
    //   ⚠ TTTT 의 '단지'-접미만 제거로는 상계주공류가 여전히 미매칭(전제 오류 판명, DB 실측).
    //   → 층구분 괄호(고층/저층) + '단지' 접미를 함께 제거해 canon 매칭. 층 분할은 동일 단지의 물리 구분
    //     이라 하나의 kaptCode 매핑이 정답(실측: 21개 전부 세대수 500+·분양). 차수/브랜드 괄호는
    //     별개 단지 구분자라 제거하지 않음(오병합 방지).
    const _canon = (n) => n.replace(/\((?:고층|저층)\)$/, '').replace(/(?:아파트|단지)$/, '');
    const _codeMap = new Map();
    for (const a of allAptList) {
      const nm = _norm(a.kaptName || a.aptName || '');
      if (!nm || !a.kaptCode) continue;
      const dong = a.as4 || a.as3 || '';
      _codeMap.set(`${nm}|${dong}`, a.kaptCode);
      if (!_codeMap.has(nm)) _codeMap.set(nm, a.kaptCode);
      const st = _canon(nm);
      if (st && st !== nm && !_codeMap.has(st)) _codeMap.set(st, a.kaptCode);
    }
    const _poolCodes = matched.map((apt) => {
      const nmKey = _norm(apt.aptName);
      return _codeMap.get(`${nmKey}|${apt.umdNm || ''}`) || _codeMap.get(nmKey) || _codeMap.get(_canon(nmKey)) || null;
    });
    const _facMap = await getFacilitiesByKaptCodes([...new Set(_poolCodes.filter(Boolean))]);
    // FILTER-KAPT-FALLBACK-2026-07-12 (Sprint UUUU, 전수조사 발견): 필터는 apt_master.facility(DB)만 봐서,
    //   apt_master 미보유 단지(신축·KAPT 미동기·고양 등 lawd 미커버)를 전부 제외 → 필터 결과 0(filteredOut) 오류.
    //   enrichment(preCodes)는 DB miss 시 KAPT API 로 facility 를 보강하나 필터엔 그 경로가 없던 게 근본원인
    //   (라이브 실측: 고양 minHouseholds:1 도 0건, noFilter 는 5건 facility 부착). 필터에도 동일 fallback 추가.
    //   ⚠ 비용 통제: DB-hit 지역(노원·강남 등)은 miss 0 → KAPT 호출 0(성능·회귀 영향 없음). miss 는 dealCount
    //   상위 _KAPT_CAP 개만(최종 top-15 커버) KAPT 조회. 캐시(in-memory) + graceful(실패 시 제외 유지).
    // FILTER-INCOMPLETE-FALLBACK-2026-07-12 (Sprint ZZZZ, 운영자 "공릉풍림아이원: 상세엔 주차 1.26 나오는데 필터가 제외"):
    //   근본원인 = 상세는 resolveFacility(라이브 KAPT)로 _dtl(주차)까지 가져오나, 필터는 apt_master.facility(DB)만
    //   보는데 그 레코드에 _dtl 이 없어(전국 2,588개·24%) parkingRatio=null → 주차필터가 부당 제외.
    //   → DB facility 가 있어도 **주차필터인데 _dtl 없으면** KAPT 라이브 재조회(상세와 동일 데이터). backfill
    //   self-heal(Sprint YYYY)이 DB를 영구 보정하기 전에도 즉시 정확. cap 20·in-memory 캐시.
    const _KAPT_CAP = 20;
    const _missIdx = [];
    for (let i = 0; i < matched.length; i++) {
      const c = _poolCodes[i];
      if (!c) continue;
      const _st = _facMap.get(c);
      if (!_st || (fMinPark > 0 && !_st._dtl)) _missIdx.push(i); // DB miss OR 주차필터인데 _dtl 없음
    }
    if (_missIdx.length) {
      _missIdx.sort((a, b) => (matched[b].dealCount || 0) - (matched[a].dealCount || 0));
      const _fetched = new Set();
      await Promise.allSettled(_missIdx.slice(0, _KAPT_CAP).map(async (i) => {
        const c = _poolCodes[i];
        if (_fetched.has(c)) return; // 동일 code 중복 조회 방지 (incomplete 는 _facMap.has 여도 재조회해야 함)
        _fetched.add(c);
        try {
          const [info, detail] = await Promise.all([
            getAptBasisInfo(c), getAptDtlInfo(c).catch(() => null),
          ]);
          if (info) _facMap.set(c, { ...info, _dtl: detail || undefined }); // buildFacility(stored, code, stored._dtl) 호환
        } catch (_) { /* graceful: 실패 시 제외 유지 */ }
      }));
    }
    candidatePool = matched.filter((apt, i) => {
      const code = _poolCodes[i];
      const stored = code ? _facMap.get(code) : null;
      const fac = stored ? buildFacility(stored, code, stored._dtl || null) : null;
      if (!fac) return false;
      if (fMinHh > 0 && !(fac.totalHouseholds >= fMinHh)) return false;
      if (fMinPark > 0 && !(fac.parkingRatio != null && fac.parkingRatio >= fMinPark)) return false;
      if (fSaleOnly && fac.saleType !== '분양') return false;
      return true;
    });
    logger.info({ before: matched.length, after: candidatePool.length, fMinHh, fMinPark, fSaleOnly }, 'PropertyService 조건 필터 적용');
    if (!candidatePool.length) {
      return {
        recommendations: [],
        targetRegions,
        totalTxAnalyzed: analyzed.length,
        inBudgetCount: matched.length,
        filteredOut: true,
        disclaimer: '본 결과는 국토교통부 실거래가 데이터 기반 정보 정리이며, 매수·매도 추천이 아닙니다.',
        fromCache: false,
      };
    }
  }

  // TRUST+HH GATE (Sprint LLLLLL, 운영자 제보 '서울숲한성' 실측 — report fetchCandidateApts 와 동일 원칙):
  //   ① 6개월 거래 1건 단지 배제 — 표본 1은 평균가 무의미 + MOLIT 신고 오타 이형(행당동 '서울숲한성' 1건,
  //      정식 '서울숲 한신 더 휴' 85건)이 별도 단지로 노출되는 채널.
  //   ② apt_master(DB) 정확·canon 매칭으로 세대수 확인된 100세대 미만 배제 (운영자 지시 "가능하면 추천 제외").
  //      미확인은 유지 — 이름 매칭 실패한 실제 대단지(예: 도원동 삼성래미안) 오배제 방지. KAPT API 추가 호출 0(DB 1쿼리).
  //   '가능하면' = 게이트 후 후보가 충분할 때만 적용(희소 지역 결과 공백 방지). Step 4 이전이라 downstream 인덱스 안전.
  {
    const _n = (s) => (s || '').replace(/\s/g, '').toLowerCase();
    const _c = (n) => n.replace(/\((?:고층|저층)\)$/, '').replace(/(?:아파트|단지)$/, '');
    const _m = new Map();
    for (const a of allAptList) {
      const nm = _n(a.kaptName || a.aptName || '');
      if (!nm || !a.kaptCode) continue;
      const dong = a.as4 || a.as3 || '';
      _m.set(`${nm}|${dong}`, a.kaptCode);
      if (!_m.has(nm)) _m.set(nm, a.kaptCode);
      const st = _c(nm);
      if (st && st !== nm && !_m.has(st)) _m.set(st, a.kaptCode);
    }
    const _codes = candidatePool.map((apt) => {
      const k = _n(apt.aptName);
      return _m.get(`${k}|${apt.umdNm || ''}`) || _m.get(k) || _m.get(_c(k)) || null;
    });
    let _hhMap = new Map();
    try { _hhMap = await getFacilitiesByKaptCodes([...new Set(_codes.filter(Boolean))]); } catch (_) { /* graceful — 게이트 ② 비활성 */ }
    const _hh = candidatePool.map((_, i) => {
      const st = _codes[i] && _hhMap.get(_codes[i]);
      if (!st) return null;
      const v = [st.kaptdaCnt, st.hoCnt].map(x => parseInt(x)).find(nn => Number.isFinite(nn) && nn > 0);
      return v || null;
    });
    // LLLLLL-2 (배포 검증에서 완화 로직이 게이트 무력화 실측 — 성동구 후보 4개<5 → 1건짜리 복귀):
    //   TRUST(거래 1건 배제)는 **무조건** — 표본 1은 어떤 경우에도 부적격(정직한 빈 결과 > 무의미 추천).
    //   HH(<100 확인분)만 후보 부족 시 완화('가능하면'). 인덱스 안전 위해 hh 를 객체에 동반.
    const _withHh = candidatePool.map((a, i) => ({ a, hh: _hh[i] }));
    const _base = _withHh.filter(x => (x.a.dealCount || 0) >= 2);            // TRUST: 무조건
    let _gated = _base.filter(x => !(x.hh != null && x.hh < 100));           // HH: 확인된 소형 제외
    if (_gated.length < 3) _gated = _base;                                    // HH 만 완화 (희소 지역)
    if (_gated.length !== candidatePool.length) {
      logger.info({ before: candidatePool.length, after: _gated.length }, 'PropertyService TRUST+HH 게이트');
    }
    candidatePool = _gated.map(x => x.a);
  }

  // Step 4: 거래량 가중 정렬 → 실거래 단지 우선 상위 15건
  const ranked = candidatePool
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
      // SCORE-MULTIFACTOR-2026-05-13 (Sprint Y — 운영자 발견: "왜 다 95점?"):
      //   기존: `min(95, 50 + min(dealCount,30)*1.5)` → dealCount ≥ 30 단지 모두 95점 (cap).
      //   변경: 다요인 합산 (거래량/신축/평형다양). facility-derived 보정은 enriched 단계에서.
      score: _calcBaseScore(apt),
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
      // 평형별 최근 시세 (사용자가 "지금 가격" 파악) — fit 평형만
      currentPriceByPyeong: apt.fitPyeongs.map(fp => ({
        pyeong: fp.pyeong,
        excluUseAr: fp.excluUseAr,
        recentAvg: parseFloat((fp.avgPrice / 10000).toFixed(2)),
        range: `${(fp.minPrice / 10000).toFixed(1)}~${(fp.maxPrice / 10000).toFixed(1)}억`,
        floorBands: fp.floorBands || null, // Sprint KKKKK — 저/중/고층 중위가 (표본 12건+ 시)
        dealCount: fp.dealCount,
        latestDeal: fp.recentTx[0] ? `${fp.recentTx[0].date.slice(2)} ${fp.recentTx[0].floor}층 ${(fp.recentTx[0].price / 10000).toFixed(2)}억` : '-',
      })),
      // AREA-OBS-2026-05-12: 단지의 **모든 관측 평형** (최근 6개월 거래된 distinct 평형).
      //   운영자 발견 (상계주공9 케이스): 단지 schema 의 12개 평형 중 5개만 표시되던 문제.
      //   현재 source 는 MOLIT 실거래 (KAPT 의 평형 list endpoint 미발굴) — 거래 sample 기반.
      //   단지정보 탭에서 "관측 평형" section 으로 노출.
      observedAreas: (apt.pyeongStats || []).map(p => ({
        pyeong: p.pyeong,
        excluUseAr: p.excluUseAr,
        dealCount: p.dealCount,
        avgPrice: parseFloat((p.avgPrice / 10000).toFixed(2)),
        floorBands: p.floorBands || null, // Sprint LLLLL — fit 평형 밖(대형 등)도 층별 중위가 열람 가능하게
      })).sort((a, b) => a.excluUseAr - b.excluUseAr),
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
  // NAME-CANON-2026-07-12 (Sprint UUUU, 전수조사 정정): 층구분 괄호(고층/저층) + '단지' 접미 정규화.
  //   MOLIT "상계주공9(고층)" ↔ KAPT "상계주공9단지" 를 canon 으로 매칭(TTTT '단지'-only 는 미해결).
  //   층 분할은 동일 단지 → 하나의 kaptCode 매핑이 정답. 차수/브랜드 괄호는 미제거(오병합 방지). 정확매칭 우선(!has).
  const canonName = (n) => n.replace(/\((?:고층|저층)\)$/, '').replace(/(?:아파트|단지)$/, '');
  for (const a of allAptList) {
    const nm = normalizeName(a.kaptName || a.aptName || '');
    if (!nm || !a.kaptCode) continue;
    const dong = a.as4 || a.as3 || '';
    kaptCodeMap.set(`${nm}|${dong}`, a.kaptCode);
    // 동명 없이도 찾을 수 있도록 fallback 키 저장 (같은 이름 여러 개면 첫 매칭 유지)
    if (!kaptCodeMap.has(nm)) kaptCodeMap.set(nm, a.kaptCode);
    const st = canonName(nm);
    if (st && st !== nm && !kaptCodeMap.has(st)) kaptCodeMap.set(st, a.kaptCode);
  }
  // allAptList 인덱스 (kaptCode → 원본 엔트리) — K-apt basis 실패 시 fallback 용
  const allAptByCode = new Map();
  for (const a of allAptList) {
    if (a.kaptCode) allAptByCode.set(a.kaptCode, a);
  }
  // REC-PERF-2026-07-10 (Sprint FFFF): kaptCode 사전 수집 → apt_master.facility 일괄 1쿼리(DB-first).
  //   콜드 KAPT 30콜(인메모리 캐시는 인스턴스 소실)이 완전콜드 잔여 ~10s 의 주 기여 — facility 컬럼이
  //   동일 raw(+_dtl)를 이미 보유(실측 99.7%) → miss(신규 단지·_empty 29개)만 기존 KAPT API 폴백.
  const preCodes = recommendations.map((rec, i) => {
    const apt = ranked[i];
    const nmKey = normalizeName(apt.aptName);
    return kaptCodeMap.get(`${nmKey}|${apt.umdNm || ''}`) || kaptCodeMap.get(nmKey) || kaptCodeMap.get(canonName(nmKey)) || null;
  });
  _mark('rank');
  const dbFacMap = await getFacilitiesByKaptCodes([...new Set(preCodes.filter(Boolean))]);
  // LLLLLL-3 (운영자 제보 'YM프라젠 83세대 소형이 세대수 null 로 게이트 우회'): KAPT 미매칭·세대수 null 단지는
  //   건축물대장(getBuildingTitle, SSSS 연동)으로 세대수 보강. building_register 캐시 우선 → miss 만
  //   지번(적재분)+Kakao 법정동+건축HUB(graceful 8s). 실패 시 null(기존 동작). top-15 로 bounded, Redis 캐시로 콜드 1회만.
  const _brHh = async (apt) => {
    try {
      const t = await getBuildingTitle({ lawdCd: apt.lawdCd, sigungu: apt.sigungu || '', umdNm: apt.umdNm || '', aptName: apt.aptName });
      return (t && Number.isFinite(t.hhldCnt) && t.hhldCnt > 0) ? t.hhldCnt : null;
    } catch (_) { return null; }
  };
  const enriched = await Promise.allSettled(
    recommendations.map(async (rec, i) => {
      const kaptCode = preCodes[i];
      if (!kaptCode) {
        // 이름 매칭 실패(KAPT 미등록/미매칭) — 건축물대장 세대수만이라도 보강해 카드 표시 + HH 게이트가 판정 가능하게.
        const brHh = await _brHh(ranked[i]);
        if (!brHh) return rec;
        const t2 = [...(rec.tags || []), ...(brHh >= 1000 ? ['대단지'] : brHh >= 500 ? ['중대단지'] : [])];
        return { ...rec, facility: { totalHouseholds: brHh, source: 'buildingRegister' }, tags: Array.from(new Set(t2)) };
      }
      // DTL-INFO-2026-05-13 (Sprint X): BasisInfo + Detail 병렬 fetch (주차 정보 포함)
      // Sprint FFFF: DB 보유분은 KAPT 콜 생략 (stored raw 의 _dtl 이 detail 역할)
      const stored = dbFacMap.get(kaptCode);
      // FILTER-INCOMPLETE-FALLBACK-2026-07-12 (Sprint ZZZZ): 주차필터 시 stored 에 _dtl(주차) 없으면 KAPT DTL
      //   재조회 → 카드 주차표시를 필터와 일치(공릉풍림처럼 필터엔 잡히나 카드 null 이던 불일치 해소). 필터가 방금
      //   조회해 in-memory 캐시 hit 이라 저비용. 미필터 경로·_dtl 보유분은 기존대로(추가 KAPT 콜 0).
      let info, detail;
      if (stored && stored._dtl) { info = stored; detail = stored._dtl; }
      else if (stored && fMinPark > 0) { info = stored; detail = await getAptDtlInfo(kaptCode).catch(() => null); }
      else if (stored) { info = stored; detail = null; }
      else {
        const [_i, _d] = await Promise.all([
          getAptBasisInfo(kaptCode),
          getAptDtlInfo(kaptCode).catch(() => null),
        ]);
        info = _i; detail = _d;
      }
      // FACILITY-HELPER-2026-05-12 + DTL-INFO-2026-05-13: detail 도 buildFacility 에 전달
      const facility = buildFacility(info, kaptCode, detail);
      // Fallback: info 없으면 allAptList 기본 데이터로 address 보강
      if (!info) {
        const basic = allAptByCode.get(kaptCode);
        if (basic && facility) {
          facility.address = basic.doroJuso || basic.as1 || null;
        }
      }
      // LLLLLL-3: KAPT 매칭됐어도 세대수(kaptdaCnt/hoCnt) 0/null 이면 건축물대장으로 보강.
      if (facility && !(facility.totalHouseholds > 0)) {
        const brHh = await _brHh(ranked[i]);
        if (brHh) facility.totalHouseholds = brHh;
      }
      // 추가 태그 — facility 값 기반
      const moreTags = [...(rec.tags || [])];
      const totalHouseholds = facility?.totalHouseholds || 0;
      const parkingRatio = facility?.parkingRatio;
      if (parkingRatio && parkingRatio >= 1.2) moreTags.push('주차여유');
      if (totalHouseholds >= 1000) moreTags.push('대단지');
      else if (totalHouseholds >= 500) moreTags.push('중대단지');
      // SCORE-MULTIFACTOR-2026-05-13 (Sprint Y): facility 알게 된 후 score 보정.
      const updatedScore = _applyFacilityToScore(rec.score, facility);
      return {
        ...rec,
        facility,
        score: updatedScore,
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
  // NAMEFIX-2026-05-11: coordInputs 의 aptName 은 **raw** 그대로 — apt_geocache cache key 호환성 보존.
  //   (Kakao query 정확도 ↑ 는 geocodeCacheService.kakaoGeocode 함수 내부에서 normalize 적용.)
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
  _mark('facility');
  // SCHOOL-PIPELINE-2026-07-18 (Sprint BBBBBB, 스테이지 실측: coords 2,938ms → schools 3,276ms 완전 순차):
  //   학군 DB 캐시(90일, 단지 키)는 좌표가 필요 없음 → 좌표 확보와 병렬 실행. 캐시 miss 단지만
  //   좌표 확보 후 2차(resolveSchools — Kakao 반경 검색·DB 저장은 기존 그대로). 결과 동일, 겹친 시간만 절약.
  const schoolCacheInputs = enrichedRecs.map((rec, i) => ({
    kaptCode: rec.facility?.kaptCode || null,
    aptName: rec.aptName,
    sigungu: ranked[i].sigungu || '',
    umdNm: ranked[i].umdNm || '',
  }));
  const [coords, schoolsCached] = await Promise.all([
    resolveCoordBatch(coordInputs, 8), // REC-PERF-2026-07-10: 4→8 (Kakao 실측 여유, 콜드 라운드 절반)
    getCachedSchoolsBatch(schoolCacheInputs, 8),
  ]);
  _mark('coords');

  // P1 (Phase 2 후속, 2026-04-25): 학군 데이터 — 좌표 확보된 단지만 학교 검색.
  // 카카오 keyword "초/중/고등학교" 반경 1km, 종류별 3개 = 9개 이내. DB 캐시 90일.
  // 학업성취도는 차후 학교알리미 API (사용자 키 발급 필요) 통합.
  // 캐시 miss 단지만 좌표 포함 2차 조회 (Kakao 검색 + DB 저장 — 기존 resolveSchools 경로 그대로)
  const schoolsArr = schoolsCached.map(s => s || []);
  const _schoolMissIdx = schoolsCached.map((s, i) => (s === undefined ? i : -1)).filter(i => i >= 0);
  if (_schoolMissIdx.length) {
    const missInputs = _schoolMissIdx.map(i => ({
      ...schoolCacheInputs[i], lat: coords[i]?.lat, lng: coords[i]?.lng,
    }));
    const fetched = await resolveSchoolsBatch(missInputs, 6); // REC-PERF-2026-07-10: 3→6
    _schoolMissIdx.forEach((origI, k) => { schoolsArr[origI] = fetched[k] || []; });
  }
  _mark('schools');
  // Sprint BBBBBB — 스테이지 분해 로그 (병목 실측 확정용, cold 에만 의미)
  logger.info({
    stageMs: {
      collect: _tt.collect - _tt.start,
      collectDetail: {
        queries: _tt.collectQ - _tt.start,
        alias: _tt.alias - _tt.collectQ,
        analyze: _tt.collect - _tt.alias,
      },
      rankFilter: _tt.rank - _tt.collect,
      facility: _tt.facility - _tt.rank,
      coords: _tt.coords - _tt.facility,
      schools: _tt.schools - _tt.coords,
    }, totalMs: _tt.schools - _tt.start,
  }, 'PropertyService 스테이지 타이밍');

  // NAMEFIX-2026-05-11: 사용자 응답에선 정규화된 단지명 노출 — "(고층)" 같은 MOLIT raw suffix 제거.
  //   DB raw apt_name 은 그대로 유지 (다른 매칭 흐름 호환). 표시 layer 만 정규화.
  const withCoords = enrichedRecs.map((rec, i) => {
    const c = coords[i];
    return {
      ...rec,
      aptName: normalizeAptName(rec.aptName),
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      // 좌표 출처 — 프론트에서 "정확" 마커와 fallback 구분 가능
      coordSource: c ? 'geocache' : null,
      // 학군: 종류별 가까운 학교 (학업성취도 X — 사실 나열만)
      nearbySchools: schoolsArr[i] || [],
    };
  });
  const missingCoords = withCoords.filter(r => r.lat == null).length;
  if (missingCoords > 0) {
    logger.info({ total: withCoords.length, missing: missingCoords },
      'propertyService: 일부 단지 좌표 해결 실패 — 프론트에서 마커 생략');
  }

  // LLLLLL-3 HH-GATE (건축물대장 보강 후): 세대수 확인된 100세대 미만 제외 (운영자 지시 "이딴것들 추천하지 말라").
  //   미확인(null) 유지. index 정렬 불요(withCoords 최종). **1개라도 남으면 소형 전부 제외** — 오직 후보 전부가
  //   소형일 때만(빈 결과 방지) 유지 = '가능하면 제외'의 강한 해석. LLLLLL-3.1(배포 실측: YM프라젠 83세대가
  //   후보 2개 상황에서 >=3 임계로 살아남던 것 → 임계 1로 강화).
  let finalRecs = withCoords;
  {
    const _big = withCoords.filter(r => !(Number.isFinite(r.facility?.totalHouseholds) && r.facility.totalHouseholds < 100));
    if (_big.length >= 1 && _big.length !== withCoords.length) {
      logger.info({ before: withCoords.length, after: _big.length }, 'PropertyService HH-GATE(건축물대장 보강): 100세대 미만 제외');
      finalRecs = _big;
    }
  }

  const result = {
    recommendations: finalRecs,
    targetRegions,
    totalTxAnalyzed: analyzed.length,
    totalAptsInRegion: allAptList.length,
    inBudgetCount: matched.length,
    // 참고단지 기능 제거 (2026-04-25) — 하위 호환 위해 0 유지
    referenceCount: 0,
    coordMissingCount: missingCoords,
    disclaimer: '본 결과는 국토교통부 실거래가 데이터 기반 정보 정리이며, 매수·매도 추천이 아닙니다. 모든 의사결정의 책임은 본인에게 있습니다.',
  };
  cache.set(cacheKey, result, 10800); // REC-PERF-2026-07-10 (Sprint EEEE): 30min→3h — 데이터는 daily cron만 갱신, 인기 조합 콜드 빈도 1/6
  require('./redisCache').rset(cacheKey, result, 10800).catch(() => {}); // Sprint AAAAAA — 인스턴스 간 공유(fire-and-forget)
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

// TEST-EXPORT-2026-07-17 (Sprint XXXXX): computeLTV 는 순수 함수 — 특성화 테스트용 export 추가(동작 불변).
module.exports = { getAIRecommendations, pickRegions, computeLTV };
