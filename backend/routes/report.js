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
// HH-CONFLICT-2026-08-17 (Sprint MMMMMMM): 세대수 원천 불일치 판정은 buildFacility 의 것 하나만 쓴다.
//   (보고서는 buildFacility 자체는 호출하지 않지만, **판정 기준까지 따로 두면 두 화면이 갈린다.**)
const { householdsConflictOf } = require('../utils/buildFacility');
// SCORE-BANDS-2026-08-30 (Sprint PPPPPPP): 회전율·유형제외·신고가 구간은 **추천 화면과 같은 모듈**을 쓴다.
//   점수표가 두 벌이면 한쪽만 고쳐지고 갈린다 — 오늘 교통 실측이 보고서에 안 갔던 이유가 그것이다.
const { turnoverScore, isExcludedAptType, countNewHighByArea } = require('../utils/scoreBands');
const { txWindowStart } = require('../utils/txWindow');
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
  userInput.lawdCd = _str(userInput.lawdCd, 41); // MULTI-REGION-2026-08-30: 5자리×6 + 콤마 5
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
  // SCORE-VER-2026-09-02 (감사 P0-2): 캐시 키가 **입력 해시뿐**이라 산식을 바꿔도 옛 결과가 그대로 나온다.
  //   (같은 함정을 추천 경로는 `rec:vNN` 으로 이미 막고 있었다 — 보고서만 버전이 없었다.)
  //   점수·표시 규칙을 바꾸면 이 값을 올릴 것.
  const SCORE_VERSION = 'v2';
  const cacheKey = `report:${SCORE_VERSION}:${crypto.createHash('sha256').update(JSON.stringify(_sortedInput)).digest('hex').slice(0, 16)}`;
  let hit = cache.get(cacheKey);
  // REDIS-CACHE-2026-07-14 (Sprint KKKKK): 로컬 미스 시 Redis 2차 조회 — 다른 인스턴스가 만든 보고서
  //   재사용(동일 입력의 AI 재호출 차단). 미설정/오류 시 undefined → 기존 흐름 그대로.
  if (!hit) {
    hit = await require('../services/redisCache').rget(cacheKey);
    if (hit) cache.set(cacheKey, hit, 1800); // 로컬에도 복사(같은 인스턴스 후속 요청 fast path)
  }
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

    // FREE-CONTEXT-2026-07-14 (Sprint JJJJJ, 운영자 "돈 안 들이고 보고서 질 높이기"):
    //   기존엔 dataBasis(ECOS 금리·실거래 반영월)·unsoldTrend(KOSIS 미분양)를 AI 호출 "이후" 에 조회해
    //   응답에만 붙였음 → AI 는 이 무료 실측 수치를 못 보고 글을 씀. 조회를 프롬프트 생성 전으로 옮겨
    //   프롬프트에 주입(추가 API 비용 0 — 같은 호출, 순서만 변경. 인풋 토큰만 수십 토큰 증가).
    const [_dataBasis, _unsold, _regionTrend] = await Promise.all([
      getDataBasis().catch(() => null),
      (async () => {
        const _sgg = candidates[0] && candidates[0].sigungu;
        if (!_sgg) return null;
        try { return await require('../services/kosisService').getUnsoldTrend(userInput.region, _sgg); }
        catch (_) { return null; }
      })(),
      // REGION-TREND-2026-07-14 (Sprint KKKKK): 대상 지역(구) 월별 거래량 추이 — 자체 DB 월별 집계.
      //   getRegionRecentTransactions 는 분석탭과 동일 함수·6h 캐시 공유라 추가 부하 미미. 실패 시 null(graceful).
      (async () => {
        try {
          const lawd = candidates[0] && candidates[0].lawd_cd;
          if (!lawd) return null;
          const { getRegionRecentTransactions, LAWD_CODE_TO_NAME } = require('../services/transactionService');
          const txs = await getRegionRecentTransactions(lawd, 6);
          if (!txs || !txs.length) return null;
          const byYm = {};
          for (const t of txs) {
            const ym = `${t.dealYear}${String(t.dealMonth).padStart(2, '0')}`;
            byYm[ym] = (byYm[ym] || 0) + 1;
          }
          const months = Object.keys(byYm).sort().map(ym => ({ ym, n: byYm[ym] }));
          // AGE-BANDS-2026-07-15 (Sprint KKKKK-2): 준공연차 구간별 평당가(전용면적 환산 기준) 중위 —
          //   같은 txs 재사용(추가 쿼리 0). 표본 8건 미만 구간 비노출(기존 단지 비교기능 n≥8 관례),
          //   유효 구간 2개 미만이면 전체 비노출(비교 의미 없음). ⚠ '전용 기준' 명시 필수 —
          //   시장 관례 평당가는 공급면적 기준이라 수치가 달라 보임(우리 비교기능과 동일 기준으로 일관).
          const _curYear = new Date().getFullYear();
          const _bandDefs = [[0, 9, '10년 미만'], [10, 19, '10~19년'], [20, 29, '20~29년'], [30, 999, '30년 이상']];
          const _byBand = _bandDefs.map(() => []);
          for (const t of txs) {
            if (!t.buildYear || t.buildYear < 1900 || !(t.excluUseAr > 10) || !(t.dealAmount > 0)) continue;
            const age = _curYear - t.buildYear;
            const bi = _bandDefs.findIndex(([lo, hi]) => age >= lo && age <= hi);
            if (bi >= 0) _byBand[bi].push(t.dealAmount / (t.excluUseAr / 3.3058));
          }
          const ageBands = _bandDefs.map(([, , label], i) => {
            const arr = _byBand[i];
            if (arr.length < 8) return null;
            arr.sort((a, b) => a - b);
            return { band: label, n: arr.length, medianPyeong: Math.round(arr[Math.floor(arr.length / 2)]) };
          }).filter(Boolean);
          return {
            sigungu: LAWD_CODE_TO_NAME[lawd] || candidates[0].sigungu,
            months,
            ...(ageBands.length >= 2 ? { ageBands } : {}),
            note: '최근 월은 신고 지연(계약 후 30일 내 신고)으로 집계 중일 수 있어요',
          };
        } catch (_) { return null; }
      })(),
    ]);
    const _freeCtx = { dataBasis: _dataBasis, unsoldTrend: _unsold, regionTxTrend: _regionTrend };

    // 3) AI prompt 작성
    const prompt = buildReportPrompt(userInput, policyData, candidates, _freeCtx);

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
      parsed = buildDataOnlyReport(userInput, candidates, policyData, _freeCtx);
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
          // NAME-ADDR-2026-08-30 (Sprint OOOOOOO): 이 주입이 **데이터판이 만든 이름까지 덮어쓴다**
          //   (주석대로 name 도 여기서 채운다). 그래서 buildDataOnlyReport 에서 정식명을 넣어도
          //   여기서 다시 MOLIT 신고명으로 되돌아갔다 — 라이브 재생성에서 "롯데캐슬"로 확인.
          //   같은 규칙(정식명 주 + 신고명 병기)을 여기에도 적용한다.
          const _nrmN = (v) => String(v || '').normalize('NFC').replace(/\s/g, '').replace(/아파트$/, '');
          const _base = c.master_name || c.apt_name;
          const _alias = (c.master_name && _nrmN(c.master_name) !== _nrmN(c.apt_name))
            ? ` (실거래 신고명 ${c.apt_name})` : '';
          a.name = _loc ? `${_base}${_alias} (${_loc})` : `${_base}${_alias}`;
          // RPT-CARD-LINK-2026-07-22 (Sprint MMMMMM-4): AI판 카드도 상세 모달 연결 식별 필드 주입 —
          //   objectiveFacts·name 강제와 동일한 candidates[i] 인덱스 매칭(기존 패턴·동일 신뢰 수준).
          a.aptName = c.apt_name;
          a.sigungu = c.sigungu;
          a.umdNm = c.umd_nm;
          a.lawdCd = c.lawd_cd;
        }
        // PRICE-INTEGRITY-2026-06-14: priceFit(예산매칭) 을 backend 결정론 계산으로 주입 — AI 전사 환각 차단.
        //   name·objectiveFacts 와 같은 candidate[i] 출처라 일관.
        // PRICE-BASIS-2026-08-30 (Sprint OOOOOOO): 기준을 `avgPrice`(예산 밴드로 잘린 부분집합 평균)에서
        //   **대표 평형의 밴드 미적용 평균**(avgPriceFull)으로 바꾼다. 옛 기준은 예산을 바꾸면 같은 단지의
        //   "시세"가 따라 움직였다(동탄 실측: 표기 9.69억 vs 실제 10.09억).
        //   ⚠ 라벨도 '회원님 평형대' → **실제 면적**으로 명시한다 — 어떤 평형의 평균인지 모호하면
        //     사용자가 다른 평형 가격으로 오해한다(라벨과 모집단이 갈리던 그 결함의 재발 방지).
        const _basis = (c && c.avgPriceFull > 0) ? c.avgPriceFull : (c && c.avgPrice);
        const _areaLabel = (c && c.primaryArea && c.primaryArea.sqm)
          ? `전용 ${c.primaryArea.sqm}㎡` : '회원님 평형대';
        const _pf = _buildPriceFit(_basis, userInput.maxBudget, _areaLabel,
          (c && c.priceSampleFull) || null);
        if (_pf) a.priceFit = _pf;
      });
    }

    const out = {
      report: parsed,
      policyContext: policyData,
      // Sprint CCCCC(검증 기준 박스)·HHHHH(KOSIS 미분양) — Sprint JJJJJ 에서 AI 호출 전으로 이동(위 _freeCtx).
      dataBasis: _dataBasis,
      unsoldTrend: _unsold,
      regionTxTrend: _regionTrend, // Sprint KKKKK — 지역 월별 거래량(자체 DB 집계, 수치 나열)
      generatedAt: new Date().toISOString(),
      disclaimer: '본 보고서는 국토교통부·한국부동산원 공공 데이터 기반 정보 정리이며, 투자자문업·중개업·대출모집인업이 아닙니다. 매수·매도 추천 X, 미래 가격 예측 X. 모든 의사결정과 책임은 본인에게 있습니다.',
      ...(_aiDown ? { aiUnavailable: true, aiUnavailableReason: _aiDown } : {}),
    };
    // CACHE-TTL-2026-07-14 (Sprint JJJJJ): 정상판 30분 → 6h. 기반 데이터가 전부 일/시간 단위 갱신
    //   (실거래 daily ingest · dataBasis 6h 캐시 · 정책 스냅샷 · KOSIS 월간)이라 최신성 손실 없이
    //   동일 입력 재요청의 AI 호출을 스킵 → 비용 절감. degrade(5분)는 AI 복구 시 빠른 교체 위해 유지.
    cache.set(cacheKey, out, _aiDown ? 300 : 21600);
    // Sprint KKKKK: Redis 에도 저장(인스턴스 간 공유) — 정상판만(degrade 는 AI 복구 시 빨리 갱신돼야 함)
    if (!_aiDown) require('../services/redisCache').rset(cacheKey, out, 21600);
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
    require('../utils/captureError').captureRouteError(e, 'report/generate'); // SENTRY-GAP (Sprint XXXXX) — GlobalAiBudget 503 은 예상 이벤트라 위에서 제외
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
/** FREE-CONTEXT-2026-07-14 (Sprint JJJJJ): 이미 무료로 확보한 실측 수치를 문장으로 정리.
 *  전부 DB/공공 API 실측값(정책 스냅샷 LTV·DSR, ECOS 금리, KOSIS 미분양, 실거래 최신월) —
 *  하드코딩·추정 없음. 스냅샷이 갱신되면 문구도 자동 갱신. 절대룰: 수치 나열만, 예측·추천 표현 금지. */
function _freeContextLines(policy, freeCtx) {
  const db = (freeCtx && freeCtx.dataBasis) || null;
  const us = (freeCtx && freeCtx.unsoldTrend) || null;
  const out = {};
  if (Array.isArray(policy?.ltv) && policy.ltv.length) {
    out.ltv = policy.ltv
      .filter(r => r && r.condition && r.ltv != null)
      .map(r => `${r.condition} LTV ${r.ltv}%`)
      .join(' · ');
  }
  const d = policy?.dsr;
  if (d && d.bankDSR != null) {
    out.dsr = `은행권 DSR ${d.bankDSR}%`
      + (d.secondFinanceDSR != null ? ` · 2금융권 ${d.secondFinanceDSR}%` : '')
      + (d.stressDSRMetro != null ? ` · 스트레스 가산금리 수도권 ${d.stressDSRMetro}%p` : '')
      + (d.stressFloorMetroRegulated != null ? `(수도권 규제지역 하한 ${d.stressFloorMetroRegulated}%)` : '');
  }
  if (db?.rateBasis) out.rate = db.rateBasis;
  if (db?.txLatestLabel) out.tx = db.txLatestLabel;
  if (us && Array.isArray(us.months) && us.months.length) {
    const seq = us.months
      .map(m => `${String(m.ym).slice(4, 6).replace(/^0/, '')}월 ${Number(m.cnt).toLocaleString()}호`)
      .join(' → ');
    out.unsold = `${us.sigungu} 미분양 ${seq} — ${us.source}`;
  }
  // Sprint KKKKK: 지역 월별 거래량 추이 (자체 DB 집계 — 최근 월은 신고 지연분 존재)
  const rt = (freeCtx && freeCtx.regionTxTrend) || null;
  if (rt && Array.isArray(rt.months) && rt.months.length) {
    const seq = rt.months
      .map(m => `${String(m.ym).slice(4, 6).replace(/^0/, '')}월 ${Number(m.n).toLocaleString()}건`)
      .join(' → ');
    out.txTrend = `${rt.sigungu} 매매 거래량 ${seq} (국토교통부 실거래 신고 기준 · 최근 월은 신고 지연으로 집계 중)`;
  }
  // Sprint KKKKK-2: 준공연차 구간별 평당가 (전용면적 환산 기준 — 시장 관례 공급면적 평당가와 다름 명시)
  if (rt && Array.isArray(rt.ageBands) && rt.ageBands.length >= 2) {
    out.agePrice = `${rt.sigungu} 준공연차별 평당가(전용면적 환산·최근 6개월 중위): `
      + rt.ageBands.map(b => `${b.band} ${b.medianPyeong.toLocaleString()}만원(${b.n}건)`).join(' · ');
  }
  return out;
}

// POOL-COVERAGE-2026-08-17 (Sprint MMMMMMM-13): 후보의 거래 수치가 **어느 기간 표본**에서 나왔는지.
//   풀이 잘리지 않았으면 '최근 6개월', 잘렸으면 실제로 덮은 일수를 돌려준다.
//   두 소비처(보고서 카드 · AI 프롬프트)가 같은 함수를 쓰게 해 사본이 갈리는 사고를 막는다 —
//   이 저장소는 같은 지표의 사본이 조용히 갈리는 사고를 여러 번 겪었다(취득세 tier·규제 판정).
//   ⚠ 서버 런타임 TZ 는 UTC 다 — 날짜 차이는 UTC 로 계산한다.
function poolSpanLabel(c) {
  if (!c || !c._poolTruncated || !c._poolFrom) return '최근 6개월';
  const days = Math.max(1, Math.round((Date.now() - Date.parse(`${c._poolFrom}T00:00:00Z`)) / 86400000));
  return Number.isFinite(days) ? `최근 ${days}일` : '최근 6개월';
}

function buildDataOnlyReport(userInput, candidates, policy, freeCtx) {
  const curYear = new Date().getFullYear();
  const fc = _freeContextLines(policy || {}, freeCtx || {});
  const apartments = (candidates || []).map((c, i) => {
    const f = c.objectiveFacts || {};
    // AREA-BASIS-2026-08-30 (Sprint OOOOOOO, 운영자 "아파트에 없는 평형대도 있다"):
    //   [무엇이 문제였나] ① 표시 면적이 `areas[0]` = 후보 면적 중 **최솟값**이었다(대표 평형이 아니다).
    //     ② 그 숫자를 그냥 "N평" 으로 적었는데 그건 **전용면적** 평수다. 네이버·호갱노노·아실은
     //     **공급면적** 기준 평형("34평형")을 쓴다 — 전용 84.9㎡ 를 우리는 "26평", 시장은 "34평" 이라 부른다.
    //     그래서 사용자 눈에는 "그 단지에 없는 평형" 으로 보인다.
    //   [왜 공급면적을 만들지 않는가] 국토부 실거래는 **전용면적만** 준다. KAPT 의 kaptMarea(관리비부과면적)로
    //     환산해 볼 수 있으나 실측상 단지별 비율이 0.51~0.77 로 흔들린다(동탄레이크자이더테라스 0.5055 vs
    //     동탄역자이 0.7722) — 산정 기준이 단지마다 다르다. 출처 없는 숫자를 만들지 않는다(절대 룰).
    //   → 대표 평형은 **거래가 가장 많은 면적**(primaryArea)으로 바꾸고, 라벨에 '전용'을 명시하며,
    //     그 단지에서 실제 거래된 면적을 함께 나열한다.
    const areaMain = (c.primaryArea && c.primaryArea.sqm)
      ? Number(c.primaryArea.sqm)
      : (Array.isArray(c.areas) && c.areas.length ? Number(c.areas[0]) : null);
    const age = (c.build_year && c.build_year > 1900) ? curYear - c.build_year : null;
    // POOL-COVERAGE-2026-08-17 (Sprint MMMMMMM-13): c.n 은 **후보 풀 안에서의** 거래 수다.
    //   풀이 잘렸으면 그 수는 6개월치가 아니다 — 실제로 덮은 기간으로 적는다.
    //   ⚠ 서버 런타임 TZ 는 UTC 이므로 날짜 차이는 UTC 기준으로 계산한다([[server-runtime-timezone-utc]]).
    const _span = poolSpanLabel(c);
    // PRICE-BASIS-2026-08-30: 거래 건수도 **예산 밴드로 잘리지 않은** 수를 쓴다.
    //   c.n 은 후보 풀(밴드 적용) 안의 건수라 실제보다 적다(동탄 실측: 표기 52건 vs 실제 66건).
    //   areaTotalN = 같은 평형 구간·같은 6개월의 전체 건수(밴드 미적용).
    const _n = Number(c.areaTotalN) > 0 ? Number(c.areaTotalN) : (c.n || 0);
    const pros = [
      (c.households && c.households >= 1000) ? `대단지 ${Number(c.households).toLocaleString()}세대` : null,
      // HH-CONFLICT-2026-08-17 (Sprint MMMMMMM): '장점' 은 판단이다 — 분모를 못 믿으면 쓰지 않는다.
      (f.parking_per_household && f.parking_per_household >= 1 && !f.parking_uncertain)
        ? `주차 세대당 ${f.parking_per_household}대` : null,
      // 잘린 풀에서도 n 은 **하한**이라 '거래 활발'은 여전히 참이다(실제는 더 많다) → 유지.
      (_n >= 20) ? `${_span} 거래 ${_n}건 (거래 활발)` : null,
      f.builder ? `시공 ${f.builder}` : null,
      f.jeonse_ratio ? `전세가율 ${f.jeonse_ratio} (회원님 평형대 전세 ${f.jeonse_sample}건)` : null, // Sprint KKKKK
    ].filter(Boolean).join(' · ');
    const cons = [
      (age != null && age >= 25) ? `준공 ${age}년차 — 수리·관리 상태 임장 확인 필요` : null,
      // ⚠ 반대로 '표본 적음'은 잘린 풀에서 **거짓 경고**가 된다 — 실제로 30건인 단지가 풀에선 3건일 수
      //   있고, 그때 "시세 판단 주의"를 붙이면 없는 위험을 만든다. 잘렸으면 이 판정을 하지 않는다.
      //   (모르는 것은 말하지 않는다 — 억지로 반대쪽 단정을 넣지도 않는다.)
      (!c._poolTruncated && _n <= 5) ? `최근 6개월 거래 ${_n}건 — 표본 적음(시세 판단 주의)` : null,
    ].filter(Boolean).join(' · ');
    return {
      rank: i + 1,
      // NAME-ADDR-2026-08-30 (Sprint OOOOOOO, 운영자 "이름도 없는 이름이고, 정확한 주소지도 써달라"):
      //   [실측] 7번 단지가 그냥 "롯데캐슬" 로 나왔다 — MOLIT 신고명이 문자 그대로 그렇다.
      //   그런데 동탄에만 롯데캐슬이 5개다(메타역·동탄역·석우동·알바트로스·동탄2) → 식별 불가.
      //   KAPT 정식명은 이미 `c.master_name` 으로 들고 있었는데 **표시에 쓰지 않고 있었다.**
      //   정식명이 있으면 그걸 주(主)로 쓰고, 신고명이 다르면 함께 적는다 —
      //   실거래 탭은 신고명으로 조회되므로 둘 다 보여야 사용자가 이어서 찾을 수 있다.
      name: (() => {
        const norm = (v) => String(v || '').normalize('NFC').replace(/\s/g, '').replace(/아파트$/, '');
        const raw = c.apt_name;
        const official = c.master_name;
        const base = official || raw;
        const differs = official && norm(official) !== norm(raw);
        const alias = differs ? ' (실거래 신고명 ' + raw + ')' : '';
        return base + alias + ' (' + c.sigungu + ' ' + c.umd_nm + ')';
      })(),
      // RPT-CARD-LINK-2026-07-22 (Sprint MMMMMM-4): 카드 → 단지 상세 모달 연결용 식별 필드.
      //   프론트 openAptDetail 필수 인자(aptName·sigungu·umdNm·lawdCd)와 동일 소스(c) — 표시용 name 과 별개.
      aptName: c.apt_name,
      sigungu: c.sigungu,
      umdNm: c.umd_nm,
      lawdCd: c.lawd_cd,
      // NAME-ADDR-2026-08-30: 찾아갈 수 있게 KAPT 공식 주소를 함께 싣는다(도로명 + 지번).
      //   없으면 필드 자체를 생략한다 — 추정 주소를 만들어 넣지 않는다.
      roadAddress: c.road_address || undefined,
      jibunAddress: c.jibun_address || undefined,
      areaSqm: areaMain || undefined,
      // AREA-BASIS-2026-08-30: 이 단지에서 **실제 거래된** 면적들(전용, 최근 6개월·예산밴드 미적용).
      //   "없는 평형" 오해를 없애고, 대표 평형이 어떤 근거로 뽑혔는지 사용자가 검증할 수 있게 한다.
      areaBreakdown: Array.isArray(c.areaStats)
        ? c.areaStats.slice(0, 6).map(a => ({
          sqm: a.sqm,
          pyeong: Math.round(a.sqm / 3.3058),
          n: a.n,
          avgAuk: Math.round((a.avg / 10000) * 100) / 100,
        }))
        : undefined,
      areaBasis: '전용면적 (국토교통부 실거래 신고 기준)',
      // PEAK-FLOOR-2026-08-31 (운영자 참고 보고서 구조 반영):
      //   · peak6m — 대표 평형의 **최근 6개월 최고가**. 참고 보고서의 "전고점" 에 대응하지만,
      //     우리 DB 는 2025-05 부터라 "역대 전고점" 이라고 부를 수 없다. 기간을 문구에 명시한다.
      //   · floorBands — 같은 평형 안에서 저/중/고층 중위가. "RR(로열동로열층)" 판단 근거다.
      //     ⚠ 표본이 얇으면(층 정보 6건 미만·구간별 2건 미만) 만들지 않는다 — null 이면 표시도 안 한다.
      peak6mAuk: Number.isFinite(c.peak6m) ? Math.round((c.peak6m / 10000) * 100) / 100 : undefined,
      floorBands: c.floorBands ? {
        low: c.floorBands.low ? { upTo: c.floorBands.low.upTo, n: c.floorBands.low.n, auk: Math.round((c.floorBands.low.median / 10000) * 100) / 100 } : null,
        mid: c.floorBands.mid ? { n: c.floorBands.mid.n, auk: Math.round((c.floorBands.mid.median / 10000) * 100) / 100 } : null,
        high: c.floorBands.high ? { from: c.floorBands.high.from, n: c.floorBands.high.n, auk: Math.round((c.floorBands.high.median / 10000) * 100) / 100 } : null,
      } : undefined,
      areaPyeong: areaMain ? Math.round(areaMain / 3.3058) : undefined,
      buildYear: c.build_year || 0,
      households: c.households || '미상',
      ratio: c._poolTruncated
        ? `${_span} 실거래 ${_n}건 (후보 표본 기준)`
        : `최근 6개월 실거래 ${_n}건`,
      // 프론트가 같은 판정을 **자기 문자열로 다시 만들지 않도록** 기간 라벨을 함께 내려보낸다.
      //   (index.html 의 카드가 '6개월' 을 하드코딩하고 있어 여기 값이 바뀌면 조용히 갈렸다.)
      sampleSpan: _span,
      // IIII: 위계 라벨("서울 외곽구" 등)이 단독 노출되면 어색(라이브 확인) — 실제 행정구역을 주정보로, 라벨은 괄호
      location: [`${c.sigungu} ${c.umd_nm}${f.district ? ` (${f.district})` : ''}`, f.regulation].filter(Boolean).join(' · '),
      pros: pros || '객관 정보는 아래 표 참조',
      cons: cons || '단점은 임장으로 직접 확인 권장',
      priceFit: '', // 아래 _buildPriceFit 주입이 덮어씀
      recommendation: '정보 참고',
    };
  });
  // FREE-CONTEXT-2026-07-14 (Sprint JJJJJ): 데이터판(=AI 미사용 경로)도 이미 확보한 실측 수치를 반영.
  //   운영자 방침(AI 비용 지출 최소화)상 이 경로가 상시 노출될 수 있어, 고정 문구 대신 실데이터를 넣어
  //   AI 없이도 정보 밀도를 높인다. 전부 실측값 — 없으면 해당 줄만 생략(graceful).
  const coreMessages = [
    `매수가 ${userInput.maxBudget}억 · 자기자본 ${userInput.myCash}억 · ${userInput.region} 조건의 최근 6개월 실거래 데이터를 정리했어요.`
      + (fc.tx ? ` (${fc.tx})` : ''),
    // '추천' 단어는 자체 단언표현 필터(filterAdviceOutputDeep)에 걸림 (라이브 확인) — 필터 안전 문구 사용
    `아래 ${apartments.length}개 단지는 국토교통부 실거래 기준 조건 부합 단지 정리예요 — 의사결정 책임은 본인에게 있어요.`,
    fc.rate
      ? `현재 금리 기준: ${fc.rate} — 대출 한도·월 상환액은 상단 대출계산 탭에서 이 금리로 계산돼요.`
      : 'AI 분석 코멘트는 현재 일시 중단 — 실거래·세대수·주차·규제 등 객관 데이터만 표시해요.',
  ];
  if (fc.unsold) coreMessages.push(`${fc.unsold} — 수치 나열이며 시장 예측이 아니에요.`);
  if (fc.txTrend) coreMessages.push(`${fc.txTrend} — 수치 나열이며 시장 예측이 아니에요.`);

  const checklist = [
    { text: '등기부등본 최신본 확인 (계약 직전 재확인)', stars: 3 },
    {
      text: fc.dsr ? `대출 사전심사 — ${fc.dsr}` : '대출 사전심사 — 스트레스 DSR 반영 한도 확인 (상단 대출계산 탭)',
      stars: 3,
    },
    // KKKKK-3: fc.ltv 없으면 항목 생략 — fallback 문구가 아래 '규제지역 확인'과 중복되던 것(라이브 발각) 제거.
    // KKKKK-4: 표시용은 사용자 상황 행만(라이브: 7개 조건 전부 나열돼 항목 과대) — 프롬프트는 전체 표 유지.
    ...((() => {
      if (!Array.isArray(policy?.ltv)) return [];
      const _st = userInput.isFirstBuyer ? '생애최초' : String(userInput.houseStatus || '무주택');
      const _kw = /생애최초/.test(_st) ? '생애최초' : (/2주택|다주택/.test(_st) ? '2주택' : (/1주택/.test(_st) ? '1주택' : '무주택'));
      const rows = policy.ltv.filter(r => r && r.condition && r.ltv != null && r.condition.includes(_kw));
      if (!rows.length) return [];
      return [{
        text: `LTV 한도 확인 — ${rows.map(r => `${r.condition} ${r.ltv}%`).join(' · ')}`,
        stars: 3,
      }];
    })()),
    { text: '규제지역 여부·전입 의무 확인 (10.15 규제 요약 참고)', stars: 2 },
    { text: '관리비·주차 실태 임장 확인 (임장노트 탭 활용)', stars: 2 },
    { text: '특약 초안 준비 (특약 탭 — 표준 템플릿 제공)', stars: 1 },
  ];

  const tips = [
    '실거래는 신고 후 해제되는 경우가 있어요 — 단지 상세의 거래 해제 안내를 참고하세요.',
    '같은 단지도 평형·층에 따라 가격 차가 커요 — 실거래가 탭의 평형 필터로 확인하세요.',
    '정책자금(디딤돌·신생아 특례) 해당 여부는 사이드바 정책자금 자격에서 확인하세요.',
  ];
  if (fc.tx) tips.push(`본 정리의 실거래 기준: ${fc.tx} (국토교통부 신고 자료 · 신고 지연분은 이후 반영돼요).`);
  if (fc.agePrice) tips.push(`${fc.agePrice} — 과거 실거래 분포이며 특정 연차 단지 권유가 아니에요.`);

  // REPORT-DEPTH-2026-08-31 (Sprint PPPPPPP, 운영자: "예전에 받았던 컨설팅 보고서처럼
  //   요약 총평·매매 시 주의할 점·뭘 봐야 하는지·어떤 집을 피해야 하는지가 들어가면 좋겠다"):
  //
  // ⚠ 절대 룰과의 경계를 분명히 한다.
  //   · 넣는 것 — **매수 실무에서 확인해야 할 항목**과 **우리 데이터로 잰 사실**.
  //   · 넣지 않는 것 — "상승여력 2~5억" 같은 **가격 예측**, "이 단지를 사라" 같은 **매수 권유**,
  //     특정 지역을 "저평가" 로 규정하는 판단.
  //   참고 자료(운영자 제공 컨설팅 보고서)에는 그런 예측이 있었지만 **그 부분은 옮기지 않는다**.
  const cautions = [
    {
      title: '계약 전에 반드시 끝내야 할 것',
      items: [
        '가계약 전에 대출 한도·가능 여부를 은행에서 확정하세요. 확정 전이라면 "대출 미승인 시 계약금 반환" 특약을 계약서에 넣는 것이 안전해요.',
        '등기부등본은 계약 직전에 다시 떼세요 — 근저당·가압류는 하루 사이에도 바뀝니다.',
        '전입 의무·실거주 의무가 붙는 지역인지 확인하세요(규제지역·토지거래허가구역).',
      ],
    },
    {
      title: '같은 단지라도 매물마다 값이 다릅니다',
      items: [
        '같은 평형이어도 동·층·향에 따라 실거래가가 갈립니다. 계약 전 **비슷한 동·층의 최근 실거래**를 찾아 비교하세요(단지 상세 → 실거래가 탭의 평형·층 필터).',
        '저층·최상층·1층·도로변 동은 같은 평형 대비 낮은 가격에 거래되는 경우가 많습니다 — 그 차이를 알고 값을 조율하세요.',
        '매도자가 왜 파는지 물어보세요. 사정을 알면 가격 조율의 근거가 생깁니다.',
      ],
    },
    {
      title: '숫자로 확인할 것 — 이 보고서가 재 준 것들',
      items: [
        '**회전율(세대수 대비 거래건수)** — 팔고 나갈 수 있는가를 보는 지표예요. 거래 건수만 보면 대단지가 무조건 유리해 보입니다.',
        '**표본 수** — 평균가 옆의 거래 건수를 보세요. 1~2건 평균은 시세라기보다 개별 사례에 가깝습니다.',
        '**지하철역까지 실제 거리** — 관리사무소 신고 도보시간은 실측과 자주 어긋납니다. 이 보고서는 잰 직선거리를 씁니다.',
      ],
    },
    {
      title: '피하기보다 확인할 것',
      items: [
        '거래가 거의 없는 단지는 시세를 확인하기 어렵고, 되팔 때도 시간이 걸립니다.',
        '세대수가 아주 적은 단지는 관리비 부담이 상대적으로 큰 경우가 있어요 — 관리비 고지서를 직접 확인하세요.',
        '주차 대수가 세대당 1대 미만이면 실제 주차 상황을 저녁 시간대에 직접 보고 판단하세요.',
        '⚠ 위 항목은 일반적인 확인 사항이며 특정 단지에 대한 매수·매도 권유가 아니에요.',
      ],
    },
  ];

  return {
    coreMessages,
    checklist,
    cautions,
    apartments,
    longTermView: 'AI 시나리오 분석이 일시 중단 상태예요. 단지별 실거래 추이·신고가 이력은 각 단지 상세의 실거래가·가격 시그널 탭에서 확인할 수 있어요.',
    tips,
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
function _buildPriceFit(avgPriceManwon, maxBudgetEok, areaLabel, sampleN) {
  const avg = Number(avgPriceManwon), bud = Number(maxBudgetEok);
  if (!Number.isFinite(avg) || avg <= 0 || !Number.isFinite(bud) || bud <= 0) return null;
  const avgEok = avg / 10000;
  const diffPct = Math.round((avgEok - bud) / bud * 100);
  const label = Math.abs(diffPct) <= 2 ? '예산 일치'
              : diffPct > 0 ? `${diffPct}% 초과`
              : `${Math.abs(diffPct)}% 여유`;
  // PRICE-BASIS-2026-08-30: 어떤 면적의, 몇 건 평균인지 함께 적는다. 표본 수가 없으면 그 부분만 생략.
  const who = areaLabel || '회원님 평형대';
  const n = Number(sampleN) > 0 ? ` · 최근 6개월 ${Number(sampleN)}건` : '';
  return `매수가 ${bud}억 vs ${who} 평균 ${avgEok.toFixed(2)}억${n} (${label})`;
}

// DATA-BASIS-2026-07-13 (Sprint CCCCC, 집사닷컴 벤치마킹 "검증 기준 박스"):
//   보고서에 데이터 기준(실거래 최신 반영월·규제 버전·출처)을 명시해 신뢰 시그널로 노출.
//   실거래 최신월은 DB 실측(molit_transactions max(deal_date)) — 추측·하드코딩 아님. 6h 캐시.
async function getDataBasis() {
  const CK = 'report:dataBasis';
  const hit = cache.get(CK);
  if (hit) return hit;
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data } = await admin
      .from('molit_transactions')
      .select('deal_date')
      .order('deal_date', { ascending: false })
      .limit(1);
    const latest = data && data[0] && data[0].deal_date ? String(data[0].deal_date) : null;
    // ECOS-2026-07-13 (Sprint FFFFF): 시중 금리 기준 표기 — ECOS 실측값(키 없으면 생략, graceful)
    let rateBasis = null, ecosSource = false;
    try {
      const ecos = await require('../services/ecosService').getEcosRates();
      if (ecos && ecos.mortgageRate != null) {
        const m = String(ecos.mortgageRateMonth || '').replace(/^(\d{4})(\d{2})$/, '$1.$2');
        rateBasis = `시중 주담대 평균 ${ecos.mortgageRate}%${ecos.baseRate != null ? ` · 기준금리 ${ecos.baseRate}%` : ''} (한국은행 ECOS ${m})`;
        ecosSource = true;
      }
    } catch (_) {}
    const out = {
      txLatest: latest,                                   // 예: '2026-07-07'
      txLatestLabel: latest ? `${latest.slice(0, 7)} 실거래까지 반영` : null,
      regulationBasis: '2025.10.15 주택시장 안정화 대책 (금융위) · 2026.6.30 규제지역 확대 반영',
      rateBasis,
      sources: ['국토교통부 실거래가', 'K-apt 공동주택', '건축물대장(건축HUB)', '학교알리미·NEIS', '카카오맵', '국가법령정보', '금융위원회', ...(ecosSource ? ['한국은행 ECOS'] : [])],
    };
    cache.set(CK, out, 21600); // 6h — daily ingest 주기와 정합
    return out;
  } catch (_) { return null; }
}

/** 정부 정책 최신 스냅샷 — regulationsService 활용 */
async function getPolicyContext() {
  // LTV-DSR-KEY-FIX-2026-07-15 (Sprint KKKKK-3, 운영자 세션 라이브 검증 중 발각):
  //   기존 getSnapshot('ltv')/('dsr')는 DB(실측: housing_loan_2025·acquisition_tax_2025 2행뿐)에도
  //   FALLBACK_BY_KEY 에도 없는 키 + 반환이 {data,...} wrapper 인데 .ltvTable 직접 접근 — 이중으로 틀려
  //   항상 null(소비처가 없어 잠복, JJJJJ 에서 첫 소비 시작하며 발각). 실제 위치 = housing_loan_2025.data.
  const housing = await getSnapshot('housing_loan_2025').catch(() => null);
  const hd = housing?.data || null;
  return {
    snapshot: '2025.10.15 주택시장 안정화 대책',
    ltv: hd?.ltvTable || null,
    dsr: hd?.dsrRules || null,
    regulatedAreas: '서울 25구 + 경기 15곳 (과천·광명·성남·수원·안양·용인·의왕·하남·구리·화성 동탄 등, 2026.6.30 동탄·기흥·구리 신규 지정)',
    landTrade: '규제지역 토지거래허가구역 — 2년 실거주 의무·갭투자 금지 (2026.7.5 동탄·기흥·구리 추가 지정)',
    policyLoans: ['보금자리론', '디딤돌', '신혼 디딤돌', '신생아 특례'],
    policyContact: '주택도시기금 nhuf.molit.go.kr · 1599-0001',
    // SOURCE-HONEST-2026-08-17 (Sprint MMMMMMM-21): 종전 문구는 "본 정보는 정부 공시 **자동** 인용"
    //   이었는데, 위 항목 중 자동으로 갱신되는 것은 **ltv·dsr(regulations_snapshot DB)** 뿐이고
    //   regulatedAreas·landTrade·snapshot 은 **코드에 고정된 문자열**이다. 절대 룰 ②는
    //   "출처 + 검증 일자 명시" 를 요구하는데, 하드코딩을 자동 인용이라 부르면 출처 표기를 오도한다.
    //   ⚠ 값 자체는 그대로 둔다 — 규제 지정일이 바뀌면 주간 규제감시 cron 이 능동 탐지한다.
    //     여기서 고치는 것은 **무엇이 자동이고 무엇이 고정인지** 를 정직하게 말하는 것뿐이다.
    note: '대출 알선·소개 X. LTV·DSR 은 정부 공시 스냅샷에서 자동 인용하고, 규제지역·토지거래허가 범위는 '
      + '표기된 지정일 기준으로 고정된 값이에요. 신청·자격과 최신 지정 현황은 별도 확인 필수.',
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
// REGION-LABEL-FIX-2026-07-25 (Sprint PPPPPP, improve 감사 CONFIRMED — 절대룰 ②③ 위반):
//   기존엔 "이름이 4자 이하 '구'" 라는 문자열 규칙만 봐서, 지방 광역시 구가 전부 걸렸다.
//   MOLIT sigungu 는 광역 prefix 가 없어(transactionService _stripCityPrefix) 인천 '연수구',
//   부산 '해운대구', 대구 '수성구' 등이 그대로 저장된다 → 보고서 카드·PDF·데이터판·AI 프롬프트에
//   "해운대구 우동 (서울 외곽구)" 같은 **사실 아닌 문장**이 노출됐다(보고서 지역은 UUUUU 이후 지방 포함).
//   ⇒ 서울 판정은 lawd_cd 11 prefix 로만. 지방은 '기타'(라벨 생략)로 떨어뜨린다.
function getDistrictTier(sigungu, lawdCd) {
  if (!sigungu) return { tier: '기타', bonus: 0 };
  const code = String(lawdCd || '').trim();
  const isSeoul = code ? code.startsWith('11') : false;
  if (isSeoul && ['강남구', '서초구', '송파구'].includes(sigungu)) return { tier: '강남3구', bonus: 60 };
  if (isSeoul && ['마포구', '용산구', '성동구', '광진구'].includes(sigungu)) return { tier: '마용성광', bonus: 50 };
  if (isSeoul && ['양천구', '영등포구', '강동구'].includes(sigungu)) return { tier: '서울 핵심구', bonus: 30 };
  // 경기 과천·분당·판교는 시/구 이름이 고유해 문자열 매칭이 안전(동명 지역 없음)
  if (['과천시', '분당구', '판교'].some(k => sigungu.includes(k))) return { tier: '분당·과천·판교', bonus: 35 };
  if (isSeoul && sigungu.endsWith('구')) return { tier: '서울 외곽구', bonus: 5 };
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
// HH-CONFLICT-2026-08-17 (Sprint MMMMMMM): 보고서는 buildFacility 를 안 거치는 **독립 2번째 경로**라
//   같은 가드를 따로 걸어야 한다(그래서 판정은 householdsConflictOf 하나만 쓴다 — 조건 복사 금지).
//   불일치면 비율은 그대로 보여주되(사실) 등급 보너스(최대 12점)만 0으로 만든다 —
//   실측상 세대당 6.07대까지 부푸는데 그걸로 점수를 주면 순위가 뒤틀린다.
function getParkingBonus(parkingTotal, households, householdsConflict) {
  const p = Number(parkingTotal), h = Number(households);
  if (!p || !h) return { ratio: null, bonus: 0 };
  if (householdsConflict) return { ratio: (p / h).toFixed(2), bonus: 0, uncertain: true };
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
// REGION-LABEL-FIX-2026-07-25 (Sprint PPPPPP): 위와 동일 근본원인. 지방 구를 '조정대상지역'으로
//   단정하면 사용자가 LTV 40%·취득세 중과·실거주 의무를 잘못 전제한다(금전 오판). 규제 여부를
//   **틀리게 단정하는 것보다 '미확인'(라벨 생략)이 절대룰에 부합** — 서울만 lawd_cd 로 확정 판정.
// REG-4TH-COPY-2026-08-16 (Plan 027, 감사 워크플로 지적): 이것이 규제 판정의 **네 번째 사본**이었다.
//   프론트 `_regLtvLabel`·`isRegFront` 는 계획 016·018·022 로 스냅샷을 따라가게 만들었는데,
//   여기만 "서울 25개 구 = 조정대상"을 **하드코딩**해 스냅샷을 보지 않았다.
//   같은 파일이 `getSnapshot` 을 이미 import 해 쓰고 있었는데도(:28, :610) 이 함수만 눈이 멀어 있었다.
//   [증상 시나리오] 서울이 규제 해제되면 프론트는 "비규제 70%" 로 바뀌는데 보고서만 계속
//     "조정대상지역" 이라 적고 점수까지 -3 감산한다 → 같은 서비스가 서로 다른 사실을 말한다(절대룰 ②).
//   [Fix] 호출측이 스냅샷에서 읽은 `seoulRegulated` 를 넘긴다.
//     **기본값 true(규제)** 는 의도적이다 — 스냅샷 조회 실패 시 보수적으로 규제로 보는 것이
//     프론트 `_regLtvLabel`(미로드면 '40%')과 같은 방향이고, 한도·의무를 과소 안내하지 않는다.
//   ⚠ 한계(프론트와 동일): 스냅샷의 `seoul` 이 문자열 + `!!` 라 **부분 해제는 표현 불가**다.
function getRegulationPenalty(sigungu, lawdCd, seoulRegulated = true) {
  if (!sigungu) return { status: '미확인', bonus: 0 };
  const code = String(lawdCd || '').trim();
  const isSeoul = code ? code.startsWith('11') : false;
  // 서울이 스냅샷상 해제됐으면 서울 분기를 타지 않는다(= 아래 '미확인'으로 떨어져 라벨 생략).
  if (isSeoul && seoulRegulated === false) return { status: '미확인', bonus: 0 };
  // 2025.10.15 기준 강화 규제지역 (서울 확정분)
  if (isSeoul && ['강남구', '서초구', '송파구', '용산구'].includes(sigungu)) {
    return { status: '투기과열·토허구역 일부', bonus: -8 };
  }
  // 서울 25개 구는 전부 조정대상 (lawd_cd 11 prefix 로만 판정 — 지방 동명 구 오판 차단)
  if (isSeoul && sigungu.endsWith('구')) {
    return { status: '조정대상지역', bonus: -3 };
  }
  // 서울 외 지역은 코드만으로 규제 여부를 단정할 수 없음 → 미확인(하위 표시에서 생략)
  //   REG-UNKNOWN-2026-08-16 (감사 #9): 예전엔 코드가 **없을 때** '비규제' 로 떨어졌다.
  //   그런데 `regulation` 필드는 '미확인' 이면 null 로 생략되지만 '비규제' 는 **화면에 그대로 뜬다**(:908).
  //   즉 lawd_cd 없이 부르면 강남구에도 "비규제" 라는 **사실 아닌 라벨**이 붙는다.
  //   코드가 없다는 건 "규제가 아니다" 가 아니라 "판정할 근거가 없다" 는 뜻이므로 '미확인' 이 정직하다.
  //   (현재 도달 불가 — apt_master 14,405행 중 lawd_cd 결측 0건 실측. 방어적 기본값으로만 둔다.)
  return { status: '미확인', bonus: 0 };
}

/** 점수 계산 — priority + 가구상황 + 예산 fit + 데이터 품질 + 객관 항목 (Phase 7) */
function computeAptScore(c, ctx) {
  const r = {};
  let total = 0;
  const p = ctx.priority;
  // TAG-AGE-FIX-2026-07-11 (Sprint OOOO): 아래 신축/재건축/장기거주 점수의 절대연도 하드코딩(≥2018/≥2012/≤1995/≤2000/≥2010)을
  //   현재연도 기준 상대 나이로 통일 — getAgeBonus 와 동일 패턴, 시간드리프트 방지(2026 동작 거의 동일).
  const _age = c.build_year ? (new Date().getFullYear() - Number(c.build_year)) : null;
  // SCORE-FIX-2026-08-30 (Sprint OOOOOOO, 점수표 감사 — 적대검증 통과):
  //   아래 학군·조용함·자녀학군은 **서울 구 이름 문자열만** 보고 점수를 준다. lawd_cd 게이트가 없어
  //   부산·대구·인천·대전·울산의 '중구' 가 서울 중구용 18점을 받는다 —
  //   이 저장소가 6회 겪은 [[region-judgment-by-lawdcd]] 의 재발이다. 여기서 원천 차단한다.
  const _isSeoul = String(c.lawd_cd || '').startsWith('11');
  // 거래건수 상한 — 아래 주석 참조(SCORE-CAP).
  const _nCapped = Math.min(20, Number(c.n) || 0);

  // 1) priority 가중치 (Phase 9.1: 환금성 가중치 n*4 → n*1.5 — 외곽 거래활발이 핵심권 못 이기던 문제)
  if (p === '환금성') {
    // SCORE-CAP-2026-08-30: 여기 n*1.5 는 **상한이 없었고**, 아래 transactions 의 n*0.5 와 합쳐
    //   환금성 선택 시 거래건수가 실효 2.0n 으로 **두 번** 반영됐다.
    //   [실측] 상한 있는 모든 항목의 이론적 최대 합이 331점인데, n≈166 이면 거래건수 하나가 그와 같아지고
    //   현실적 상한(150~200) 기준으로는 **n≈75~100 에서 이미 지배**한다 — 입지·연식·인프라가 무의미해진다.
    //   → n 항은 transactions 한 곳으로만 반영하고(아래), 여기서는 세대수만 본다.
    //   '환금성' 의 실질 의미(거래가 잘 되는가)는 transactions 항이 이미 담는다.
    const sub = (c.households >= 500 ? 25 : (c.households >= 300 ? 12 : 0));
    r.priority_환금성 = sub; total += sub;
  } else if (p === '학군') {
    // MOB-AUDIT-2026-05-03: 외곽 학군 우선순위 사용자에게 ★★★ 0개 risk → 부분 매칭 보강
    //   양천·강남·서초·송파·노원·광진 (35) / 마포·용산·성동·영등포·중구·종로 (18) / 외 (8)
    // P1-9 (2026-05-04): 학원 핵심 동 단위 추가 보너스 (대치·목동·잠실·중계·반포 등)
    //   양천구 ≠ 목동만, 강남구 ≠ 대치동만 — 동 단위 매칭으로 정확화
    const topSchoolGu = ['양천구', '강남구', '서초구', '송파구', '노원구', '광진구'];
    const midSchoolGu = ['마포구', '용산구', '성동구', '영등포구', '중구', '종로구', '동작구', '강동구'];
    const topSchoolDong = ['대치동', '목동', '잠실동', '중계동', '반포동', '서초동', '여의도동', '도곡동'];
    // SCORE-FIX-2026-08-30: 서울 구 목록은 **서울일 때만** 본다(동명 지방 중구 오판 차단).
    //   비서울은 이 목록으로 변별이 안 돼 전 후보가 8점 상수였다 — 학군을 1순위로 고른 의미가 없었다.
    //   대신 이미 수집하는 amenities.school(반경 1.2km 학교 수)로 상대 등급을 준다.
    //   ⚠ amenities 는 KAPT 호출 뒤에 붙으므로 여기선 없을 수 있다 → 그때는 종전 8점(모름)을 쓴다.
    let sub;
    if (_isSeoul) {
      sub = topSchoolGu.includes(c.sigungu) ? 35 : (midSchoolGu.includes(c.sigungu) ? 18 : 8);
      if (topSchoolDong.includes(c.umd_nm)) sub += 10; // 핵심 동 가산점
    } else {
      const sc = c.amenities && Number(c.amenities.school);
      sub = Number.isFinite(sc) ? (sc >= 12 ? 30 : sc >= 8 ? 22 : sc >= 4 ? 14 : 8) : 8;
    }
    r.priority_학군 = sub; total += sub;
  } else if (p === '역세권') {
    const sub = c.n >= 12 ? 20 : (c.n >= 8 ? 12 : 5);
    r.priority_역세권 = sub; total += sub;
  } else if (p === '신축') {
    const sub = (_age !== null && _age <= 8) ? 35 : ((_age !== null && _age <= 14) ? 18 : 0);
    r.priority_신축 = sub; total += sub;
  } else if (p === '재건축') {
    const sub = (_age !== null && _age >= 30) ? 30 : ((_age !== null && _age >= 25) ? 12 : 0);
    r.priority_재건축 = sub; total += sub;
  } else if (p === '교통') {
    const sub = c.n >= 10 ? 18 : 6;
    r.priority_교통 = sub; total += sub;
  } else if (p === '조용함') {
    const quietGu = ['도봉구', '강북구', '중랑구', '은평구', '금천구'];
    // SCORE-FIX-2026-08-30: 서울 전용 목록 — 서울일 때만 적용(비서울은 종전대로 3점, 변별 불가를 인정).
    const sub = (_isSeoul && quietGu.includes(c.sigungu)) ? 18 : 3;
    r.priority_조용함 = sub; total += sub;
  } else if (p === '갭투자') {
    const sub = c.n >= 10 ? 12 : 3;
    r.priority_갭투자 = sub; total += sub;
  }

  // 2) 가구 상황 보너스
  if (ctx.kidPlan === '초등' || ctx.kidPlan === '중등+') {
    const goodSchoolGu = ['양천구', '강남구', '서초구', '송파구', '노원구', '광진구'];
    // SCORE-FIX-2026-08-30: 서울 전용 목록 — 동명 지방구가 서울용 가산점을 받지 않게 한다.
    if (_isSeoul && goodSchoolGu.includes(c.sigungu)) {
      r.kids_school_bonus = 20; total += 20;
    }
  }
  if (ctx.stayYears === '10년+' && _age !== null && _age <= 16) {
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
  // SCORE-CAP-2026-08-30: 상한 없는 유일한 항이었다. n=300 이면 150점으로,
  //   단일 최대 항목(행정구위계 60)의 2.5배·상한합 331 의 45% 를 혼자 차지했다.
  //   ⚠ c.n 은 **후보 풀(평형 밴드 적용) 안의** 6개월 건수라 실제보다 작다 — 그래서 상한을 낮게 잡는다.
  // TURNOVER-2026-08-30 (Sprint PPPPPPP): 절대 건수 → **세대수 대비 회전율**.
  //   운영자 지적: 보고서 1위가 43건으로 건수 1위였지만 1,226세대라 회전율은 3.51% 로 4위였다.
  //   구간은 utils/scoreBands 한 곳에만 둔다(추천 화면과 동일 기준).
  //   ⚠ 이 시점엔 KAPT 를 아직 안 불러 **세대수를 모른다**. 그래서 여기서는 건수 기반 폴백만 매기고,
  //     세대수를 아는 applyObjectiveScore 에서 회전율로 **교체**한다.
  //   ⚠ 분자에 _nCapped(20 상한)를 쓰면 안 된다 — 큰 단지가 전부 같은 회전율로 뭉개진다.
  const _turn = turnoverScore(Number(c.n) || 0, 0, 15);
  if (_turn.score > 0) { r.transactions = _turn.score; total += _turn.score; }

  // ※ 데이터 품질 + 객관 항목 + universal preference 는 KAPT 호출 후 (applyObjectiveScore)

  return { total: Math.round(total), breakdown: r };
}

/** Phase 7: 객관 데이터 점수 추가 — KAPT API 호출 후 별도 적용 */
function applyObjectiveScore(c, seoulRegulated = true) {
  // c.score, c.scoreBreakdown 이 이미 1차 계산되어 있다고 가정
  const r = c.scoreBreakdown;

  // 데이터 품질 보너스
  if (c.households && !r.data_households) { r.data_households = 5; c.score += 5; }
  if (c.build_year && !r.data_build_year) { r.data_build_year = 5; c.score += 5; }

  // 객관 데이터 항목 — KAPT facility + sigungu 활용
  const district = getDistrictTier(c.sigungu, c.lawd_cd);
  if (district.bonus && !r['객관_행정구위계']) { r['객관_행정구위계'] = district.bonus; c.score += district.bonus; }

  const builder = getBuilderTier(c.kaptInfo?.builder);
  if (builder.bonus && !r['객관_시공사']) { r['객관_시공사'] = builder.bonus; c.score += builder.bonus; }

  const hhBonus = getHouseholdBonus(c.households);
  if (hhBonus && !r['객관_세대수']) { r['객관_세대수'] = hhBonus; c.score += hhBonus; }

  const parking = getParkingBonus(c.kaptInfo?.parking, c.households, c.householdsConflict);
  if (parking.bonus && !r['객관_주차']) { r['객관_주차'] = parking.bonus; c.score += parking.bonus; }

  const age = getAgeBonus(c.build_year);
  if (age.bonus && !r['객관_노후도']) { r['객관_노후도'] = age.bonus; c.score += age.bonus; }

  const reg = getRegulationPenalty(c.sigungu, c.lawd_cd, seoulRegulated);
  if (reg.bonus && !r['객관_규제']) { r['객관_규제'] = reg.bonus; c.score += reg.bonus; }

  // TURNOVER-2026-08-30 (Sprint PPPPPPP): 세대수를 아는 지금 **회전율로 교체**한다.
  //   computeAptScore 는 KAPT 호출 전이라 건수 폴백밖에 못 매겼다.
  //   구간은 utils/scoreBands 한 곳에만 있다 — 추천 화면과 같은 기준이다.
  if (Number(c.households) > 0) {
    const t = turnoverScore(Number(c.n) || 0, Number(c.households), 15);
    const prev = Number(r.transactions) || 0;
    c.score += (t.score - prev);
    r.transactions = t.score;
    c._turnoverWhy = t.why;
  }

  // Phase 8: 신고가 갱신 횟수 (6개월 내)
  if (c.new_high_count > 0 && !r['객관_신고가갱신']) {
    const sub = c.new_high_count >= 3 ? 8 : (c.new_high_count >= 1 ? 4 : 0);
    if (sub) { r['객관_신고가갱신'] = sub; c.score += sub; }
  }

  // SUBWAY-PROXY-2026-08-30 (Sprint OOOOOOO, 점수표 감사 — 적대검증 통과):
  //   '역세권'·'교통' 우선순위가 **지하철 데이터를 전혀 보지 않고 거래건수(c.n)로만** 판정하고 있었다
  //   (computeAptScore: 역세권 `c.n>=12?20:...`, 교통 `c.n>=10?18:6`).
  //   그런데 실제 지하철 개수는 amenities.subway 로 **이미 수집돼 있다** — 다만 '객관_생활인프라'
  //   한 항목에만 쓰이고, 그 값은 우선순위와 무관하게 모두에게 똑같이 붙는다.
  //   즉 사용자가 '역세권'을 1순위로 골라도 그 선택이 실제 역 개수를 더 무겁게 만들지 못했다.
  //   → amenities 가 붙은 지금 시점에 그 두 항목을 **실측 지하철 수로 교체**한다.
  //   ⚠ 좌표가 없거나 카카오 조회가 실패하면 amenities 자체가 없다 → 그때는 종전 값을 그대로 둔다
  //     (모르는 것을 0으로 바꾸지 않는다 — [[unknown-treated-as-value]]).
  // ⚠ NULL-NOT-ZERO-2026-09-02 (감사 P0-2): `Number(null) === 0` 이라 null 체크 없이
  //   Number.isFinite 만 보면 **조회 실패가 "역 0곳"으로 통과**한다. 실제로 그랬다.
  if (c.amenities && c.amenities.subway != null && Number.isFinite(Number(c.amenities.subway))) {
    const sw = Number(c.amenities.subway);
    if (r.priority_역세권 != null) {
      const next = sw >= 4 ? 20 : sw >= 2 ? 14 : sw >= 1 ? 8 : 2;
      c.score += (next - r.priority_역세권);
      r.priority_역세권 = next;
      r._역세권_근거 = `반경 1.2km 지하철역 ${sw}곳`;
    }
    if (r.priority_교통 != null) {
      const next = sw >= 4 ? 18 : sw >= 2 ? 12 : sw >= 1 ? 7 : 2;
      c.score += (next - r.priority_교통);
      r.priority_교통 = next;
      r._교통_근거 = `반경 1.2km 지하철역 ${sw}곳`;
    }
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
    // REGION-LABEL-FIX-2026-07-25: 확정되지 않은 위계·규제는 **표시하지 않는다**(null → 프론트·PDF·
    //   AI 프롬프트에서 자동 생략). 틀린 단정보다 미표기가 절대룰(환각 차단·정확도)에 부합.
    district: district.tier === '기타' ? null : district.tier,
    builder: c.kaptInfo?.builder ? `${c.kaptInfo.builder} (${builder.tier})` : null,
    households: c.households || null,
    age_years: age.years,
    parking_per_household: parking.ratio,
    // HH-CONFLICT-2026-08-17: 비율은 그대로 보여주되 '장점' 문장은 이 플래그로 막는다(위 pros 참조).
    parking_uncertain: parking.uncertain || false,
    parking_total: c.kaptInfo?.parking || null,
    regulation: reg.status === '미확인' ? null : reg.status,
    transactions_6mo: c.n,
    new_high_count: c.new_high_count || 0, // Phase 8
    amenities: c.amenities || null,        // Phase 8: { school, mart, hospital, subway, cvs }
    // Sprint KKKKK: 전세가율 — 회원님 평형대 전세 실거래 중위 환산보증금 / 같은 평형대 매매 평균 (수치만)
    jeonse_ratio: c.jeonse ? `${c.jeonse.ratio}%` : null,
    jeonse_sample: c.jeonse ? c.jeonse.n : null,
  };

  c.score = Math.round(c.score);
}

/** 추천 단지 후보 fetch — molit + apt_master 통합 + 점수 매칭 + 다양성 */
async function fetchCandidateApts(admin, input, limit) {
  const buy = parseFloat(input.maxBudget) || 0;
  const region = String(input.region || '').trim();
  // REGION-CODE-2026-08-30 (Sprint OOOOOOO): 프론트 지역 칩이 실어 보내는 시군구 코드.
  //   있으면 아래 pickRegions 가 문자열 해석을 건너뛴다 — 이름 매칭 결함 계열의 원천 차단.
  // MULTI-REGION-2026-08-30 (Sprint OOOOOOO): 콤마 구분 다중 코드 허용("41597,41595").
  //   pickRegions 가 화이트리스트 검증·중복 제거·상한(6)을 이미 하므로 여기선 형식만 거른다.
  const _reqLawdCd = String(input.lawdCd || '').split(',').map(x => x.trim())
    .filter(x => /^\d{5}$/.test(x)).join(',');
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
  // POOL-PARALLEL-2026-08-17 (Sprint MMMMMMM-17): 아래 지역 분기는 종전에 빌더 `q` 를 직접 mutate 했다.
  //   supabase-js 빌더는 mutable 이라 **같은 인스턴스로는 페이지를 병렬 요청할 수 없다**(range 가 서로 덮인다).
  //   그래서 지역 판정 결과를 **적용 함수 하나**(_regionOp)로만 담고, 페이지마다 새 빌더를 만든다.
  //   ⚠ 판정 **조건은 한 글자도 바꾸지 않았다** — `q = q.X(…)` 를 `_regionOp = qq => qq.X(…)` 로
  //     기계적으로 치환했을 뿐이다. 이 구간은 지역 판정 사고가 8회 재발한 자리라 의미 변경을 섞지 않는다.
  //   날짜 기준은 **밖에서 한 번** 계산한다 — 팩토리 안에서 계산하면 자정 경계에서 페이지마다 달라진다.
  // TX-WINDOW-2026-08-31: 추천 경로와 **같은 시작일**을 쓴다.
  //   종전 롤링 180일은 달 경계 기준과 며칠 어긋나, 같은 단지가 두 화면에서 다른 값을 보였다
  //   (자연앤데시앙 85㎡ 고층: 보고서 11건·6.10억 ↔ 추천 기준 12건·5.98억).
  const _sinceDate = txWindowStart(6);
  let _regionOp = null;   // (qq) => qq · null 이면 지역 필터 없음
  const _newPageQuery = () => {
    let qq = admin.from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, exclu_use_ar, deal_amount, deal_date, apt_seq, jibun')
      .gte('exclu_use_ar', minSqm).lte('exclu_use_ar', maxSqm)
      .gte('deal_amount', minAmt).lte('deal_amount', maxAmt)
      .gte('deal_date', _sinceDate);
    if (_regionOp) qq = _regionOp(qq);
    // 2차 정렬키 id — deal_date 동점의 페이지 경계 중복/누락을 막는다(병렬이라 더 중요해졌다).
    return qq.order('deal_date', { ascending: false }).order('id', { ascending: false });
  };

  // METRO-SUB-2026-07-17 (Sprint UUUUU): 지방 광역시 세부(해운대·수영·수성·유성·광주서구)는 guMatch 보다 먼저 처리.
  //   '해운대/수영/수성/유성'은 '구' 접미사가 없어 guMatch 미스 → 전국 조회로 빠지고, '광주서구'는 sigungu 문자열에
  //   없어 like 실패. 5개 구는 이미 적재된 lawd_cd 라 IN 필터로 정확 도달(propertyService.REGION_KEYWORDS 와 동반 수정).
  //   REGION-SWAP-2026-08-10: '광주서'(29140) 제거 — 광주광역시 → 전남광주통합특별시 편입으로
  //   구 코드 폐지 + 운영자 방침(전라권 미지원).
  //   CHEONGJU-FIX-2026-08-10: 청주를 여기 **반드시** 넣어야 한다. 직전 커밋의 "청주는 '○○구'로
  //   끝나 guMatch 가 처리한다"는 주석은 **틀렸다** — guMatch 가 보는 것은 DB 의 sigungu 값이 아니라
  //   프론트가 보내는 **사용자 선택값**이고, 그 값은 `getRegionForSearch()`(index.html)가 만드는
  //   "지방 청주"다('구'가 없다). 그러면 METRO_SUB·guMatch·서울/경기/인천 세 분기에 모두 걸리지 않아
  //   **lawd_cd 필터가 아예 안 붙고 전국 molit_transactions 가 후보 풀이 된다** — 에러도 빈 결과도
  //   아닌 "조용히 틀린 보고서"라 가장 위험하다. 청주는 구가 4개라 값을 배열로 통일한다.
  const METRO_SUB = {
    '해운대': ['26350'], '수영': ['26500'], '수성': ['27260'], '유성': ['30200'],
    '청주': ['43111', '43112', '43113', '43114'],
  };
  // ══ REGION-SCOPE-2026-08-17 (Sprint MMMMMMM-16) ══════════════════════════════
  //   [실측] 프론트가 보내는 지역 문자열은 **닫힌 집합**이다 — `getRegionForSearch()` 가
  //     `${wide} ${sub}` 를 만들고 wide∈{서울,경기,인천,지방}, sub 는 REGION_SUB 의 52개뿐.
  //     그 56개를 전부 아래 분기에 넣어 돌린 결과:
  //       · 서울 25개 · 지방 5개 · 인천 '서구'  → 정확히 1개 구로 좁혀짐 ✅
  //       · **경기 16개 전부 → 경기 44개 코드 전체** ❌
  //       · **인천 5개(연수(송도)·남동·부평·계양·미추홀) → 인천 14개 전체** ❌
  //       · **'지방' 세부 미선택 → 필터 자체가 안 붙어 전국** ❌
  //     원인은 단순하다. 이 분기는 `[가-힣]+구` 로 '구'가 붙은 이름만 좁힐 수 있는데
  //     경기·인천 칩 라벨은 '과천'·'분당'·'남동'처럼 **'구'가 없다**.
  //     화면 안내는 "선택 시 **그 지역만** 분석" 이라고 말한다 — 52개 중 21개가 그 말과 달랐다.
  //
  //   [고치는 방법 — 새 매핑을 만들지 않는다] `propertyService.REGION_KEYWORDS` 가
  //     판교→41135 · 평촌→41173 · 미사→41450 · 수지→41465 처럼 **이미 정확한 매핑을 갖고 있고**
  //     추천 경로는 그걸로 잘 좁히고 있었다(52개 전부 정확 해석 실측). 즉 같은 입력에 두 기능이
  //     다르게 동작하던 것 — 이 저장소가 반복해 겪은 "사본이 갈린다" 그 자체다.
  //     여기서 별도 표를 만들면 **세 번째 사본**이 된다 → 검증된 쪽을 재사용한다.
  //
  //   ⚠ 안전장치: pickRegions 는 매칭 실패 시 **예산 기반 서울 인기 구**를 돌려준다(추천용 폴백).
  //     그게 보고서로 새면 "경기 보고서에 서울 단지" 가 된다 → 결과 코드의 시도 접두가
  //     사용자가 고른 광역과 맞을 때만 채택하고, 아니면 아래 기존 광역 분기로 내려간다.
  const _WIDE_PFX = { '서울': '11', '경기': '41', '인천': '28' };
  const _wideKey = Object.keys(_WIDE_PFX).find(w => region.includes(w)) || (region.includes('지방') ? '지방' : null);
  const _subToken = ['서울', '경기', '인천', '지방'].reduce((s, w) => s.split(w).join(''), String(region || '')).trim();
  let _scopedCodes = null;
  if (_subToken) {
    try {
      const { pickRegions } = require('../services/propertyService');
      // REGION-CODE-2026-08-30: 프론트가 코드를 실어 보내면 문자열 해석을 건너뛴다(추천과 동일 경로).
      const picked = pickRegions(region, buy, '', _reqLawdCd) || [];
      const codes = [...new Set(picked.map(p => p && p.lawdCd).filter(Boolean))];
      const wantPfx = _WIDE_PFX[_wideKey] || null;
      // ⚠ 접두 검증만으로는 부족하다(실측으로 확인). 매핑에 없는 세부 토큰이 오면 pickRegions 는
      //   **그 광역의 대표 몇 개 구**를 돌려주는데(예: '인천 테스트동' → 28185·28200·28237·28245),
      //   접두는 28 로 맞아 그대로 채택돼 버린다. 사용자가 고른 곳과 무관한 4개 구를 뒤지게 된다.
      //   판별자는 `name` 이다 — 매핑에 걸리면 매칭된 키워드('연수'·'과천'·'판교')가 오고,
      //   못 걸리면 **광역 이름**('인천'·'경기')이 온다. 후자면 해석 실패로 보고 광역 분기로 내려간다
      //   (광역 전체가 대표 4구보다 정직하다 — 임의로 좁히면 빠진 지역을 사용자가 알 길이 없다).
      const names = picked.map(p => p && p.name).filter(Boolean);
      const resolved = names.length && !names.some(n => ['서울', '경기', '인천', '지방'].includes(n));
      const ok = codes.length && resolved && (wantPfx
        ? codes.every(c => String(c).startsWith(wantPfx))
        // '지방'은 여러 시도가 섞이므로 접두 대신 "수도권 코드가 아닐 것"으로 본다(해운대26·수성27·유성30·청주43).
        : codes.every(c => !['11', '41', '28'].includes(String(c).slice(0, 2))));
      if (ok) _scopedCodes = codes;
      else logger.warn({ region, codes, names }, '지역 세부 해석 실패 — 광역 분기로 폴백');
    } catch (e) { logger.warn({ region, err: e.message }, 'pickRegions 재사용 실패 — 광역 분기로 폴백'); }
  }

  let _metroCodes = null;
  for (const [kw, codes] of Object.entries(METRO_SUB)) { if (region.includes(kw)) { _metroCodes = codes; break; } }
  const guMatch = (_scopedCodes || _metroCodes) ? null : region.match(/([가-힣]+구)/);
  if (_scopedCodes) _regionOp = qq => qq.in('lawd_cd', _scopedCodes);
  else if (_metroCodes) _regionOp = qq => qq.in('lawd_cd', _metroCodes);
  else if (guMatch) {
    // SIDO-SCOPE-2026-08-10 (Sprint KKKKKKK-9): 구 이름만으로 `.like('sigungu', …)` 하면
    //   **다른 도시 아파트가 섞인다**. molit_transactions.sigungu 에는 광역 접두가 없어
    //   (transactionService._stripCityPrefix) 실측상 '중구'는 6개 시도, '서구'는 4개 시도에
    //   17,350건이 같은 문자열로 저장돼 있다 — "인천 서구" 보고서에 부산·대구·대전 서구 단지가
    //   후보로 들어왔다. 광역 접두가 있으면 그 시도의 lawd_cd 로 정확히 좁힌다.
    const { LAWD_CODES } = require('../services/transactionService');
    const SIDO_PFX = [['서울', '11'], ['인천', '28'], ['부산', '26'], ['대구', '27'],
      ['대전', '30'], ['울산', '31'], ['경기', '41']];
    const hit = SIDO_PFX.find(([nm]) => region.includes(nm));
    const scoped = hit
      ? Object.entries(LAWD_CODES)
        .filter(([, c]) => String(c).startsWith(hit[1]))
        .filter(([n]) => String(n).replace(/^(인천|부산|대구|대전|울산)/, '') === guMatch[1])
        .map(([, c]) => c)
      : [];
    if (scoped.length) _regionOp = qq => qq.in('lawd_cd', scoped);
    else _regionOp = qq => qq.like('sigungu', `%${guMatch[1]}%`); // 광역 접두 없음 → 기존 동작(모호성 잔존)
  } else {
    // P1-1 (2026-05-04): lawd_cd LIKE '11%' → IN (...) 명시
    //   진단 (EXPLAIN): LIKE prefix 시 인덱스 미활용 → Parallel Seq Scan 960ms
    //   변경: IN (서울 25개 코드) 명시 → idx_molit_lawd_date 인덱스 활용 → ~10x 향상 예상
    const { LAWD_CODES } = require('../services/transactionService');
    const codeList = Object.values(LAWD_CODES);
    if (region.includes('서울')) _regionOp = qq => qq.in('lawd_cd', codeList.filter(c => c.startsWith('11')));
    else if (region.includes('경기')) _regionOp = qq => qq.in('lawd_cd', codeList.filter(c => c.startsWith('41')));
    else if (region.includes('인천')) _regionOp = qq => qq.in('lawd_cd', codeList.filter(c => c.startsWith('28')));
    // REGION-SCOPE-2026-08-17: '지방' 광역을 세부 미선택으로 보내면 **위 셋 어디에도 안 걸려
    //   lawd_cd 필터가 통째로 빠지고 전국이 후보 풀이 됐다**(실측). 화면은 "광역의 인기 구 분석"
    //   이라고 안내하는데 실제로는 서울·경기까지 포함한 전국을 뒤진 것 — 에러도 빈 결과도 아니라
    //   가장 발견하기 어려운 종류다(청주 사고 때 주석이 경고한 바로 그 형태).
    //   우리가 '지방'으로 커버하는 범위는 정의상 위 METRO_SUB 그 자체이므로 그 합집합으로 좁힌다.
    else if (region.includes('지방')) _regionOp = qq => qq.in('lawd_cd', Object.values(METRO_SUB).flat());
    else logger.warn({ region }, '지역 필터 미적용 — 전국이 후보 풀이 된다(예상치 못한 지역 문자열)');
  }

  // Phase 9: 광역 검색 시 후보 풀 2500 (선호도 가산점 위해 더 넓게 후보 풀)
  // REPORT-CAP-FIX-2026-07-25 (Sprint NNNNNN-4, 워크플로 적대검증 CONFIRMED — 성능이 아니라 정확도 결함):
  //   [실측] Supabase REST 는 응답당 1000행 cap(레포 내 2회 독립 실증: transactionService.js:109-112,
  //     geocacheBackfill 페이징). 여기 .limit(2500) 은 서버가 1000으로 자르고, **정렬 지정이 없어**
  //     인덱스(idx_molit_lawd_date) 출력 순서 = lawd_cd 오름차순으로 잘렸다.
  //   [영향] 서울 광역("서울" 칩이 기본값·세부 구 미선택) 6개월 밴드 실측 4,624~6,208행 → 1000 절단이
  //     상시 발동. 앞쪽 8개 구(종로 11110~성북 11290)만 덮여 **강남(11680)·서초(11650)·송파(11710)·
  //     마포(11440)·강동(11740)이 후보 풀에 구조적으로 전혀 진입 못함**(후보 단지 1,446→261=17%).
  //     "광역 서울" 보고서인데 강남권이 통째로 빠지던 것 — 사용자에겐 보이지 않는 조용한 누락.
  //   [Fix] transactionService.getRegionRecentTransactions(113-127)와 동일 패턴: 최신순 정렬 명시 +
  //     1000행 range 페이징으로 의도한 2500 을 실제로 확보. deal_date 동점의 페이지 경계 중복/누락은
  //     2차 정렬키 id 로 차단. 왕복 1→3(광역 기준) — 정확도 대비 수용.
  //   ⚠ 구현 주의: supabase-js 빌더에서 .order() 는 쿼리스트링에 **누적**되므로 루프 밖에서 1회만 적용하고,
  //     루프 안에서는 Range 헤더를 덮어쓰는 .range() 만 반복한다(반복 호출 시 order 중복 방지).
  // POOL-COVERAGE-2026-08-17 (Sprint MMMMMMM-13): 위 페이징은 1000행 cap 은 풀었지만
  //   **2,500 이라는 상한 자체가 광역 보고서를 조용히 최근 2개월짜리로 만들고 있었다.**
  //   [실측 — 서울 광역·평형 전체·매수가 10억(밴드 0.7~1.2배)]
  //     · 밴드 내 180일 행수 **11,983** → 2,500 은 20.9%
  //     · 풀이 실제로 덮는 기간 = **2026-06-19 이후(59일)**. 의도한 시작일은 2026-02-18.
  //     · 적격 단지(n>=2) **1,329곳 → 508곳**. **821곳(62%)이 후보에 아예 진입하지 못했다.**
  //   [왜 라벨 수정으로 못 덮나] n 은 표시용이 아니다 — 아래 TRUST-GATE `n >= 2` 의 판정 기준이고
  //     computeAptScore 의 거래량 점수 입력이다. 잘린 풀에서 n=1 이 된 정상 단지가 유령 단지와
  //     구별 없이 배제된다. 게이트를 완화하는 건 답이 아니다(유령 단지가 다시 들어온다) —
  //     **풀이 잘리지 않게 하는 것**이 유일한 해법이다.
  //   [상한을 12,000 으로 잡은 근거] 구 단위 선택은 원래 안 잘린다(서울 최대 노원구 1,430행).
  //     광역만 문제이고 서울 광역은 밴드별 최대 11,983행 → 12,000 이면 **행수 기준으로는** 전부 담긴다.
  //     경기 광역 최악 밴드는 29,260행이라 여전히 부분 표본이다 — 그 경우는 아래에서 사실대로 밝힌다.
  //   [시간 예산 — ⚠ 2026-08-17 정정] 처음엔 8s 로 잡았는데, **왕복 실측을 안 하고 정한 값이었다.**
  //     Supabase edge_logs 실측(`response.origin_time`, molit_transactions 대상):
  //       · 1,000행 페이지(`content_range: 0-999/*`)  평균 **935ms** · 최대 3,967ms (n=19)
  //       · 2페이지째(`1000-1999/*`)                   평균 **1,076ms** · 최대 2,683ms (n=7)
  //     즉 12페이지 순차면 평균 **약 11~12초**다. 8s 예산은 7~8페이지에서 끊겨
  //     "12,000 이면 전량 커버" 가 실제로는 성립하지 않았다. 평균 소요에 여유를 둬 **25s** 로 올린다.
  //     (함수 maxDuration 은 300s 이고 이 경로는 뒤이어 AI 호출까지 하므로 25s 는 안전 범위.)
  //   [남은 개선 — 운영자 결정 대기] 병렬화하면 12초가 1~4초가 된다. 다만 supabase-js 빌더는 mutable
  //     이라 페이지마다 **새 빌더**가 필요하고, 그러려면 위 지역 판정 분기(956~1012행)를 팩토리로
  //     빼야 한다. 이 저장소는 지역 판정 수정에서 사고가 반복된 이력이 있어 오늘은 건드리지 않는다.
  //   ⚠ 구현 주의: supabase-js 빌더에서 .order() 는 쿼리스트링에 **누적**되고 .range() 는 헤더를
  //     덮어쓴다. 그래서 **한 인스턴스를 재사용하면 병렬 요청이 서로를 덮는다** —
  //     `_newPageQuery()` 로 페이지마다 새 빌더를 만드는 이유가 이것이다(위 팩토리 주석 참조).
  //   [병렬화 근거 — 실측] 1,000행 페이지 왕복이 평균 935ms(최대 3,967ms)라 12페이지 순차는
  //     약 11~12초였다. 배치 병렬로 3라운드면 **약 3초**다. 동시 요청 수는 4로 제한한다 —
  //     한 번에 12개를 던지는 이득(3초→1초)은 크지 않은데 커넥션 부담은 3배가 되고,
  //     그 부담이 안전한지는 **재보지 않았다**(재보지 않은 값을 고르지 않는다).
  //   ⚠ **첫 페이지는 반드시 단독으로** 받는다(POOL-COLD-2026-08-17, 프로덕션 DB 실측으로 발견).
  //     처음엔 0번 페이지부터 4개를 동시에 던졌는데, **콜드 상태에서 4개가 서로 경합해 전부
  //     statement timeout** 이 났다(실측: 4개 동시 → 4,177ms 만에 4개 모두 실패).
  //     같은 쿼리를 한 번 워밍한 뒤에는 4개 병렬이 **167ms** 에 끝난다 — 즉 병렬 자체가 아니라
  //     **콜드 경합**이 문제였다. 첫 페이지를 혼자 보내 워밍하면 그 창이 사라진다.
  //     ⚠ statement_timeout 은 service_role 도 무제한이 아니다 — `authenticator` 의 **8s** 를 물려받는다
  //       (`pg_roles.rolconfig` 실측: anon 3s · authenticated 8s · authenticator 8s · service_role null).
  const PAGE = 1000, POOL_MAX = 12000, POOL_BUDGET_MS = 25000, POOL_CONCURRENCY = 4;
  const _poolStart = Date.now();
  let txs = [], poolComplete = false;
  {
    // ① 첫 페이지 단독 — 콜드 경합 방지. 여기서 덜 차면(구 단위 선택 등) 더 볼 것도 없다.
    const { data: first, error: firstErr } = await _newPageQuery().range(0, PAGE - 1);
    if (firstErr) throw firstErr;
    txs = first || [];
    if (txs.length < PAGE) poolComplete = true;
  }
  // ② 이후는 배치 병렬. 결과는 offsets 순서로 돌아오므로 concat 만으로 정렬이 보존된다.
  for (let from = PAGE; from < POOL_MAX && !poolComplete; from += PAGE * POOL_CONCURRENCY) {
    if (Date.now() - _poolStart > POOL_BUDGET_MS) break;   // 예산 초과 → 잘린 상태로 진행
    const offsets = [];
    for (let i = 0; i < POOL_CONCURRENCY; i++) {
      const off = from + i * PAGE;
      if (off < POOL_MAX) offsets.push(off);
    }
    const pages = await Promise.all(offsets.map(off =>
      _newPageQuery().range(off, off + PAGE - 1)
        .then(r => (r.error ? { err: r.error } : { rows: r.data || [] }))));
    for (const p of pages) {
      if (p.err) throw p.err;                       // 조회 실패는 종전처럼 그대로 던진다
      txs = txs.concat(p.rows);
      // 한 페이지라도 덜 찼으면 그 뒤는 존재하지 않는다 = 조건 내 전량 확보.
      if (p.rows.length < PAGE) poolComplete = true;
    }
  }
  // 잘렸다면 "최근 6개월" 이라고 말하면 안 된다 — 실제로 덮은 시작일을 함께 들고 다닌다.
  //   (txs 는 deal_date 내림차순이므로 마지막 원소가 가장 오래된 거래다.)
  const poolTruncated = !poolComplete;
  const poolFromDate = txs.length ? txs[txs.length - 1].deal_date : null;
  if (poolTruncated) {
    logger.warn({ region, rows: txs.length, poolFromDate, elapsedMs: Date.now() - _poolStart },
      '보고서 후보 풀 절단 — 표기를 실제 커버 기간으로 낮춘다');
    // 로그는 Hobby 에서 1시간이면 사라진다. **얼마나 자주 잘리는지**를 알아야 예산·병렬화를
    //   추측이 아니라 데이터로 정할 수 있다 → health.searchDegrade 에 카운터로 남긴다.
    //   ⚠ await 하지 않으면 서버리스 동결로 유실된다(커밋 ba1db07 에서 실제로 겪었다).
    //   여기는 응답까지 아직 멀지만, 유실 가능한 관측을 남기지 않는다는 규약을 일관되게 지킨다.
    await require('../services/degradeStats').observeDegrade('report-pool-cut');
  }

  // ALIAS-MERGE-2026-05-21 (전수조사: BUG2 동일 클래스): raw MOLIT명(풍림아파트A/B) →
  //   canonical master명(공릉풍림아이원) relabel → 보고서 후보도 1개 단지로 병합 (검색/지도/단지정리와 동일 식별).
  const txList = txs || [];
  let _aliasMap = new Map();
  try {
    const { getAliasCanonicalMap } = require('../services/transactionService');
    _aliasMap = await getAliasCanonicalMap([...new Set(txList.map(t => t.lawd_cd).filter(Boolean))]); // ALIAS-REGION-FIX-2026-07-12: sigungu 명→lawd_cd (getAliasCanonicalMap 조회키 통일)
  } catch (_) {}

  // 단지 그룹화 + build_year mode + 신고가 갱신 카운트
  const byApt = {};
  for (const t of txList) {
    const _canon = _aliasMap.get(`${t.apt_name}|${t.umd_nm}`) || t.apt_name;
    // SAME-DONG-SPLIT-2026-08-30: 추천 경로(transactionService.analyzeTransactions)와 **같은 정책**.
    //   이름+동이 같아도 준공년도가 다르면 다른 단지다(실측 20그룹·204거래).
    const key = `${_canon}|${t.sigungu}|${t.umd_nm}|${t.build_year || ''}`;
    if (!byApt[key]) byApt[key] = {
      apt_name: _canon, sigungu: t.sigungu, umd_nm: t.umd_nm,
      lawd_cd: t.lawd_cd,
      sum: 0, n: 0, areas: new Set(), rawNames: new Set(), bonCnt: {}, latest: t.deal_date,
      buildYearCnt: {},
      deals: [], // Phase 8: 신고가 갱신 계산용
    };
    byApt[key].sum += t.deal_amount;
    byApt[key].n++;
    byApt[key].areas.add(Math.round(t.exclu_use_ar));
    byApt[key].rawNames.add(t.apt_name);
    // MERGE-GUARD-JIBUN-2026-08-30: 개명 단지를 필지로 이어붙이기 위한 최빈 본번 집계.
    const _bon = String(t.jibun || '').trim().match(/^(\d+)/);
    if (_bon) byApt[key].bonCnt[_bon[1]] = (byApt[key].bonCnt[_bon[1]] || 0) + 1;
    if (t.deal_date > byApt[key].latest) byApt[key].latest = t.deal_date;
    if (t.build_year) {
      byApt[key].buildYearCnt[t.build_year] = (byApt[key].buildYearCnt[t.build_year] || 0) + 1;
    }
    // area 를 함께 싣는다 — 평형별 신고가 판정에 필요하다.
    byApt[key].deals.push({ date: t.deal_date, amount: t.deal_amount, area: t.exclu_use_ar ?? t.excluUseAr });
  }

  // NEWHIGH-AREA-2026-08-30 (Sprint PPPPPPP): 신고가 갱신은 **평형별**로 센다.
  //   기존 구현은 평형을 섞어 누적 최대값을 봤다 — 큰 평형이 한 번 최고가를 찍으면
   //   그 뒤 소형의 신고가가 영영 세지지 않는다. 과대가 아니라 **과소**였다.
  //   [실측] 푸른마을포스코더샵2차(전용 76~117㎡): 혼합 4회 ↔ 평형별 18회.
  //   판정은 utils/scoreBands 한 곳에만 둔다.
  const countNewHigh = countNewHighByArea;
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
        rawNames: [...a.rawNames],
        // 최빈 지번 본번 — MERGE-GUARD 가 개명 단지를 필지로 확인할 때 쓴다.
        jibunBon: (() => {
          const e = Object.entries(a.bonCnt).sort((x, y) => y[1] - x[1])[0];
          return e ? e[0] : null;
        })(),
        build_year: mode ? Number(mode) : null,
        households: null,
        master_matched: false,
        new_high_count: countNewHigh(a.deals), // Phase 8
        // POOL-COVERAGE-2026-08-17: n·new_high_count 가 **어떤 표본에서 나온 값인지**를 값과 함께
        //   들고 다닌다. 잘린 풀에서 나온 수치를 "최근 6개월" 이라고 적으면 그게 곧 거짓 서술이다.
        _poolTruncated: poolTruncated,
        _poolFrom: poolFromDate,
      };
    });

  // 점수 계산 (KAPT 호출 전 1차 점수: priority + 가구상황 + 예산fit + 거래량 + 행정구위계)
  for (const c of pool) {
    const s = computeAptScore(c, ctx);
    c.score = s.total;
    c.scoreBreakdown = s.breakdown;
    // 1차 행정구위계 점수도 미리 부여 — 강남/마용성광이 외곽보다 1차에서 우선
    const district = getDistrictTier(c.sigungu, c.lawd_cd);
    if (district.bonus) {
      c.scoreBreakdown['객관_행정구위계'] = district.bonus;
      c.score += district.bonus;
    }
  }
  pool.sort((a, b) => b.score - a.score);

  // TRUST-GATE (Sprint LLLLLL, 운영자 제보 '서울숲한성' DB 실측): 6개월 거래 1건 단지는 평균가 자체가
  //   무의미(표본 1)하고, MOLIT 신고 오타 이형(행당동 '서울숲한성' 1건 — 정식 표기 '서울숲 한신 더 휴' 85건)이
  //   별도 단지처럼 보고서에 오르는 유일한 채널.
  //   LLLLLL-2: **무조건 배제** — 배포 검증에서 '후보 부족 시 완화'가 게이트를 무력화(성동 후보 4개 → 1건짜리
  //   복귀) 실측. 표본 1은 어떤 경우에도 부적격 — 0건이면 기존 인접 구 확장/빈 결과 안내가 정직한 처리.
  pool = pool.filter(a => a.n >= 2);

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
  let out = pool.slice(0, Math.min(limit * 3, 20)); // LLLLLL: HH-GATE 재할당 위해 let

  // Phase 6+ (2026-04-26): KAPT API 통합 — 선정된 N개 단지만 facility 병렬 fetch
  //   resolveFacility() 가 ILIKE 토큰 매칭 + KAPT API + DB 캐시 (90일) 다 처리.
  //   첫 호출: API 호출 → DB 저장 (응답 +5~10초). 두 번째: cache hit (0초).
  await Promise.all(out.map(async (c) => {
    try {
      const f = await resolveFacility({ aptName: c.apt_name, sigungu: c.sigungu, umdNm: c.umd_nm });
      // MERGE-GUARD (Sprint LLLLLL, '서울숲한성' 오병합 실측): resolveFacility 의 관대 매칭(ILIKE·토큰)이
      //   오타 이형 이름에 유사 단지('서울숲한신더휴' 1,410세대)를 붙여 "그럴듯한 틀린 정보"가 되던 것 차단.
      //   정규화+접미(아파트/단지/고·저층) 제거 후 포함관계일 때만 채택 — 정당 케이스('왕십리삼성'⊂
      //   '왕십리삼성아파트', '답십리 서울한양'⊂'답십리동서울한양')는 유지, 판정 불가면 미채택(정보 없음 > 틀린 정보).
      if (f?.raw) {
        const _nrm = (s) => String(s || '').normalize('NFC').replace(/\s/g, '').toLowerCase()
          .replace(/\((?:고층|저층)\)$/, '').replace(/(?:아파트|단지)$/, '');
        const _a = _nrm(c.apt_name);
        const _b = _nrm(f.official || f.raw.kaptName || '');
        // MERGE-GUARD-JIBUN-2026-08-30 (Sprint OOOOOOO): **개명 단지가 이 가드에 막힌다.**
        //   [실측] MOLIT 신고명 "동탄파크자이" ↔ KAPT 신규명 "동탄역자이 아파트" — 포함관계가 아니라
        //   facility 가 통째로 미채택돼 주소·시공사가 카드에서 사라졌다(라이브 재생성으로 확인).
        //   이름이 달라도 **같은 필지면 같은 단지**다. `verifyCandidate` 도 지번 일치를 'jibun-match'
        //   강한 긍정 신호로 이미 쓰고 있으므로(aptFacilityService), 같은 근거를 여기서도 인정한다.
        //   지번은 MOLIT 실거래(최빈 본번) ↔ KAPT kaptAddr 를 비교한다 — 둘 다 공식 출처다.
        let _jibunOk = false;
        try {
          const { jibunFromKaptAddr, bonbun } = require('../services/aptFacilityService');
          const kBon = bonbun(jibunFromKaptAddr(f.raw.kaptAddr));
          if (kBon && c.jibunBon && kBon === c.jibunBon) _jibunOk = true;
        } catch (_) { /* 판정 불가면 기존 이름 가드만 적용 */ }
        if (_a && _b && !_jibunOk && !(_a.includes(_b) || _b.includes(_a))) {
          logger.info({ apt: c.apt_name, official: f.official || f.raw.kaptName }, 'MERGE-GUARD: 이름 불일치 — facility 미채택');
          return;
        }
        if (_jibunOk && _a && _b && !(_a.includes(_b) || _b.includes(_a))) {
          logger.info({ apt: c.apt_name, official: f.official || f.raw.kaptName, bon: c.jibunBon },
            'MERGE-GUARD: 이름은 다르나 지번 일치 — 개명으로 보고 채택');
        }
      }
      if (f?.raw) {
        const raw = f.raw;
        const detail = f.detail || {};
        // HH-HOCNT-FALLBACK-2026-07-14 (Sprint IIIII): kaptdaCnt 가 0("0" 문자열 포함)인 단지는 hoCnt(호수) fallback.
        c.households = [raw.kaptdaCnt, raw.hoCnt, raw.householdCount, raw.kaptCount]
          .map(v => parseInt(v)).find(n => Number.isFinite(n) && n > 0) || null;
        // HH-CONFLICT-2026-08-17 (Sprint MMMMMMM): 위 fallback 이 고른 값이 신뢰 가능한지 함께 기록.
        //   세대수 자체는 그대로 쓰되(표시는 사실), 세대당 주차로 **점수를 주는 것**만 막는다.
        c.householdsConflict = householdsConflictOf(raw.kaptdaCnt, raw.hoCnt);
        // build_year 우선순위 #1: KAPT 공식 사용승인일
        const useDate = raw.kaptUsedate || raw.kaptUseDate || raw.useApprovalDate;
        if (useDate) {
          const ys = String(useDate).slice(0, 4);
          if (/^\d{4}$/.test(ys)) c.build_year = Number(ys);
        }
        c.master_matched = true;
        c.master_name = f.official; // 정식 단지명 (예: '답십리동서울한양')
        // NAME-ADDR-2026-08-30: 주소는 KAPT 공식값 그대로. 카드에 실어 사용자가 찾아갈 수 있게 한다.
        c.road_address = raw.doroJuso || null;
        c.jibun_address = raw.kaptAddr || null;
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

  // LLLLLL-3 (운영자 제보 'YM프라젠 83세대 소형이 세대수 null 로 노출'): KAPT 세대수 못 찾은 후보를
  //   건축물대장(getBuildingTitle, SSSS 연동·building_register 캐시)으로 보강 → 카드 세대수 표시 +
  //   아래 HH-GATE 가 100세대 미만을 정확히 제외. top out(~20) bounded, graceful(실패 시 기존 null 유지).
  try {
    const { getBuildingTitle } = require('../services/buildingRegisterService');
    await Promise.all(out.map(async (c) => {
      if (Number.isFinite(c.households) && c.households > 0) return;
      try {
        const t = await getBuildingTitle({ lawdCd: c.lawd_cd, sigungu: c.sigungu, umdNm: c.umd_nm, aptName: c.apt_name });
        if (t && Number.isFinite(t.hhldCnt) && t.hhldCnt > 0) {
          c.households = t.hhldCnt;
          if (!c.build_year && t.useAprDay && /^\d{4}/.test(t.useAprDay)) c.build_year = Number(t.useAprDay.slice(0, 4));
          c.br_source = true;
        }
      } catch (_) { /* graceful */ }
    }));
  } catch (_) { /* 서비스 로드 실패 시 기존 동작 */ }

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
    // FANOUT-CAP-2026-08-28 (Plan 032): 콜드 캐시일 때 out(최대 20) × Kakao 6콜 = 최대 120 동시 호출이
    //   나갔다. 이 저장소의 다른 외부 API 팬아웃은 전부 동시성을 명시 제한한다(molitIngest 3, 지오코딩 4~8).
    //   getNearbyAmenities 내부 캐시(3일)가 있어 캐시가 더운 경우엔 체감 변화가 없다 — 콜드 버스트만 막는다.
    const AMENITY_CONCURRENCY = 4;
    for (let i = 0; i < out.length; i += AMENITY_CONCURRENCY) {
      await Promise.all(out.slice(i, i + AMENITY_CONCURRENCY).map(async (c) => {
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
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Phase 8 좌표/amenities 일괄 처리 실패 — 객관 점수만으로 진행');
  }

  // JEONSE-2026-07-14 (Sprint KKKKK): 후보별 전세가율 — 무료 MOLIT 전월세 실거래(getJeonseByApt).
  //   ⚠ 후보별 개별 호출은 같은 구 후보 7개가 월별 캐시(rent:{lawd}:{ym}) 미스를 "동시에" 때려
  //   MOLIT 콜이 7배 증폭(in-flight dedup 없음) → lawd 당 1회(getJeonseByApt(lawd, '') = 전체 목록)만
  //   조회하고 단지명 필터는 여기서 수행. 콜드 시 구당 정확히 6콜(월별), 이후 24h 캐시.
  //   분석탭(analysisService)과 동일 소스·동일 표본 임계(getJeonseReliability NONE: <4건 → 비노출).
  //   회원님 평형대(±5㎡) 전세만 스코프 — 매매 avgPrice(같은 평형대)와 비교 정합.
  //   절대룰: 수치 나열만(전세가율 %·표본수). 판단·전망·갭투자 서술 없음.
  try {
    const { getJeonseByApt } = require('../services/rentService');
    const _lawds = [...new Set(out.map(c => c.lawd_cd).filter(Boolean))];
    const _rentByLawd = new Map();
    await Promise.all(_lawds.map(async (l) => {
      try { _rentByLawd.set(l, await getJeonseByApt(l, '')); } // query '' → 전체 목록 (includes('') 항상 true)
      catch (_) { _rentByLawd.set(l, []); }
    }));
    for (const c of out) {
      if (!c.lawd_cd || !(c.avgPrice > 0)) continue;
      const all = _rentByLawd.get(c.lawd_cd) || [];
      const q = String(c.apt_name || '').replace(/\s/g, '');
      if (!q) continue;
      const areas = Array.isArray(c.areas) ? c.areas : [...(c.areas || [])];
      // JEONSE-SCOPE-FIX-2026-07-15 (Sprint KKKKK-3, 라이브 '동신 9%' 실측 발각):
      //   ① 순수 전세(monthlyRent=0)만 — 소액보증금 월세가 환산돼도 중위를 심하게 끌어내림(9% 왜곡).
      //     라벨 '전세 N건'과도 정합. ② 2글자 이하 단지명은 정확 일치만 — '동신' includes 가
      //     '당현천동신' 등 다른 단지 전세를 흡수하는 오병합 차단(KAPT-LOOKUP 短이름 가드와 동일 원칙).
      const scoped = all.filter(t =>
        t.monthlyRent === 0 &&
        (q.length >= 3 ? t.aptName.replace(/\s/g, '').includes(q) : t.aptName.replace(/\s/g, '') === q) &&
        areas.some(a => Math.abs((t.excluUseAr || 0) - a) <= 5));
      if (scoped.length < 4) continue; // 표본 부족 — 분석탭 jeonseReliability NONE 관례와 동일
      const deps = scoped.map(t => t._convertedDeposit || t.deposit || 0).filter(d => d > 0).sort((a, b) => a - b);
      if (deps.length < 4) continue;
      const med = deps[Math.floor(deps.length / 2)];
      // PRICE-BASIS-2026-08-30: 분모도 표시 가격과 같은 기준이어야 한다 — 밴드로 잘린 평균을
      //   분모로 쓰면 전세가율이 실제와 어긋난다(분자 전세는 밴드와 무관하므로 한쪽만 잘린 비율이 된다).
      const _basis = (c.avgPriceFull > 0) ? c.avgPriceFull : c.avgPrice;
      const ratio = Math.round((med / _basis) * 100);
      if (ratio <= 0 || ratio > 130) continue; // 명백한 데이터 오류(면적 오매칭 등) 방어
      c.jeonse = { medianDeposit: med, n: deps.length, ratio };
    }
  } catch (e) {
    logger.warn({ err: e.message }, '전세가율 일괄 계산 실패 — 비노출로 진행');
  }

  // ══ PRICE-BASIS-2026-08-30 (Sprint OOOOOOO, 운영자 "실거래가에도 안 맞고 평형대도 다 이상하다") ══
  //
  // [무엇이 틀렸나 — PDF 실물 대조로 확정] 보고서가 적는 "평형대 평균"이 실제 시세가 아니었다.
  //   원인 두 겹:
  //   (a) 후보 풀 쿼리가 `deal_amount BETWEEN buy*0.7 AND buy*1.2` 로 **개별 거래**를 자른다.
  //       그 잘린 부분집합의 평균을 "평균"이라고 적고 있었다.
  //       [동탄 9억 실측] 호반베르디움센트럴포레 실제 6.53억(96건) → 보고서 6.99억(51건, +0.46억)
  //                      동탄 더샵 레이크에듀타운 실제 10.12억(66건) → 보고서 9.69억(52건, -0.43억)
  //                      호수공원역 센트럴시티     실제 9.57억(56건) → 보고서 9.15억(45건, -0.42억)
  //       ⚠ 방향이 일정하지 않아 **단지 간 비교까지 왜곡**된다. 예산을 바꾸면 같은 단지의
  //         "평균 시세"가 따라 움직인다 — 시세는 사용자의 예산과 무관해야 한다.
  //   (b) 표시 면적은 `areas[0]`(= 후보 면적 중 **최솟값**)인데 가격은 **전 평형 통합 평균**이었다.
  //       [동탄파크자이 실측] 라벨 "28평(93㎡)" · 표기 8.38억 — 그런데 93㎡ 실제 평균은 7.93억이고
  //       8.38억은 93·100·103㎡ 를 섞은 값이다. 라벨과 가격이 **서로 다른 모집단**을 가리켰다.
  //
  // [고치는 방법] 최종 후보에 대해 **가격 밴드 없이** 같은 지역·같은 평형구간·같은 기간을 다시 조회해
  //   면적(㎡ 반올림)별 통계를 만들고, **거래가 가장 많은 면적**을 대표 평형으로 삼는다.
  //   표시 가격은 그 평형만의 평균이다 — 라벨과 가격이 같은 모집단이 된다.
  //   후보 **선별**에는 기존 밴드를 그대로 둔다(예산과 동떨어진 단지를 띄우지 않기 위함) —
  //   바뀌는 것은 "무엇을 보여주는가" 뿐이다.
  //   ⚠ PostgREST 는 1000행에서 조용히 잘린다(레포 6회 재발) → range 페이징 + 2차 정렬키.
  try {
    const _names = [...new Set(out.flatMap(c => (c.rawNames && c.rawNames.length) ? c.rawNames : [c.apt_name]))];
    if (_names.length) {
      const _PAGE = 1000;
      const _rows = [];
      for (let from = 0; from <= 9000; from += _PAGE) {
        let qq = admin.from('molit_transactions')
          // PEAK-FLOOR-2026-08-31: 층을 함께 받는다 — 같은 평형이어도 층에 따라 값이 갈린다.
          .select('apt_name, sigungu, umd_nm, exclu_use_ar, deal_amount, deal_date, floor')
          .in('apt_name', _names)
          .gte('exclu_use_ar', minSqm).lte('exclu_use_ar', maxSqm)
          .gte('deal_date', _sinceDate);
        if (_regionOp) qq = _regionOp(qq);
        const { data: page, error } = await qq.order('deal_date', { ascending: false }).order('id', { ascending: false })
          .range(from, from + _PAGE - 1);
        if (error) throw error;
        if (page && page.length) _rows.push(...page);
        if (!page || page.length < _PAGE) break;
      }
      // 후보 키(별칭 반영) → 면적별 버킷
      const _byKey = new Map();
      for (const t of _rows) {
        const canon = _aliasMap.get(`${t.apt_name}|${t.umd_nm}`) || t.apt_name;
        const k = `${canon}|${t.sigungu}|${t.umd_nm}`;
        if (!_byKey.has(k)) _byKey.set(k, new Map());
        const bySqm = _byKey.get(k);
        const sq = Math.round(t.exclu_use_ar);
        if (!bySqm.has(sq)) bySqm.set(sq, []);
        bySqm.get(sq).push({ p: Number(t.deal_amount) || 0, f: Number(t.floor) || null });
      }
      for (const c of out) {
        const bySqm = _byKey.get(`${c.apt_name}|${c.sigungu}|${c.umd_nm}`);
        if (!bySqm || !bySqm.size) continue;
        const stats = [...bySqm.entries()].map(([sqm, recs]) => {
          const arr = recs.map(r2 => r2.p);
          const sorted = [...arr].sort((x, y) => x - y);
          // PEAK-FLOOR-2026-08-31: 층별 가격대 — 참고 컨설팅 보고서의 'RR(로열동로열층)' 판단 근거.
          //   ⚠ 표본이 얇으면 만들지 않는다. 층 3구간에 각 2건 미만이면 숫자가 사례 하나에 끌려간다.
          const withF = recs.filter(r2 => Number.isFinite(r2.f));
          let floorBands = null;
          if (withF.length >= 6) {
            const fs2 = withF.map(r2 => r2.f).sort((x, y) => x - y);
            const lo = fs2[Math.floor(fs2.length / 3)];
            const hi = fs2[Math.floor((fs2.length * 2) / 3)];
            const med = (a3) => { if (!a3.length) return null; const t2 = [...a3].sort((x, y) => x - y); return t2[Math.floor(t2.length / 2)]; };
            const band = (pick) => { const g = withF.filter(pick); return g.length >= 2 ? { n: g.length, median: med(g.map(r2 => r2.p)) } : null; };
            const b1 = band(r2 => r2.f <= lo), b2 = band(r2 => r2.f > lo && r2.f <= hi), b3 = band(r2 => r2.f > hi);
            if (b1 && b3) floorBands = { low: Object.assign({ upTo: lo }, b1), mid: b2, high: Object.assign({ from: hi }, b3) };
          }
          return {
            sqm: Number(sqm), n: arr.length,
            avg: arr.reduce((a2, b2) => a2 + b2, 0) / arr.length,
            min: sorted[0], max: sorted[sorted.length - 1],
            median: sorted[Math.floor(sorted.length / 2)],
            floorBands,
          };
        // 대표 평형 = 거래가 가장 많은 면적. 동수면 큰 면적을 택한다(같은 값이면 결정적으로).
        }).sort((a2, b2) => (b2.n - a2.n) || (b2.sqm - a2.sqm));
        c.areaStats = stats;
        c.primaryArea = stats[0];
        c.avgPriceFull = stats[0].avg;      // 대표 평형의 6개월 평균 (밴드 미적용)
        c.priceSampleFull = stats[0].n;
        c.areaTotalN = stats.reduce((a2, b2) => a2 + b2.n, 0);
        // 최근 6개월 최고가(대표 평형) — 참고 보고서의 '전고점' 에 대응하되 **기간을 명시**한다.
        //   ⚠ 우리 DB 는 2025-05 부터라 '역대 전고점' 이라고 부를 수 없다. 부르지 않는다.
        c.peak6m = stats[0].max;
        c.floorBands = stats[0].floorBands || null;
      }
      logger.info({ names: _names.length, rows: _rows.length, withStats: out.filter(c => c.primaryArea).length },
        '보고서 대표평형 재집계 (예산밴드 미적용)');
    }
  } catch (e) {
    // 실패해도 기존 값으로 보고서는 나간다 — 다만 그 사실을 남긴다(조용한 열화 금지).
    logger.warn({ err: e.message }, '보고서 대표평형 재집계 실패 — 예산밴드 기준 값으로 표시됨');
  }

  // Phase 7 + 8 + 9: KAPT + amenities 호출 후 객관 점수 + objectiveFacts 적용
  // REG-4TH-COPY-2026-08-16 (Plan 027): 규제 판정을 프론트와 **같은 근거**(스냅샷)로 맞춘다.
  //   여기서 1회만 읽어 루프에 넘긴다(후보마다 조회하면 N번 왕복).
  //   조회 실패 시 true(규제) — 보수적 폴백. 프론트 `_regLtvLabel` 의 미로드 동작과 같은 방향이다.
  let _seoulRegulated = true;
  try {
    const _snap = await getSnapshot('housing_loan_2025').catch(() => null);
    const _seoul = _snap?.data?.regulatedRegions?.seoul;
    if (_snap && _snap.data) _seoulRegulated = !!_seoul; // 스냅샷을 읽은 경우에만 반영
  } catch (_) { /* 보수적 기본값 유지 */ }
  for (const c of out) {
    applyObjectiveScore(c, _seoulRegulated);
  }
  // HH-GATE (Sprint LLLLLL, 운영자 지시 "100세대 미만은 가능하면 추천하지 말 것"):
  //   세대수 확인된 소형(<100)만 제외 — 미확인(null)은 유지(이름 매칭 실패한 실제 대단지 오배제 방지).
  //   LLLLLL-3.1: 세대수는 이제 건축물대장으로 대부분 채워짐 → **1개라도 남으면 소형 전부 제외**
  //   (전부 소형일 때만 유지 = 빈 결과 방지). 기존 '>=limit' 은 너무 느슨해 소형 잔존(실측)했음.
  {
    const _big = out.filter(c => !(Number.isFinite(c.households) && c.households < 100));
    if (_big.length >= 1 && _big.length !== out.length) {
      logger.info({ before: out.length, after: _big.length }, 'HH-GATE: 100세대 미만 제외');
      out = _big;
    }
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

/** AI prompt 빌드 — 사용자 입력 + 정책 + 단지 정보 + 점수 breakdown + 객관 fact (Phase 7)
 *  Sprint JJJJJ: freeCtx(이미 무료로 확보한 ECOS 금리·KOSIS 미분양·실거래 최신월) + 정책 LTV/DSR 실수치 주입. */
function buildReportPrompt(input, policy, candidates, freeCtx) {
  const fc = _freeContextLines(policy || {}, freeCtx || {});
  const _freeBlock = [
    fc.ltv ? `- LTV 한도(정부 공시 스냅샷): ${fc.ltv}` : null,
    fc.dsr ? `- DSR 규제: ${fc.dsr}` : null,
    fc.rate ? `- 시중 금리(실측): ${fc.rate}` : null,
    fc.unsold ? `- 대상 지역 미분양 추이(실측): ${fc.unsold}` : null,
    fc.txTrend ? `- 대상 지역 매매 거래량 추이(실측): ${fc.txTrend}` : null,
    fc.agePrice ? `- 대상 지역 준공연차별 평당가(실측): ${fc.agePrice}` : null,
    fc.tx ? `- 실거래 데이터 기준: ${fc.tx}` : null,
  ].filter(Boolean).join('\n');
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
      // POOL-COVERAGE-2026-08-17: 신고가 갱신 횟수도 후보 풀 안에서 센 값이다 — 기간을 정확히 적는다.
      facts.new_high_count > 0 ? `${poolSpanLabel(c)} 신고가 ${facts.new_high_count}회 갱신` : null,
      facts.jeonse_ratio ? `전세가율: ${facts.jeonse_ratio} (회원님 평형대 전세 ${facts.jeonse_sample}건 기준)` : null, // Sprint KKKKK
      amStr,
    ].filter(Boolean).join(' | ');
    return `${i + 1}. ${displayName} (${c.sigungu} ${c.umd_nm})
   - 준공: ${c.build_year || '미상'}년 / 세대수: ${householdsStr}
   - 회원님 평형대 (${c.areas.map(a => `${a}㎡(${Math.round(a / 3.3058)}평)`).join(', ')}) 만 노출됨
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
${_freeBlock ? `\n## 실측 수치 (전부 공식 출처 — 아래 수치만 인용 가능, 임의 변형·추정 금지)\n${_freeBlock}` : ''}

## 단지 정보 (${candidates.length}개 후보, ${poolSpanLabel(candidates[0])} 실거래 기반)
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

[실측 수치 활용 — Sprint JJJJJ]
- 위 '실측 수치' 블록(LTV·DSR·금리·미분양·실거래 기준월)이 있으면 checklist/coreMessages 의 근거로 인용할 것
  (예: checklist {"text":"대출한도 — 생애최초 규제지역 LTV 70%","stars":3} / {"text":"금리 — 시중 주담대 4.32% 기준 상환액 확인","stars":3})
- 그 블록에 없는 수치(LTV·DSR·금리·미분양 값)는 절대 임의로 쓰지 말 것. 블록이 없으면 해당 수치 언급 자체를 생략.
- 미분양·거래량 수치는 나열만. "미분양이 늘어 가격이 …" "거래가 줄어 …" 같은 인과·전망 서술 절대 금지.
- 전세가율은 객관 fact 에 있을 때만 그 값 그대로 인용 (예: "전세가율 62%, 전세 8건 기준"). 갭투자·역전세 예측 서술 금지 — 전세 표본이 적으면 그 사실만 언급.

[환각 차단 절대 규칙]
- 입력 데이터에 없는 거리(km, 도보 분), 지형(평지·경사), 정확한 역명·노선 번호, 재개발 일정 임의 추정 X
- 입력 데이터의 amenities 카운트 (지하철 N개, 마트 N개 등) 만 인용 가능
- 시공사/세대수가 입력에 없으면 "미상" 표기 (임의 보강 X)
- 회원님 평형대 평균이 단지 전체 평균이 아님 — 모든 평균 표기에 "회원님 평형대" 명시

JSON만 반환. 다른 텍스트 X.`;
}

// REPORT-DRYRUN-2026-08-30 (Sprint OOOOOOO): 보고서의 **단지 선별 단계만** 따로 부를 수 있게 export.
//   전 지역이 보고서를 낼 수 있는지 확인하려면 119곳을 돌려봐야 하는데, /generate 는 매 건 유료
//   AI 를 호출한다. 후보가 0이면 그 자리에서 404 가 나므로 **결함은 이 단계에서 전부 드러난다** —
//   유료 호출 없이 전수 확인이 가능하다. router 동작은 그대로다(export 추가뿐).
module.exports = router;
module.exports.fetchCandidateApts = fetchCandidateApts;
// TEST-EXPORT-2026-09-02 (감사 P0-2): 회귀 주입 실측 결과 이 함수의 null 가드가 **무커버리지**였다
//   (가드를 지우고 테스트를 돌렸더니 136 pass 로 그냥 통과했다). 순수 함수라 export 해서 실제 실행으로 고정한다.
module.exports.applyObjectiveScore = applyObjectiveScore;
