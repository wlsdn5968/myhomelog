/**
 * 정책 스냅샷 ↔ 정부 보도자료 대조 (Phase 37, 2026-05-04 / 룰베이스 전환 2026-08-16)
 *
 * 운영자 명령:
 *   "맨날 내가 정부 정책 파악해서 너한테 주는거면 이 서비스가 의미가 없지.
 *    수시로 너가 정부 정책이나 제도 개편등을 파악해서 업데이트 해줘야돼."
 *
 * 하는 일:
 *   1) regulationsAutoFetch 가 정부 RSS(금융위·국토부·국세청·정책브리핑)를 최근 7일치 fetch +
 *      부동산 정책 키워드 매칭
 *   2) 활성 regulations_snapshot 각 key 에 대해, 그 정책 주제 키워드에 걸린 보도자료를 대조
 *   3) 걸린 게 있으면 증거(제목·링크·일자)와 함께 운영자 확인 요청 로그
 *
 * 하지 않는 일 (의도적):
 *   - "정책이 실제로 바뀌었다"는 판정 — 보도자료 제목만으로는 알 수 없다(절대 룰 ② 환각 차단)
 *   - proposedSQL 자동 생성 — 법령·정책 SQL 을 추론으로 만들지 않는다
 *   - DB 자동 반영 — 검증 후 운영자가 Supabase Dashboard 에서 직접 실행(legal risk 차단)
 *
 * 비용:
 *   REG-ZERO-COST-2026-08-16 — 외부 유료 호출 0. 종전 Anthropic 호출은 제거됐고,
 *   CI 가드(scripts/security-regression-check.js)가 재유입을 차단한다.
 *
 * 호출:
 *   - cron `/api/cron/regulations-auto-fetch` (매일 21:30 UTC)
 */
// REG-ZERO-COST-2026-08-16: callAI import 제거(유료 호출 구조적 폐기). 문구용 상수만 가져온다.
const { LOOK_BACK_DAYS } = require('./regulationsAutoFetch');
const logger = require('../logger');
// SSOT-2026-08-09 (Plan 007): 자체 createClient → db/client 팩토리.
//   이 파일이 SSOT 의 존재 이유다 — ENV-FIX-2026-05-21(Sentry NODE-2): 과거 이 파일만
//   SUPABASE_SECRET_KEY 라는 자기만의 env 를 읽어 cron 매 실행 실패. 비표준 SECRET_KEY
//   우선순위는 여기서 폐기(표준은 SERVICE_ROLE_KEY — db/client 가 단일 관리).
const { requireSupabaseAdmin } = require('../db/client');

function adminClient() {
  return requireSupabaseAdmin();
}

/**
 * 현재 활성 regulations_snapshot 로드.
 * @returns {Promise<Array<{key, source_effective_date, valid_to, data, note}>>}
 */
async function loadCurrentSnapshot() {
  const sb = adminClient();
  const { data, error } = await sb
    .from('regulations_snapshot')
    .select('key, source_effective_date, valid_to, data, note')
    .is('valid_to', null);
  if (error) throw error;
  return data || [];
}

// ── 스냅샷 key → 정책 주제 키워드 ────────────────────────────
// RSS_SOURCES 의 keywords 와 같은 어휘를 쓴다(정부 보도자료 제목에 실제로 등장하는 표현).
// 여기 없는 신규 key 는 GENERIC 폴백(전체 매칭 항목)으로 떨어져 "관련 가능성" 으로만 보고된다 —
// 새 정책 key 를 추가하고 이 표를 깜빡해도 **누락이 아니라 과보고** 쪽으로 실패하게 하기 위함.
const KEY_TOPIC_KEYWORDS = {
  acquisition_tax_2025: ['취득세', '양도세', '종부세', '종합부동산세', '주택세', '부동산세', '중과'],
  housing_loan_2025: ['LTV', 'DSR', '주담대', '주택담보', '대출', '규제지역', '스트레스', '디딤돌', '보금자리', '가계부채', '만기연장'],
};

/**
 * RSS 매칭 항목 ↔ 현재 snapshot 대조 (룰베이스 · 외부 유료 호출 0).
 *
 * REG-ZERO-COST-2026-08-16 (Sprint LLLLLLL — Sentry NODE-7: 20건 / 2026-07-18~08-15):
 *   종전 이 함수는 cron 마다 Anthropic 유료 호출을 했다. 크레딧 소진 이후 **29일간 100% 실패**했고,
 *   Sentry v10 의 `auto.ai.anthropic` 자동 계측이 우리 try/catch 보다 먼저 잡아 매일 error 이슈를
 *   만들었다(그래서 "폴백이 있으니 조용할 것"이라는 코드상 기대가 실제와 달랐다).
 *   운영자 방침 "비용 0원 영구"상 이 호출은 되살아날 수 없으므로 **구조적으로 제거**한다
 *   (챗 CHAT-ZERO-COST-2026-08-12 와 동일 원칙 — 남겨두면 언젠가 다시 과금된다).
 *
 * 룰베이스 전환으로 의도적으로 **포기한 것**:
 *   - 기사 본문 해석 기반 "정책이 실제로 바뀌었는가" 판정 → 하지 않는다. 제목 키워드로는 알 수 없다.
 *   - proposedSQL 자동 생성 → 폐지. 법령·정책 SQL 을 추론으로 만드는 것은 절대 룰 ②(환각 차단)
 *     위반 위험이 가장 큰 지점이며, 어차피 실행 전 운영자 수동 검증이 필수였다.
 *   - confidence 점수 → null. 근거 없는 숫자를 만들지 않는다.
 *
 * 보존한 실제 가치: "어느 스냅샷 key 와 관련된 정부 보도자료가 최근 N일 내 몇 건 나왔는가" +
 *   증거(제목·링크·일자) 원문. 운영자가 확인할 대상을 좁혀주는 기능은 그대로다.
 *
 * @param {Array} rssMatched - regulationsAutoFetch 의 matched 결과 (각 source 별)
 * @param {Array} currentSnapshot - regulations_snapshot 현재 활성 row
 * @returns {Promise<{analysis: Array, topAlert: string|null, reviewNeededCount: number}>}
 */
async function analyzeRegulations(rssMatched, currentSnapshot) {
  // RSS 매칭 항목 정리 (전체 source 합쳐서 대조)
  const rssItems = [];
  for (const src of rssMatched || []) {
    if (!src.matched || !src.matched.length) continue;
    for (const item of src.matched) {
      rssItems.push({
        source: src.name,
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        keywords: item.hits,
      });
    }
  }

  const _fmt = (it) => `[${it.source}] ${it.title}${it.pubDate ? ` (${String(new Date(it.pubDate).toISOString()).slice(0, 10)})` : ''} — ${it.link || '링크 없음'}`;

  const analysis = (currentSnapshot || []).map(s => {
    const topic = KEY_TOPIC_KEYWORDS[s.key] || null;
    // 주제 키워드가 정의된 key 는 교집합으로, 미정의 key 는 전체 매칭 항목으로 폴백(과보고 쪽 실패).
    const hits = topic
      ? rssItems.filter(it => {
          const hay = `${it.title} ${(it.keywords || []).join(' ')}`.toLowerCase();
          return topic.some(k => hay.includes(k.toLowerCase()));
        })
      : rssItems;
    return {
      key: s.key,
      currentState: s.note || '',
      latestRssEvidence: hits.length ? _fmt(hits[0]) : null,
      evidence: hits.slice(0, 5).map(_fmt),
      evidenceCount: hits.length,
      // 룰베이스는 '변경'을 판정하지 않는다 — 제목 키워드로 정책 변경을 단정하면 그게 환각이다.
      changeDetected: false,
      reviewNeeded: hits.length > 0,
      confidence: null,
      proposedSQL: null,
      reasoning: hits.length
        ? `최근 ${LOOK_BACK_DAYS}일 정부 보도자료 중 이 정책 주제 키워드에 걸린 항목 ${hits.length}건${topic ? '' : ' (주제 키워드 미정의 key — 전체 매칭 기준)'} — 운영자 확인 필요(변경 확정 아님)`
        : `최근 ${LOOK_BACK_DAYS}일 이 정책 주제에 걸린 정부 보도자료 없음`,
    };
  });

  const reviewNeededCount = analysis.filter(a => a.reviewNeeded).length;
  return {
    analysis,
    topAlert: reviewNeededCount
      ? `확인 필요 정책 ${reviewNeededCount}건 — 관련 정부 보도자료 감지 (변경 확정 아님)`
      : null,
    reviewNeededCount,
  };
}

/**
 * 통합 실행: RSS fetch (Phase 20) + 룰베이스 대조 (REG-ZERO-COST-2026-08-16) + 운영자 알림.
 * 호출처: cron `/api/cron/regulations-auto-fetch`
 *
 * @returns {Promise<{
 *   rssResults: Array,
 *   aiResults: object,
 *   currentSnapshot: Array,
 *   timestamp: string,
 * }>}
 */
async function runFullCheck() {
  const started = Date.now();
  const { run: runRssAutoFetch } = require('./regulationsAutoFetch');

  // 1. RSS fetch + 키워드 매칭 (Phase 20)
  const rssSummary = await runRssAutoFetch();

  // 2. 현재 snapshot 로드
  const currentSnapshot = await loadCurrentSnapshot();

  // 3. 룰베이스 대조 (외부 유료 호출 0)
  const aiResults = await analyzeRegulations(rssSummary.sources, currentSnapshot);

  // 4. 확인 필요 항목이 있으면 운영자 알림
  //    문구 주의: '변경 감지'가 아니라 '관련 보도자료 감지'다 — 룰베이스는 변경을 판정하지 않는다.
  for (const a of aiResults.analysis) {
    if (!a.reviewNeeded) continue;
    logger.warn({
      key: a.key,
      evidenceCount: a.evidenceCount,
      evidence: a.evidence,
      reasoning: a.reasoning,
    }, '📌 정책 관련 보도자료 감지 — 운영자 확인 필요 (변경 확정 아님)');
  }

  logger.info({
    durationMs: Date.now() - started,
    rssMatched: rssSummary.totalMatched,
    reviewNeeded: aiResults.reviewNeededCount,
    snapshotKeys: currentSnapshot.length,
  }, 'regulationsAiCheck OK');

  return {
    rssResults: rssSummary,
    aiResults,
    currentSnapshot: currentSnapshot.map(s => ({
      key: s.key,
      source_effective_date: s.source_effective_date,
      note: s.note,
    })),
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  runFullCheck,
  analyzeRegulations,
  loadCurrentSnapshot,
};
