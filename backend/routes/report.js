/**
 * 1Page 컨설팅 보고서 자동 생성 (Phase 5, 2026-04-26)
 *
 * 핵심 가치 (사용자 정정 후):
 *   - 호갱노노/직방 = 시세 검색
 *   - 우리 = AI 컨설턴트 1page 종합 보고서 (사용자 자금/가족/우선순위 자동 매칭)
 *
 * 절대 금지:
 *   - 대출 알선·소개 (대출모집인법 위험)
 *   - 미래 가격 예측 (자본시장법 위험)
 *   - "추천" 표현 → "조건 부합 단지" 사용
 *
 * 데이터 통합:
 *   - regulationsService: 정부 정책 최신 스냅샷
 *   - propertyService.recommend: 추천 단지 7개
 *   - molit_transactions: 평형별 가격
 *   - apt_master: 단지 상세 (세대수·시공사·용적률)
 *   - apt_schools: 주변 학교
 *
 * AI 호출:
 *   - Claude Sonnet 4 + cache_control (PDF 구조 prompt 매번 cache hit)
 *   - 출력: JSON 5섹션 (핵심방향·정책환경·체크리스트·단지·갈아타기·TIP)
 */
const express = require('express');
const { callAI } = require('../services/aiService');
const { getSupabaseAdmin } = require('../db/client');
const { getSnapshot } = require('../services/regulationsService');
const { resolveFacility } = require('../services/aptFacilityService');
const { resolveCoordBatch } = require('../services/geocodeCacheService');
const { getNearbyAmenities, countNearby, keywordToCoord, getTransitMinutes } = require('../services/kakaoService');
const cache = require('../cache');
const logger = require('../logger');
const crypto = require('crypto');

const router = express.Router();

const REPORT_SYSTEM_PROMPT = `당신은 대한민국 부동산 컨설턴트입니다. 회원님 가구 상황에 맞는 1page 단지 분석 보고서를 작성합니다.

## 절대 위반 금지 (법적 안전)
1. ⛔ "추천", "사세요", "매수하세요" 등 권유 표현 금지. 대신 "조건 부합 단지", "탐색 후보" 사용.
2. ⛔ 미래 가격 예측 금지 ("N억 오를 것", "5년 후 N억"). 정성적 안내만 ("자녀 학교 시기 갈아타기 권장").
3. ⛔ 대출 알선·소개 금지. "이 은행 가세요", "신용대출 받으세요" 금지.
   대출 한도·DSR 분석은 보고서에 포함 X. 정책자금은 "이런 게 있다" 정보만.
4. ⛔ 자본시장법상 투자자문업·공인중개사법상 중개업 표현 금지.
5. ⛔ 본 보고서는 정보 정리이며 투자자문 아님 명시 필수.

## 톤
- "회원님" 호칭 사용 (친근하고 전문적)
- 컨설턴트 어투 ("솔직히", "이런 점은", "검토해보세요")
- 별점 ★★★ ★★ ★ 활용 (PDF 컨설팅 톤)
- 단지명 정확히 (오타·줄임 X)
- ⛔ markdown 문법 사용 금지 — **굵게**, __강조__, # 제목, \` 코드, --- 구분선 등 X
   - 별 두 개 (\`**\`) 가 plain text 로 그대로 노출되어 가독성 망침
   - 강조가 필요하면 핵심 단어를 문장 자연스러운 위치에 배치하거나, 별점 ★ 활용
- 각 문장 80자 이내 권장 (가독성)

## 출력 형식 (반드시 JSON, 그 외 텍스트 금지)
{
  "coreMessages": ["1줄...", "2줄...", "3줄..."],
  "checklist": [{"text":"회전율 (환금성)", "stars":3}, ...],
  "apartments": [
    {
      "rank": 1,
      "name": "단지명",
      "areaSqm": 84,
      "areaPyeong": 25,
      "buildYear": 2001,
      "households": 1676,
      "ratio": "회전율 ★★★ (대단지)",
      "location": "역세권·학교·평지",
      "pros": "장점 1줄",
      "cons": "단점 1줄",
      "priceFit": "매수가 7억 vs 단지 평균 8.1억 (16% 초과)",
      "recommendation": "검토 시 21평 또는 다른 단지 비교 권장"
    }
  ],
  "longTermView": "5년 갈아타기 정성적 시나리오 (가격 수치 X, 자녀 학교 시기 + 권역 권장)",
  "tips": ["실무 TIP 1", "실무 TIP 2", ...]
}`;

router.post('/generate', async (req, res) => {
  const userInput = req.body || {};
  const userId = req.user?.id || null;

  // 입력 검증
  if (!userInput.maxBudget || userInput.maxBudget <= 0) {
    return res.status(400).json({ error: '매수가 (maxBudget) 필수' });
  }
  if (!userInput.region) {
    return res.status(400).json({ error: '희망 지역 (region) 필수' });
  }

  // 캐시 키 — 동일 입력 30분 캐시
  const cacheKey = `report:${crypto.createHash('sha256').update(JSON.stringify(userInput)).digest('hex').slice(0, 16)}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json({ ...hit, fromCache: true });

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: 'DB 미설정' });

    // 1) 정부 정책 최신 스냅샷
    const policyData = await getPolicyContext().catch(() => ({}));

    // 2) 추천 단지 fetch (기존 propertyService 우선, 없으면 단순 query)
    const candidates = await fetchCandidateApts(admin, userInput, 7);
    if (!candidates.length) {
      return res.status(404).json({ error: '입력 조건에 맞는 단지가 없어요. 매수가나 지역을 조정해보세요.' });
    }

    // 3) AI prompt 작성
    const prompt = buildReportPrompt(userInput, policyData, candidates);

    // 4) AI 호출 — REPORT_SYSTEM_PROMPT 를 system 으로 명시 전달
    //    Phase 6 (2026-04-26): max_tokens 4500 → 6500
    //    matchReason 필드 추가 + 단지 다양성 확장 후 6087자에서 또 잘림 (실측 logs)
    //    frontend timeout 120s 와 페어링 (Claude Sonnet 4.5 + 6500 토큰 ≒ 60~90s)
    const result = await callAI(
      [{ role: 'user', content: prompt }],
      false,
      { userId, system: REPORT_SYSTEM_PROMPT, maxTokens: 6500 }
    );
    const cleaned = String(result.content || '').replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch (e) {
      // 진단 로그 — sample_head/tail 은 운영자 디버그용 유지 (response body 의 _debug 는 제거)
      logger.error({
        err: e.message,
        sample_head: cleaned.slice(0, 800),
        sample_tail: cleaned.slice(-400),
        cleaned_len: cleaned.length,
      }, '보고서 AI JSON 파싱 실패');
      return res.status(502).json({ error: '보고서 생성 실패 — AI 응답 형식 오류' });
    }

    // 안전망: markdown 강조 표기 (** __ ##) 자동 제거 — prompt 가 금지해도 가끔 새어나옴
    stripMarkdownDeep(parsed);

    // Phase 7 (2026-04-26): AI 응답 apartments 에 backend 의 objectiveFacts 주입
    //   AI 가 생성하지 않는 객관 데이터 — backend 가 직접 매칭해서 보장
    if (Array.isArray(parsed.apartments)) {
      parsed.apartments.forEach((a, i) => {
        const c = candidates[i];
        if (c?.objectiveFacts) a.objectiveFacts = c.objectiveFacts;
        if (c?.score != null) a.matchScore = c.score;
      });
    }

    const out = {
      report: parsed,
      policyContext: policyData,
      generatedAt: new Date().toISOString(),
      disclaimer: '본 보고서는 국토교통부·한국부동산원 공공 데이터 기반 정보 정리이며, 투자자문업·중개업·대출모집인업이 아닙니다. 매수·매도 추천 X, 미래 가격 예측 X. 모든 의사결정과 책임은 본인에게 있습니다.',
    };
    cache.set(cacheKey, out, 1800); // 30분
    res.json({ ...out, fromCache: false });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, '보고서 생성 실패');
    res.status(500).json({ error: e.message });
  }
});

/** markdown 강조 표기 자동 제거 — 응답 객체 내 모든 string 재귀 정제 */
function stripMarkdown(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/__(.+?)__/g, '$1')        // __bold__ → bold
    .replace(/^#{1,6}\s+/gm, '')        // # 제목 → 제목
    .replace(/`([^`]+)`/g, '$1')        // `code` → code
    .replace(/^---+$/gm, '');           // --- → 빈 줄
}
function stripMarkdownDeep(obj) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') obj[i] = stripMarkdown(obj[i]);
      else if (obj[i] && typeof obj[i] === 'object') stripMarkdownDeep(obj[i]);
    }
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'string') obj[k] = stripMarkdown(obj[k]);
      else if (obj[k] && typeof obj[k] === 'object') stripMarkdownDeep(obj[k]);
    }
  }
}

/** 정부 정책 최신 스냅샷 — regulationsService 활용 */
async function getPolicyContext() {
  const [ltv, dsr] = await Promise.all([
    getSnapshot('ltv').catch(() => null),
    getSnapshot('dsr').catch(() => null),
  ]);
  return {
    snapshot: '2025.10.15 주택시장 안정화 대책',
    ltv: ltv?.ltvTable || null,
    dsr: dsr?.dsrRules || null,
    regulatedAreas: '서울 25구 + 경기 12곳 (과천·광명·성남 분당 등)',
    landTrade: '강남·송파·용산 일부 (2년 실거주 의무)',
    policyLoans: ['보금자리론', '디딤돌', '신혼 디딤돌', '신생아 특례'],
    policyContact: '주택도시기금 nhuf.molit.go.kr · 1599-0001',
    note: '대출 알선·소개 X. 본 정보는 정부 공시 자동 인용. 신청·자격은 별도 확인 필수.',
  };
}

// Phase 6 (2026-04-26): 추천 엔진 v2 — 점수 기반 매칭 + 구 다양성 보장 + 토큰 기반 master 매칭

/** 단지명 토큰 추출 (sliding window 길이 2~4) — '주공1' vs '휘경주공1단지' 매칭용 */
function extractAptTokens(name) {
  const cleaned = String(name||'').replace(/\s+/g, '').replace(/아파트$/, '');
  const tokens = new Set();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= cleaned.length - len; i++) {
      tokens.add(cleaned.substring(i, i + len));
    }
  }
  return Array.from(tokens);
}

/** 두 단지명의 매칭 점수 (가장 긴 공통 토큰 길이) */
function aptNameMatchScore(a, b) {
  const at = extractAptTokens(a);
  const bSet = new Set(extractAptTokens(b));
  let best = 0;
  for (const t of at) {
    if (bSet.has(t) && t.length > best) best = t.length;
  }
  return best;
}

// ── Phase 7 (2026-04-26): 객관 데이터 분류 helper ──
// 우리 DB + KAPT API 만으로 가능한 객관 fact. 외부 의존성 0.
// 절대 Tier(S+/A) 매기지 X — 사용자 priority 가중치의 보조 역할.

/** 행정구 위계 — 강남3구·마용성광·외곽 (사용자 보편 선호도 반영, Phase 9 강화) */
function getDistrictTier(sigungu) {
  if (!sigungu) return { tier: '기타', bonus: 0 };
  if (['강남구', '서초구', '송파구'].includes(sigungu)) return { tier: '강남3구', bonus: 35 };
  if (['마포구', '용산구', '성동구', '광진구'].includes(sigungu)) return { tier: '마용성광', bonus: 25 };
  if (['양천구', '영등포구', '강동구'].includes(sigungu)) return { tier: '서울 핵심구', bonus: 15 };
  if (['과천시', '분당구', '판교'].some(k => sigungu.includes(k))) return { tier: '분당·과천·판교', bonus: 22 };
  if (sigungu.endsWith('구') && sigungu.length <= 4) return { tier: '서울 외곽구', bonus: 5 };
  return { tier: '기타', bonus: 0 };
}

/** 시공사 브랜드 등급 분류 (KAPT facility.kaptBcompany)
 *  Phase 8++ (2026-04-26): PDF5 검증 — 태영(데시앙)·한신공영·우미린 등 누락 보강
 */
function getBuilderTier(builder) {
  if (!builder) return { tier: '미상', bonus: 0 };
  const b = String(builder).replace(/\s+/g, '').replace(/[()주식회사㈜]/g, '');
  // 1군 프리미엄
  if (/(아크로|디에이치|르엘|푸르지오써밋|반포자이|래미안첼리투스)/.test(b)) return { tier: '1군 프리미엄', bonus: 20 };
  // 1군 일반 — 시공사명 또는 브랜드명 모두 매칭
  if (/(힐스테이트|래미안|자이|롯데캐슬|푸르지오|아이파크|더샵|디오슬|디에트르|두산위브|위브)/.test(b))
    return { tier: '1군', bonus: 15 };
  if (/(삼성물산|GS건설|현대건설|현대산업|HDC|대림|DL|대우|롯데건설|포스코|두산|쌍용|한화건설)/.test(b))
    return { tier: '1군', bonus: 15 };
  if (/(태영|한신공영|한라건설|한신건설|동부건설|효성|코오롱)/.test(b))
    return { tier: '1군', bonus: 15 };
  // 2군
  if (/(SK뷰|에스케이|이편한세상|꿈에그린|한화|호반|반도|제일|풍림|경남|벽산건설)/.test(b)) return { tier: '2군', bonus: 8 };
  // 중견
  if (/(우미|중흥|금호|계룡|신영|동문|벽산|성원|이수)/.test(b)) return { tier: '중견', bonus: 4 };
  // 공공(LH·SH·대한주택공사)
  if (/(대한주택공사|LH|한국토지주택|SH공사|서울주택)/.test(b)) return { tier: '공공', bonus: 3 };
  return { tier: '일반', bonus: 1 };
}

/** 세대수 등급 보너스 (Phase 9: 사용자 보편 선호 — 대단지 = 환금성·인프라·관리효율 동시) */
function getHouseholdBonus(n) {
  if (!n || !Number.isFinite(Number(n))) return 0;
  const v = Number(n);
  if (v >= 3000) return 30;
  if (v >= 2000) return 25;
  if (v >= 1000) return 20;
  if (v >= 500) return 12;
  if (v >= 300) return 5;
  return 0;
}

/** 주차 대수/세대 (Phase 9 강화) */
function getParkingBonus(parkingTotal, households) {
  const p = Number(parkingTotal), h = Number(households);
  if (!p || !h) return { ratio: null, bonus: 0 };
  const ratio = p / h;
  if (ratio >= 1.3) return { ratio: ratio.toFixed(2), bonus: 12 };
  if (ratio >= 1.0) return { ratio: ratio.toFixed(2), bonus: 8 };
  if (ratio >= 0.7) return { ratio: ratio.toFixed(2), bonus: 3 };
  return { ratio: ratio.toFixed(2), bonus: 0 };
}

/** 노후도 점수 (Phase 9: 신축 강세 — 사용자 보편 선호) */
function getAgeBonus(buildYear) {
  if (!buildYear) return { years: null, bonus: 0 };
  const years = new Date().getFullYear() - Number(buildYear);
  if (years <= 5) return { years, bonus: 25 };
  if (years <= 10) return { years, bonus: 18 };
  if (years <= 15) return { years, bonus: 12 };
  if (years <= 20) return { years, bonus: 6 };
  if (years <= 30) return { years, bonus: 2 };
  return { years, bonus: 0 };
}

/** 규제지역 페널티 (가산이 아닌 감산) */
function getRegulationPenalty(sigungu) {
  if (!sigungu) return { status: '미확인', bonus: 0 };
  // 2025.10.15 기준 강화 규제지역
  if (['강남구', '서초구', '송파구', '용산구'].includes(sigungu)) {
    return { status: '투기과열·토허구역 일부', bonus: -8 };
  }
  // 서울 25구는 모두 조정대상
  if (sigungu.endsWith('구') && sigungu.length <= 4) {
    return { status: '조정대상지역', bonus: -3 };
  }
  return { status: '비규제', bonus: 0 };
}

/** 점수 계산 — priority + 가구상황 + 예산 fit + 데이터 품질 + 객관 항목 (Phase 7) */
function computeAptScore(c, ctx) {
  const r = {};
  let total = 0;
  const p = ctx.priority;

  // 1) priority 가중치
  if (p === '환금성') {
    const sub = c.n * 4 + (c.households >= 500 ? 25 : (c.households >= 300 ? 12 : 0));
    r.priority_환금성 = sub; total += sub;
  } else if (p === '학군') {
    const goodSchoolGu = ['양천구', '강남구', '서초구', '송파구', '노원구', '광진구'];
    const sub = goodSchoolGu.includes(c.sigungu) ? 35 : 5;
    r.priority_학군 = sub; total += sub;
  } else if (p === '역세권') {
    const sub = c.n >= 12 ? 20 : (c.n >= 8 ? 12 : 5);
    r.priority_역세권 = sub; total += sub;
  } else if (p === '신축') {
    const sub = c.build_year >= 2018 ? 35 : (c.build_year >= 2012 ? 18 : 0);
    r.priority_신축 = sub; total += sub;
  } else if (p === '재건축') {
    const sub = (c.build_year && c.build_year <= 1995) ? 30 : (c.build_year && c.build_year <= 2000 ? 12 : 0);
    r.priority_재건축 = sub; total += sub;
  } else if (p === '교통') {
    const sub = c.n >= 10 ? 18 : 6;
    r.priority_교통 = sub; total += sub;
  } else if (p === '조용함') {
    const quietGu = ['도봉구', '강북구', '중랑구', '은평구', '금천구'];
    const sub = quietGu.includes(c.sigungu) ? 18 : 3;
    r.priority_조용함 = sub; total += sub;
  } else if (p === '갭투자') {
    const sub = c.n >= 10 ? 12 : 3;
    r.priority_갭투자 = sub; total += sub;
  }

  // 2) 가구 상황 보너스
  if (ctx.kidPlan === '초등' || ctx.kidPlan === '중등+') {
    const goodSchoolGu = ['양천구', '강남구', '서초구', '송파구', '노원구', '광진구'];
    if (goodSchoolGu.includes(c.sigungu)) {
      r.kids_school_bonus = 20; total += 20;
    }
  }
  if (ctx.stayYears === '10년+' && c.build_year >= 2010) {
    r.long_stay_bonus = 10; total += 10;
  }
  if (ctx.isFirstBuyer && c.avgPrice <= 90000) {
    r.first_buyer_bonus = 5; total += 5;
  }

  // 3) 예산 fit
  const ratio = c.avgPrice / (ctx.buy * 10000);
  if (ratio >= 0.9 && ratio <= 1.1) {
    r.budget_fit = 30; total += 30;
  } else if (ratio >= 0.8 && ratio <= 1.2) {
    r.budget_fit = 12; total += 12;
  }

  // 4) 거래량 (기본 점수) — Phase 9: n*0.5 로 축소 (이전엔 거래량이 점수 좌우)
  const txnScore = Math.round(c.n * 0.5);
  if (txnScore > 0) { r.transactions = txnScore; total += txnScore; }

  // ※ 데이터 품질 + 객관 항목 + universal preference 는 KAPT 호출 후 (applyObjectiveScore)

  return { total: Math.round(total), breakdown: r };
}

/** Phase 7: 객관 데이터 점수 추가 — KAPT API 호출 후 별도 적용 */
function applyObjectiveScore(c) {
  // c.score, c.scoreBreakdown 이 이미 1차 계산되어 있다고 가정
  const r = c.scoreBreakdown;

  // 데이터 품질 보너스
  if (c.households && !r.data_households) { r.data_households = 5; c.score += 5; }
  if (c.build_year && !r.data_build_year) { r.data_build_year = 5; c.score += 5; }

  // 객관 데이터 항목 — KAPT facility + sigungu 활용
  const district = getDistrictTier(c.sigungu);
  if (district.bonus && !r['객관_행정구위계']) { r['객관_행정구위계'] = district.bonus; c.score += district.bonus; }

  const builder = getBuilderTier(c.kaptInfo?.builder);
  if (builder.bonus && !r['객관_시공사']) { r['객관_시공사'] = builder.bonus; c.score += builder.bonus; }

  const hhBonus = getHouseholdBonus(c.households);
  if (hhBonus && !r['객관_세대수']) { r['객관_세대수'] = hhBonus; c.score += hhBonus; }

  const parking = getParkingBonus(c.kaptInfo?.parking, c.households);
  if (parking.bonus && !r['객관_주차']) { r['객관_주차'] = parking.bonus; c.score += parking.bonus; }

  const age = getAgeBonus(c.build_year);
  if (age.bonus && !r['객관_노후도']) { r['객관_노후도'] = age.bonus; c.score += age.bonus; }

  const reg = getRegulationPenalty(c.sigungu);
  if (reg.bonus && !r['객관_규제']) { r['객관_규제'] = reg.bonus; c.score += reg.bonus; }

  // Phase 8: 신고가 갱신 횟수 (6개월 내)
  if (c.new_high_count > 0 && !r['객관_신고가갱신']) {
    const sub = c.new_high_count >= 3 ? 8 : (c.new_high_count >= 1 ? 4 : 0);
    if (sub) { r['객관_신고가갱신'] = sub; c.score += sub; }
  }

  // Phase 9: amenities (사용자 보편 선호 — 지하철 인접·학교 밀집·생활인프라 강세)
  if (c.amenities && !r['객관_생활인프라']) {
    const a = c.amenities;
    let bonus = 0;
    // 지하철 — 사용자 보편 선호 1순위
    if (a.subway >= 5) bonus += 25;       // 다중 노선·환승 핵심
    else if (a.subway >= 3) bonus += 18;
    else if (a.subway >= 1) bonus += 8;
    // 학교 (학군 권역 신호)
    if (a.school >= 10) bonus += 15;
    else if (a.school >= 5) bonus += 8;
    else if (a.school >= 2) bonus += 3;
    // 종합병원 (생활안전 + 응급의료)
    if (a.hospital >= 3) bonus += 10;
    else if (a.hospital >= 1) bonus += 5;
    // 마트
    if (a.mart >= 3) bonus += 8;
    else if (a.mart >= 1) bonus += 3;
    // 공원
    if (a.park >= 5) bonus += 8;
    else if (a.park >= 1) bonus += 3;
    if (bonus) { r['객관_생활인프라'] = bonus; c.score += bonus; }
  }

  // 객관 fact 객체 — UI/PDF 노출용 (점수와 별개로 사용자에게 보여줌)
  c.objectiveFacts = {
    district: district.tier,
    builder: c.kaptInfo?.builder ? `${c.kaptInfo.builder} (${builder.tier})` : null,
    households: c.households || null,
    age_years: age.years,
    parking_per_household: parking.ratio,
    parking_total: c.kaptInfo?.parking || null,
    regulation: reg.status,
    transactions_6mo: c.n,
    new_high_count: c.new_high_count || 0, // Phase 8
    amenities: c.amenities || null,        // Phase 8: { school, mart, hospital, subway, cvs }
  };

  c.score = Math.round(c.score);
}

/** 추천 단지 후보 fetch — molit + apt_master 통합 + 점수 매칭 + 다양성 */
async function fetchCandidateApts(admin, input, limit) {
  const buy = parseFloat(input.maxBudget) || 0;
  const region = String(input.region || '').trim();
  const pyeong = String(input.pyeong || '').trim();
  const ctx = {
    buy,
    priority: String(input.priority || '환금성').trim(),
    kidPlan: String(input.kidPlan || '없음').trim(),
    stayYears: String(input.stayYears || '5~10년').trim(),
    isFirstBuyer: !!input.isFirstBuyer,
  };

  // 평형 범위
  let minSqm = 0, maxSqm = 999;
  if (pyeong.includes('소형')) { minSqm = 50; maxSqm = 75; }
  else if (pyeong.includes('중형')) { minSqm = 76; maxSqm = 109; }
  else if (pyeong.includes('대형')) { minSqm = 110; maxSqm = 200; }

  const minAmt = Math.round(buy * 0.7 * 10000);
  const maxAmt = Math.round(buy * 1.2 * 10000);

  // 지역
  let q = admin.from('molit_transactions')
    .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, exclu_use_ar, deal_amount, deal_date, apt_seq')
    .gte('exclu_use_ar', minSqm).lte('exclu_use_ar', maxSqm)
    .gte('deal_amount', minAmt).lte('deal_amount', maxAmt)
    .gte('deal_date', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

  const guMatch = region.match(/([가-힣]+구)/);
  if (guMatch) q = q.like('sigungu', `%${guMatch[1]}%`);
  else if (region.includes('서울')) q = q.like('lawd_cd', '11%');
  else if (region.includes('경기')) q = q.like('lawd_cd', '41%');
  else if (region.includes('인천')) q = q.like('lawd_cd', '28%');

  // Phase 9: 광역 검색 시 후보 풀 2500 (선호도 가산점 위해 더 넓게 후보 풀)
  const { data: txs, error } = await q.limit(2500);
  if (error) throw error;

  // 단지 그룹화 + build_year mode + 신고가 갱신 카운트
  const byApt = {};
  for (const t of (txs || [])) {
    const key = `${t.apt_name}|${t.sigungu}|${t.umd_nm}`;
    if (!byApt[key]) byApt[key] = {
      apt_name: t.apt_name, sigungu: t.sigungu, umd_nm: t.umd_nm,
      lawd_cd: t.lawd_cd,
      sum: 0, n: 0, areas: new Set(), latest: t.deal_date,
      buildYearCnt: {},
      deals: [], // Phase 8: 신고가 갱신 계산용
    };
    byApt[key].sum += t.deal_amount;
    byApt[key].n++;
    byApt[key].areas.add(Math.round(t.exclu_use_ar));
    if (t.deal_date > byApt[key].latest) byApt[key].latest = t.deal_date;
    if (t.build_year) {
      byApt[key].buildYearCnt[t.build_year] = (byApt[key].buildYearCnt[t.build_year] || 0) + 1;
    }
    byApt[key].deals.push({ date: t.deal_date, amount: t.deal_amount });
  }

  // Phase 8: 신고가 갱신 카운트 (최근 6개월 내 누적 max 갱신 횟수)
  function countNewHigh(deals) {
    const sorted = [...deals].sort((a, b) => a.date.localeCompare(b.date));
    let runningMax = 0, count = 0;
    for (const d of sorted) {
      if (d.amount > runningMax) {
        if (runningMax > 0) count++; // 첫 거래는 갱신으로 안 침
        runningMax = d.amount;
      }
    }
    return count;
  }

  let pool = Object.values(byApt)
    .filter(a => a.n >= 1)
    .map(a => {
      const entries = Object.entries(a.buildYearCnt);
      const mode = entries.length
        ? entries.reduce((m, [y, c]) => c > m[1] ? [y, c] : m, ['', 0])[0]
        : null;
      return {
        apt_name: a.apt_name, sigungu: a.sigungu, umd_nm: a.umd_nm,
        lawd_cd: a.lawd_cd, n: a.n, latest: a.latest,
        avgPrice: a.sum / a.n,
        areas: [...a.areas].sort((x, y) => x - y),
        build_year: mode ? Number(mode) : null,
        households: null,
        master_matched: false,
        new_high_count: countNewHigh(a.deals), // Phase 8
      };
    });

  // 점수 계산 (KAPT 호출 전 1차 점수: priority + 가구상황 + 예산fit + 거래량 + 행정구위계)
  for (const c of pool) {
    const s = computeAptScore(c, ctx);
    c.score = s.total;
    c.scoreBreakdown = s.breakdown;
    // 1차 행정구위계 점수도 미리 부여 — 강남/마용성광이 외곽보다 1차에서 우선
    const district = getDistrictTier(c.sigungu);
    if (district.bonus) {
      c.scoreBreakdown['객관_행정구위계'] = district.bonus;
      c.score += district.bonus;
    }
  }
  pool.sort((a, b) => b.score - a.score);

  // Phase 9: 다양성 강제 제거 — 한 구에 몰려도 OK. 사용자 의도: "최적 매물 우선"
  //   상위 limit*2 개 후보를 KAPT 호출 대상으로 (API 호출 비용 절감)
  const out = pool.slice(0, Math.min(limit * 2, 14));

  // Phase 6+ (2026-04-26): KAPT API 통합 — 선정된 N개 단지만 facility 병렬 fetch
  //   resolveFacility() 가 ILIKE 토큰 매칭 + KAPT API + DB 캐시 (90일) 다 처리.
  //   첫 호출: API 호출 → DB 저장 (응답 +5~10초). 두 번째: cache hit (0초).
  await Promise.all(out.map(async (c) => {
    try {
      const f = await resolveFacility({ aptName: c.apt_name, sigungu: c.sigungu, umdNm: c.umd_nm });
      if (f?.raw) {
        const raw = f.raw;
        c.households = raw.kaptdaCnt || raw.householdCount || raw.kaptCount || null;
        // build_year 우선순위 #1: KAPT 공식 사용승인일
        const useDate = raw.kaptUsedate || raw.kaptUseDate || raw.useApprovalDate;
        if (useDate) {
          const ys = String(useDate).slice(0, 4);
          if (/^\d{4}$/.test(ys)) c.build_year = Number(ys);
        }
        c.master_matched = true;
        c.master_name = f.official; // 정식 단지명 (예: '답십리동서울한양')
        // 추가 풍부화: 시공사·주차·승강기 (AI prompt 활용)
        c.kaptInfo = {
          builder: raw.kaptBcompany || raw.bcompany || null,
          parking: raw.kaptdPcnt || raw.parkingCount || null,
          elevators: raw.kaptdEcapa || null,
        };
      }
    } catch (e) {
      logger.warn({ err: e.message, apt: c.apt_name }, 'facility 호출 실패 (단지 1개)');
    }
  }));

  // Phase 8 (2026-04-26): 좌표 해결 → 카카오 amenities 병렬 fetch
  // 7단지 좌표 일괄 + 주변 시설 카운트 (학교/마트/병원/지하철/공원)
  try {
    const aptsForGeo = out.map(c => ({
      kaptCode: c.kapt_code, // KAPT 매칭됐으면 우선
      aptName: c.master_name || c.apt_name,
      sigungu: c.sigungu,
      umdNm: c.umd_nm,
    }));
    const coords = await resolveCoordBatch(aptsForGeo, 4);
    // coords 와 out 의 인덱스 일치 가정 (resolveCoordBatch 가 보장하는지 확인 필요 — 일단 동일 길이 매칭)
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      const coord = coords?.[i];
      if (coord?.lat && coord?.lng) {
        c.lat = coord.lat; c.lng = coord.lng;
      }
    }
    // amenities 병렬 (좌표 있는 단지만)
    await Promise.all(out.map(async (c) => {
      if (!c.lat || !c.lng) return;
      try {
        const amen = await getNearbyAmenities(c.lat, c.lng);
        if (amen) {
          c.amenities = amen; // { school, mart, hospital(종합병원), subway, cvs, park }
        }
      } catch (e) {
        logger.warn({ err: e.message, apt: c.apt_name }, 'amenities 호출 실패');
      }
    }));
  } catch (e) {
    logger.warn({ err: e.message }, 'Phase 8 좌표/amenities 일괄 처리 실패 — 객관 점수만으로 진행');
  }

  // Phase 7 + 8 + 9: KAPT + amenities 호출 후 객관 점수 + objectiveFacts 적용
  for (const c of out) {
    applyObjectiveScore(c);
  }
  // Phase 9: 객관 점수 (universal preference) 적용 후 최종 정렬
  out.sort((a, b) => b.score - a.score);
  const finalOut = out.slice(0, limit);
  finalOut.forEach((c, i) => { c.rank = i + 1; });

  // 진단 로그 — 운영자가 매칭 추적
  logger.info({
    region, priority: ctx.priority, pool_size: pool.length,
    selected: finalOut.map(c => ({
      name: c.apt_name, sigungu: c.sigungu, score: c.score,
      n: c.n, master_matched: c.master_matched,
    })),
  }, '보고서 후보 매칭 (Phase 9)');

  return finalOut;
}

/** AI prompt 빌드 — 사용자 입력 + 정책 + 단지 정보 + 점수 breakdown + 객관 fact (Phase 7) */
function buildReportPrompt(input, policy, candidates) {
  const aptList = candidates.map((c, i) => {
    const householdsStr = (c.households && Number.isFinite(Number(c.households))) ? `${c.households}세대` : '미상';
    const displayName = c.master_name || c.apt_name;
    const breakdownStr = Object.entries(c.scoreBreakdown || {})
      .map(([k, v]) => `${k}=${v}`).join(', ');
    const facts = c.objectiveFacts || {};
    const am = facts.amenities;
    const amStr = am ? `반경 1.2~2km: 학교 ${am.school}·마트 ${am.mart}·종합병원 ${am.hospital}·지하철역 ${am.subway}·공원 ${am.park||0}` : null;
    const factsList = [
      facts.district ? `행정구위계: ${facts.district}` : null,
      facts.builder ? `시공사: ${facts.builder}` : null,
      facts.parking_per_household ? `주차: 세대당 ${facts.parking_per_household}대 (총 ${facts.parking_total})` : null,
      facts.age_years != null ? `노후도: ${facts.age_years}년차` : null,
      facts.regulation ? `규제: ${facts.regulation}` : null,
      facts.new_high_count > 0 ? `최근 6개월 신고가 ${facts.new_high_count}회 갱신` : null,
      amStr,
    ].filter(Boolean).join(' | ');
    return `${i + 1}. ${displayName} (${c.sigungu} ${c.umd_nm})
   - 준공: ${c.build_year || '미상'}년 / 세대수: ${householdsStr}
   - 평형: ${c.areas.map(a => `${a}㎡(${Math.round(a / 3.3)}평)`).join(', ')}
   - 최근 6개월 평균가: ${(c.avgPrice / 10000).toFixed(2)}억원 (${c.n}건 거래, 최근 ${c.latest})
   - 객관 fact: ${factsList || '데이터 부족'}
   - 매칭 점수: ${c.score}점 (${breakdownStr})`;
  }).join('\n\n');

  // REPORT_SYSTEM_PROMPT 는 callAI options.system 으로 전달됨 (중복 제거)
  return `## 회원님 가구 상황
- 매수가: ${input.maxBudget}억
- 자기자본: ${input.myCash || '?'}억
- 보유 주택: ${input.houseStatus || '?'}
- 생애 최초: ${input.isFirstBuyer ? '예' : '아니오'}
- 희망 지역: ${input.region}
- 평형: ${input.pyeong || '전체'}
- 학군 중요도: ${input.schoolNeeded ? '중요' : '보통'}
- 자녀 계획: ${input.kidPlan || '없음'}
- 거주 기간 목표: ${input.stayYears || '5~10년'}
- 우선순위 1순위: ${input.priority || '환금성'}
- 직장 위치: ${input.workplaceArea || '미입력'}

## 현재 부동산 정책 환경 (${policy.snapshot})
- 규제지역: ${policy.regulatedAreas}
- 토지거래허가: ${policy.landTrade}
- 정책자금 종류: ${(policy.policyLoans || []).join(', ')} (자세한 자격·신청은 ${policy.policyContact})
- ※ ${policy.note}

## 단지 정보 (${candidates.length}개 후보, 최근 6개월 실거래 기반)
${aptList}

## 작성 지침
1. coreMessages — 회원님 가구 상황 기반 핵심 방향 3줄
2. checklist — 매수·갈아타기 체크리스트 5~7개 + 별점 + 짧은 근거 (필수)
   ★★★ = 회원님 1순위(${input.priority || '환금성'}) 직접 부합 + 데이터로 입증
   ★★  = 보조 항목 부합 또는 부분 입증
   ★   = 일반 권고 사항
   각 항목 형식: {"text":"항목명 — 근거 (최대 15자)", "stars":N}
   예: {"text":"회전율 — 6개월 17건·대단지", "stars":3}
        {"text":"역세권 — 7호선 도보 8분", "stars":3}
        {"text":"준공연도 — 1999년 노후도 중간", "stars":2}
3. apartments — 위 후보 단지 그대로 (rank·name·areaSqm·areaPyeong·buildYear·households·ratio·location·pros·cons·priceFit·recommendation·matchReason)
   - name 형식: "단지명 (시군구 동)" — 예: "한양아파트 (노원구 상계동)" — 동명 누락 금지 (사용자 식별용)
   - households: 입력 데이터의 세대수 그대로 사용. "미상"이면 "미상"으로 표기 (NaN/null 금지)
   - priceFit: "매수가 ${input.maxBudget}억 vs 단지 평균 X억 (X% 초과/일치/여유)" — 단순 비교만
   - recommendation: "검토 권장" 또는 "예산 초과 — 다른 단지 비교 권장" — 매수 추천 X
   - matchReason: 매칭 점수 breakdown 을 자연스러운 한 줄로 풀어 씀 (예: "1순위 환금성 부합(거래활발 60점) + 예산 적합(30점)") — 사용자 투명성 핵심
   ※ pros/cons/location 작성 시 위 '객관 fact' 의 시공사·세대수·주차·노후도·규제 정보를 적극 활용 (예: pros 에 "삼성 1군 브랜드, 세대당 1.3대 주차" 같이 구체적 fact 인용)
   ★ 응답 길이 절약: location/pros/cons/recommendation/matchReason 각각 60자 이내, ratio 30자 이내 (응답 토큰 부족시 잘림 방지)
4. longTermView — 자녀 시점 기반 갈아타기 시나리오 (가격 수치 X, 권역만)
5. tips — 실무 TIP 5~6개 (회전율·RR·복비·잔금·임장)

JSON만 반환. 다른 텍스트 X.`;
}

module.exports = router;
