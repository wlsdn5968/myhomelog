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
const { parseWalkBand, WALK_BAND_LABEL } = require('../utils/walkBand');
const { turnoverScore, isExcludedAptType, interestScore } = require('../utils/scoreBands');
const { getAptListBySgg, getAptBasisInfo, getAptDtlInfo } = require('./aptInfoService');
const { resolveCoordBatch } = require('./geocodeCacheService');
const { resolveSchoolsBatch, getCachedSchoolsBatch } = require('./schoolService');
const { isRegulatedRegion, getRegulatedKeywords, SEOUL_GU_KEYWORDS } = require('./regulationsService');
const { normalizeAptName } = require('../utils/aptName');
const { buildFacility } = require('../utils/buildFacility');
// REC-PERF-2026-07-10 (Sprint FFFF): apt_master.facility 배치 조회 — 콜드 KAPT 30콜 제거
// IDENTITY-GATE-2026-08-10 (Sprint KKKKKKK): 이 경로는 resolveFacility 를 거치지 않고 자체 이름
//   매칭(_norm/_canon)으로 kaptCode 를 얻으므로, 그 검증 게이트가 닿지 않는다. 붙은 facility 가
//   실거래 건축년도와 어긋나면 필터·게이트 판정이 통째로 틀어지므로 여기서도 같은 검증을 적용한다.
const { getFacilitiesByKaptCodes, verifyCandidate, getAptListByLawdFromDb, bonbun, resolveFacility } = require('./aptFacilityService');
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
  //   REGION-SWAP-2026-08-10: '광주서'(29140) 제거 — 광주광역시가 전남광주통합특별시로 편입돼
  //   구 코드가 폐지됐고, 운영자 방침상 전라권 미지원. 대신 청주 4개 구를 추가한다.
  //   '청주'는 경기 '광주'(41610)와 달리 충돌 키워드가 없다.
  '해운대': ['26350'], '수영': ['26500'], '수성': ['27260'], '유성': ['30200'],
  '청주': ['43111', '43112', '43113', '43114'],
  '상당': ['43111'], '서원': ['43112'], '흥덕': ['43113'], '청원': ['43114'],
  // 경기 — COVERAGE-EXPAND-2026-07-12 (Sprint VVVV). 구 단위 세부를 도시 키워드보다 먼저 나열:
  //   pickRegions 는 combined.includes(kw) 첫 매칭을 반환하므로 세부 구가 우선돼야 정확히 해석됨.
  '덕양': ['41281'], '일산동': ['41285'], '일산서': ['41287'],
  '만안': ['41171'], '동안': ['41173'], '평촌': ['41173'],
  '처인': ['41461'], '기흥': ['41463'], '수지': ['41465'],
  '장안': ['41111'], '권선': ['41113'], '팔달': ['41115'], '영통': ['41117'],
  '수정': ['41131'], '중원': ['41133'], '분당': ['41135'], '판교': ['41135'],
  '원미': ['41192'], '소사': ['41194'], '오정': ['41196'],
  '상록': ['41271'], '단원': ['41273'], '미사': ['41450'],
  // HWASEONG-4GU-2026-08-30 (Sprint OOOOOOO, 운영자 친구 실제 질문에서 발각): 화성시 4개 구 중
  //   동탄구(41597)만 있었다. 병점구 41595 · 효행구 41593 · 만세구 41591 (KAPT as2 실조회로 확정).
  //   ⚠ **'서동탄' 을 '동탄' 보다 반드시 앞에 둔다** — `combined.includes(kw)` 는 첫 매칭을 반환하므로
  //     뒤에 두면 "서동탄역파크자이"를 찾는 입력이 동탄구(41597)로 새고, 그 단지는 거기 없다.
  //     이 저장소가 반복해 겪은 "부분문자열이 더 긴 이름을 삼킨다" 계열이다.
  '서동탄': ['41595'], '병점': ['41595'], '진안': ['41595'],
  '봉담': ['41593'], '향남': ['41593'], '기안': ['41593'],
  '새솔': ['41591'], '송산': ['41591'],
  '동탄': ['41597'],
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

/**
 * SIDO-SCOPE-2026-08-10 (Sprint KKKKKKK-9): 광역 접두가 있으면 **그 시도 안에서만** 구를 찾는다.
 *
 * [환각 실측] REGION_KEYWORDS 는 `'중구': ['11140']`·`'강서': ['11500']` 처럼 **서울 코드 하나로
 *   고정**돼 있는데, DB 에는 동명 시군구가 실재한다(molit_transactions 실측):
 *     '중구' 6곳(서울11140·부산26110·대구27110·인천28110·대전30140·울산31110, 11,243건)
 *     '서구' 4곳(17,350건) · '동구' 5곳 · '남구'/'북구' 3곳 · '강서구' 2곳(서울11500·부산26440)
 *   그래서 "부산 중구"를 입력해도 아래 1)단계가 '중구'를 매칭해 **서울 중구 아파트**를 추천했다.
 *   프론트는 항상 "광역 세부"(예 "인천 서구") 형태로 보내므로(index.html getRegionForSearch),
 *   광역을 먼저 확정하면 이 모호성이 원천 제거된다.
 *
 * ⚠ 가장 **긴** 구 이름을 택한다 — "인천 남동구"에서 '동구'가 부분문자열로 걸리기 때문.
 * ⚠ 경기는 제외 — LAWD_CODES 키가 '성남시분당구' 형태라 사용자 입력('분당')과 형태가 달라
 *   기존 REGION_KEYWORDS(분당·판교 등 고유 별칭)가 이미 정확히 처리한다.
 */
const _SIDO_PFX = [['서울', '11'], ['인천', '28'], ['부산', '26'], ['대구', '27'],
  ['대전', '30'], ['울산', '31'], ['세종', '36'], ['청주', '43']];
function _scopedBySido(text) {
  const hit = _SIDO_PFX.find(([nm]) => text.includes(nm));
  if (!hit) return null;
  const pfx = hit[1];
  const { LAWD_CODES } = require('./transactionService');
  let best = null;
  for (const [name, code] of Object.entries(LAWD_CODES)) {
    if (!String(code).startsWith(pfx)) continue;
    // LAWD_CODES 키는 광역 접두를 갖는다('인천중구'·'부산중구'). 서울·세종은 접두가 없다.
    const gu = String(name).replace(/^(인천|부산|대구|대전|울산)/, '');
    if (gu.length >= 2 && text.includes(gu) && (!best || gu.length > best.name.length)) {
      best = { lawdCd: code, name: gu };
    }
  }
  return best ? [best] : null;
}

/**
 * JIBUN-MATCH-2026-08-30 (Sprint OOOOOOO): 단지명이 달라도 **같은 땅이면 같은 단지**다.
 *
 * [왜 필요한가 — 실측] MOLIT 실거래명과 KAPT 등록명은 접두·어순이 다르다:
 *   "충무주공(872)" ↔ 산본주공충무1 · "개나리주공13" ↔ 산본13단지개나리 · "가야주공" ↔ 가야1차
 *   전국 최근 6개월 거래 단지 16,466곳 중 이름 정확일치는 **2,588곳(15.7%)** 뿐이고,
 *   동+지번 본번으로 맞추면 **10,104곳(61.4%)** 이 붙는다. 이름 규칙을 더 손대는 건 답이 아니다.
 *   (aptFacilityService.findMaster 가 이미 같은 원리를 1순위로 쓴다 — 여기선 그 규칙을 배치로 재사용한다.)
 *
 * ⚠ 오매칭 차단: (동|본번) 키가 **유일할 때만** 즉시 채택한다. 전국 지번키 12,803개 중 중복은
 *   880개(6.9%) — 그때는 준공연도가 정확히 하나만 맞을 때만 채택하고, 아니면 포기한다.
 *   "그럴듯한 틀린 정보"보다 "정보 없음"이 낫다(절대 룰).
 */
function buildJibunIndex(list) {
  const idx = new Map();
  for (const a of list || []) {
    if (!a || !a.kaptCode || !a.jibunBon) continue;
    const dong = a.as3 || a.as4 || '';
    if (!dong) continue;
    const k = `${dong}|${a.jibunBon}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ kaptCode: a.kaptCode, year: Number(String(a.kaptUsedate || '').slice(0, 4)) || 0 });
  }
  return idx;
}
function lookupByJibun(idx, apt) {
  if (!idx || !idx.size || !apt) return null;
  const bon = bonbun(apt.jibun);
  const dong = apt.umdNm || '';
  if (!bon || !dong) return null;
  let hits = idx.get(`${dong}|${bon}`);
  // EUPMYEON-FALLBACK-2026-08-30 (Sprint OOOOOOO): 군(郡)·읍면 지역은 표기 단위가 다르다 —
  //   MOLIT 은 "와부읍 덕소리"(읍/면 + 리)로 신고하는데 KAPT 는 "와부읍"(읍/면 단독)으로 등록한다.
  //   그래서 동등 비교가 **전건 실패**한다. aptFacilityService.findMaster 가 이미 같은 폴백을 갖고 있고
  //   그때 실측이 231/240(96.3%) 였다 — 배치 색인에도 같은 규칙을 준다(사본이 아니라 같은 규칙의 적용).
  //   [이번 실측] 미매칭 8,093 단지 중 '그 동에 KAPT 0곳'이 1,919 단지·17,310 거래인데,
  //   상위가 전부 이 패턴이다(남양주 와부읍 덕소리 365건 · 오남읍 오남리 272건 · 대구 유가읍 봉리 225건).
  //   ⚠ 지번 본번까지 함께 맞아야 채택되므로 읍/면 단위로 넓혀도 오매칭 위험은 커지지 않는다.
  if ((!hits || !hits.length) && /\s/.test(dong)) {
    const eupMyeon = dong.trim().split(/\s+/)[0];
    if (eupMyeon && eupMyeon !== dong) hits = idx.get(`${eupMyeon}|${bon}`);
  }
  if (!hits || !hits.length) return null;
  if (hits.length === 1) return hits[0].kaptCode;
  // 한 필지에 여러 KAPT 단지 — 준공연도로만 가른다(±1년). 유일하게 좁혀질 때만 채택.
  const by = Number(apt.buildYear) || 0;
  if (!by) return null;
  const near = hits.filter(h => h.year && Math.abs(h.year - by) <= 1);
  return near.length === 1 ? near[0].kaptCode : null;
}

/**
 * REGION-CODE-2026-08-30 (Sprint OOOOOOO, 운영자 "경기는 시 자체도 이상하고 동탄이 없다"):
 *   `lawdCd` 를 받으면 **문자열 해석을 건너뛴다**. 이 저장소가 6회 반복해 겪은 결함이
 *   전부 "행정구역을 이름 문자열로 판정"에서 나왔다([[region-judgment-by-lawdcd]]).
 *   프론트 칩이 코드를 그대로 실어 보내면 그 계열 전체가 원천 제거된다.
 *   ⚠ 반드시 LAWD_CODES 에 실재하는 코드만 채택한다 — 임의 코드로 조회를 열지 않는다.
 *   ⚠ name 은 시군구 이름을 준다(광역 이름이면 안 된다) — report.js 가 name 으로
 *     "세부 해석 성공" 여부를 판별하기 때문이다.
 */
function pickRegions(userRegion = '', maxBudget = 0, workplaceArea = '', lawdCd = '') {
  // MULTI-REGION-2026-08-30 (Sprint OOOOOOO, 운영자 "화성시 동탄·만세·병점·효행 이런식으로 복수 선택"):
  //   `lawdCd` 는 콤마 구분 다중 코드를 받는다("41597,41595"). 실제 생활권은 행정구 경계와
  //   일치하지 않는다 — 화성시가 4개 구로 갈리면서 한 도시를 보려면 4번 검색해야 했다.
  //   ⚠ LAWD_CODES 화이트리스트를 통과한 코드만 채택하고, 중복은 제거한다.
  //   ⚠ 상한 MAX_MULTI — 지역 수만큼 실거래·단지목록 조회가 늘어난다(무제한이면 타임아웃).
  const MAX_MULTI = 6;
  const _codes = String(lawdCd || '').split(',').map(s => s.trim()).filter(s => /^\d{5}$/.test(s));
  if (_codes.length) {
    const { LAWD_CODE_TO_NAME } = require('./transactionService');
    const out = [];
    const seen = new Set();
    for (const c of _codes) {
      if (seen.has(c)) continue;
      const nm = LAWD_CODE_TO_NAME[c];
      if (!nm) { logger.warn({ lawdCd: c }, 'pickRegions: LAWD_CODES 에 없는 코드 — 무시'); continue; }
      seen.add(c);
      out.push({ lawdCd: c, name: nm });
      if (out.length >= MAX_MULTI) break;
    }
    if (out.length) return out;
    logger.warn({ lawdCd }, 'pickRegions: 유효한 코드가 하나도 없다 — 문자열 해석으로 폴백');
  }
  // Unicode NFC 정규화 — 일부 OS(Mac)/브라우저에서 한글이 NFD(분해형)로 전달돼
  // "강북" 같은 NFC 키워드와 문자열 비교 실패하는 버그 방지
  const r = String(userRegion || '').normalize('NFC').replace(/\s+/g,'');
  const wp = String(workplaceArea || '').normalize('NFC').replace(/\s+/g,'');
  const combined = r + ' ' + wp;
  logger.debug({ userRegion, r, wp, maxBudget }, 'pickRegions 진입');
  // 0) 광역 접두가 있으면 그 시도 범위로 먼저 확정 — 동명 구('중구'·'서구'…) 환각 차단.
  //    userRegion 만 본다(workplaceArea 는 자유 입력이라 광역 판정 근거로 쓰기엔 신뢰도가 낮다).
  const scoped = _scopedBySido(r);
  if (scoped) return scoped;
  // 1) 사용자 입력에서 구 단위 키워드 매칭 (광역 키워드는 후순위)
  const SKIP_GLOBAL = new Set(['서울','경기','인천']);
  for (const [kw, codes] of Object.entries(REGION_KEYWORDS)) {
    if (!SKIP_GLOBAL.has(kw) && combined.includes(kw)) {
      return codes.map(c => ({ lawdCd: c, name: kw }));
    }
  }
  // 2) 광역만 입력 — REC-BROAD-ALL-2026-09-05 (운영자 재실사고 "서울 6.5억 결과가 더 이상해졌다"):
  //   종전 ① 예산 구간별 하드코딩 3구 → ② 예산 밴드 실거래 분포 상위 5구(REC-BROAD, 같은 날 1차 수정)
  //   둘 다 틀렸다. 서울 25개 구를 **전부 개별 조회해 합친** 상위 15곳과 5구 결과는 **2곳만 겹쳤다**
  //   (라이브 실측). "어느 구를 볼지"를 예산으로 미리 고르는 발상 자체가 정답을 놓친다 — '서울'을 고른
  //   사용자에게 대상은 **서울 전체**다(보고서 경로는 이미 25구 전수). 그래서 광역은 그 시도의 **모든
  //   시군구**를 돌려준다. 비용은 호출측(getAIRecommendations)이 광역 모드로 통제한다
  //   (DB 단일쿼리만·라이브 KAPT 목록 생략·MOLIT API 폴백 생략).
  //   ⚠ 폐지 코드(RETIRED_LAWD_CODES)는 뺀다 — 적재가 멈춘 코드에 빈 조회를 던질 이유가 없다.
  const _mkBroad = (arr, pfx) => Object.assign(arr, { _broad: pfx });
  const _sidoOf = (pfx) => {
    const { LAWD_CODES: _LC, RETIRED_LAWD_CODES: _RET } = require('./transactionService');
    const seen = new Set();
    const out = [];
    for (const [name, code] of Object.entries(_LC)) {
      const c = String(code);
      if (!c.startsWith(pfx) || seen.has(c) || (_RET && _RET.has(c))) continue;
      seen.add(c);
      out.push({ lawdCd: c, name });
    }
    return out;
  };
  if (!r || r.includes('서울')) return _mkBroad(_sidoOf('11'), '11');
  // 3) 광역 매칭 (인천/경기) — 동일하게 시도 전체 + 마커
  for (const wide of ['인천', '경기']) {
    if (r.includes(wide)) {
      const pfx = wide === '인천' ? '28' : '41';
      return _mkBroad(_sidoOf(pfx), pfx);
    }
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
  // REG-LABEL-FIX-2026-07-25 (Sprint UUUUUU): 2주택+ 는 isRegulated 와 무관하게 '(규제)' 를 붙이고
  //   있었다 → **비규제 지역 단지에 "규제" 라고 표기**되는 사실 오류(다른 모든 분기는 지역 상태를
  //   정확히 반영한다). LTV 0% 자체는 유지 — 2주택 이상은 규제지역·수도권 구입 불가(스냅샷 note).
  //   접미사는 '지역이 규제인가'만 나타내므로 isRegulated 를 그대로 쓴다.
  //   ※ 프론트가 이 접미사로 마커·필터의 규제 여부를 판정(_isRegProp)하므로 정확성이 표시에 직결된다.
  if (houseStatus === '2주택+') return { ltv: `0% ${isRegulated ? '(규제)' : '(비규제)'}`, maxLoan: '0억' };
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
/**
 * SCORE-V2-2026-08-30 (Sprint OOOOOOO, 운영자 "위치·교통·인프라·거래활발이 더 중요하다. 점수표를 다시 객관화"):
 *
 * [기존 모델의 문제 — 실측]
 *   거래량 30점 · 신축 18 · 평형다양 8 · 세대수 8 · 주차 4 · **지하철 도보 4** · 교육 2.
 *   운영자가 1순위로 꼽은 교통이 **거래량의 1/7.5** 였고, 병원·마트 같은 생활 인프라는
 *   추천 경로 점수에 **아예 없었다**(amenities 를 쓰지 않았다).
 *
 * [무엇을 근거로 쓸 수 있나 — 전수 실측]
 *   KAPT 지하철 도보시간 10,785/14,660(73.6%) · 버스 도보 13,815(94.2%) · 교육시설 11,048(75.4%)
 *   도보시간은 이미 5단계로 들어온다(5분이내 / 5~10 / 10~15 / 15~20 / 20분초과) —
 *   기존엔 앞 두 단계만 쓰고 4점·2점을 줬다. 경기 남부 892단지 기준 역5분내 69곳(7.7%)로 변별력 충분.
 *
 * [배점 — 총 100점] 운영자 승인
 *   교통 30 · 생활인프라 20 · 단지규모/주차 15 · 거래활발 15 · 연식 12 · 평형다양 8
 *
 * ⚠ **모르는 것은 0점이 아니라 중간값**을 준다. 도보시간 미보유가 26% 인데 0점 처리하면
 *   데이터 없는 단지가 부당하게 밀린다 — 이 저장소가 이미 겪은 실수다([[unknown-treated-as-value]]:
 *   세대수 미확인 407곳이 소형으로 배제됐고, 교차검증한 17곳은 전부 100세대 이상이었다).
 *
 * ⚠ 점수는 **매수 추천이 아니다** — 객관 지표의 가중합이고, 근거를 breakdown 으로 함께 내보낸다.
 *
 * ── SCORE-V3-2026-08-30 (Sprint PPPPPPP) — 운영자 보고서 리뷰 반영 ──────────
 * 운영자: "회전율도 별로 안 좋은 것 같고, 사람들이 좋아하는 매물은 가격도 많이 오른다.
 *          호갱노노 순위 같은 것도 중요하다 — 단기 말고 1년·3년 오래 검색되는 곳."
 *
 * [실측으로 확인된 결함] 거래 점수가 **절대 건수**라 대단지가 자동으로 유리했다.
 *   보고서 1위 푸른마을포스코더샵2차는 43건으로 건수 1위였지만 1,226세대라
 *   회전율은 3.51% 로 4위였다(서동탄역파크자이 6.42% · 동탄파크푸르지오 5.81% · 자연앤데시앙 4.42%).
 *   → 거래는 **세대수로 정규화한 회전율**로 판정한다.
 *   전국 회전율 분포(6개월, 100세대 이상 2,981단지 실측):
 *     p10 0.70% · p25 1.25% · p50 2.03% · p75 3.02% · p90 4.11% · p99 7.41%
 *
 * [신설] 관심도 14점 — 네이버 데이터랩 36개월 검색 지수(앵커 정규화 중앙값).
 *   호갱노노는 공개 API 가 없고 스크래핑은 약관 위반이라, 같은 목적을 공식 API 로 달성한다.
 *   ⚠ 검색량은 '좋은 단지' 가 아니라 '많이 회자되는 단지' 다 — 근거 문구에 그대로 쓴다.
 */
const SCORE_V2_MAX = { 교통: 28, 인프라: 16, 규모주차: 12, 거래: 14, 연식: 10, 평형: 6, 관심도: 14 };

/**
 * 아파트가 아닌 유형 — 추천 순위에서 제외한다(검색·상세는 그대로 둔다).
 * 운영자: "오피스텔 느낌은 다들 안 좋아하니 이런 매물은 다 제외시켜줘."
 * KAPT `codeAptNm` 실측 분포: 아파트 12,730 · 주상복합 1,261 · 연립주택 185 ·
 *   도시형 생활주택 144 · 다세대 9 · 미상 331.
 * ⚠ **주상복합은 제외하지 않는다** — 1,261곳이고 대형 브랜드 단지가 다수라
 *   '오피스텔 느낌' 과 동의어가 아니다. 근거 없이 자르면 멀쩡한 단지를 지운다.
 * ⚠ 유형이 비어 있으면(331곳) 제외하지 않는다 — 모름은 배제 사유가 아니다
 *   ([[unknown-treated-as-value]]).
 */
// EXCLUDED_APT_TYPES 는 utils/scoreBands 에 있다(사본 금지).

/** facility 의 유형이 추천에서 배제 대상인가. 판정은 utils/scoreBands 한 곳에만 둔다. */
function _isExcludedType(facility) {
  return isExcludedAptType(facility && facility.aptType);
}
/** 연식·평형 — facility 없이 계산 가능한 부분. 거래는 세대수가 필요해 뒤로 미룬다. */
function _calcBaseScore(apt) {
  const b = {};
  // 연식 (10)
  const yr = parseInt(apt.buildYear) || 0;
  const age = yr ? (new Date().getFullYear() - yr) : null;
  b.연식 = age === null ? 5 // 모름 → 중간값
    : age <= 5 ? 10 : age <= 10 ? 8 : age <= 20 ? 6 : age <= 30 ? 3 : 2;
  // 평형 다양 (6) — 갈아타기·가족 변화 대응 폭
  const distinctP = Array.isArray(apt.pyeongStats) ? new Set(apt.pyeongStats.map(p => p.pyeong)).size : 0;
  b.평형 = Math.min(SCORE_V2_MAX.평형, distinctP * 2);
  const total = b.연식 + b.평형;
  // dealCount 를 들려 보낸다 — 회전율은 세대수를 아는 _applyFacilityToScore 에서 계산한다.
  return { total, breakdown: b, dealCount: Number(apt.dealCount) || 0 };
}

// enriched 단계에서 facility 받은 후 추가 보정
//   기본 (Sprint Y): 단지 규모 (max 8) + 주차 (max 4) = +12점
//   확장 (Sprint CC+): 위치 가치 (지하철 도보 + 교육시설) = +6점
/**
 * SCORE-V2-2026-08-30: 교통(30) + 인프라(20) + 규모·주차(15) 를 더해 100점을 완성한다.
 * @param {object} base   _calcBaseScore 결과 { total, breakdown }
 * @param {object} facility buildFacility 결과
 * @param {object} [amen] 카카오 반경 카운트 { subway, school, hospital, mart, park } — 없으면 KAPT 로만
 */
function _applyFacilityToScore(base, facility, amen) {
  const b = Object.assign({}, (base && base.breakdown) || {});
  const why = [];

  // ── 교통 30 ─────────────────────────────────────────────────────────────
  //
  // TRANSIT-TRUTH-2026-08-30: 우선순위가 **뒤집혔다**. 이전엔 KAPT 신고값이 1순위였다.
  //   좌표 보유 2,778 단지를 카카오로 실측해 신고 밴드와 대조한 결과 —
  //     일치 42.6% · 한 칸 차 41.6% · **두 칸 이상 어긋남 15.8%(413곳)**.
  //   신고가 실제보다 가깝다고 말한 '과대신고' 347곳(동탄파크한양수자인 "10~15분" ↔ 동탄역 2,441m).
  //   → **잰 거리(1순위) > 신고값(2순위) > 반경 역 수(3순위) > 버스 신고값(4순위) > 중간값**.
  //
  // 구간 근거 — 카카오 도보 길찾기 **실측 5건** 으로 보정했다(추정 아님):
  //     미도 215m→4.5분 / 서동탄역파크자이 659m→20.2분 / 화서역파크푸르지오 861m→24.6분
  //     권선자이e편한세상 1,072m→27.1분 / 서동탄역더샵파크시티 1,129m→26.8분
  //   보행속도는 62~67 m/분으로 일정하나 **우회계수가 1.40~1.97 로 흔들린다**.
  //   ⚠ 그래서 직선거리로 "도보 몇 분" 을 **단정하지 않는다**. 구간만 나누고,
  //     사용자에게는 잰 값(역 이름 + 직선 m)을 그대로 보여준다.
  //
  // ⚠ 지하철이 없는 지역은 전 단지가 최저점이 되어 교통의 변별력이 0 이 된다.
  //   그건 사실이므로 왜곡이 아니다 — 그 지역 순위는 나머지 70점으로 갈린다.
  let 교통 = null;
  const nearM = amen ? amen.subwayNearestM : undefined;
  if (nearM === null) {
    // 반경 3km 안에 역이 없다 — 실패가 아니라 **관측된 사실**이다.
    교통 = 1;
    why.push('반경 3km 내 지하철역 없음');
  } else if (Number.isFinite(Number(nearM))) {
    const d = Number(nearM);
    교통 = d <= 250 ? 28 : d <= 450 ? 22 : d <= 650 ? 16 : d <= 900 ? 10 : d <= 1400 ? 6 : d <= 2500 ? 3 : 1;
    const st = (amen && amen.subwayNearestName) ? amen.subwayNearestName : '지하철역';
    why.push(`${st} 직선 ${d}m`);
  }
  // 2순위 — KAPT 자기신고 밴드. ⚠ includes() 부분문자열 매칭 금지:
  //   `"10~15분이내".includes("5분이내")` 는 참이라, 예전엔 10~15분 단지 2,429곳이
  //   교통 만점을 받았다(만점 단지의 55.7% 가 가짜). parseWalkBand 로 닫힌 집합을 쓴다.
  if (교통 === null) {
    const band = parseWalkBand(facility && facility.walkSubwayMin);
    if (band) {
      교통 = { LE5: 24, M5_10: 18, M10_15: 12, M15_20: 7, GT20: 3 }[band];
      why.push(`지하철 도보 ${WALK_BAND_LABEL[band]}(관리사무소 신고값)`);
    }
  }
  // ⚠ NULL-NOT-ZERO-2026-09-02 (감사 P0-2): `Number(null) === 0` → null 체크가 없으면
  //   카카오 조회 실패가 "반경 1.2km 지하철역 0곳"(교통 4점, 최저 밴드)으로 둔갑한다.
  if (교통 === null && amen && amen.subway != null && Number.isFinite(Number(amen.subway))) {
    const n = Number(amen.subway);
    교통 = n >= 4 ? 22 : n >= 2 ? 17 : n >= 1 ? 11 : 4;
    why.push(`반경 1.2km 지하철역 ${n}곳`);
  }
  if (교통 === null) {
    const busBand = parseWalkBand(facility && facility.walkBusMin);
    if (busBand === 'LE5') { 교통 = 12; why.push('버스 도보 5분 이내(신고값)'); }
    else if (busBand === 'M5_10') { 교통 = 9; why.push('버스 도보 5~10분(신고값)'); }
  }
  if (교통 === null) { 교통 = 15; why.push('교통 정보 미확인(중간값)'); } // 모름 → 중간
  b.교통 = 교통;

  // ── 생활 인프라 16 ─────────────────────────────────────────────────────────
  //   카카오 반경 카운트(학교·병원·마트). 만점 배분은 학교 6 · 병원 5 · 마트 5.
  //
  // ⚠ NULL-NOT-ZERO-2026-08-30 (Sprint PPPPPPP): 조회 실패를 0 으로 읽으면
  //   "주변에 병원이 없다" 는 **사실 주장**이 된다. 실제로 그런 일이 있었다 —
  //   카카오 키워드 검색 `size` 상한이 15 인데 45 를 넘겨 전건 400 이 떨어졌고,
  //   catch 가 0 을 돌려줘 화면엔 "종합병원 0" 이, 점수엔 0점이 찍혔다(런타임 로그 실측).
  //   → 이제 실패는 null 이고, **아는 항목만으로 채점한 뒤 만점으로 환산**한다.
  //     하나도 모르면 중간값. 모름을 나쁨으로 만들지 않는다([[unknown-treated-as-value]]).
  let 인프라 = null;
  if (amen) {
    const parts = [
      { v: amen.school, max: 6, band: (n) => (n >= 10 ? 6 : n >= 5 ? 4 : n >= 2 ? 2 : 0) },
      { v: amen.hospital, max: 5, band: (n) => (n >= 3 ? 5 : n >= 1 ? 3 : 0) },
      { v: amen.mart, max: 5, band: (n) => (n >= 3 ? 5 : n >= 1 ? 3 : 0) },
    ];
    const known = parts.filter(p => p.v !== null && p.v !== undefined && Number.isFinite(Number(p.v)));
    if (known.length) {
      const got = known.reduce((a, p) => a + p.band(Number(p.v)), 0);
      const cap = known.reduce((a, p) => a + p.max, 0);
      인프라 = Math.round((got / cap) * SCORE_V2_MAX.인프라);
      const fmt = (x) => (x === null || x === undefined ? '미확인' : x);
      why.push(`학교 ${fmt(amen.school)}·병원 ${fmt(amen.hospital)}·마트 ${fmt(amen.mart)}`);
    }
  }
  if (인프라 === null) {
    const edu = String((facility && facility.educationFacility) || '');
    const cvn = String((facility && facility.convenientFacility) || '');
    const meaningful = (t) => t.replace(/[가-힣A-Za-z]+\(\s*\)/g, '').replace(/[,\s]/g, '').length >= 5;
    인프라 = (meaningful(edu) ? 4 : 0) + (meaningful(cvn) ? 4 : 0);
    // 둘 다 없으면 중간값 — 정보 없음이지 인프라 없음이 아니다.
    if (인프라 === 0) { 인프라 = Math.round(SCORE_V2_MAX.인프라 * 0.5); why.push('생활시설 정보 미확인(중간값)'); }
  }
  b.인프라 = 인프라;

  // ── 단지 규모·주차 15 ──────────────────────────────────────────────────────
  const th = (facility && facility.totalHouseholds) || 0;
  // SCALE-BANDS-2026-09-05: 100~299세대를 300~499와 같은 3점으로 두면 규모 항목이 소단지를 변별하지 못했다
  //   (프리뷰 실측: 111~340세대 소단지가 상위 15를 채웠다). 300 미만 1점·300~499 3점. 0=모름은 종전대로 중간(5).
  let 규모 = th >= 3000 ? 9 : th >= 1500 ? 8 : th >= 1000 ? 7 : th >= 500 ? 5 : th >= 300 ? 3 : th > 0 ? 1 : 5;
  // HH-CONFLICT: 세대수 원천이 갈린 단지는 주차 비율의 분모를 믿을 수 없다(실측 6.07대/세대까지 부푼다).
  //   점수를 깎지도 않는다 — 모르는 것은 중간값이다.
  const pr = (facility && facility.householdsConflict) ? null : ((facility && facility.parkingRatio) || null);
  const 주차 = pr === null ? 3 : pr >= 1.2 ? 6 : pr >= 1.0 ? 5 : pr >= 0.8 ? 4 : 2;
  b.규모주차 = Math.min(SCORE_V2_MAX.규모주차, 규모 + 주차);

  // ── 거래 회전율 14 ─────────────────────────────────────────────────────
  //   ⚠ 절대 건수가 아니라 **세대수 대비 비율**이다. 건수로 재면 대단지가 자동으로 이긴다 —
  //   운영자가 보고서에서 짚은 결함이다(43건/1,226세대 = 3.51% 가 건수 1위로 표시됐다).
  //   구간은 전국 실측 분위수(6개월, 100세대 이상 2,981단지): p25 1.25 · p50 2.03 · p75 3.02 · p90 4.11.
  const _deals = Number(base && base.dealCount) || 0;
  const _hh = (facility && facility.totalHouseholds) || 0;
  {
    // ⚠ 구간은 utils/scoreBands 한 곳에만 있다 — 보고서 경로와 **같은 기준**을 써야 한다.
    const t = turnoverScore(_deals, _hh, SCORE_V2_MAX.거래);
    b.거래 = t.score;
    why.push(t.why);
  }
  // ── 장기 관심도 14 ─────────────────────────────────────────────────────
  //   네이버 데이터랩 36개월 검색 지수를 앵커(은마아파트) 중앙값 대비 비율로 정규화한 값.
  //   운영자: "단기 일주일 순위보다 1년·3년 오래 검색되는 곳이 좋다."
  //   [실측 기준점] 헬리오시티 1.15 · 서동탄역파크자이 0.057 · 푸른마을포스코더샵2차 0.0017
  //   → 검색량은 자릿수로 갈리므로 구간도 로그 간격으로 둔다.
  //   ⚠ 캐시에 없으면(=아직 안 채워짐) 7점(중간). 조회 실패를 '무명 단지' 로 만들지 않는다.
  //   구간은 utils/scoreBands 한 곳에만 있다(전국 1,551단지 실분위수로 보정).
  {
    const _ni = amen && amen.interestRatio;
    const it = interestScore(_ni == null ? null : _ni, SCORE_V2_MAX.관심도);
    b.관심도 = it.score;
    if (it.why) why.push(it.why);
  }
  const total = Object.values(b).reduce((a, c) => a + (Number(c) || 0), 0);
  return { total: Math.max(0, Math.min(100, Math.round(total))), breakdown: b, why };
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
    lawdCd,          // REGION-CODE-2026-08-30: 프론트 칩이 실어 보내는 시군구 코드(문자열 해석 우회)
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
  const _filterActive = fMinHh > 0 || fMinPark > 0 || fSaleOnly;
  // COND-FILTER-SSOT-2026-08-30 (Sprint OOOOOOO, 운영자 "군포 4.4억에 500세대+ 를 걸면 0건"):
  //   [실측] 군포 4.4억 무필터 결과 15곳이 **전부 500세대 이상**(충무주공 2,490 · 주몽2-10 2,119 …)
  //   인데 500세대+ 필터는 0건이었다. 부천 원미 5.4억도 같았다.
  //   근본 원인 — **판정이 두 벌**이었다:
  //     · 카드(enrichment): KAPT 이름 매칭 실패 시 **건축물대장(_brHh)** 으로 세대수를 얻는다 → 2,490 표시
  //     · 필터: 같은 이름 매칭이 실패하면 그냥 **제외**. 건축물대장 경로가 없다
  //   MOLIT 거래명과 KAPT 명은 접두·어순이 다르다(실측: "충무주공(872)" ↔ "산본주공충무1",
  //   "개나리주공13" ↔ "산본13단지개나리") — 괄호·접미 제거만으로는 절대 안 붙는다.
  //   → 최종 판정을 **enrichment 뒤 한 곳**으로 옮긴다. 카드에 보이는 값과 필터가 같은 소스를 쓰면
  //     원리적으로 갈릴 수 없다([[tax-law-crosscheck-2026-06-24]] 의 "사본 2개" 와 같은 구조).
  const _condPass = (fac) => {
    if (!fac) return false; // 최종 단계에서 모름 = 조건 확인 불가 → 제외(UI 안내와 일치)
    if (fMinHh > 0 && !(fac.totalHouseholds >= fMinHh)) return false;
    // HH-CONFLICT-2026-08-17: 세대수 원천이 갈린 단지는 주차 비율의 분모를 믿을 수 없다.
    if (fMinPark > 0 && fac.householdsConflict) return false;
    if (fMinPark > 0 && !(fac.parkingRatio != null && fac.parkingRatio >= fMinPark)) return false;
    if (fSaleOnly && fac.saleType !== '분양') return false;
    return true;
  };

  // NFC 정규화 — Mac(NFD) ↔ Windows(NFC) 캐시 분리 방지
  const normReg = String(region || '').normalize('NFC').trim();
  const normWp = String(workplaceArea || '').normalize('NFC').trim();
  // MULTI-REGION-2026-08-30: 콤마 구분 다중 코드 허용("41597,41595"). 캐시 키에도 그대로 실린다.
  const _lawd = String(lawdCd || '').split(',').map(x => x.trim()).filter(x => /^\d{5}$/.test(x)).join(',');
  const cacheKey = `rec:v26:${_lawd}:${normReg}:${maxBudget}:${houseStatus}:${isFirstBuyer}:${normWp}:${minPy}:${maxPy}:${fMinHh}:${fMinPark}:${fSaleOnly}`;
  // 버전 이력(산식·표시가 바뀌면 반드시 올릴 것 — 안 올리면 최대 3h 동안 옛 점수가 그대로 나간다):
  //   v26 TRANSIT-STAGE·SAMPLE-TIER·COUNT-CAP·SCALE-BANDS — 후보 전체 역 거리 실측 뒤 컷, 표본 3건 티어, 회전율 건수 상한, 규모 밴드.
  //   v25 REC-BROAD-ALL·BUDGET-CAP·REC-RANK-PROV·RANK-SEQ — 광역=시도 전체, 예산 상한 1.0x, 후보 컷 임시점수순,
  //       rank 재부여. 같은 키가 완전히 다른 후보 집합·가격 상한을 보므로 반드시 분리.
  //   v24 REC-BROAD — 광역 검색 대상 구가 하드코딩 3구 → 예산 밴드 상위 5구로. 같은 '서울:6.5' 키가
  //       완전히 다른 지역 집합을 보므로 반드시 분리(+ 미매칭 facility 를 resolveFacility 로 복원).
  //   v22 PPPPPPP 대표 평형에 표본 하한(3건) 도입
  //   v23 감사 P0-2 — 카카오 조회 실패를 0 이 아니라 null 로 다루면서 교통·인프라 점수가 달라짐
  // ⚠ 종전엔 키만 올리고 주석은 v22 사유를 그대로 뒀다. 그 탓에 교차검증에서 "오늘 사유로 안 올라갔다"는
  //   **오독**이 나왔다 — 버전을 올릴 때 이 목록에 한 줄을 같이 추가할 것. — v21 캐시에는 1건짜리 평형이 헤드라인인 결과가 남아 있다.
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
  // MULTI-REGION-2026-08-30: 사용자가 **직접 고른** 지역은 자르지 않는다.
  //   slice(0,3) 은 키워드 해석이 광역 대표 구를 여러 개 돌려줄 때 비용을 막으려던 것인데,
  //   복수 선택에 그대로 적용하면 "4개 골랐는데 3개만 본다" 가 된다(조용한 축소).
  //   명시 선택은 pickRegions 가 이미 MAX_MULTI(6)로 상한을 두므로 여기선 그대로 쓴다.
  const _picked = pickRegions(region, maxBudget, workplaceArea, _lawd);
  // REC-BROAD-ALL-2026-09-05: 광역(_broad)은 그 시도의 모든 시군구다 — 자르지 않는다.
  //   [실측] 서울 25구 개별 조회 합집합 상위 15곳 vs 5구 결과 = 2곳 겹침. "어느 구를 볼지"를 미리 고르는
  //   방식은 어떤 기준(하드코딩·예산 밴드)이든 정답을 놓친다. 비용은 광역 모드(_broadMode)에서 통제한다.
  const _broadMode = !_lawd && !!_picked._broad;
  const targetRegions = (_lawd || _broadMode) ? _picked : _picked.slice(0, 3);

  // Step 2: 병렬 조회 — (a) 시군구 전체 단지 목록 + (b) 실거래 내역
  // COLLECT-PAR-2026-07-18 (Sprint DDDDDD): aliasMap 이 대형 병렬 조회 뒤 직렬 1왕복이던 것 — 동시 시작
  const aliasMapPromise = getAliasCanonicalMap(targetRegions.map(r => r.lawdCd));
  // APTLIST-DB-2026-08-30 (Sprint OOOOOOO): 단지 목록의 **1순위는 DB(apt_master)** 다.
  //   라이브 KAPT 목록만 쓰다가 그 API 가 폐기되자 전국 필터가 0건이 됐다(실측) —
  //   같은 데이터를 DB 가 이미 들고 있었는데도. 두 소스를 합치고 kaptCode 로 중복 제거한다.
  const dbAptListPromise = getAptListByLawdFromDb(targetRegions.map(r => r.lawdCd));
  // REC-BROAD-ALL-2026-09-05 광역 모드 비용 통제: 시도 전체(서울 25·인천 11·경기 47)를 볼 때는
  //   ① 라이브 KAPT 시군구 목록(외부 API, 지역당 최대 10페이지)을 생략하고 DB(apt_master)만 쓴다 —
  //      DB 가 1순위 소스다(APTLIST-DB). 미등재 신축은 enrichment 의 resolveFacility 폴백이 받는다.
  //   ② DB 에 그 지역 거래가 없어도 MOLIT 월별 API(지역당 6콜)로 내려가지 않는다 — 전수 조회의 목적은
  //      있는 것을 놓치지 않는 것이고, 적재가 비어 있는 지역은 "거래 없음"으로 두는 것이 맞다.
  const [aptListArrays, txArrays] = await Promise.all([
    Promise.allSettled(
      targetRegions.map(r => (_broadMode ? Promise.resolve([]) : getAptListBySgg(r.lawdCd)))
    ).then(results => results.map(r => r.status === 'fulfilled' ? r.value : [])),
    Promise.allSettled(
      // REC-PERF-2026-07-10 (Sprint EEEE): 지역 단일쿼리 우선(12왕복→1왕복/지역, 131ms 실측) —
      //   null(미ingest·실패)이면 기존 월별 경로(MOLIT API 폴백 포함)로 안전 fallback.
      targetRegions.map(async r => (await getRegionRecentTransactions(r.lawdCd))
        ?? (_broadMode ? [] : await getTransactionsByApt(r.lawdCd, '')))
    ).then(results => results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn({
        region: targetRegions[i].name, errMsg: r.reason?.message,
      }, 'PropertyService 지역별 거래 조회 실패');
      return [];
    })),
  ]);
  _mark('collectQ');
  // 라이브 목록 + DB 목록 병합(kaptCode 유일). 라이브가 죽어도 필터가 살아 있어야 한다.
  const _dbAptList = await dbAptListPromise;
  const _seenKapt = new Set();
  const allAptList = [];
  for (const a of [...aptListArrays.flat(), ..._dbAptList]) {
    const c = a && (a.kaptCode || a.kapt_code);
    if (!c || _seenKapt.has(c)) continue;
    _seenKapt.add(c);
    allAptList.push(a);
  }
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
    aptListTotal: allAptList.length, aptListLive: aptListArrays.flat().length, aptListDb: _dbAptList.length,
    analyzedCount: analyzed.length,
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
  // BUDGET-CAP-2026-09-05 (운영자 "6.5억인데 6.8억이 나온다 — 예산이 안 맞는다"): 종전 5% 여유(1.05x)로
  //   6.81·6.74·6.59·6.56억이 6.5억 검색에 실렸다(라이브 실측 15곳 중 4곳). 사용자가 적은 값은 **상한**이다 —
  //   여유가 필요하면 사용자가 예산을 올리면 된다. 표시 기준(대표 평형 6개월 가중평균)이 예산 이하인 단지만 통과.
  const budgetMaxMan = maxBudget * 10000;
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
    // PRIMARY-SAMPLE-2026-08-31 (Sprint PPPPPPP): 대표 평형은 **예산 근접 + 표본 크기** 로 고른다.
    //
    // [전국 실측 — 101지역·1,793건] 헤드라인 가격의 대표 평형이
    //   거래 **1건**인 경우가 **16.9%(303건)**, 2건 이하가 29.1% 였다.
    //   [사례] 이편한세상강동에코포레: 단지 전체 11건인데 대표로 뽑힌 16평은 **1건**,
    //          그 한 건의 12.6억이 헤드라인이 됐다.
    // 원인: 예산에 가장 가까운 평형만 골랐고 **표본을 전혀 보지 않았다**.
    //   1~2건 평균은 시세라기보다 개별 사례에 가깝다 — 그걸 단지의 대표값으로 쓰면 안 된다.
    //
    // ⚠ 표본이 적다고 단지를 **버리지는 않는다**. 예산대에 그 평형밖에 없을 수 있다.
    //   충분한 표본(3건 이상)이 있으면 그중에서 고르고, 하나도 없으면 종전대로 예산 근접으로 고른다.
    //   대신 표본 수를 응답에 실어 화면이 "1건 기준" 임을 밝힐 수 있게 한다.
    const MIN_PRIMARY_N = 3;
    const _pickClosest = (arr) => arr.reduce((best, p) => {
      const diff = Math.abs(p.avgPrice - maxBudget * 10000);
      const bestDiff = Math.abs(best.avgPrice - maxBudget * 10000);
      return diff < bestDiff ? p : best;
    }, arr[0]);
    const _enough = fitPyeongs.filter(p => (p.dealCount || 0) >= MIN_PRIMARY_N);
    const primaryPyeong = _pickClosest(_enough.length ? _enough : fitPyeongs);
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
    // NOTICE-HONEST-2026-08-30: 여기는 **조회 성공 + 조건 미매칭** 이다. '조회 실패' 가 아니다.
    return {
      recommendations: getNoMatchNotice(maxBudget, region, {
        pyeongLabel: (minArea || maxArea) ? `전용 ${minPy}~${maxPy}평` : null,
        analyzed: analyzed.length,
      }),
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
    // JIBUN-MATCH-2026-08-30: 이름으로 못 찾으면 필지로 찾는다(전국 15.7% → 61.4%).
    const _jibunIdx = buildJibunIndex(allAptList);
    const _poolCodes = matched.map((apt) => {
      const nmKey = _norm(apt.aptName);
      return _codeMap.get(`${nmKey}|${apt.umdNm || ''}`) || _codeMap.get(nmKey) || _codeMap.get(_canon(nmKey))
        || lookupByJibun(_jibunIdx, apt) || null;
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
      // 실거래 건축년도와 어긋나는 facility 는 신뢰할 수 없다 → 조건 충족 판정 불가로 제외.
      //   (이름 정확일치 기반이라 mode='exact' 의 ±3년 허용치를 쓴다. 동명 단지 혼동은 보통 연도가 크게 다르다.)
      if (stored && apt.buildYear
          && !verifyCandidate(stored.kaptUsedate, stored.kaptAddr, { buildYear: apt.buildYear }, 'exact').ok) {
        return false;
      }
      const fac = stored ? buildFacility(stored, code, stored._dtl || null) : null;
      // ⚠ 여기서 모르는 단지를 빼면 안 된다([[unknown-treated-as-value]]). 이 단계는 pool 축소일 뿐이고,
      //   최종 판정은 enrichment 뒤에서 한다 — 그때는 건축물대장 폴백까지 붙은 값을 본다.
      if (!fac) return true;
      return _condPass(fac);
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
    // REC-RANK-PROV-2026-09-05: 이름 매칭 실패는 지번으로 한 번 더(카드·필터와 같은 규칙 — 사본 금지).
    const _jIdx = buildJibunIndex(allAptList);
    const _codes = candidatePool.map((apt) => {
      const k = _n(apt.aptName);
      return _m.get(`${k}|${apt.umdNm || ''}`) || _m.get(k) || _m.get(_c(k)) || lookupByJibun(_jIdx, apt) || null;
    });
    let _hhMap = new Map();
    try { _hhMap = await getFacilitiesByKaptCodes([...new Set(_codes.filter(Boolean))]); } catch (_) { /* graceful — 게이트 ② 비활성 */ }
    const _hh = candidatePool.map((_a, i) => {
      const st = _codes[i] && _hhMap.get(_codes[i]);
      if (!st) return null;
      // 건축년도가 어긋나면 남의 단지 세대수다 → '미확인'(null)으로 되돌려 게이트를 적용하지 않는다.
      //   잘못된 104세대로 3,169세대 대단지를 추천에서 탈락시키는 것이 이 게이트의 최악 실패 모드다.
      if (_a.buildYear
          && !verifyCandidate(st.kaptUsedate, st.kaptAddr, { buildYear: _a.buildYear }, 'exact').ok) {
        return null;
      }
      const v = [st.kaptdaCnt, st.hoCnt].map(x => parseInt(x)).find(nn => Number.isFinite(nn) && nn > 0);
      return v || null;
    });
    // LLLLLL-2 (배포 검증에서 완화 로직이 게이트 무력화 실측 — 성동구 후보 4개<5 → 1건짜리 복귀):
    //   TRUST(거래 1건 배제)는 **무조건** — 표본 1은 어떤 경우에도 부적격(정직한 빈 결과 > 무의미 추천).
    //   HH(<100 확인분)만 후보 부족 시 완화('가능하면'). 인덱스 안전 위해 hh 를 객체에 동반.
    // REC-RANK-PROV-2026-09-05: 후보 컷(RANK_N)을 **거래 건수순**에서 **임시 점수순**으로 바꾼다.
    //   [실측] 서울 6.5억 중형: 예산 안 후보 262곳 중 거래 상위 40곳만 채점됐다 — 거래가 적어도 역세권·
    //   중대단지인 곳은 채점 자체를 못 받았다. 여기서 이미 확보한 facility(DB 배치 1회)로 100점 산식의
    //   임시값(교통은 신고밴드·인프라는 시설문구·규모주차·회전율·연식·평형)을 매기고, 그 순서로 자른다.
    //   최종 점수는 종전대로 enrichment 뒤 실측 교통·인프라로 확정한다(상위 15곳).
    //   ⚠ 검증 티어: 세대수가 **확인된 100세대 이상**(KAPT, 연도 검증 통과) 후보를 미확인보다 앞에 둔다 —
    //     미확인은 대개 KAPT 미등록(의무관리 대상이 아닌 소규모) 건물이었다(실측: 17·103·121세대짜리가
    //     76~82점으로 1~3위). 미확인을 나쁨으로 만드는 게 아니라([[unknown-treated-as-value]]), 확인된
    //     후보가 충분할 때 검증된 정보를 우선하는 정렬이다. 확인된 후보가 RANK_N 에 못 미치면 미확인이 채운다.
    const _withHh = candidatePool.map((a, i) => {
      const code = _codes[i];
      const st = code && _hhMap.get(code);
      const fac = (st && _hh[i] != null) ? buildFacility(st, code, st._dtl || null) : null;
      const prov = _applyFacilityToScore(_calcBaseScore(a), fac, null).total;
      return { a, hh: _hh[i], fac, prov };
    });
    const _base = _withHh.filter(x => (x.a.dealCount || 0) >= 2);            // TRUST: 무조건
    let _gated = _base.filter(x => !(x.hh != null && x.hh < 100));           // HH: 확인된 소형 제외
    if (_gated.length < 3) _gated = _base;                                    // HH 만 완화 (희소 지역)
    if (_gated.length !== candidatePool.length) {
      logger.info({ before: candidatePool.length, after: _gated.length }, 'PropertyService TRUST+HH 게이트');
    }
    candidatePool = _gated.map(x => ({ ...x.a, _prov: x.prov, _verified: x.hh != null && x.hh >= 100 }));
  }

  // Step 4: 거래량 가중 정렬 → 실거래 단지 우선 상위 15건
  // 필터 활성 시 폭을 넓힌다 — 최종 판정(enrichment 뒤)에서 걸러내고도 15건을 채우기 위함.
  //   좌표·학군은 최종 15건에만 조회하므로 늘어나는 비용은 facility 해석분뿐이다(대부분 DB 1쿼리).
  // SCORE-ORDER-2026-08-30 (Sprint OOOOOOO, 운영자 "객관 지표가 좋은 곳들을 순서대로 배치해줘"):
  //   [실측] 경기 남부 6곳 복수 검색 결과가 **점수순이 아니었다** —
  //     1위 황골마을주공1 69점 · 2위 수원하늘채더퍼스트2단지 94점 · 3위 서동탄역더샵파크시티 **98점**.
  //   여기 `_score`(거래량 가중)로 정렬해 놓고, 카드에는 `score`(_calcBaseScore + facility 보정)를
  //   표시한다 — **보이는 점수와 순서가 다른 두 값**이었다. 사용자는 "왜 94점이 69점 아래지" 라고 본다.
  //   [왜 여기서 점수로 못 정렬했나] 최종 점수는 facility 가 붙은 **뒤**에 확정된다(_applyFacilityToScore).
  //   → 이 단계는 **후보를 넓게 고르는 역할만** 하고(거래량순은 그 목적엔 타당하다),
  //     최종 순서는 enrichment 뒤에서 확정된 점수로 다시 매긴다.
  //   ⚠ 폭을 넓히면 facility 해석이 늘지만 그건 DB 배치 1쿼리다. 좌표·학군은 최종 15건에만 돈다.
  const RANK_N = _filterActive ? 65 : 60; // TRANSIT-STAGE-2026-09-05: 역 거리 실측을 후보 전체에 걸 수 있어 컷을 넓힌다(종전 40/45)
  // REC-RANK-PROV-2026-09-05: 검증 티어 → 임시 점수 → 거래 건수 → 이름(결정적). 종전 거래 건수 가중은 폐기.
  const ranked = candidatePool
    .map(a => ({ ...a, _score: Number(a._prov) || 0 }))
    .sort((x, y) => (Number(y._verified) - Number(x._verified))
      || (y._score - x._score)
      || ((y.dealCount || 0) - (x.dealCount || 0))
      || String(x.aptName || '').localeCompare(String(y.aptName || ''), 'ko'))
    .slice(0, RANK_N);

  // Step 5: 결과 카드 생성 (AI 호출 없음, 즉시 응답)
  // 규제지역 키워드 1회 조회 → 단지별 sigungu 기준으로 정확하게 LTV 계산.
  // (snapshot in-process 캐시 hit 시 비용 무시 가능)
  const { keywords: regKeywords, seoulRegulated } = await getRegulatedKeywords();
  // SEOUL-JUNGGU-FIX-2026-07-25 (Sprint PPPPPP, improve 감사 CONFIRMED — P0 금전 영향):
  //   SEOUL_GU_KEYWORDS 는 주석과 달리 24개('중구' 누락)여서 서울 중구 단지(DB 실측 1,355건)가
  //   **비규제로 오판정** → 카드에 LTV 70%(생애최초 80%)·한도 무제한으로 표기됐다. 실제 규제지역
  //   무주택은 40%+cap. 이 파일 120~127행 주석이 경고한 "계약금 걸고 은행 가서 40%만 나오는" 그 시나리오.
  //   ⚠ 문자열 '중구' 추가는 오답 — 부산·대구·인천·대전·울산에도 bare '중구' 가 저장돼 있어(DB 실측)
  //     지방 5곳을 규제로 오판정한다. **lawdCd 우선 판정**(서울=11 prefix)이 유일하게 안전.
  const matchRegulated = (sigunguStr, lawdCd) => {
    const code = String(lawdCd || '').trim();
    // 1) 지역코드가 있으면 최우선 — 서울 전역 규제 시 11 prefix 로 25개 구 전부 정확 판정(동명 구 오판 0)
    if (seoulRegulated && code.startsWith('11')) return true;
    const r = String(sigunguStr || '').normalize('NFC').trim();
    if (!r) return false;
    // 2) 코드가 없을 때만 문자열 키워드 폴백(사용자 자유입력 경로와 동일 한계)
    if (seoulRegulated && !code) {
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
    // 단지 실제 위치(MOLIT sggNm + lawdCd)로 규제 판정 — 사용자 입력 region 보다 정확
    const aptIsRegulated = matchRegulated(apt.sigungu || region || '', apt.lawdCd);
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
      // 이 가격이 몇 건 위에서 계산됐는지 — 화면이 "표본 적음" 을 밝힐 수 있게 한다.
      priceSampleN: p.dealCount || 0,
      // SCORE-MULTIFACTOR-2026-05-13 (Sprint Y — 운영자 발견: "왜 다 95점?"):
      //   기존: `min(95, 50 + min(dealCount,30)*1.5)` → dealCount ≥ 30 단지 모두 95점 (cap).
      //   변경: 다요인 합산 (거래량/신축/평형다양). facility-derived 보정은 enriched 단계에서.
      // SCORE-V2-2026-08-30: 여기선 facility 없이 계산 가능한 부분(거래·연식·평형, 35점)만.
      //   교통 30 · 인프라 20 · 규모주차 15 는 enrichment 뒤에 더해진다.
      _baseScore: _calcBaseScore(apt),
      score: 0, // enrichment 에서 확정 — 그 전 값을 쓰면 순위가 뒤집힌다
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
  // JIBUN-MATCH-2026-08-30: 카드 쪽도 같은 폴백을 쓴다 — 필터와 카드가 다른 규칙을 쓰면 또 갈린다.
  const _jibunIdxRank = buildJibunIndex(allAptList);
  const preCodes = recommendations.map((rec, i) => {
    const apt = ranked[i];
    const nmKey = normalizeName(apt.aptName);
    return kaptCodeMap.get(`${nmKey}|${apt.umdNm || ''}`) || kaptCodeMap.get(nmKey) || kaptCodeMap.get(canonName(nmKey))
      || lookupByJibun(_jibunIdxRank, apt) || null;
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
        // REC-RESOLVE-FALLBACK-2026-09-05 (운영자 실사고 '벽산'·'동부골든'): 배치 매처(정확명·canon·지번)가
        //   못 붙여도, 단건 매처 resolveFacility(molit 신원 60행 집계 → 지번 1순위 → 부분·공백·토큰 + 연도 게이트)는
        //   붙는 경우가 실재한다 — /search/facility 는 상계벽산 1,590세대를 정확히 돌려주는데 추천 카드만
        //   건축물대장 세대수 1개짜리 부실 facility 를 실어 단지정보 탭 전체가 '미상'으로 떴다.
        //   비용: 미매칭 항목(최대 15)에만 · 인메모리/DB 캐시 공유 · 실패하면 종전 BR 경로 그대로.
        const rf = await resolveFacility({
          aptName: ranked[i].aptName, sigungu: ranked[i].sigungu || '',
          umdNm: ranked[i].umdNm || '', lawdCd: ranked[i].lawdCd,
        }).catch(() => null);
        if (rf && rf.kaptCode && rf.raw) {
          const _rfDetail = rf.detail || (rf.raw && rf.raw._dtl) || null;
          const facility = buildFacility(rf.raw, rf.kaptCode, _rfDetail);
          if (facility && !(facility.totalHouseholds > 0)) {
            const _bh = await _brHh(ranked[i]);
            if (_bh) facility.totalHouseholds = _bh;
          }
          const _tagsR = [...(rec.tags || [])];
          const _thR = (facility && facility.totalHouseholds) || 0;
          if (facility && facility.parkingRatio >= 1.2 && !facility.householdsConflict) _tagsR.push('주차여유');
          if (_thR >= 1000) _tagsR.push('대단지'); else if (_thR >= 500) _tagsR.push('중대단지');
          const _scR = _applyFacilityToScore(rec._baseScore, facility, rec._amen || null);
          return {
            ...rec, facility,
            score: _scR.total, scoreBreakdown: _scR.breakdown, scoreWhy: _scR.why,
            tags: Array.from(new Set(_tagsR)),
          };
        }
        // 이름 매칭 실패(KAPT 미등록/미매칭) — 건축물대장 세대수만이라도 보강해 카드 표시 + HH 게이트가 판정 가능하게.
        //
        // ⚠ SCORE-ZERO-2026-08-30 (Sprint PPPPPPP): 이 두 갈래가 **점수를 계산하지 않고 조기 반환**했다.
        //   recommendations 는 score:0 으로 만들어지고 "enrichment 에서 확정" 하기로 돼 있는데,
        //   여기로 빠지면 확정이 일어나지 않는다 → KAPT 이름이 안 붙은 단지는 **무조건 0점**이고
        //   scoreBreakdown·scoreWhy 도 비어 화면에 근거 없이 최하위로 찍힌다.
        //   [실측] 용산구 12억 검색에서 '삼라마이다스빌2'(158세대·6개월 2건)가 0점으로 8위였다.
        //   매칭 실패는 **우리 사정**이지 단지의 결함이 아니다 — 아는 만큼으로 점수를 낸다.
        const brHh = await _brHh(ranked[i]);
        const _fac = brHh ? { totalHouseholds: brHh, source: 'buildingRegister' } : null;
        const _sc0 = _applyFacilityToScore(rec._baseScore, _fac, rec._amen || null);
        const t2 = [...(rec.tags || []), ...(brHh >= 1000 ? ['대단지'] : brHh >= 500 ? ['중대단지'] : [])];
        return {
          ...rec,
          ...(_fac ? { facility: _fac } : {}),
          score: _sc0.total,
          scoreBreakdown: _sc0.breakdown,
          scoreWhy: _sc0.why,
          tags: Array.from(new Set(t2)),
        };
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
      // HH-CONFLICT-2026-08-17 (Sprint MMMMMMM): 프론트 단지정보 태그(index.html)와 같은 가드.
      //   두 자리가 갈리면 같은 단지가 카드엔 '주차여유', 상세엔 미표기로 나와 사용자가 모순을 본다.
      if (parkingRatio && parkingRatio >= 1.2 && !facility?.householdsConflict) moreTags.push('주차여유');
      if (totalHouseholds >= 1000) moreTags.push('대단지');
      else if (totalHouseholds >= 500) moreTags.push('중대단지');
      else if (totalHouseholds > 0 && totalHouseholds < 100) moreTags.push('소규모');
      // SCORE-V2-2026-08-30: facility(+선택적 amenities)를 알게 된 뒤 100점 확정.
      const _sc = _applyFacilityToScore(rec._baseScore, facility, rec._amen || null);
      return {
        ...rec,
        facility,
        score: _sc.total,
        scoreBreakdown: _sc.breakdown, // 왜 이 점수인지 — 화면에 근거를 보여주기 위함
        scoreWhy: _sc.why,
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

  // enrich는 항상 recommendations 와 길이 동일
  // COND-FILTER-SSOT-2026-08-30: **여기가 조건 필터의 최종 판정**이다(위 사전 필터는 pool 축소용).
  //   카드에 표시되는 facility 와 같은 객체로 판정하므로 "카드엔 2,490세대인데 필터가 뺀다" 가 불가능하다.
  let _rankedF = ranked;
  let enrichedRecs = enriched;
  if (_filterActive) {
    const keep = [];
    for (let i = 0; i < enrichedRecs.length; i++) if (_condPass(enrichedRecs[i] && enrichedRecs[i].facility)) keep.push(i);
    logger.info({ before: enrichedRecs.length, after: keep.length, fMinHh, fMinPark, fSaleOnly },
      'PropertyService 조건 필터 최종 판정');
    _rankedF = keep.map(i => ranked[i]);
    enrichedRecs = keep.map(i => enrichedRecs[i]);
  }
  // TYPE-EXCLUDE-2026-08-30 (Sprint PPPPPPP): 아파트가 아닌 유형을 추천 순위에서 뺀다.
  //   운영자: "오피스텔 느낌은 다들 안 좋아하니 이런 매물들은 다 제외시켜줘."
  //   ⚠ facility 가 붙은 **뒤에** 판정한다 — 사전 단계에서 자르면 KAPT 매칭 실패 단지가
  //     '유형 모름' 으로 함께 잘린다([[unknown-treated-as-value]] 의 재발).
  //   ⚠ 검색·상세는 건드리지 않는다. 있는 단지를 없다고 하는 게 아니라 **추천 정렬에서만** 뺀다.
  {
    const keep2 = [];
    const dropped = [];
    for (let i = 0; i < enrichedRecs.length; i++) {
      const fac = enrichedRecs[i] && enrichedRecs[i].facility;
      if (_isExcludedType(fac)) { dropped.push(`${enrichedRecs[i].aptName}(${fac.aptType})`); continue; }
      keep2.push(i);
    }
    if (dropped.length) {
      logger.info({ dropped: dropped.slice(0, 10), n: dropped.length }, '추천 제외 — 아파트가 아닌 유형');
      _rankedF = keep2.map(i => _rankedF[i]);
      enrichedRecs = keep2.map(i => enrichedRecs[i]);
    }
  }
  // TRANSIT-STAGE-2026-09-05: 최종 15곳을 고르기 전에 후보 전체(≤RANK_N)의 **최근접 역 직선거리**를 잰다.
  //   [프리뷰 실측] 임시 점수(관리사무소 신고 밴드)로 15곳을 고르자 벽산(역 108m·1,590세대·최종 73점)이
  //   컷에서 빠지고 111~340세대 소단지가 상위를 채웠다. 교통 28점은 산식 최대 항목이라 여기서 틀리면 다 틀린다.
  //   역 거리는 카카오 SW8 1콜(apt_amenities 90일 + 메모리 3일 캐시)이라 후보 전체에 걸 수 있다.
  //   나머지 시설 6종(학교·병원·마트…)은 종전대로 최종 15곳에만 건다(운영자 승인 B안 유지).
  //   ⚠ 조회 실패(undefined)는 신고밴드 점수를 그대로 둔다. '반경 내 역 없음'(null)은 사실이므로 반영한다.
  try {
    const { nearestSubway } = require('./kakaoService');
    const stageInputs = enrichedRecs.map((rec, i) => ({
      kaptCode: rec.facility?.kaptCode || null,
      aptName: rec.aptName,
      sigungu: (_rankedF[i] && _rankedF[i].sigungu) || '',
      umdNm: (_rankedF[i] && _rankedF[i].umdNm) || '',
      address: rec.facility?.address || null,
    }));
    const stageCoords = await resolveCoordBatch(stageInputs, 8);
    const STAGE_CONC = 8;
    const dists = new Array(enrichedRecs.length).fill(undefined);
    for (let i = 0; i < enrichedRecs.length; i += STAGE_CONC) {
      await Promise.all(enrichedRecs.slice(i, i + STAGE_CONC).map(async (_r, k) => {
        const c = stageCoords[i + k];
        if (!c || c.lat == null || c.lng == null) return;
        try { dists[i + k] = await nearestSubway(c.lat, c.lng, 3000); } catch (_) { /* 모름 유지 */ }
      }));
    }
    let measured = 0;
    for (let i = 0; i < enrichedRecs.length; i++) {
      const ns = dists[i];
      if (ns === undefined) continue;
      const rec = enrichedRecs[i];
      const amen = { subwayNearestM: ns ? ns.distance : null, subwayNearestName: ns && ns.name ? ns.name : null };
      const _sc = _applyFacilityToScore(rec._baseScore, rec.facility, amen);
      enrichedRecs[i] = { ...rec, score: _sc.total, scoreBreakdown: _sc.breakdown, scoreWhy: _sc.why };
      measured++;
    }
    logger.info({ n: enrichedRecs.length, measured }, 'TRANSIT-STAGE 역 거리 반영');
  } catch (e) {
    logger.warn({ err: e.message }, 'TRANSIT-STAGE 실패 — 신고밴드 점수로 진행');
  }

  // SCORE-ORDER-2026-08-30 (Sprint OOOOOOO): **최종 순서를 화면에 보이는 점수로 확정한다.**
  //   여기까지 오면 facility 가 붙어 `rec.score` 가 최종값이다(_applyFacilityToScore 적용 후).
  //   위 거래량 정렬은 후보를 넓게 고르는 용도였고, 사용자에게 보이는 순서는 이 점수여야 한다 —
  //   [실측] 그 전에는 98점 단지가 3위, 69점 단지가 1위였다.
  //   ⚠ 동점은 거래량으로 가른다(표본이 많은 쪽이 시세 신뢰도가 높다). 그래도 같으면 이름순 —
  //     정렬이 결정적이어야 같은 검색이 매번 같은 순서를 준다.
  {
    const order = enrichedRecs.map((rec, i) => ({ rec, apt: _rankedF[i], i }));
    // SAMPLE-TIER-2026-09-05: 헤드라인 가격 표본 3건 이상을 앞세운다(부족하면 1~2건이 채운다 — 화면이 '1건 기준' 을 밝힌다).
    const _sOk = (o) => Number((Number(o.rec?.priceSampleN) || 0) >= 3);
    order.sort((a, b) => (_sOk(b) - _sOk(a))
      || (Number(b.rec?.score) || 0) - (Number(a.rec?.score) || 0)
      || (Number(b.apt?.dealCount) || 0) - (Number(a.apt?.dealCount) || 0)
      || String(a.rec?.aptName || '').localeCompare(String(b.rec?.aptName || ''), 'ko'));
    _rankedF = order.map(o => o.apt);
    enrichedRecs = order.map(o => o.rec);
  }
  _rankedF = _rankedF.slice(0, 15);
  enrichedRecs = enrichedRecs.slice(0, 15);

  // Step 6: 좌표 해결 — DB 캐시 우선, miss 시 Kakao 지오코딩.
  // 여기서 lat/lng 를 채워야 프론트가 fallback/jitter 없이 정확한 위치에 마커를 찍는다.
  // (기존 버그: 프론트 getLat/getLng 의 구명 키워드 매칭 실패 시 서울 중심 근처로 떨어져
  //  은평구 단지가 용산/한강 근처에 표시됨 → Bug #2 의 근본 원인)
  // NAMEFIX-2026-05-11: coordInputs 의 aptName 은 **raw** 그대로 — apt_geocache cache key 호환성 보존.
  //   (Kakao query 정확도 ↑ 는 geocodeCacheService.kakaoGeocode 함수 내부에서 normalize 적용.)
  const coordInputs = enrichedRecs.map((rec, i) => {
    const apt = _rankedF[i];
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
    sigungu: _rankedF[i].sigungu || '',
    umdNm: _rankedF[i].umdNm || '',
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

  // ── SCORE-V2 인프라(20점) — 좌표가 풀린 최종 15건에만 카카오 주변시설 조회 ──────────
  //   [왜 여기인가] 인프라는 좌표가 있어야 센다. 교통 30점은 KAPT 도보시간이라 좌표 없이도
  //   이미 반영돼 있으므로, 위 정렬은 이미 대부분 맞다 — 여기서는 인프라만 얹어 재확정한다.
  //   ⚠ 후보 전체(40건)에 걸면 카카오 호출이 240회다. 최종 15건으로 묶어 비용을 고정한다
  //     (운영자 승인 B안). 좌표·반경 캐시가 메모리 3일 + DB 90일이라 반복 검색은 대부분 캐시 히트.
  //   ⚠ 실패·좌표없음은 amen=null → `_applyFacilityToScore` 가 KAPT 교육/편의시설로 대체하고,
  //     그것도 없으면 중간값을 준다. **0점으로 떨어뜨리지 않는다**([[unknown-treated-as-value]]).
  try {
    const { getNearbyAmenities } = require('./kakaoService');
    const _amenArr = await Promise.all(enrichedRecs.map(async (rec, i) => {
      const c = coords[i];
      if (!c || c.lat == null || c.lng == null) return null;
      try { return await getNearbyAmenities(c.lat, c.lng); } catch (_) { return null; }
    }));
    // INTEREST-2026-08-30: 장기 검색 관심도 — **캐시에 있는 것만** 읽는다(외부 호출 0, 지연 0).
    //   미스는 백그라운드로 채우고(응답을 기다리게 하지 않는다) 다음 검색부터 실값이 붙는다.
    //   운영자 지시 "최대한 부하가 안 걸리게" 를 이 구조로 지킨다.
    let _interest = new Map();
    try {
      const dl = require('./naverDatalabService');
      // ⚠ 추천 객체에는 `sigungu` 필드가 **없다**(area 로 합쳐져 있다).
      //   rec.sigungu 로 키를 만들면 항상 빈 문자열이 되어 캐시가 영원히 미스다(실측: 히트 0).
      const items = enrichedRecs.map((rec, i) => ({
        aptName: rec.aptName,
        sigungu: (_rankedF[i] && _rankedF[i].sigungu) || '',
        umd: (_rankedF[i] && _rankedF[i].umdNm) || '',
        lat: coords[i] && coords[i].lat, lng: coords[i] && coords[i].lng,
      }));
      _interest = await dl.getCachedInterest(items);
      // ⚠ "채웠다" 와 "쓰인다" 는 다른 문제다 — 1,551건을 채우고도 히트가 0 이던 적이 있다
      //   (키가 양쪽에서 달랐다). 히트율을 상시로 남겨 그런 상태를 조용히 넘기지 않는다.
      logger.info({ interestHits: _interest.size, of: items.length,
        sample: items.slice(0, 2).map(x => `${x.aptName}|${x.sigungu}`) }, '관심도 캐시 히트');
      // ⚠ 여기서 채우지 않는다 — **서버리스는 응답 후 작업을 보장하지 않는다**(실측: 캐시 0행).
      //   채우기는 admin/cron 경로(GET /api/admin/warm-interest)가 맡는다.
    } catch (e) {
      logger.warn({ err: e.message }, '관심도 조회 실패 — 중간값으로 진행');
    }
    let _rescored = 0;
    for (let i = 0; i < enrichedRecs.length; i++) {
      const amen = _amenArr[i];
      const rec = enrichedRecs[i];
      const ir = _interest.get(`${rec.aptName}|${rec.sigungu || ''}`);
      // amen 이 없어도 관심도만으로 재계산할 값이 있으면 진행한다.
      if (!amen && ir === undefined) continue;
      const _amen2 = Object.assign({}, amen || {}, ir === undefined ? {} : { interestRatio: ir });
      const _sc = _applyFacilityToScore(rec._baseScore, rec.facility, amen ? _amen2 : _amen2);
      enrichedRecs[i] = { ...rec, amenities: amen || null, score: _sc.total, scoreBreakdown: _sc.breakdown, scoreWhy: _sc.why };
      _rescored++;
    }
    if (_rescored) {
      // 인프라가 반영됐으니 순서를 다시 확정한다(동점은 거래량 → 이름순으로 결정적).
      // ⚠ **coords·schoolsArr 도 같은 순서로 옮겨야 한다** — 이 함수의 downstream 은 전부
      //   `coords[i]`·`schoolsArr[i]` 처럼 **인덱스 대응**을 전제한다. 하나만 정렬하면
      //   마커가 다른 단지 위치에 찍히고 학군이 뒤바뀐다(이 저장소가 겪은 Bug #2 와 같은 계열).
      //   그래서 네 배열을 한 묶음으로 정렬한 뒤 되돌려 놓는다.
      const order = enrichedRecs.map((rec, i) => ({ rec, apt: _rankedF[i], coord: coords[i], school: schoolsArr[i] }));
      const _sOk = (o) => Number((Number(o.rec?.priceSampleN) || 0) >= 3); // SAMPLE-TIER: 1차 정렬과 같은 키
      order.sort((a, b) => (_sOk(b) - _sOk(a))
        || (Number(b.rec?.score) || 0) - (Number(a.rec?.score) || 0)
        || (Number(b.apt?.dealCount) || 0) - (Number(a.apt?.dealCount) || 0)
        || String(a.rec?.aptName || '').localeCompare(String(b.rec?.aptName || ''), 'ko'));
      _rankedF = order.map(o => o.apt);
      enrichedRecs = order.map(o => o.rec);
      for (let i = 0; i < order.length; i++) { coords[i] = order[i].coord; schoolsArr[i] = order[i].school; }
    }
    logger.info({ n: enrichedRecs.length, rescored: _rescored }, 'SCORE-V2 인프라 반영');
  } catch (e) {
    logger.warn({ err: e.message }, 'SCORE-V2 인프라 조회 실패 — KAPT 기반 점수로 진행');
  }

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
      // RANK-SEQ-2026-09-05 (라이브 실측: 화면 순번이 5·22·20·29… 로 보였다): rank 는 거래량 컷 시점 번호였고
      //   점수순 재정렬 뒤에도 그대로였다. 표시 순서가 곧 순번이어야 한다.
      rank: i + 1,
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
  //   ⚠ HH-UNKNOWN-2026-08-17 (Sprint MMMMMMM-19): 위 "미확인(null) 유지" 는 **도달 불가능한 의도**였다.
  //     `buildFacility` 는 세대수를 모를 때 null 이 아니라 **0** 을 넣는다(KAPT info 자체가 없으면
  //     `totalHouseholds: 0`, 있어도 `_posInt(kaptdaCnt) || _posInt(hoCnt)` 가 둘 다 0이면 0).
  //     그런데 `Number.isFinite(0)` 은 true 이고 `0 < 100` 도 true 라 **미확인이 전부 소형으로 배제**됐다.
  //     [실측] 세대수 미확인 단지 **407곳**(서울 56). 그중 건축물대장(building_register.hhldCnt)으로
  //     교차확인되는 17곳은 **전부 100세대 이상**(평균 878 · 최대 2,700세대), 소형은 **0곳**.
  //     즉 "미확인 = 소형" 이라는 전제가 데이터로 반증된다 — 2,700세대 단지가 추천에서 빠지고 있었다.
  //     운영자 지시는 "확인된 100세대 미만 제외" 이므로 **0(미확인)은 배제 대상이 아니다.**
  //     ⚠ 진짜 소형(1~99세대, 실측 239곳)은 종전대로 배제된다 — 지시의 대상은 그쪽이다.
  let finalRecs = withCoords;
  {
    const _isKnownSmall = (r) => {
      const hh = r.facility?.totalHouseholds;
      return Number.isFinite(hh) && hh > 0 && hh < 100;   // 0 = 미확인 → 소형으로 치지 않는다
    };
    const _big = withCoords.filter(r => !_isKnownSmall(r));
    if (_big.length >= 1 && _big.length !== withCoords.length) {
      logger.info({ before: withCoords.length, after: _big.length }, 'PropertyService HH-GATE(건축물대장 보강): 100세대 미만 제외');
      finalRecs = _big.map((r, i) => ({ ...r, rank: i + 1 })); // RANK-SEQ: 게이트로 빠진 뒤에도 1부터 이어진다
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
/**
 * NOTICE-HONEST-2026-08-30 (Sprint OOOOOOO, 전수조사 847건에서 발각):
 *   "조건에 맞는 단지 없음" 을 **"데이터 조회 실패"** 라고 표시하고 있었다.
 *   [실측] 대형(전용 34평+) 조건에서 종로구·과천·구리·군포·동두천 5곳이 안내카드를 냈는데,
 *   전부 조회는 **성공**했다(분석 단지 70·16·134·154·62곳). 매칭만 0이었다.
 *   사용자에게 틀린 원인을 알려주면 "잠시 후 재시도" 하다가 서비스를 불신하게 된다 —
 *   실제로는 조건을 바꿔야 하는 상황이다.
 *   → 원인별로 문구를 가른다. 응답 형태(_notice 플래그·필드)는 그대로 둔다(소비자 호환).
 */
function getNoMatchNotice(budget, region, opts = {}) {
  const { pyeongLabel, analyzed } = opts;
  const scope = pyeongLabel ? `${pyeongLabel} 조건` : '입력하신 조건';
  return [{
    rank: 1,
    _notice: true,
    _reason: 'no-match', // 프론트가 '실패' 와 '조건 미매칭' 을 구분할 수 있게
    aptName: '조건에 맞는 단지가 없어요',
    area: `${region || '서울'} · 예산 ${budget}억 · ${scope}`,
    avgPrice: budget,
    score: 0,
    pros: analyzed ? `이 지역 최근 6개월 거래 단지 ${analyzed}곳을 살펴봤어요 — 조회는 정상이에요` : '조회는 정상이에요',
    cons: '예산 범위나 평형 조건이 이 지역 실거래 분포와 맞지 않아요',
    strategy: '예산을 ±20% 넓히거나 평형 조건을 풀어보세요. 지역을 여러 곳 함께 선택할 수도 있어요.',
    tags: ['조건조정필요'],
    risk: '조건 미매칭 (데이터 이상 아님)',
    recommend: false,
    txHistory: [],
    currentPriceByPyeong: [],
  }];
}

function getStaticFallback(budget, region) {
  // NOTICE-FLAG-2026-08-17 (Sprint MMMMMMM-7): 이 항목은 **단지가 아니라 안내**다.
  //   예전엔 표식이 없어 프론트가 props.length 를 그대로 건수로 찍었고, 매칭 0건인데
  //   헤더에 '추천 단지 1건' 이 뜨고 단지 카드 자리에 실패 안내가 들어앉았다.
  //   (props.length 가 1이라 '검색 결과 없음' 분기도 타지 않았다.)
  //   응답 형태를 바꾸면 기존 소비자가 깨질 수 있으므로 **식별 플래그만** 추가한다.
  return [{
    rank: 1,
    _notice: true,
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
// TEST-EXPORT-2026-09-02 (감사 P0-2): _applyFacilityToScore 도 순수 함수라 export 한다.
//   "카카오 조회 실패(null)를 0 곳으로 채점하지 않는다" 를 **텍스트 검사 대신 실제 실행**으로 고정하기 위함.
module.exports = { getAIRecommendations, pickRegions, computeLTV, buildJibunIndex, lookupByJibun, _applyFacilityToScore };
