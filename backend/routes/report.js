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

    // 4) AI 호출 — REPORT_SYSTEM_PROMPT 를 system 으로 명시 전달 (default chat system 이 평문 답변 강제하는 문제 회피)
    //    max_tokens 4500 — 2500 으로는 7단지 풀 정보 시 JSON 잘림 (실측: 3815자에서 array 미닫힘)
    //    frontend timeout 120s 와 페어링 (Claude Sonnet 4.5 + 4500 토큰 ≒ 40~70s)
    const result = await callAI(
      [{ role: 'user', content: prompt }],
      false,
      { userId, system: REPORT_SYSTEM_PROMPT, maxTokens: 4500 }
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

/** 추천 단지 후보 fetch — molit + apt_master 통합 */
async function fetchCandidateApts(admin, input, limit) {
  const buy = parseFloat(input.maxBudget) || 0;
  const region = String(input.region || '').trim();
  const pyeong = String(input.pyeong || '').trim();

  // 평형 범위 (예: '중형 23~33평' → sqm 76~109)
  let minSqm = 0, maxSqm = 999;
  if (pyeong.includes('소형')) { minSqm = 50; maxSqm = 75; }
  else if (pyeong.includes('중형')) { minSqm = 76; maxSqm = 109; }
  else if (pyeong.includes('대형')) { minSqm = 110; maxSqm = 200; }

  // 가격 범위 — 예산 -30% ~ +20% (사용자 피드백: 2~3억 초과는 부담)
  // Phase 5+ (2026-04-26): maxAmt 1.30 → 1.20 (9억 예산 기준 10.8억까지만 후보)
  const minAmt = Math.round(buy * 0.7 * 10000);
  const maxAmt = Math.round(buy * 1.2 * 10000);

  // 지역 필터 — sigungu 기반 (region이 sigungu 직접 또는 광역시일 수 있음)
  let q = admin.from('molit_transactions')
    .select('apt_name, sigungu, umd_nm, lawd_cd, build_year, exclu_use_ar, deal_amount, deal_date, apt_seq')
    .gte('exclu_use_ar', minSqm).lte('exclu_use_ar', maxSqm)
    .gte('deal_amount', minAmt).lte('deal_amount', maxAmt)
    .gte('deal_date', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

  // 지역 매칭 — 시/구 단위 우선 (예: "서울 노원구" → sigungu LIKE '%노원구%')
  // Phase 5+ (2026-04-26): 이전엔 광역만 보고 lawd_cd '11%' 매칭해서 노원구 요청에도
  // 중구/동대문구 같은 거래 활발 지역이 우선 매칭되던 버그 수정.
  const guMatch = region.match(/([가-힣]+구)/);
  if (guMatch) {
    q = q.like('sigungu', `%${guMatch[1]}%`);
  } else if (region.includes('서울')) {
    q = q.like('lawd_cd', '11%');
  } else if (region.includes('경기')) {
    q = q.like('lawd_cd', '41%');
  } else if (region.includes('인천')) {
    q = q.like('lawd_cd', '28%');
  }

  const { data: txs, error } = await q.limit(500);
  if (error) throw error;

  // apt_seq 기준 그룹 (단지별 평균가·거래수)
  const byApt = {};
  for (const t of (txs || [])) {
    const key = `${t.apt_name}|${t.sigungu}|${t.umd_nm}`;
    if (!byApt[key]) byApt[key] = {
      apt_name: t.apt_name, sigungu: t.sigungu, umd_nm: t.umd_nm,
      lawd_cd: t.lawd_cd, build_year: t.build_year,
      sum: 0, n: 0, areas: new Set(), latest: t.deal_date,
    };
    byApt[key].sum += t.deal_amount;
    byApt[key].n++;
    byApt[key].areas.add(Math.round(t.exclu_use_ar));
    if (t.deal_date > byApt[key].latest) byApt[key].latest = t.deal_date;
  }

  // 거래 활발 순 정렬 + 상위 N
  const ranked = Object.values(byApt)
    .filter(a => a.n >= 1)
    .map(a => ({
      ...a,
      avgPrice: a.sum / a.n,
      areas: [...a.areas].sort((x, y) => x - y),
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);

  // apt_master 풍부화 (가능한 경우)
  if (ranked.length) {
    const names = ranked.map(r => r.apt_name);
    const { data: masters } = await admin
      .from('apt_master')
      .select('apt_name, sigungu, umd_nm, kapt_code, facility')
      .in('apt_name', names);
    const masterMap = new Map();
    for (const m of (masters || [])) {
      masterMap.set(`${m.apt_name}|${m.sigungu}|${m.umd_nm}`, m);
    }
    for (const r of ranked) {
      const m = masterMap.get(`${r.apt_name}|${r.sigungu}|${r.umd_nm}`);
      if (m?.facility) {
        r.households = m.facility.kaptdaCnt || m.facility.householdCount || null;
      }
    }
  }

  return ranked;
}

/** AI prompt 빌드 — 사용자 입력 + 정책 + 단지 정보 */
function buildReportPrompt(input, policy, candidates) {
  const aptList = candidates.map((c, i) => {
    const householdsStr = (c.households && Number.isFinite(c.households)) ? `${c.households}세대` : '미상';
    return `${i + 1}. ${c.apt_name} (${c.sigungu} ${c.umd_nm})
   - 준공: ${c.build_year || '미상'}년
   - 세대수: ${householdsStr}
   - 평형: ${c.areas.map(a => `${a}㎡(${Math.round(a / 3.3)}평)`).join(', ')}
   - 최근 6개월 평균가: ${(c.avgPrice / 10000).toFixed(2)}억원 (${c.n}건 거래)
   - 최근 거래일: ${c.latest}`;
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
3. apartments — 위 후보 단지 그대로 (rank·name·areaSqm·areaPyeong·buildYear·households·ratio·location·pros·cons·priceFit·recommendation)
   - name 형식: "단지명 (시군구 동)" — 예: "한양아파트 (노원구 상계동)" — 동명 누락 금지 (사용자 식별용)
   - households: 입력 데이터의 세대수 그대로 사용. "미상"이면 "미상"으로 표기 (NaN/null 금지)
   - priceFit: "매수가 ${input.maxBudget}억 vs 단지 평균 X억 (X% 초과/일치/여유)" — 단순 비교만
   - recommendation: "검토 권장" 또는 "예산 초과 — 다른 단지 비교 권장" — 매수 추천 X
4. longTermView — 자녀 시점 기반 갈아타기 시나리오 (가격 수치 X, 권역만)
5. tips — 실무 TIP 5~6개 (회전율·RR·복비·잔금·임장)

JSON만 반환. 다른 텍스트 X.`;
}

module.exports = router;
