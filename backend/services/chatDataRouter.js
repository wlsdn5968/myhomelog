/**
 * 데이터 도우미 룰베이스 라우터 — CHAT-ZERO-COST-2026-08-12 (Sprint KKKKKKK-16, 운영자 A안 승인)
 *
 * [왜 존재하나]
 *   종전 챗은 모든 메시지를 Anthropic 유료 호출로 보냈다(폴백 0). 운영자 방침 "비용 0원 영구 보장"
 *   에 따라 LLM 호출을 **구조적으로 제거**하고, 질문 의도를 규칙으로 분류해 **이미 보유한 공식
 *   데이터**(국토부 실거래 DB · 한국은행 ECOS · HF 공시 · 규제 스냅샷 · 인기 스냅샷)로 답한다.
 *   부수 효과: 환각 0 (모든 응답이 데이터 조회 결과 — 절대 룰 '환각 차단'과 정합).
 *
 * [설계 원칙]
 *   - classifyIntent 는 순수 함수 → 테스트로 고정. route 는 데이터 조회 포함 async.
 *   - 응답은 plain text(+개행) — 프론트 addMsg 가 _escHtml 처리하므로 HTML 금지.
 *   - 매수·매도 추천/가격 예측 표현 금지(절대 룰 ①) — 데이터 나열 + 출처 표기만.
 *   - 분류 실패는 정직하게 "가능한 질문" 안내 (아는 척 금지 — 환각 차단).
 *   - 모든 외부/DB 실패는 개별 삼킴 → 해당 데이터 줄만 생략(부분 응답 > 전체 실패).
 */
const { getSupabaseAdmin } = require('../db/client');
const logger = require('../logger');

// ── 의도 분류 (순수 함수 — characterization 테스트 고정 대상) ─────────────────
// 순서 중요: 구체적 의도(특약·금리·정책자금·규제·한도·인기·전세)를 먼저, 시세(광범위)는 뒤에.
const INTENT_RULES = [
  { intent: 'greeting',   re: /^(안녕하세요|안녕|하이|헬로|반가워요?|반갑습니다|고마워요?|고맙습니다|감사합니다|감사해요|감사|ㅎㅇ|hi|hello)[!~\s.^^]*$/i },
  // WATCH-2026-08-12 (KKKKKKK-20 제안 B): 관심단지 — popular 보다 앞(같이 등장 시 관심단지 우선)
  { intent: 'watch',      re: /관심\s*단지|북마크|즐겨찾기|찜(한|해\s*둔|해둔)?\s*(단지|아파트|곳)/ },
  { intent: 'clause',     re: /특약|계약서|가계약|등기부|전세\s*사기|임대차.*(조항|문구)/ },
  { intent: 'policyLoan', re: /디딤돌|보금자리|신생아\s*특례|신혼.*대출|정책\s*자금|특례\s*대출/ },
  { intent: 'rates',      re: /금리|이자율|기준\s*금리/ },
  { intent: 'regulation', re: /규제|조정\s*대상|투기\s*과열|토지\s*거래\s*허가|토허/ },
  { intent: 'loanLimit',  re: /대출|한도|DSR|LTV|얼마.*빌릴/i },
  { intent: 'popular',    re: /인기\s*단지|인기\s*아파트|거래\s*많은|요즘\s*(핫|뜨는|인기)/ },
  { intent: 'jeonse',     re: /전세가율|갭\s*투자|갭이|전세/ },
  { intent: 'market',     re: /시세|실거래|매매가|평당가|가격|얼마/ },
  { intent: 'howto',      re: /사용법|사용방법|도움말|어떻게\s*(써|사용|해)|무슨\s*기능|뭘\s*할\s*수/ },
  // 추천 요청은 전용 정책 응답 — 절대 룰 ①(매수·매도 추천 금지)을 정중히 안내 + 대안 제시.
  //   구체 의도(인기 단지 추천해줘 → popular)가 전부 위에서 먼저 잡히므로 순수 추천 요청만 남는다.
  { intent: 'recommendAsk', re: /추천/ },
];

// 시세 질의에서 단지명 후보 추출 시 걷어낼 조사·상투어.
// ⚠ '아파트'는 여기 넣지 않는다 — "신동아아파트1" 처럼 이름 중간에 낀 경우를 훼손한다.
//   대신 아래 _stripAptSuffix 가 **끝에 붙은** "아파트(단지)"만 제거(search.js SEARCH-SUFFIX 와 동일 규칙:
//   MOLIT 은 "은마"로 저장하는데 사용자는 "은마아파트"로 묻는 비대칭 해소, 제거 후 2자 미만이면 원본 유지).
const MARKET_STOPWORDS = /(시세|실거래가?|매매가|평당가|가격|얼마(예요|에요|야|인가요|임|죠|지)?|알려\s*줘요?|알려주세요|어때(요)?|궁금해?요?|보여\s*줘요?|좀|요즘|최근|근처|주변)\s*/g;
function _stripAptSuffix(q) {
  const s = String(q || '').replace(/\s*아파트(?:단지)?$/, '').trim();
  return s.length >= 2 ? s : String(q || '').trim();
}

// 인기 질의에서 지역 토큰 추출용 상투어 ("공덕 인기단지" → "공덕")
const POPULAR_STOPWORDS = /(인기|단지|아파트|거래|많은|많이|요즘|핫한|뜨는|알려\s*줘요?|알려주세요|어디(예요|야)?|보여\s*줘요?|좀|추천해?\s*줘요?|top\s*\d*)\s*/gi;

function classifyIntent(message) {
  const m = String(message || '').trim();
  if (!m) return { intent: 'fallback' };
  for (const r of INTENT_RULES) {
    if (r.re.test(m)) {
      if (r.intent === 'popular') {
        // REGION-POPULAR-2026-08-12 (운영자 요청 "공덕 인기단지·노원구 인기단지 되게"):
        //   상투어를 걷어낸 잔여 토큰을 지역 후보로 — 실제 판정은 데이터(sigungu/umd_nm 매칭)가 한다.
        const q = m.replace(POPULAR_STOPWORDS, ' ').replace(/[?!.~,]/g, ' ').replace(/\s+/g, ' ').trim();
        return { intent: 'popular', query: q.length >= 2 ? q : null };
      }
      if (r.intent === 'market' || r.intent === 'jeonse') {
        let q = m.replace(MARKET_STOPWORDS, ' ').replace(/[?!.~,]/g, ' ').replace(/\s+/g, ' ').trim();
        q = _stripAptSuffix(q);
        return { intent: r.intent, query: q.length >= 2 ? q : null };
      }
      return { intent: r.intent };
    }
  }
  // 의도어가 전혀 없어도 2~20자 단문이면 단지명 단독 입력으로 간주("은마", "헬리오시티").
  //   ⚠ 동사 어미로 끝나는 문장은 제외 — 라이브 실채팅에서 "오늘 저녁 메뉴 추천해줘"가 단지명으로
  //   오인돼 어색한 응답이 나왔다. 어미는 **끝 위치만** 본다("해모로"류 단지명 훼손 방지).
  if (/^[가-힣A-Za-z0-9\s()]{2,20}$/.test(m) && !/[?]/.test(m)
      && !/(줘|줄래|주세요|해요|할까요|하세요|인가요|일까요|나요|세요|습니다|어요|게요|네요|죠|해봐|해봐요)$/.test(m)) {
    return { intent: 'market', query: _stripAptSuffix(m) };
  }
  return { intent: 'fallback' };
}

// ── 포맷 헬퍼 ────────────────────────────────────────────────────────────────
const eok = (manwon) => {
  const v = Number(manwon) / 10000;
  if (!Number.isFinite(v)) return '?';
  return (v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '') + '억';
};
const mmdd = (d) => { const s = String(d || ''); return s.length >= 10 ? `${s.slice(5, 7)}.${s.slice(8, 10)}` : s; };

const DISCLAIMER = '\n\n※ 공식 데이터 정리이며 매수·매도 추천이 아니에요.';
const EXAMPLES = '예를 들어 이렇게 물어보실 수 있어요:\n· "은마 시세" · "오늘 금리" · "동탄 규제"\n· "5억 대출 한도" · "요즘 인기 단지" · "디딤돌 조건"';

// ── 인텐트별 핸들러 ──────────────────────────────────────────────────────────
async function _market(query, context) {
  let q = query;
  // 단지명이 없으면 현재 상세 보고 있는 단지로 (질문 의도 추론 — "여기 시세 어때?")
  if (!q && context && context.session && context.session.focusProperty
      && typeof context.session.focusProperty.aptName === 'string') {
    q = context.session.focusProperty.aptName.slice(0, 40);
  }
  if (!q) return { text: `어느 단지가 궁금하세요? 단지명이나 동네 이름을 함께 적어주세요.`, suggestions: ['은마 시세', '공덕 시세', '노원구 시세'] };
  // REGION-MARKET-2026-08-12 (KKKKKKK-18): 지역(구·동) 토큰이면 지역 요약 우선 — "공덕 시세"는
  //   단지가 아니라 동네 질문이다. 단지명("은마" 등)은 sigungu/umd 에 없어 여기서 자연히 걸러지고
  //   기존 단지 경로로 폴백한다(회귀 없음 — 라이브 재검증으로 확인).
  const regionAns = await _regionMarket(q);
  if (regionAns) return regionAns;
  const admin = getSupabaseAdmin();
  if (!admin) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
  const since = new Date(); since.setMonth(since.getMonth() - 6);
  const _safeQ = q.replace(/[%_]/g, '');

  // MARKET-SAMPLE-2026-08-17 (Sprint MMMMMMM-13): **단지 선택**과 **통계 계산**을 분리한다.
  //
  //   [종전 결함 — 실측] 이름 부분일치 전체를 `.limit(400)` 최신순으로 한 번에 긁어 그 안에서
  //     그룹핑했다. 6개월 매칭 행수는 "자이" 6,117건(289그룹) · "푸르지오" 7,057건(351그룹) —
  //     400행은 **6.5%** 다. 그래서 ① 어느 단지를 고를지가 "최근 며칠" 표본으로 결정되고
  //     ② 고른 단지의 "거래 N건 · 단순평균"이 그 잘린 조각에서 계산됐다.
  //     화면은 "최근 6개월"이라고 적는데 실제로는 아니었다.
  //     ⚠ "은마"는 233건이라 상한에 닿은 적이 없다 — 라이브 점검에서 이 결함이 안 보인 이유다.
  //
  //   [Fix] ① 후보 단지는 검색용 MV(`molit_apt_index`, 단지 단위 집계 22,473행)에서 고른다.
  //           search.js 와 같은 소스다. 등급(정확>접두>부분)별로 따로 조회해 **낮은 등급의
  //           대량 매칭이 높은 등급을 밀어내지 못하게** 한다(실측 상한: 접두 최대 134행·부분 359행,
  //           '아파트' 같은 무의미 질의만 1,282행).
  //         ② 통계는 **고른 단지 하나**의 6개월 거래만 조회해 계산한다. 단지 하나의 6개월 거래는
  //           실측 최대 **209건**이고 400건 초과 단지는 **0곳**이라 상한에 닿지 않는다.
  //
  //   ⚠ MV 의 deal_count 는 **전 기간** 누적이다(정의에 날짜 필터 없음). 그래서 후보 **순위**에만
  //     쓰고, 사용자에게 보여주는 건수·평균은 아래 6개월 조회 결과로만 만든다. 두 기준을 섞지 않는다.
  const _mvSel = 'apt_name, lawd_cd, sigungu, umd_nm, build_year, deal_count';
  const _mv = () => admin.from('molit_apt_index').select(_mvSel);
  const [exactRes, prefixRes, substrRes] = await Promise.all([
    _mv().eq('apt_name', _safeQ).limit(50),
    _mv().ilike('apt_name', `${_safeQ}%`).order('deal_count', { ascending: false }).limit(200),
    _mv().ilike('apt_name', `%${_safeQ}%`).order('deal_count', { ascending: false }).limit(500),
  ]);
  if (exactRes.error && prefixRes.error && substrRes.error) {
    return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
  }

  // NAME-RANK-2026-08-12 (라이브 실채팅에서 발각): 건수만으로 정렬하면 부분문자열 오매칭이
  //   1위를 먹는다 — 실사고: "은마"(강남)가 "동탄시범**다은마**을…"에 밀렸다.
  //   **이름 정확일치 > 접두 일치 > 부분 포함** 순으로 먼저 가르고, 같은 등급 안에서만 건수순.
  const _tier = (name) => name === _safeQ ? 3 : String(name || '').startsWith(_safeQ) ? 2 : 1;
  // ⚠ 세 결과는 서로 포함관계(정확 ⊂ 접두 ⊂ 부분)라 같은 MV 행이 여러 번 온다.
  //   MV 행 고유키로 먼저 걸러내지 않으면 deal_count 가 2~3배로 부풀어 순위가 뒤집힌다.
  const seenRow = new Set();
  const cand = new Map();   // "이름|시군구" → { aptName, sigungu, dealCount, tier }
  for (const r of [...(exactRes.data || []), ...(prefixRes.data || []), ...(substrRes.data || [])]) {
    if (!r || !r.apt_name) continue;
    const rowKey = `${r.apt_name}|${r.lawd_cd}|${r.sigungu}|${r.umd_nm}|${r.build_year}`;
    if (seenRow.has(rowKey)) continue;
    seenRow.add(rowKey);
    // (단지, 시군구) 그룹핑 — 동명 단지 분리 (문자열 지역 판정 아님: 표시 그룹핑 용도만).
    //   종전과 같은 그룹 키를 유지한다 — 여기서 바꾸면 화면에 보이는 묶음이 달라진다(별개 결정).
    const k = `${r.apt_name}|${r.sigungu || ''}`;
    const cur = cand.get(k);
    if (cur) cur.dealCount += (r.deal_count || 0);
    else cand.set(k, { aptName: r.apt_name, sigungu: r.sigungu || '', dealCount: r.deal_count || 0, tier: _tier(r.apt_name) });
  }
  const ranked = [...cand.values()].sort((a, b) => b.tier !== a.tier ? b.tier - a.tier : b.dealCount - a.dealCount);
  if (!ranked.length) {
    return `"${q}" 이름이 들어간 단지를 국토부 실거래 데이터에서 찾지 못했어요.\n` +
      `· 단지명을 조금 다르게(공백·차수 없이) 적어보시거나\n· 상단 검색창 자동완성으로 정확한 이름을 확인해 보세요.`;
  }

  // 상위 후보부터 6개월 거래를 조회 — 전 기간 순위 1위가 최근 6개월엔 거래가 없을 수 있다.
  const TX_CAP = 400;   // 단지 하나 기준 실측 최대 209건(400 초과 0곳). 닿으면 아래에서 사실대로 밝힌다.
  let picked = null, txs = null;
  for (const c of ranked.slice(0, 3)) {
    let tq = admin.from('molit_transactions')
      .select('apt_name, sigungu, umd_nm, deal_amount, deal_date, exclu_use_ar')
      .eq('apt_name', c.aptName)
      .gte('deal_date', since.toISOString().slice(0, 10));
    tq = c.sigungu ? tq.eq('sigungu', c.sigungu) : tq.is('sigungu', null);
    const { data, error } = await tq.order('deal_date', { ascending: false }).limit(TX_CAP);
    if (error) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
    if (data && data.length) { picked = c; txs = data; break; }
  }
  if (!picked) {
    const names = ranked.slice(0, 3).map(c => `${c.aptName}${c.sigungu ? `(${c.sigungu})` : ''}`).join(' · ');
    return `"${q}" 로 찾은 단지(${names})는 최근 6개월 국토부 실거래가 없어요.\n` +
      `· 상단 검색창에서 단지명을 검색하면 더 이전 거래까지 볼 수 있어요.`;
  }

  const aptName = picked.aptName, sigungu = picked.sigungu;
  const avg = txs.reduce((s, t) => s + Number(t.deal_amount || 0), 0) / txs.length;
  const recent = txs.slice(0, 3)
    .map(t => `· ${mmdd(t.deal_date)} · 전용 ${Number(t.exclu_use_ar || 0).toFixed(0)}㎡ · ${eok(t.deal_amount)}`)
    .join('\n');
  let out = `📊 ${aptName} (${sigungu}${txs[0].umd_nm ? ' ' + txs[0].umd_nm : ''}) — 최근 6개월 국토부 실거래\n` +
    `${recent}\n거래 ${txs.length}건 · 단순평균 ${eok(avg)}`;
  // 실측상 닿지 않는 상한이지만, 닿았다면 그 사실을 숨기지 않는다(조용한 절단 재발 방지).
  if (txs.length >= TX_CAP) out += `\n(최신 ${TX_CAP}건까지만 집계한 값이에요)`;
  if (ranked.length > 1) {
    // ⚠ 여기 건수를 붙이지 않는다 — MV 의 deal_count 는 전 기간이라 위의 6개월 건수와 기준이 다르다.
    //   같은 줄에 두 기준의 숫자가 나란히 놓이면 사용자가 비교 가능한 값으로 읽는다.
    const others = ranked.slice(1, 3).map(c => `${c.aptName}(${c.sigungu || '지역미상'})`).join(' · ');
    out += `\n\n같은 이름의 다른 단지도 있어요: ${others}\n지역명을 함께 적어주시면 좁혀드려요.`;
  }
  out += `\n\n🔍 전세가율·연식·학군 등 상세는 상단 검색창에서 "${aptName}" 을 검색해 보세요.`;
  // 후속 질문 칩 — 그 단지의 동네로 시야 확장 + 동명 단지 바로가기 (KKKKKKK-19)
  const sug = [];
  if (sigungu) sug.push(`${sigungu} 인기단지`);
  if (sorted.length > 1) sug.push(`${sorted[1][0].split('|')[0]} 시세`);
  return { text: out + DISCLAIMER, suggestions: sug };
}

async function _rates() {
  const lines = [];
  try {
    const e = await require('./ecosService').getEcosRates();
    if (e && e.baseRate != null) lines.push(`· 한국은행 기준금리: ${e.baseRate}% (${String(e.baseRateDate || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')})`);
    if (e && e.mortgageRate != null) lines.push(`· 주담대 가중평균(신규취급): ${e.mortgageRate}% (${String(e.mortgageRateMonth || '').replace(/(\d{4})(\d{2})/, '$1.$2')}월, ECOS)`);
  } catch (_) { /* 줄 생략 */ }
  try {
    const h = await require('./hfService').getHfRates();
    if (h && h.didimdol) lines.push(`· 디딤돌: ${h.didimdol.min}~${h.didimdol.max}% (HF ${String(h.didimdol.applyDy || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')} 공시)`);
    if (h && h.bogeum) lines.push(`· 보금자리론: ${h.bogeum.min}~${h.bogeum.max}%`);
  } catch (_) { /* 줄 생략 */ }
  if (!lines.length) {
    return '지금 금리 공시 조회가 잠시 어려워요 😥 잠시 후 다시 물어봐 주시거나, 대출 탭의 정책자금 비교표를 확인해 주세요.';
  }
  return `💰 오늘의 금리 (공식 공시 기준)\n${lines.join('\n')}\n\n개인 조건(소득·만기·우대)에 따라 실제 금리는 달라요 — 🧮 대출 탭에서 내 조건으로 계산해 보세요.`;
}

async function _policyLoan() {
  // 요건 수치는 서비스 대출 탭 비교표와 동일(정부 공시 검증본) — 금리만 HF 라이브로 갱신
  let rateLine = '';
  try {
    const h = await require('./hfService').getHfRates();
    if (h && (h.didimdol || h.bogeum)) {
      const p = [];
      if (h.didimdol) p.push(`디딤돌 ${h.didimdol.min}~${h.didimdol.max}%`);
      if (h.bogeum) p.push(`보금자리론 ${h.bogeum.min}~${h.bogeum.max}%`);
      rateLine = `\n오늘 공시 금리: ${p.join(' · ')} (HF)`;
    }
  } catch (_) { /* 생략 */ }
  return { text: '🏦 정책자금 4종 핵심 요건 (주택도시기금·HF 공시)\n' +
    '· 디딤돌: 부부합산 소득 6~7천만↓ · 집값 5억↓ · 한도 2~2.4억\n' +
    '· 신혼 디딤돌: 소득 8.5천만↓ · 집값 6억↓ · 한도 3.2억\n' +
    '· 신생아 특례: 소득 1.3억↓ · 집값 9억↓ · 한도 4억\n' +
    '· 보금자리론: 소득 7천만↓ · 집값 6억↓ · 한도 3.6~4.2억' + rateLine +
    '\n\n자격·서류 요건은 별도예요 — 주택도시기금(nhuf.molit.go.kr) · 1599-0001 에서 확정 확인.\n🧮 대출 탭에 4종 비교표와 내 조건 계산기가 있어요.',
    // KKKKKKK-20 제안 C: 정책자금 관심자도 보고서 퍼널 진입점
    suggestions: [{ label: '📊 내 조건 맞춤 보고서 만들기', view: 'report' }, '오늘 금리 알려줘'] };
}

async function _regulation(message) {
  let kw = null, seoulAll = false, sample = [];
  try {
    const { keywords, seoulRegulated } = await require('./regulationsService').getRegulatedKeywords();
    seoulAll = !!seoulRegulated;
    const list = [...(keywords || [])];
    sample = list.filter(k => k.length >= 2).slice(0, 8);
    kw = list.find(k => k.length >= 2 && message.includes(k)) || null;
  } catch (_) { /* snapshot 실패 → 일반 안내 */ }
  const basis = '(2025.10.15 대책 + 2026.6.30 확대 기준)';
  if (kw) {
    return `📍 "${kw}" — 현행 규제지역 목록에 있는 지역이에요 ${basis}\n` +
      '· 투기과열지구·조정대상지역 — LTV 40%(무주택 기준)·대출한도 제한·전입 의무 등 적용\n' +
      '· 상세 항목별 내용은 📋 규제요약 버튼(아래)에서 표로 볼 수 있어요.' + DISCLAIMER;
  }
  if (/서울/.test(message) && seoulAll) {
    return `📍 서울은 전 지역이 규제지역이에요 ${basis} — LTV 40%(무주택 기준)·한도 제한 적용.\n상세는 📋 규제요약 버튼에서 확인하세요.` + DISCLAIMER;
  }
  let out = `📋 현행 규제지역 ${basis}\n`;
  if (seoulAll) out += '· 서울: 전 지역\n';
  if (sample.length) out += `· 수도권 일부: ${sample.join(' · ')} 등\n`;
  out += '\n특정 지역이 궁금하면 지역명을 함께 적어주세요 (예: "동탄 규제 맞아?").\n' +
    '목록에 없는 지역이 곧 비규제라는 뜻은 아니니, 계약 전 반드시 공식 공고를 확인하세요.\n상세 표는 📋 규제요약 버튼에 있어요.';
  return out;
}

function _loanLimit(message) {
  const m = String(message).match(/(\d+(?:\.\d+)?)\s*억/);
  const price = m ? parseFloat(m[1]) : null;
  let out = '🧮 주택담보대출 한도의 큰 틀 (무주택 기준)\n' +
    '· 비규제지역: LTV 70%\n· 규제지역: LTV 40% + 한도 제한\n' +
    '· 여기에 스트레스 DSR(수도권 +3.0%p 가산 심사)로 소득 대비 한도가 다시 줄어요.\n';
  if (price) {
    const nonReg = (price * 0.7), reg = (price * 0.4);
    out = `🧮 매수가 ${price}억 기준, LTV 만 보면 (무주택)\n` +
      `· 비규제지역: 최대 약 ${nonReg.toFixed(1).replace(/\.0$/, '')}억 (70%)\n` +
      `· 규제지역: 최대 약 ${reg.toFixed(1).replace(/\.0$/, '')}억 (40%)\n` +
      '· 실제 한도는 소득 기반 스트레스 DSR 심사로 이보다 줄 수 있어요.\n';
  }
  out += '\n연소득까지 넣은 정밀 계산은 🧮 대출 탭 계산기에서 바로 돼요 (생애최초·정책자금 분기 포함).\n' +
    '⚠ 참고용 계산이며 실제 한도는 금융기관 심사로 확정돼요.';
  // KKKKKKK-20 제안 C: 한도 질문자는 보고서 퍼널의 최적 진입점 — 이동형 칩(view) 동봉
  return { text: out, suggestions: [
    { label: '📊 내 조건 맞춤 보고서 만들기', view: 'report' },
    '디딤돌 조건 알려줘',
  ] };
}

async function _popular(regionQuery) {
  // 지역 토큰이 있으면 지역 스코프 집계 (REGION-POPULAR-2026-08-12, 운영자 요청)
  if (regionQuery) {
    const scoped = await _regionPopular(regionQuery);
    if (scoped) return scoped;
    // 지역 해석 실패 → 전국 TOP 으로 자연 폴백하되 그 사실을 정직하게 앞에 밝힘
    const nation = await _popularNationwide();
    return `"${regionQuery}" 지역의 최근 60일 실거래를 찾지 못했어요 — 구·동 이름(예: "노원구 인기단지", "공덕 인기단지")으로 물어봐 주세요.\n\n대신 전국 기준으로 보여드려요:\n\n${nation}`;
  }
  return _popularNationwide();
}

async function _popularNationwide() {
  try {
    const snap = await require('./popularService').readPopularSnapshot(5);
    if (snap && snap.length) {
      const rows = snap.map((p, i) =>
        `${i + 1}. ${p.aptName} (${p.sigungu}) — 최근 60일 ${p.dealCount60d}건 · 평균 ${eok(p.avgDealAmount)}`).join('\n');
      return `🔥 지금 인기 단지 TOP 5 (최근 60일 국토부 실거래 많은 순 · 최근 21일 거래 단지 우선 · 지역 쏠림 완화)\n${rows}\n\n지도 탭에서 위치와 함께 전체 12곳을 볼 수 있어요.` + DISCLAIMER;
    }
  } catch (_) { /* 아래 안내 */ }
  return '인기 단지 집계를 지금 불러오지 못했어요 — 지도 탭에서 숫자 라벨(인기 단지)로 확인할 수 있어요.';
}

// lawd_cd 앞 2자리 → 시도명 (routes/region.js SIDO_BY_PREFIX 와 동일 값 — 코드 기반 판정, 이름 판정 아님)
const SIDO_BY_PREFIX = { 11: '서울', 26: '부산', 27: '대구', 28: '인천', 29: '광주', 30: '대전',
  31: '울산', 36: '세종', 41: '경기', 42: '강원', 51: '강원', 43: '충북', 44: '충남',
  45: '전북', 46: '전남', 47: '경북', 48: '경남', 50: '제주' };
const SIDO_NAME_TO_PREFIX = { '서울': '11', '부산': '26', '대구': '27', '인천': '28', '대전': '30',
  '울산': '31', '세종': '36', '경기': '41', '충북': '43' };

/**
 * 공용 지역 해석기 — 최근 60일 실거래를 (구 이름 우선 → 동 이름 폴백)으로 스캔.
 * REGION-SHARED-2026-08-12 (Sprint KKKKKKK-18): 인기·시세 두 인텐트가 같은 검증된 경로를 쓴다.
 * [실측 근거 2026-08-12] "노원"→sigungu 노원구 948건 / "공덕"→umd 공덕동(마포) 10건 /
 *   "중구"→6개 시도 산재(대전283·울산240·대구218·서울95·부산16·인천1) — 동명 시군구는 반드시
 *   되묻는다(region-judgment-by-lawdcd 원칙: 판정은 lawd_cd 로, 이름은 표시용).
 * @returns {Promise<null | {ambiguousSidos: string[], token: string} | {rows, scopeLabel}>}
 */
async function _resolveRegionRows(regionQuery) {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  // "서울 중구" 처럼 광역 접두가 오면 분리 — 접두는 lawd_cd prefix 필터로만 쓴다
  let r = regionQuery.trim(), sidoPfx = null;
  const mSido = r.match(/^(서울|부산|대구|인천|대전|울산|세종|경기|충북)\s+(.+)$/);
  if (mSido) { sidoPfx = SIDO_NAME_TO_PREFIX[mSido[1]]; r = mSido[2].trim(); }
  const safe = r.replace(/[%_]/g, '');
  if (safe.length < 2) return null;
  const since = new Date(); since.setDate(since.getDate() - 60);
  const sinceStr = since.toISOString().slice(0, 10);

  // 페이지 루프 (PostgREST 1000행 캡 — 실측 최대 구가 60일 ~1천 건대라 3페이지면 충분, 도달 시 로그)
  const fetchBy = async (col) => {
    const out = []; const PAGE = 1000;
    for (let from = 0; from < 3000; from += PAGE) {
      const { data, error } = await admin.from('molit_transactions')
        .select('apt_name, sigungu, umd_nm, lawd_cd, deal_amount')
        .ilike(col, `${safe}%`).gte('deal_date', sinceStr)
        .order('deal_date', { ascending: false }).order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error || !data || !data.length) break;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    if (out.length >= 3000) logger.warn({ source: 'chat-region-resolve', col, region: safe }, '지역 스캔 3천행 캡 도달 — 집계가 최신 구간으로 절단됨');
    return out;
  };

  // ① 구 이름 우선 → ② 동 이름 폴백 (실측: "공덕"은 sigungu 에 없고 umd 공덕동에만 있다)
  let rows = await fetchBy('sigungu');
  if (rows.length) {
    // 동명 시군구 검사 — 시도 prefix 가 2개 이상이면 단정하지 않고 되묻는다
    const sidos = [...new Set(rows.map(t => String(t.lawd_cd || '').slice(0, 2)))];
    if (!sidoPfx && sidos.length > 1) {
      return { ambiguousSidos: sidos.map(p => SIDO_BY_PREFIX[p]).filter(Boolean), token: r };
    }
    const filtered = sidoPfx ? rows.filter(t => String(t.lawd_cd || '').startsWith(sidoPfx)) : rows;
    if (!filtered.length) return null;
    const scopeLabel = `${SIDO_BY_PREFIX[String(filtered[0].lawd_cd || '').slice(0, 2)] || ''} ${filtered[0].sigungu}`.trim();
    return { rows: filtered, scopeLabel };
  }
  rows = await fetchBy('umd_nm');
  if (!rows.length) return null;
  if (sidoPfx) rows = rows.filter(t => String(t.lawd_cd || '').startsWith(sidoPfx));
  if (!rows.length) return null;
  const umds = [...new Set(rows.map(t => `${t.sigungu} ${t.umd_nm}`))];
  const scopeLabel = umds.length === 1 ? umds[0]
    : `'${safe}…' 동 일대 (${umds.slice(0, 3).join(' · ')}${umds.length > 3 ? ' 외' : ''})`;
  return { rows, scopeLabel };
}

/** (단지,구,동) 그룹 상위 N — 지역 응답 공용 */
function _topGroups(rows, n) {
  const groups = new Map();
  for (const t of rows) {
    const k = `${t.apt_name}|${t.sigungu || ''}|${t.umd_nm || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, n);
}
const _groupLines = (top) => top.map(([k, v], i) => {
  const [name, , umd] = k.split('|');
  const avg = v.reduce((s, t) => s + Number(t.deal_amount || 0), 0) / v.length;
  return `${i + 1}. ${name}${umd ? ` (${umd})` : ''} — ${v.length}건 · 평균 ${eok(avg)}`;
}).join('\n');

async function _regionPopular(regionQuery) {
  const res = await _resolveRegionRows(regionQuery);
  if (!res) return null;
  if (res.ambiguousSidos) {
    // 되묻기도 칩으로 — 시도별 선택지를 눌러서 바로 확정 (KKKKKKK-19)
    return {
      text: `"${res.token}" 는 여러 지역에 있어요 (${res.ambiguousSidos.join('·')}) — 아래에서 눌러 고르시거나 광역시·도를 함께 적어주세요.`,
      suggestions: res.ambiguousSidos.slice(0, 3).map(s => `${s} ${res.token} 인기단지`),
    };
  }
  const top = _topGroups(res.rows, 5);
  const top1 = top[0][0].split('|')[0];
  return {
    text: `🔥 ${res.scopeLabel} 최근 60일 거래 많은 단지 TOP ${top.length} (국토부 실거래 ${res.rows.length}건 기준)\n${_groupLines(top)}` + DISCLAIMER,
    suggestions: [`${top1} 시세`, `${regionQuery} 시세`],
  };
}

/**
 * 지역 시세 요약 — REGION-MARKET-2026-08-12 (Sprint KKKKKKK-18, 운영자 "검색 자체가 더 많이"):
 * "공덕 시세"·"노원구 시세"처럼 지역 단위 시세 질문에 60일 요약(건수·평균·범위·상위 단지)으로 답한다.
 */
async function _regionMarket(regionQuery) {
  const res = await _resolveRegionRows(regionQuery);
  if (!res) return null;
  if (res.ambiguousSidos) {
    return {
      text: `"${res.token}" 는 여러 지역에 있어요 (${res.ambiguousSidos.join('·')}) — 아래에서 눌러 고르시거나 광역시·도를 함께 적어주세요.`,
      suggestions: res.ambiguousSidos.slice(0, 3).map(s => `${s} ${res.token} 시세`),
    };
  }
  const amounts = res.rows.map(t => Number(t.deal_amount || 0)).filter(v => v > 0);
  if (!amounts.length) return null;
  const avg = amounts.reduce((s, v) => s + v, 0) / amounts.length;
  const min = Math.min(...amounts), max = Math.max(...amounts);
  const top = _topGroups(res.rows, 3);
  const top1 = top[0][0].split('|')[0];
  return {
    text: `📊 ${res.scopeLabel} 최근 60일 실거래 요약 (국토부 ${res.rows.length}건)\n` +
      `· 단순평균 ${eok(avg)} · 거래 범위 ${eok(min)} ~ ${eok(max)} (평형·연식 섞인 전체 범위예요)\n\n` +
      `거래 많은 단지:\n${_groupLines(top)}` + DISCLAIMER,
    suggestions: [`${top1} 시세`, `${regionQuery} 인기단지`],
  };
}

function _jeonseGuide(query) {
  let out = '🏷 전세가율·갭은 단지별 실거래(매매+전세)로 계산해 보여드려요.\n' +
    '· 상단 검색창에서 단지 검색 → 단지 상세에 전세가율·갭 표시\n' +
    '· 전세 실거래는 국토부 신고 기준(무료 공개 데이터)이에요.';
  if (query) out += `\n\n"${query}" 는 검색창에 그대로 입력하면 상세에서 확인할 수 있어요.`;
  return out;
}

function _clauseGuide() {
  return '✍ 특약 초안은 법령 인용 표준 템플릿으로 무료 제공돼요 — 아래 "✍ 특약초안" 버튼을 눌러보세요.\n' +
    '전세사기 예방 기본 3종(등기부 확인 · 보증금 반환 특약 · 전입+확정일자)도 템플릿에 들어 있어요.\n' +
    '⚠ 법률 자문이 아니며, 중요 계약은 전문가 검토를 권해요.';
}

function _howto() {
  return '이렇게 쓰실 수 있어요 👇\n' +
    '· 지도 탭: 인기 단지·실거래 마커 탐색\n' +
    '· 목록 탭: "내 상황" 입력 → 조건에 맞는 단지 정리\n' +
    '· 보고서 탭: 3가지만 입력하면 30초 만에 1page 맞춤 보고서\n' +
    '· 대출 탭: 규제 반영 한도 계산 + 정책자금 4종 비교\n' +
    '· 여기(도우미): "은마 시세" · "오늘 금리" 처럼 물어보면 공식 데이터로 바로 답해드려요.';
}

function _greeting() {
  return `안녕하세요 👋 국토부 실거래·한국은행 금리 같은 공식 데이터로 바로 답해드리는 데이터 도우미예요.\n\n${EXAMPLES}`;
}

/**
 * 관심단지 최근 거래 요약 — KKKKKKK-20 제안 B. 프론트가 context.session.bookmarks 로 보낸
 * 단지명(클라이언트 제공 — 문자열·개수·길이만 신뢰)을 하나씩 60일 실거래로 대조.
 * 이름은 자체 데이터 출신이라 eq(정확일치) 우선, 없으면 접두 ilike 폴백. 없으면 없다고 말한다.
 */
async function _watch(context) {
  const raw = context && context.session && context.session.bookmarks;
  const names = Array.isArray(raw)
    ? raw.filter(s => typeof s === 'string' && s.trim().length >= 2).slice(0, 4).map(s => s.trim().slice(0, 40))
    : [];
  if (!names.length) {
    return { text: '아직 담아둔 관심단지가 없어요 ⭐\n단지 상세에서 별(⭐) 버튼으로 담아두면, 여기서 "관심단지 소식"이라고 물었을 때 최근 거래를 한 번에 모아 보여드려요.',
      suggestions: ['노원구 인기단지', '은마 시세'] };
  }
  const admin = getSupabaseAdmin();
  if (!admin) return '지금 조회가 잠시 어려워요. 잠시 후 다시 시도해주세요.';
  const since = new Date(); since.setDate(since.getDate() - 60);
  const sinceStr = since.toISOString().slice(0, 10);
  const lines = [];
  for (const n of names) {
    const safe = n.replace(/[%_]/g, '');
    let { data } = await admin.from('molit_transactions').select('deal_amount, deal_date')
      .eq('apt_name', safe).gte('deal_date', sinceStr)
      .order('deal_date', { ascending: false }).limit(100);
    if (!data || !data.length) {
      ({ data } = await admin.from('molit_transactions').select('deal_amount, deal_date')
        .ilike('apt_name', `${safe}%`).gte('deal_date', sinceStr)
        .order('deal_date', { ascending: false }).limit(100));
    }
    if (data && data.length) {
      const avg = data.reduce((s, t) => s + Number(t.deal_amount || 0), 0) / data.length;
      lines.push(`· ${n} — ${data.length}건 · 평균 ${eok(avg)} · 최근 ${mmdd(data[0].deal_date)}`);
    } else {
      lines.push(`· ${n} — 최근 60일 신고 거래 없음`);
    }
  }
  return {
    text: `⭐ 관심단지 최근 60일 거래 요약 (국토부 신고 기준)\n${lines.join('\n')}\n\n새 거래 배지는 관심단지 목록(⭐ 버튼)에서도 확인할 수 있어요.` + DISCLAIMER,
    suggestions: [`${names[0]} 시세`],
  };
}

function _recommendAsk() {
  return '매수·매도 추천은 정책상 하지 않아요 🙏 (정보 정리 도구예요)\n\n대신 이렇게 도와드릴 수 있어요:\n' +
    '· 조건에 맞는 단지 정리: 목록 탭 → "내 상황" 입력 → 조건 검색\n' +
    '· 특정 단지 데이터: "○○ 시세" 라고 물어보세요\n' +
    '· 요즘 거래 많은 곳: "인기 단지" 라고 물어보세요\n\n판단에 필요한 공식 데이터를 정리해드리는 게 제 역할이에요.';
}

function _fallback() {
  return `그 질문은 제가 가진 공식 데이터로는 정확히 답하기 어려워요 😅\n\n${EXAMPLES}\n\n매물 추천·가격 전망은 정책상 다루지 않아요 (정보 정리 도구).`;
}

// ── 진입점 ───────────────────────────────────────────────────────────────────
// SUGGEST-2026-08-12 (Sprint KKKKKKK-19, 운영자 "예시로 어디까지 되는지 알게"): 모든 응답에
//   문맥 맞는 후속 질문(탭 칩)을 동봉한다. 핸들러가 {text, suggestions} 를 주면 그것을,
//   문자열만 주면 인텐트별 기본값을 쓴다. 칩 문구는 전부 실제로 라우팅되는 질문이어야 한다
//   (누르면 즉시 전송되므로 — 죽은 예시 금지).
const DEFAULT_SUG = {
  greeting:   ['은마 시세', '노원구 인기단지', '오늘 금리'],
  clause:     ['동탄 규제 맞아?', '5억이면 대출 얼마까지 돼?'],
  policyLoan: ['오늘 금리 알려줘', '5억이면 대출 얼마까지 돼?'],
  rates:      ['디딤돌 조건 알려줘', '5억이면 대출 얼마까지 돼?'],
  regulation: ['5억이면 대출 얼마까지 돼?', '노원구 인기단지'],
  loanLimit:  ['디딤돌 조건 알려줘', '동탄 규제 맞아?'],
  jeonse:     ['은마 시세', '공덕 시세'],
  popular:    ['은마 시세', '공덕 시세'],
  market:     ['노원구 인기단지', '오늘 금리'],
  howto:      ['은마 시세', '노원구 인기단지', '오늘 금리'],
  recommendAsk: ['노원구 인기단지', '은마 시세'],
  watch:      ['노원구 인기단지', '은마 시세'],
  fallback:   ['은마 시세', '노원구 인기단지', '오늘 금리'],
};
function _norm(v, intent) {
  const isObj = v && typeof v === 'object';
  const reply = isObj ? v.text : v;
  const suggestions = (isObj && Array.isArray(v.suggestions) && v.suggestions.length
    ? v.suggestions : DEFAULT_SUG[intent] || []).slice(0, 3);
  return { reply, intent, suggestions };
}

// INTENT-OBSERVE-2026-08-12 (KKKKKKK-20 제안 A): 의도 분포를 Redis 일별 해시로 누적 —
//   로그는 1시간이면 증발(Hobby)하지만 이건 3주 남아 "다음에 무슨 인텐트를 만들지"를 실사용이
//   결정하게 한다. fallback 원문(80자·PII 차단 통과분만 — 라우터 앞의 PII 게이트가 이미 거름)은
//   최근 50개 링버퍼로. 전부 fail-open — 관측 실패가 응답을 막지 않는다.
async function _observe(intent, message) {
  try {
    const r = require('../redis').getRedis();
    if (!r) return;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await r.hincrby(`chatint:${day}`, intent, 1);
    await r.expire(`chatint:${day}`, 60 * 60 * 24 * 21);
    if (intent === 'fallback') {
      await r.lpush('chatint:misses', String(message || '').slice(0, 80));
      await r.ltrim('chatint:misses', 0, 49);
    }
  } catch (_) { /* 관측은 본 기능을 막지 않는다 */ }
}

async function route(message, context) {
  const { intent, query } = classifyIntent(message);
  logger.info({ source: 'chat-data-router', intent, hasQuery: !!query }, '데이터 도우미 의도 분류');
  await _observe(intent, message);
  switch (intent) {
    case 'greeting':   return _norm(_greeting(), intent);
    case 'watch':      return _norm(await _watch(context), intent);
    case 'clause':     return _norm(_clauseGuide(), intent);
    case 'policyLoan': return _norm(await _policyLoan(), intent);
    case 'rates':      return _norm(await _rates(), intent);
    case 'regulation': return _norm(await _regulation(String(message || '')), intent);
    case 'loanLimit':  return _norm(_loanLimit(message), intent);
    case 'popular':    return _norm(await _popular(query), intent);
    case 'jeonse':     return _norm(_jeonseGuide(query), intent);
    case 'market':     return _norm(await _market(query, context), intent);
    case 'howto':      return _norm(_howto(), intent);
    case 'recommendAsk': return _norm(_recommendAsk(), intent);
    default:           return _norm(_fallback(), 'fallback');
  }
}

module.exports = { route, classifyIntent };
