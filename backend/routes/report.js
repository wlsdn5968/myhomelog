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

/** 점수 계산 — priority + 가구상황 + 예산 fit + 데이터 품질 */
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

  // 4) 데이터 품질
  if (c.households) { r.data_households = 5; total += 5; }
  if (c.build_year) { r.data_build_year = 5; total += 5; }

  // 5) 거래량 (기본 점수)
  r.transactions = c.n;
  total += c.n;

  return { total: Math.round(total), breakdown: r };
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

  // Phase 6: 광역 검색 시 후보 풀 확장 (1500건 → 단지 다양성 확보)
  const { data: txs, error } = await q.limit(1500);
  if (error) throw error;

  // 단지 그룹화 + build_year mode (최빈값) 산출
  const byApt = {};
  for (const t of (txs || [])) {
    const key = `${t.apt_name}|${t.sigungu}|${t.umd_nm}`;
    if (!byApt[key]) byApt[key] = {
      apt_name: t.apt_name, sigungu: t.sigungu, umd_nm: t.umd_nm,
      lawd_cd: t.lawd_cd,
      sum: 0, n: 0, areas: new Set(), latest: t.deal_date,
      buildYearCnt: {},
    };
    byApt[key].sum += t.deal_amount;
    byApt[key].n++;
    byApt[key].areas.add(Math.round(t.exclu_use_ar));
    if (t.deal_date > byApt[key].latest) byApt[key].latest = t.deal_date;
    if (t.build_year) {
      byApt[key].buildYearCnt[t.build_year] = (byApt[key].buildYearCnt[t.build_year] || 0) + 1;
    }
  }

  let pool = Object.values(byApt)
    .filter(a => a.n >= 1)
    .map(a => {
      // build_year 우선순위 #2: molit 거래 최빈값
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
      };
    });

  // 점수 계산 (master 매칭 전, 거래 데이터 기반 1차 점수)
  // → 다양성 강제 후 상위 N개만 facility 호출 (API 호출 비용 절감)
  for (const c of pool) {
    const s = computeAptScore(c, ctx);
    c.score = s.total;
    c.scoreBreakdown = s.breakdown;
  }
  pool.sort((a, b) => b.score - a.score);

  // 다양성 강제 (한 sigungu 최대 3개) — 상위 limit 개 선정
  const out = [];
  const guCnt = {};
  for (const c of pool) {
    if (out.length >= limit) break;
    const cnt = guCnt[c.sigungu] || 0;
    if (cnt >= 3) continue;
    guCnt[c.sigungu] = cnt + 1;
    out.push(c);
  }

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

  // 데이터 품질 보너스 재계산 (households/build_year 채워졌으면 +5씩)
  for (const c of out) {
    if (c.households && !c.scoreBreakdown.data_households) {
      c.scoreBreakdown.data_households = 5;
      c.score += 5;
    }
    if (c.build_year && !c.scoreBreakdown.data_build_year) {
      c.scoreBreakdown.data_build_year = 5;
      c.score += 5;
    }
  }

  // 진단 로그 — 운영자가 매칭 추적
  logger.info({
    region, priority: ctx.priority, pool_size: pool.length,
    selected: out.map(c => ({
      name: c.apt_name, sigungu: c.sigungu, score: c.score,
      n: c.n, master_matched: c.master_matched,
    })),
  }, '보고서 후보 매칭 (Phase 6)');

  return out;
}

/** AI prompt 빌드 — 사용자 입력 + 정책 + 단지 정보 + 점수 breakdown */
function buildReportPrompt(input, policy, candidates) {
  const aptList = candidates.map((c, i) => {
    const householdsStr = (c.households && Number.isFinite(c.households)) ? `${c.households}세대` : '미상';
    const displayName = c.master_name || c.apt_name; // 정식 단지명 우선 (예: '휘경주공1단지')
    const breakdownStr = Object.entries(c.scoreBreakdown || {})
      .map(([k, v]) => `${k}=${v}`).join(', ');
    return `${i + 1}. ${displayName} (${c.sigungu} ${c.umd_nm})
   - 준공: ${c.build_year || '미상'}년
   - 세대수: ${householdsStr}
   - 평형: ${c.areas.map(a => `${a}㎡(${Math.round(a / 3.3)}평)`).join(', ')}
   - 최근 6개월 평균가: ${(c.avgPrice / 10000).toFixed(2)}억원 (${c.n}건 거래)
   - 최근 거래일: ${c.latest}
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
   ★ 응답 길이 절약: location/pros/cons/recommendation/matchReason 각각 60자 이내, ratio 30자 이내 (응답 토큰 부족시 잘림 방지)
4. longTermView — 자녀 시점 기반 갈아타기 시나리오 (가격 수치 X, 권역만)
5. tips — 실무 TIP 5~6개 (회전율·RR·복비·잔금·임장)

JSON만 반환. 다른 텍스트 X.`;
}

module.exports = router;
