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
 *   - Claude Sonnet 4.5 + cache_control (PDF 구조 prompt 매번 cache hit)
 *   - 출력: JSON 5섹션 (핵심방향·정책환경·체크리스트·단지·갈아타기·TIP)
 */
const express = require('express');
const { callAI } = require('../services/aiService');
const { filterAdviceOutputDeep, REPORT_FILTER_FIELDS } = require('../services/aiOutputFilter');
const { getSupabaseAdmin } = require('../db/client');
const { getSnapshot } = require('../services/regulationsService');
const { resolveFacility } = require('../services/aptFacilityService');
const { resolveCoordBatch } = require('../services/geocodeCacheService');
const { getNearbyAmenities, countNearby, keywordToCoord, getTransitMinutes } = require('../services/kakaoService');
const cache = require('../cache');
const logger = require('../logger');
const crypto = require('crypto');

const router = express.Router();

// Phase B-2 (2026-05-01): REPORT_SYSTEM_PROMPT → REPORT_SPECIFIC 으로 변환.
//   SHARED_BASE (services/aiService.js) 가 callAI 안에서 자동 prepend → endpoint 간 cache 공유.
//   REPORT_SPECIFIC 만 report 전용 톤·출력 형식 정의 (~800 토큰).
//   기존 절대 금지 5개는 SHARED_BASE 의 10개 rule 에 통합됨.
const REPORT_SPECIFIC = `## 추가 규칙 (보고서 응답)
- ⛔ "추천", "사세요", "매수하세요" 등 권유 표현 금지. 대신 "조건 부합 단지", "탐색 후보" 사용.
- ⛔ 미래 가격 예측 금지 ("N억 오를 것", "5년 후 N억"). 정성적 안내만 ("자녀 학교 시기 갈아타기 권장").
- ⛔ 대출 한도·DSR 분석은 보고서에 포함 X. 정책자금은 "이런 게 있다" 정보만.

## 톤
- "회원님" 호칭 사용 (친근하고 전문적)
- 컨설턴트 어투 ("솔직히", "이런 점은", "검토해보세요")
- 별점 ★★★ ★★ ★ 활용 (PDF 컨설팅 톤)
- 단지명 정확히 (오타·줄임 X)
- ⛔ markdown 문법 사용 금지 — **굵게**, __강조__, # 제목, \` 코드, --- 구분선 등 X
   - 별 두 개 (\`**\`) 가 plain text 로 그대로 노출되어 가독성 망침
   - 강조가 필요하면 핵심 단어를 문장 자연스러운 위치에 배치하거나, 별점 ★ 활용
- 각 문장 80자 이내 권장 (가독성)

## 출력 분량 제약 (Phase B-1, 2026-04-29 — 비용 절감 + 잘림 방지)
- ⛔ 출력은 5500 토큰 이내. 초과 위험 시 tips 후순위부터 생략 (5번째→6번째 순).
- ⛔ markdown 헤더는 H2(##) 까지만. H3(###) 이하 금지.
- ⛔ 이모지·인사말("안녕하세요")·맺음말("감사합니다") 금지.
- ⛔ 단지별 분석(pros/cons/location/recommendation/matchReason 합산) 단지당 200자 이내.
- ⛔ JSON 외 부가 설명 텍스트 금지 (JSON 앞뒤로 코멘트 X).

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
      "priceFit": "매수가 7억 vs 회원님 평형대 평균 8.1억 (16% 초과)",
      "recommendation": "검토 시 21평 또는 다른 단지 비교 권장"
    }
  ],
  "longTermView": "5년 갈아타기 정성적 시나리오 (가격 수치 X, 자녀 학교 시기 + 권역 권장)",
  "tips": ["실무 TIP 1", "실무 TIP 2", ...]
}`;

router.post('/generate', async (req, res) => {
  const userInput = req.body || {};
  const userId = req.user?.id || null;

  // 입력 검증 + 정규화 (2026-05-31): 자유입력 길이 제한·범위 clamp·enum 정규화.
  //   목적: prompt 토큰 폭주 / injection 표면 / 비정상 숫자가 prompt·SQL 에 유입되는 것 차단.
  //   범위 근거(추측 아님): frontend/index.html 매수가 bp(L1271 min=0.1 max=500 억) / 자기자본 mc(L1271 min=0 max=500 억).
  //   문자열 40자: chat.js _sStr(region/workplaceArea, 40) (L94) 선례와 일치.
  //   enum/기본값: UI chip 'on' 기본값(L1268/1322/1312/1294/1304) + 기존 fetchCandidateApts 기본값(환금성/없음/5~10년)과 동일.
  //   ※ 정상 입력(프론트 UI 경유)은 모두 화이트리스트 내 → 동작 불변. 비정상 값만 정규화됨.
  const _num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
  const _clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const _str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const _enum = (v, allowed, dflt) => { const t = String(v == null ? '' : v).trim(); return allowed.includes(t) ? t : dflt; };

  const _budget = _num(userInput.maxBudget);
  if (!Number.isFinite(_budget) || _budget <= 0) {
    return res.status(400).json({ error: '매수가 (maxBudget) 필수' });
  }
  if (!userInput.region || !String(userInput.region).trim()) {
    return res.status(400).json({ error: '희망 지역 (region) 필수' });
  }
  // 숫자 — UI 범위 clamp (억 단위). 음수/NaN/과대값 차단.
  userInput.maxBudget = _clamp(_budget, 0.1, 500);
  const _cash = _num(userInput.myCash);
  userInput.myCash = Number.isFinite(_cash) ? _clamp(_cash, 0, 500) : 0;
  // 연소득(만원 단위) — UI 상·하한 미지정 → 보수적 sanity cap(0 ~ 1,000,000만원 = 100억) + 음수/NaN 차단.
  const _inc = _num(userInput.annualIncome);
  userInput.annualIncome = Number.isFinite(_inc) ? _clamp(_inc, 0, 1000000) : 0;
  // 자유입력 문자열 — 40자 제한 (prompt 토큰 폭주·injection 표면 축소).
  userInput.region = _str(userInput.region, 40);
  userInput.workplaceArea = _str(userInput.workplaceArea, 40);
  // enum 필드 — 화이트리스트 외 값(garbage·injection 문자열)은 안전 기본값으로 정규화.
  userInput.houseStatus = _enum(userInput.houseStatus, ['무주택', '1주택', '1주택 (처분조건부)', '2주택+'], '무주택');
  userInput.pyeong      = _enum(userInput.pyeong, ['소형 15~22평', '중형 23~33평', '대형 34평+', '전체'], '전체');
  userInput.priority    = _enum(userInput.priority, ['학군', '역세권', '환금성', '조용함', '교통', '신축', '재건축', '갭투자'], '환금성');
  userInput.kidPlan     = _enum(userInput.kidPlan, ['없음', '예정', '0~6세', '초등', '중등+'], '없음');
  userInput.stayYears   = _enum(userInput.stayYears, ['3년 이하', '5~10년', '10년+'], '5~10년');
  userInput.isFirstBuyer = !!userInput.isFirstBuyer;
  userInput.schoolNeeded = !!userInput.schoolNeeded;

  // 캐시 키 — 동일 입력 30분 캐시
  // MOB-AUDIT-2026-05-03: JSON.stringify 의 key 순서 비결정성 → 동일 입력 두 번째 호출이 fresh 가 될 수 있음
  //   → keys sort 후 stringify (결정성 보장) — 비용 절감
  const _sortedInput = Object.keys(userInput).sort().reduce((o, k) => { o[k] = userInput[k]; return o; }, {});
  const cacheKey = `report:${crypto.createHash('sha256').update(JSON.stringify(_sortedInput)).digest('hex').slice(0, 16)}`;
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

    // 4) AI 호출 — REPORT_SPECIFIC 을 systemSpecific 으로 명시 전달
    //    Phase 6 (2026-04-26): 4500 → 6500 (단지 확장 후 6087자 잘림 실측 대응)
    //    Phase B-1 (2026-04-29): 출력 분량 제약 강화 + 6500 → 5500 (1차 조정, -15%)
    //    Phase B-2 (2026-05-01): SHARED_BASE + REPORT_SPECIFIC 분리 — endpoint 간 cache 공유 + ttl 1h
    //    P2-3 (2026-05-04): maxTokens 단지 수 비례 — 단지 7개+amenities 풍부 시 잘림 차단
    //      base 1500 (longTerm + tips + 헤더) + 단지당 600 → 7단지 = 5700
    const _candidatesCount = Array.isArray(candidates) ? candidates.length : 7;
    const _maxTokens = Math.min(7000, 1500 + _candidatesCount * 600);
    // AI-DEGRADE-2026-07-11 (Sprint HHHH, 운영자 "유료 API 없이 살리는 방법 우선"):
    //   기존엔 AI 실패(크레딧 소진·429·503·파싱 실패) 시 보고서 전체가 죽고, 이미 수집한
    //   candidates(MOLIT+KAPT+Kakao 결정론 데이터)를 통째로 버렸음 (라이브 재현: Anthropic
    //   credit balance too low → 500). AI 는 문장 생성만 담당하므로 실패 시
    //   buildDataOnlyReport() 로 데이터 전용 보고서를 반환 — 핵심 가치(단지 정리·객관정보·
    //   정책 컨텍스트·priceFit)는 AI 없이 유지. 응답에 aiUnavailable 플래그로 정직하게 표시.
    let parsed;
    let _aiDown = null;
    try {
    const result = await callAI(
      [{ role: 'user', content: prompt }],
      false,
      { userId, systemSpecific: REPORT_SPECIFIC, maxTokens: _maxTokens }
    );
    const cleaned = String(result.content || '').replace(/```json|```/g, '').trim();

    // Phase B-2 (2026-05-01): char 기반 → token 기반 임계 (시나리오 B 5723 char vs 4167 token 단위 불일치 fix)
    //   max_tokens 5500 의 95% = 5225 token. cleaned_len 도 진단용으로 함께 기록.
    if ((result.usage?.output_tokens || 0) > 5225) {
      logger.warn({
        cleaned_len: cleaned.length,
        usage: result.usage,
        max_tokens: 5500,
        threshold_tokens: 5225,
      }, '보고서 출력이 max_tokens 95% 도달 — 잘림 risk');
    }
    // MOB-AUDIT-2026-05-03: 그리디 매칭 → 응답 끝 부가 텍스트 시 invalid JSON
    //   → balanced brace counter 로 정확 매칭 (첫 { 부터 brace 0 도달 위치까지)
    let jsonStr = cleaned;
    const _firstBrace = cleaned.indexOf('{');
    if (_firstBrace >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = _firstBrace; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
        else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end >= 0) jsonStr = cleaned.slice(_firstBrace, end + 1);
    }
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // 진단 로그 — sample_head/tail 은 운영자 디버그용 유지 (response body 의 _debug 는 제거)
      logger.error({
        err: e.message,
        sample_head: cleaned.slice(0, 800),
        sample_tail: cleaned.slice(-400),
        cleaned_len: cleaned.length,
      }, '보고서 AI JSON 파싱 실패');
      throw e; // AI-DEGRADE: 기존 502 대신 데이터 전용 보고서로 degrade
    }
    } catch (aiErr) {
      // AI 실패 전 분류: 사용자 월예산(budget) vs 그 외(upstream — 크레딧 소진·503·타임아웃·파싱)
      const { BudgetExceededError: _BE } = require('../services/aiService');
      _aiDown = aiErr instanceof _BE ? 'budget' : 'upstream';
      logger.warn({ err: aiErr.message, mode: _aiDown, userId: userId || null },
        '보고서 AI 실패 — 데이터 전용 보고서로 degrade');
      parsed = buildDataOnlyReport(userInput, candidates);
    }

    // 안전망: markdown 강조 표기 (** __ ##) 자동 제거 — prompt 가 금지해도 가끔 새어나옴
    stripMarkdownDeep(parsed);

    // FILTER-UNIFY-2026-05-10 (M-3 β): chat.js 의 filterAdviceOutput 과 대칭.
    //   sanitize 직후 + backend objectiveFacts 주입 직전에 적용 — backend 주입 데이터는 검사 X.
    //   매칭 시 해당 필드 string 만 안내 텍스트로 교체 (응답 통째 거부 X — 사용자 경험 보호).
    //   matched 패턴명 ('buy_imperative' 등) 은 내부 정책 정보 → 서버 logger 만, client 응답엔 boolean flag 만.
    const _filterRes = filterAdviceOutputDeep(parsed, REPORT_FILTER_FIELDS);
    if (_filterRes.filtered) {
      logger.warn({
        source: 'ai-output-filter-deep',
        endpoint: 'report',
        userId: userId || null,
        matched: _filterRes.matched,
      }, 'AI 응답 단언 표현 감지 → report JSON 필드 교체');
      parsed._filtered = true;
    }

    // Phase 7 (2026-04-26): AI 응답 apartments 에 backend 의 objectiveFacts 주입
    //   AI 가 생성하지 않는 객관 데이터 — backend 가 직접 매칭해서 보장
    if (Array.isArray(parsed.apartments)) {
      parsed.apartments.forEach((a, i) => {
        const c = candidates[i];
        if (c?.objectiveFacts) a.objectiveFacts = c.objectiveFacts;
        if (c?.score != null) a.matchScore = c.score;
        // 동명 단지 식별 보장 (2026-05-31): name 을 backend 후보(canonical apt_name + 행정구역)로 강제 정합.
        //   AI 가 prompt 의 "단지명 (시군구 동)" 형식을 어겨도(누락/오타) 보고서·PDF·북마크 식별 신뢰 유지.
        //   render(_renderReport)·PDF(_downloadReportPDF)·북마크(_addAllReportAptsToBookmarks) 모두 a.name 사용 —
        //   표시 escape(_escHtml)·scoring·prompt 로직 불변. 후보 부재 시(c 없음) AI name 그대로 둠.
        if (c?.apt_name) {
          const _loc = [c.sigungu, c.umd_nm].filter(Boolean).join(' ').trim();
          a.name = _loc ? `${c.apt_name} (${_loc})` : c.apt_name;
        }
        // PRICE-INTEGRITY-2026-06-14: priceFit(예산매칭) 을 backend 결정론 계산으로 주입 — AI 전사 환각 차단.
        //   c.avgPrice(회원님 평형대 실거래 평균) + maxBudget → 정확 비교. name·objectiveFacts 와 같은 candidate[i] 출처라 일관.
        const _pf = _buildPriceFit(c?.avgPrice, userInput.maxBudget);
        if (_pf) a.priceFit = _pf;
      });
    }

    const out = {
      report: parsed,
      policyContext: policyData,
      generatedAt: new Date().toISOString(),
      disclaimer: '본 보고서는 국토교통부·한국부동산원 공공 데이터 기반 정보 정리이며, 투자자문업·중개업·대출모집인업이 아닙니다. 매수·매도 추천 X, 미래 가격 예측 X. 모든 의사결정과 책임은 본인에게 있습니다.',
      ...(_aiDown ? { aiUnavailable: true, aiUnavailableReason: _aiDown } : {}),
    };
    cache.set(cacheKey, out, _aiDown ? 300 : 1800); // AI degrade 시 5분만 — AI 복구 시 정상판으로 빨리 교체
    res.json({ ...out, fromCache: false });
  } catch (e) {
    // P0 (Agent 3차 audit, 2026-05-04): BudgetExceededError 처리 누락 → Pro 가입 funnel 차단
    //   chat.js / clause.js 는 처리됨. report.js 만 generic 500 → 사용자 "오류" 만 인지.
    const { BudgetExceededError, GlobalAiBudgetExceededError } = require('../services/aiService');
    if (e instanceof BudgetExceededError) {
      return res.status(429).json({
        code: 'budget_exceeded',
        error: '이번 달 AI 사용 한도에 도달했어요. 다음 달 1일에 리셋됩니다.',
        budget: e.info,
      });
    }
    if (e instanceof GlobalAiBudgetExceededError) {
      return res.status(503).json({
        code: 'ai_globally_paused',
        error: 'AI 보고서 생성이 오늘 많이 사용되어 잠시 멈췄어요. 잠시 후 다시 시도해주세요. (단지 검색·LTV 계산은 정상)',
        retryAfterSec: 1800,
      });
    }
    logger.error({ err: e.message, stack: e.stack }, '보고서 생성 실패');
    // MOB-AUDIT-2026-05-03: production 에선 generic 메시지 — stack 내부 정보 누출 차단
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: isProd ? '보고서 생성 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.' : e.message,
    });
  }
});

/**
 * AI-DEGRADE-2026-07-11 (Sprint HHHH): AI 실패 시 데이터 전용 보고서.
 * 전 필드가 이미 수집된 결정론 데이터(candidates: MOLIT 실거래·KAPT 세대수/주차·Kakao 편의시설,
 * objectiveFacts)와 서비스가 상시 안내하는 사실 문구만 사용 — 생성·추정 없음 (환각 0).
 * 프론트 _renderReport 필수 필드(coreMessages/checklist/apartments/longTermView/tips) 전부 충족.
 * priceFit·objectiveFacts·matchScore·name 은 아래 기존 backend 주입 로직이 동일하게 채움.
 */
function buildDataOnlyReport(userInput, candidates) {
  const curYear = new Date().getFullYear();
  const apartments = (candidates || []).map((c, i) => {
    const f = c.objectiveFacts || {};
    const areaMain = Array.isArray(c.areas) && c.areas.length ? Number(c.areas[0]) : null;
    const age = (c.build_year && c.build_year > 1900) ? curYear - c.build_year : null;
    const pros = [
      (c.households && c.households >= 1000) ? `대단지 ${Number(c.households).toLocaleString()}세대` : null,
      (f.parking_per_household && f.parking_per_household >= 1) ? `주차 세대당 ${f.parking_per_household}대` : null,
      (c.n >= 20) ? `최근 6개월 거래 ${c.n}건 (거래 활발)` : null,
      f.builder ? `시공 ${f.builder}` : null,
    ].filter(Boolean).join(' · ');
    const cons = [
      (age != null && age >= 25) ? `준공 ${age}년차 — 수리·관리 상태 임장 확인 필요` : null,
      (c.n <= 5) ? `최근 6개월 거래 ${c.n}건 — 표본 적음(시세 판단 주의)` : null,
    ].filter(Boolean).join(' · ');
    return {
      rank: i + 1,
      name: `${c.apt_name} (${c.sigungu} ${c.umd_nm})`,
      areaSqm: areaMain || undefined,
      areaPyeong: areaMain ? Math.round(areaMain / 3.3058) : undefined,
      buildYear: c.build_year || 0,
      households: c.households || '미상',
      ratio: `최근 6개월 실거래 ${c.n || 0}건`,
      // IIII: 위계 라벨("서울 외곽구" 등)이 단독 노출되면 어색(라이브 확인) — 실제 행정구역을 주정보로, 라벨은 괄호
      location: [`${c.sigungu} ${c.umd_nm}${f.district ? ` (${f.district})` : ''}`, f.regulation].filter(Boolean).join(' · '),
      pros: pros || '객관 정보는 아래 표 참조',
      cons: cons || '단점은 임장으로 직접 확인 권장',
      priceFit: '', // 아래 _buildPriceFit 주입이 덮어씀
      recommendation: '정보 참고',
    };
  });
  return {
    coreMessages: [
      `매수가 ${userInput.maxBudget}억 · 자기자본 ${userInput.myCash}억 · ${userInput.region} 조건의 최근 6개월 실거래 데이터를 정리했어요.`,
      // '추천' 단어는 자체 단언표현 필터(filterAdviceOutputDeep)에 걸림 (라이브 확인) — 필터 안전 문구 사용
      `아래 ${apartments.length}개 단지는 국토교통부 실거래 기준 조건 부합 단지 정리예요 — 의사결정 책임은 본인에게 있어요.`,
      'AI 컨설팅 코멘트는 현재 일시 중단 — 실거래·세대수·주차·규제 등 객관 데이터만 표시해요.',
    ],
    checklist: [
      { text: '등기부등본 최신본 확인 (계약 직전 재확인)', stars: 3 },
      { text: '대출 사전심사 — 스트레스 DSR 반영 한도 확인 (상단 대출계산 탭)', stars: 3 },
      { text: '규제지역 여부·전입 의무 확인 (10.15 규제 요약 참고)', stars: 2 },
      { text: '관리비·주차 실태 임장 확인 (임장노트 탭 활용)', stars: 2 },
      { text: '특약 초안 준비 (특약 탭 — 표준 템플릿 제공)', stars: 1 },
    ],
    apartments,
    longTermView: 'AI 시나리오 분석이 일시 중단 상태예요. 단지별 실거래 추이·신고가 이력은 각 단지 상세의 실거래가·가격 시그널 탭에서 확인할 수 있어요.',
    tips: [
      '실거래는 신고 후 해제되는 경우가 있어요 — 단지 상세의 거래 해제 안내를 참고하세요.',
      '같은 단지도 평형·층에 따라 가격 차가 커요 — 실거래가 탭의 평형 필터로 확인하세요.',
      '정책자금(디딤돌·신생아 특례) 해당 여부는 사이드바 정책자금 자격에서 확인하세요.',
    ],
    _dataOnly: true,
  };
}

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

/** PRICE-INTEGRITY-2026-06-14: 예산매칭(priceFit) 결정론 생성 — AI 전사 환각 차단.
 *  @param avgPriceManwon 회원님 평형대 실거래 평균가 (만원, c.avgPrice)
 *  @param maxBudgetEok 매수가 (억, userInput.maxBudget)
 *  운영자 #1 룰(환각 차단·공식 출처): 가격 비교는 AI 가 아니라 DB 실거래 평균으로 보장. */
function _buildPriceFit(avgPriceManwon, maxBudgetEok) {
  const avg = Number(avgPriceManwon), bud = Number(maxBudgetEok);
  if (!Number.isFinite(avg) || avg <= 0 || !Number.isFinite(bud) || bud <= 0) return null;
  const avgEok = avg / 10000;
  const diffPct = Math.round((avgEok - bud) / bud * 100);
  const label = Math.abs(diffPct) <= 2 ? '예산 일치'
              : diffPct > 0 ? `${diffPct}% 초과`
              : `${Math.abs(diffPct)}% 여유`;
  return `매수가 ${bud}억 vs 회원님 평형대 평균 ${avgEok.toFixed(2)}억 (${label})`;
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
    regulatedAreas: '서울 25구 + 경기 15곳 (과천·광명·성남·수원·안양·용인·의왕·하남·구리·화성 동탄 등, 2026.6.30 동탄·기흥·구리 신규 지정)',
    landTrade: '규제지역 토지거래허가구역 — 2년 실거주 의무·갭투자 금지 (2026.7.5 동탄·기흥·구리 추가 지정)',
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

/** 행정구 위계 (Phase 9.1: SQL 진단 후 추가 강화 — 9억 예산에 핵심권 단지 다수 존재 확인 */
function getDistrictTier(sigungu) {
  if (!sigungu) return { tier: '기타', bonus: 0 };
  if (['강남구', '서초구', '송파구'].includes(sigungu)) return { tier: '강남3구', bonus: 60 };
  if (['마포구', '용산구', '성동구', '광진구'].includes(sigungu)) return { tier: '마용성광', bonus: 50 };
  if (['양천구', '영등포구', '강동구'].includes(sigungu)) return { tier: '서울 핵심구', bonus: 30 };
  if (['과천시', '분당구', '판교'].some(k => sigungu.includes(k))) return { tier: '분당·과천·판교', bonus: 35 };
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
  if (/(아크로|디에이치|르엘|푸르지오써밋|반포자이|래미안첼리투스)/.test(b)) return { tier: '1군 프리미엄', bonus: 30 };
  // 1군 일반 — 시공사명 또는 브랜드명 모두 매칭
  if (/(힐스테이트|래미안|자이|롯데캐슬|푸르지오|아이파크|더샵|디오슬|디에트르|두산위브|위브)/.test(b))
    return { tier: '1군', bonus: 20 };
  if (/(삼성물산|GS건설|현대건설|현대산업|HDC|대림|DL|대우|롯데건설|포스코|두산|쌍용|한화건설)/.test(b))
    return { tier: '1군', bonus: 20 };
  if (/(태영|한신공영|한라건설|한신건설|동부건설|효성|코오롱)/.test(b))
    return { tier: '1군', bonus: 20 };
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

  // 1) priority 가중치 (Phase 9.1: 환금성 가중치 n*4 → n*1.5 — 외곽 거래활발이 핵심권 못 이기던 문제)
  if (p === '환금성') {
    const sub = Math.round(c.n * 1.5) + (c.households >= 500 ? 25 : (c.households >= 300 ? 12 : 0));
    r.priority_환금성 = sub; total += sub;
  } else if (p === '학군') {
    // MOB-AUDIT-2026-05-03: 외곽 학군 우선순위 사용자에게 ★★★ 0개 risk → 부분 매칭 보강
    //   양천·강남·서초·송파·노원·광진 (35) / 마포·용산·성동·영등포·중구·종로 (18) / 외 (8)
    // P1-9 (2026-05-04): 학원 핵심 동 단위 추가 보너스 (대치·목동·잠실·중계·반포 등)
    //   양천구 ≠ 목동만, 강남구 ≠ 대치동만 — 동 단위 매칭으로 정확화
    const topSchoolGu = ['양천구', '강남구', '서초구', '송파구', '노원구', '광진구'];
    const midSchoolGu = ['마포구', '용산구', '성동구', '영등포구', '중구', '종로구', '동작구', '강동구'];
    const topSchoolDong = ['대치동', '목동', '잠실동', '중계동', '반포동', '서초동', '여의도동', '도곡동'];
    let sub = topSchoolGu.includes(c.sigungu) ? 35 : (midSchoolGu.includes(c.sigungu) ? 18 : 8);
    if (topSchoolDong.includes(c.umd_nm)) sub += 10; // 핵심 동 가산점
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
  else {
    // P1-1 (2026-05-04): lawd_cd LIKE '11%' → IN (...) 명시
    //   진단 (EXPLAIN): LIKE prefix 시 인덱스 미활용 → Parallel Seq Scan 960ms
    //   변경: IN (서울 25개 코드) 명시 → idx_molit_lawd_date 인덱스 활용 → ~10x 향상 예상
    const { LAWD_CODES } = require('../services/transactionService');
    const codeList = Object.values(LAWD_CODES);
    if (region.includes('서울')) q = q.in('lawd_cd', codeList.filter(c => c.startsWith('11')));
    else if (region.includes('경기')) q = q.in('lawd_cd', codeList.filter(c => c.startsWith('41')));
    else if (region.includes('인천')) q = q.in('lawd_cd', codeList.filter(c => c.startsWith('28')));
  }

  // Phase 9: 광역 검색 시 후보 풀 2500 (선호도 가산점 위해 더 넓게 후보 풀)
  const { data: txs, error } = await q.limit(2500);
  if (error) throw error;

  // ALIAS-MERGE-2026-05-21 (전수조사: BUG2 동일 클래스): raw MOLIT명(풍림아파트A/B) →
  //   canonical master명(공릉풍림아이원) relabel → 보고서 후보도 1개 단지로 병합 (검색/지도/단지정리와 동일 식별).
  const txList = txs || [];
  let _aliasMap = new Map();
  try {
    const { getAliasCanonicalMap } = require('../services/transactionService');
    _aliasMap = await getAliasCanonicalMap([...new Set(txList.map(t => t.sigungu).filter(Boolean))]);
  } catch (_) {}

  // 단지 그룹화 + build_year mode + 신고가 갱신 카운트
  const byApt = {};
  for (const t of txList) {
    const _canon = _aliasMap.get(`${t.apt_name}|${t.umd_nm}`) || t.apt_name;
    const key = `${_canon}|${t.sigungu}|${t.umd_nm}`;
    if (!byApt[key]) byApt[key] = {
      apt_name: _canon, sigungu: t.sigungu, umd_nm: t.umd_nm,
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
  // MOB-AUDIT-2026-05-03: priority 매칭 점수 ≥ 임계 단지가 7개 미만일 risk → 후보 풀 14 → 20 확장
  //   cache 적중률 90%+ 라 실제 비용 영향 미미. 외곽 사용자 priority 부분 매칭 후보 발견율 ↑
  // P2-2 (2026-05-04): 후보 풀 < 7 시 인접 구 자동 확장 안내 (외곽 지역 사용자 다양성 부족)
  if (pool.length < 7) {
    // STAB-AUDIT-2026-05-07 (m-1 fix): ctx 에 region 키 없음 → 함수 scope 'region' 변수 직접 사용
    logger.warn({ region, pool_size: pool.length },
      '후보 풀 부족 — 인접 구 확장 권장 (사용자에 안내)');
  }
  const out = pool.slice(0, Math.min(limit * 3, 20));

  // Phase 6+ (2026-04-26): KAPT API 통합 — 선정된 N개 단지만 facility 병렬 fetch
  //   resolveFacility() 가 ILIKE 토큰 매칭 + KAPT API + DB 캐시 (90일) 다 처리.
  //   첫 호출: API 호출 → DB 저장 (응답 +5~10초). 두 번째: cache hit (0초).
  await Promise.all(out.map(async (c) => {
    try {
      const f = await resolveFacility({ aptName: c.apt_name, sigungu: c.sigungu, umdNm: c.umd_nm });
      if (f?.raw) {
        const raw = f.raw;
        const detail = f.detail || {};
        c.households = raw.kaptdaCnt || raw.householdCount || raw.kaptCount || null;
        // build_year 우선순위 #1: KAPT 공식 사용승인일
        const useDate = raw.kaptUsedate || raw.kaptUseDate || raw.useApprovalDate;
        if (useDate) {
          const ys = String(useDate).slice(0, 4);
          if (/^\d{4}$/.test(ys)) c.build_year = Number(ys);
        }
        c.master_matched = true;
        c.master_name = f.official; // 정식 단지명 (예: '답십리동서울한양')
        // PARK-FIX-2026-05-13 (Sprint AA): KAPT V4 주차는 detail (kaptdPcnt 지상 + kaptdPcntu 지하)
        const surfP = parseInt(detail.kaptdPcnt) || 0;
        const underP = parseInt(detail.kaptdPcntu) || 0;
        const parking = (surfP + underP) || parseInt(raw.kaptdPcnt) || null;
        c.kaptInfo = {
          builder: raw.kaptBcompany || raw.bcompany || null,
          parking,
          elevators: parseInt(detail.kaptdEcnt) || parseInt(raw.kaptdEcntp) || null,
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
    // RISK-6 fix (2026-05-02): displayName 단순화 — c.master_name (KAPT facility 매칭 결과) 무시
    //   문제: master_name 매칭이 잘못되면 다른 단지의 정식명이 displayName 으로 노출 → 사용자에게
    //         "마포한강아이파크 (실제는 휴먼빌) 평균 7.95억" 같은 거짓 정보.
    //   해결: c.apt_name 만 표시 — 거래 데이터의 실제 단지명. KAPT score 임계 3 상향과 동시 적용.
    const displayName = c.apt_name;
    const breakdownStr = Object.entries(c.scoreBreakdown || {})
      .map(([k, v]) => `${k}=${v}`).join(', ');
    const facts = c.objectiveFacts || {};
    const am = facts.amenities;
    const amStr = am ? `반경 1.2~2km: 학교 ${am.school}·마트 ${am.mart}·종합병원 ${am.hospital}·지하철역 ${am.subway}·공원 ${am.park||0}` : null;
    const factsList = [
      facts.district ? `행정구위계: ${facts.district}` : null,
      facts.builder ? `시공사: ${facts.builder}` : null,
      facts.parking_per_household ? `주차: 세대당 ${facts.parking_per_household}대${facts.parking_total ? ` (총 ${facts.parking_total}대)` : ''}` : null,
      facts.age_years != null ? `노후도: ${facts.age_years}년차` : null,
      facts.regulation ? `규제: ${facts.regulation}` : null,
      facts.new_high_count > 0 ? `최근 6개월 신고가 ${facts.new_high_count}회 갱신` : null,
      amStr,
    ].filter(Boolean).join(' | ');
    return `${i + 1}. ${displayName} (${c.sigungu} ${c.umd_nm})
   - 준공: ${c.build_year || '미상'}년 / 세대수: ${householdsStr}
   - 회원님 평형대 (${c.areas.map(a => `${a}㎡(${Math.round(a / 3.3)}평)`).join(', ')}) 만 노출됨
   - 회원님 평형대 평균가: ${(c.avgPrice / 10000).toFixed(2)}억원 (해당 평형 ${c.n}건 거래, 최근 ${c.latest})
   - 객관 fact: ${factsList || '데이터 부족'}
   - 매칭 점수: ${c.score}점 (${breakdownStr})`;
  }).join('\n\n');

  // REPORT_SYSTEM_PROMPT 는 callAI options.system 으로 전달됨 (중복 제거)
  return `## 회원님 가구 상황
- 매수가: ${input.maxBudget}억
- 자기자본: ${input.myCash || '?'}억
- 연소득: ${input.annualIncome ? input.annualIncome + '만원' : '미입력'} (참고용 — DSR 계산은 사이드바 대출계산 탭)
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
   - priceFit: "매수가 ${input.maxBudget}억 vs 회원님 평형대 평균 X억 (X% 초과/일치/여유)" — 단순 비교만. "단지 평균"이라고 쓰지 말고 "회원님 평형대 평균"이라고 정확히 표기 (단지 전체 평형의 평균이 아니라 회원님 입력 평형대 거래 평균이기 때문)
   - recommendation: "검토 권장" 또는 "예산 초과 — 다른 단지 비교 권장" — 매수 추천 X
   - matchReason: 매칭 점수 breakdown 을 자연스러운 한 줄로 풀어 씀 (예: "1순위 환금성 부합(거래활발 60점) + 예산 적합(30점)") — 사용자 투명성 핵심
   - location: 입력 데이터의 amenities (지하철·학교·마트·병원·공원 카운트) + 행정구위계만 인용. 도보 거리·구체적 역명·지형(평지/경사) 임의 추정 X (입력 데이터에 없음). "역세권"·"학교 17곳" 같이 카운트 기반 표현만 허용.
   ※ pros/cons/location 작성 시 위 '객관 fact' 의 시공사·세대수·주차·노후도·규제 정보를 적극 활용 (예: pros 에 "삼성 1군 브랜드, 세대당 1.3대 주차" 같이 구체적 fact 인용)
   ★ 응답 길이 절약: location/pros/cons/recommendation/matchReason 각각 60자 이내, ratio 30자 이내 (응답 토큰 부족시 잘림 방지)
4. longTermView — 자녀 시점 기반 갈아타기 시나리오 (가격 수치 X, 권역만)
5. tips — 실무 TIP 5~6개 (회전율·RR·복비·잔금·임장)

[환각 차단 절대 규칙]
- 입력 데이터에 없는 거리(km, 도보 분), 지형(평지·경사), 정확한 역명·노선 번호, 재개발 일정 임의 추정 X
- 입력 데이터의 amenities 카운트 (지하철 N개, 마트 N개 등) 만 인용 가능
- 시공사/세대수가 입력에 없으면 "미상" 표기 (임의 보강 X)
- 회원님 평형대 평균이 단지 전체 평균이 아님 — 모든 평균 표기에 "회원님 평형대" 명시

JSON만 반환. 다른 텍스트 X.`;
}

module.exports = router;
