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
  { intent: 'clause',     re: /특약|계약서|가계약|등기부|전세\s*사기|임대차.*(조항|문구)/ },
  { intent: 'policyLoan', re: /디딤돌|보금자리|신생아\s*특례|신혼.*대출|정책\s*자금|특례\s*대출/ },
  { intent: 'rates',      re: /금리|이자율|기준\s*금리/ },
  { intent: 'regulation', re: /규제|조정\s*대상|투기\s*과열|토지\s*거래\s*허가|토허/ },
  { intent: 'loanLimit',  re: /대출|한도|DSR|LTV|얼마.*빌릴/i },
  { intent: 'popular',    re: /인기\s*단지|인기\s*아파트|거래\s*많은|요즘\s*(핫|뜨는|인기)/ },
  { intent: 'jeonse',     re: /전세가율|갭\s*투자|갭이|전세/ },
  { intent: 'market',     re: /시세|실거래|매매가|평당가|가격|얼마/ },
  { intent: 'howto',      re: /사용법|사용방법|도움말|어떻게\s*(써|사용|해)|무슨\s*기능|뭘\s*할\s*수/ },
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

function classifyIntent(message) {
  const m = String(message || '').trim();
  if (!m) return { intent: 'fallback' };
  for (const r of INTENT_RULES) {
    if (r.re.test(m)) {
      if (r.intent === 'market' || r.intent === 'jeonse') {
        let q = m.replace(MARKET_STOPWORDS, ' ').replace(/[?!.~,]/g, ' ').replace(/\s+/g, ' ').trim();
        q = _stripAptSuffix(q);
        return { intent: r.intent, query: q.length >= 2 ? q : null };
      }
      return { intent: r.intent };
    }
  }
  // 의도어가 전혀 없어도 2~20자 단문이면 단지명 단독 입력으로 간주("은마", "헬리오시티")
  if (/^[가-힣A-Za-z0-9\s()]{2,20}$/.test(m) && !/[?]/.test(m)) return { intent: 'market', query: _stripAptSuffix(m) };
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
  if (!q) return `어느 단지가 궁금하세요? 단지명을 함께 적어주세요 (예: "은마 시세", "헬리오시티 실거래").`;
  const admin = getSupabaseAdmin();
  if (!admin) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
  const since = new Date(); since.setMonth(since.getMonth() - 6);
  const { data, error } = await admin.from('molit_transactions')
    .select('apt_name, sigungu, umd_nm, deal_amount, deal_date, exclu_use_ar')
    .ilike('apt_name', `%${q.replace(/[%_]/g, '')}%`)
    .gte('deal_date', since.toISOString().slice(0, 10))
    .order('deal_date', { ascending: false })
    .limit(400);
  if (error || !data) return '지금 실거래 조회가 잠시 어려워요. 상단 검색창에서 단지명을 검색해 보세요.';
  if (!data.length) {
    return `"${q}" 이름이 들어간 단지의 최근 6개월 국토부 실거래를 찾지 못했어요.\n` +
      `· 단지명을 조금 다르게(공백·차수 없이) 적어보시거나\n· 상단 검색창 자동완성으로 정확한 이름을 확인해 보세요.`;
  }
  // (단지, 시군구) 그룹핑 — 동명 단지 분리 (문자열 지역 판정 아님: 표시 그룹핑 용도만)
  const groups = new Map();
  for (const t of data) {
    const k = `${t.apt_name}|${t.sigungu || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topKey, txs] = sorted[0];
  const [aptName, sigungu] = topKey.split('|');
  const avg = txs.reduce((s, t) => s + Number(t.deal_amount || 0), 0) / txs.length;
  const recent = txs.slice(0, 3)
    .map(t => `· ${mmdd(t.deal_date)} · 전용 ${Number(t.exclu_use_ar || 0).toFixed(0)}㎡ · ${eok(t.deal_amount)}`)
    .join('\n');
  let out = `📊 ${aptName} (${sigungu}${txs[0].umd_nm ? ' ' + txs[0].umd_nm : ''}) — 최근 6개월 국토부 실거래\n` +
    `${recent}\n거래 ${txs.length}건 · 단순평균 ${eok(avg)}`;
  if (sorted.length > 1) {
    const others = sorted.slice(1, 3).map(([k, v]) => { const [n, s] = k.split('|'); return `${n}(${s}, ${v.length}건)`; }).join(' · ');
    out += `\n\n같은 이름의 다른 단지도 있어요: ${others}\n지역명을 함께 적어주시면 좁혀드려요.`;
  }
  out += `\n\n🔍 전세가율·연식·학군 등 상세는 상단 검색창에서 "${aptName}" 을 검색해 보세요.`;
  return out + DISCLAIMER;
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
  return '🏦 정책자금 4종 핵심 요건 (주택도시기금·HF 공시)\n' +
    '· 디딤돌: 부부합산 소득 6~7천만↓ · 집값 5억↓ · 한도 2~2.4억\n' +
    '· 신혼 디딤돌: 소득 8.5천만↓ · 집값 6억↓ · 한도 3.2억\n' +
    '· 신생아 특례: 소득 1.3억↓ · 집값 9억↓ · 한도 4억\n' +
    '· 보금자리론: 소득 7천만↓ · 집값 6억↓ · 한도 3.6~4.2억' + rateLine +
    '\n\n자격·서류 요건은 별도예요 — 주택도시기금(nhuf.molit.go.kr) · 1599-0001 에서 확정 확인.\n🧮 대출 탭에 4종 비교표와 내 조건 계산기가 있어요.';
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
    return `📍 "${kw}" 는 현행 규제지역 목록에 있어요 ${basis}\n` +
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
  return out;
}

async function _popular() {
  try {
    const snap = await require('./popularService').readPopularSnapshot(5);
    if (snap && snap.length) {
      const rows = snap.map((p, i) =>
        `${i + 1}. ${p.aptName} (${p.sigungu}) — 최근 60일 ${p.dealCount60d}건 · 평균 ${eok(p.avgDealAmount)}`).join('\n');
      return `🔥 지금 인기 단지 TOP 5 (최근 60일 국토부 실거래 많은 순 · 시군구당 최대 2곳)\n${rows}\n\n지도 탭에서 위치와 함께 전체 12곳을 볼 수 있어요.` + DISCLAIMER;
    }
  } catch (_) { /* 아래 안내 */ }
  return '인기 단지 집계를 지금 불러오지 못했어요 — 지도 탭에서 숫자 라벨(인기 단지)로 확인할 수 있어요.';
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

function _fallback() {
  return `그 질문은 제가 가진 공식 데이터로는 정확히 답하기 어려워요 😅\n\n${EXAMPLES}\n\n매물 추천·가격 전망은 정책상 다루지 않아요 (정보 정리 도구).`;
}

// ── 진입점 ───────────────────────────────────────────────────────────────────
async function route(message, context) {
  const { intent, query } = classifyIntent(message);
  logger.info({ source: 'chat-data-router', intent, hasQuery: !!query }, '데이터 도우미 의도 분류');
  switch (intent) {
    case 'greeting':   return { reply: _greeting(), intent };
    case 'clause':     return { reply: _clauseGuide(), intent };
    case 'policyLoan': return { reply: await _policyLoan(), intent };
    case 'rates':      return { reply: await _rates(), intent };
    case 'regulation': return { reply: await _regulation(String(message || '')), intent };
    case 'loanLimit':  return { reply: _loanLimit(message), intent };
    case 'popular':    return { reply: await _popular(), intent };
    case 'jeonse':     return { reply: _jeonseGuide(query), intent };
    case 'market':     return { reply: await _market(query, context), intent };
    case 'howto':      return { reply: _howto(), intent };
    default:           return { reply: _fallback(), intent: 'fallback' };
  }
}

module.exports = { route, classifyIntent };
