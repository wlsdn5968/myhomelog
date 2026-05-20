/**
 * AI 기반 정책 자동 분석 + 제안 SQL 생성 (Phase 37, 2026-05-04)
 *
 * 운영자 명령:
 *   "맨날 내가 정부 정책 파악해서 너한테 주는거면 이 서비스가 의미가 없지.
 *    수시로 너가 정부 정책이나 제도 개편등을 파악해서 업데이트 해줘야돼."
 *
 * Phase 20 (regulationsAutoFetch) 의 한계:
 *   - RSS 키워드 매칭만 수행 → "변경 가능성 있음" 알림만
 *   - 운영자가 직접 RSS 항목 읽고 → 변경 여부 판단 → SQL 작성 → 실행 (수동)
 *
 * Phase 37 (본 파일) 의 강화:
 *   - RSS 매칭 항목 + 현재 regulations_snapshot 을 Claude AI 가 비교 분석
 *   - 변경 감지 시 confidence + proposed SQL 자동 생성
 *   - confidence ≥ 90% : Sentry alert + 즉시 적용 가능 SQL 제공
 *   - confidence < 90% : Sentry warn + 운영자 수동 검증 필요
 *
 * 안전성:
 *   - SQL 자동 실행 X — 운영자가 검증 후 Supabase Dashboard 에서 직접 실행
 *   - AI hallucination risk → confidence threshold + 정부 사이트 URL 명시
 *   - 잘못된 정책 정보 노출 risk 차단 (legal)
 *
 * 호출:
 *   - cron `/api/cron/regulations-auto-fetch` 에서 매주 자동
 *   - admin endpoint `/api/admin/regulations-status` 에서 on-demand
 */
const { createClient } = require('@supabase/supabase-js');
const { callAI } = require('../services/aiService');
const logger = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
// ENV-FIX-2026-05-21 (Sentry NODE-2 "Supabase 미설정" on cron regulations-auto-fetch):
//   기존: process.env.SUPABASE_SECRET_KEY 단독 → 해당 env 미설정 → adminClient() 항상 throw →
//   정책추적 AI 비교(regulationsAiCheck) 매 cron 실패. 코드베이스 표준은 SUPABASE_SERVICE_ROLE_KEY.
//   fallback chain 으로 정정 (다른 모든 파일과 동일 패턴).
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.service_role;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

/**
 * Claude AI 로 RSS 매칭 항목 + 현재 snapshot 비교 분석.
 *
 * @param {Array} rssMatched - regulationsAutoFetch 의 matched 결과 (각 source 별)
 * @param {Array} currentSnapshot - regulations_snapshot 현재 활성 row
 * @returns {Promise<{
 *   analysis: Array<{key, currentState, latestRssEvidence, changeDetected, confidence, proposedSQL, reasoning}>,
 *   topAlert: string|null,
 *   highConfidenceCount: number
 * }>}
 */
async function aiAnalyzeRegulations(rssMatched, currentSnapshot) {
  // RSS 매칭 항목 정리 (전체 source 합쳐서 분석)
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

  // 분석할 RSS 항목 X → 정책 변경 신호 없음
  if (!rssItems.length) {
    return {
      analysis: currentSnapshot.map(s => ({
        key: s.key,
        currentState: s.note,
        latestRssEvidence: null,
        changeDetected: false,
        confidence: 100,
        proposedSQL: null,
        reasoning: '최근 7일 RSS 매칭 항목 없음 — 정책 변경 신호 없음',
      })),
      topAlert: null,
      highConfidenceCount: 0,
    };
  }

  // ── AI 시스템 프롬프트 ────────────────────────────────────
  const SYSTEM = `당신은 대한민국 부동산 정책 분석가입니다. 정부 RSS 보도자료와 현재 정책 스냅샷을 비교하여 변경 여부를 판단합니다.

## 절대 규칙
1. 정확한 사실만 분석. 추측·예측·해석 금지.
2. 정부 보도자료 (금융위·국토부·국세청) 의 명시적 언급만 신뢰.
3. confidence 산정 기준:
   - 95+: 보도자료에 정책 변경 + 시행일 + 구체 수치 명시 ("LTV 50% → 40%, 2026.1.1 시행")
   - 80-94: 변경 시그널 명확하나 일부 수치 미확정
   - 60-79: 변경 가능성 시사하나 모호 (검토 중·예정)
   - 0-59: 단순 언급 또는 무관
4. proposedSQL: confidence ≥ 90 일 때만 생성. 미만이면 null.
5. SQL 형식: UPDATE regulations_snapshot SET ... WHERE key = '...' AND valid_to IS NULL; 또는 INSERT 추가 후 옛 row 마감.
6. 출력은 반드시 JSON 만 (코드 블록·설명 금지).

## 출력 JSON schema
{
  "analysis": [
    {
      "key": "housing_loan_2025",
      "currentState": "현 note 요약 (1줄)",
      "latestRssEvidence": "관련 RSS 항목 title + link" | null,
      "changeDetected": true|false,
      "confidence": 0-100,
      "proposedSQL": "SQL 문장" | null,
      "reasoning": "왜 그렇게 판단했는지 (3줄 이내)"
    },
    ... (current snapshot 각 key 마다 1개)
  ],
  "topAlert": "가장 중요한 변경 사항 1줄" | null,
  "highConfidenceCount": 숫자
}`;

  const USER = `## 현재 활성 정책 스냅샷
${JSON.stringify(currentSnapshot.map(s => ({
    key: s.key,
    source_effective_date: s.source_effective_date,
    note: s.note,
    summary: typeof s.data === 'object' ? JSON.stringify(s.data).slice(0, 500) : String(s.data).slice(0, 500),
  })), null, 2)}

## 최근 7일 RSS 매칭 항목 (정부 보도자료)
${JSON.stringify(rssItems.slice(0, 30), null, 2)}

위 RSS 항목들이 현재 정책 스냅샷에 영향을 주는 변경인지 분석하세요. JSON 만 출력.`;

  let aiResp;
  try {
    aiResp = await callAI([{ role: 'user', content: USER }], false, {
      system: SYSTEM,
      maxTokens: 3000,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'regulationsAiCheck: AI 호출 실패');
    return {
      analysis: currentSnapshot.map(s => ({
        key: s.key,
        currentState: s.note || '',
        latestRssEvidence: null,
        changeDetected: false,
        confidence: 0,
        proposedSQL: null,
        reasoning: `AI 분석 실패: ${e.message}`,
      })),
      topAlert: 'AI 분석 실패 — 운영자 수동 검토 필요',
      highConfidenceCount: 0,
    };
  }

  // AI 응답 JSON 파싱
  let parsed;
  try {
    // Claude 가 ```json ... ``` 으로 감싸는 경우 대비
    const jsonText = aiResp.content.replace(/^```json\s*/m, '').replace(/```\s*$/m, '').trim();
    parsed = JSON.parse(jsonText);
  } catch (e) {
    logger.warn({ err: e.message, content: aiResp.content.slice(0, 200) }, 'regulationsAiCheck: AI 응답 JSON 파싱 실패');
    return {
      analysis: currentSnapshot.map(s => ({
        key: s.key,
        currentState: s.note || '',
        latestRssEvidence: null,
        changeDetected: false,
        confidence: 0,
        proposedSQL: null,
        reasoning: `AI 응답 파싱 실패 — 운영자 수동 검토 필요. 원본: ${aiResp.content.slice(0, 200)}`,
      })),
      topAlert: 'AI 응답 형식 이상 — 운영자 수동 검토 필요',
      highConfidenceCount: 0,
    };
  }

  // 안전 검증: parsed.analysis 가 배열인가
  if (!Array.isArray(parsed.analysis)) {
    return {
      analysis: [],
      topAlert: 'AI 응답 schema 위반 — 운영자 수동 검토 필요',
      highConfidenceCount: 0,
    };
  }

  const highCount = parsed.analysis.filter(a => a.confidence >= 90 && a.changeDetected).length;

  return {
    analysis: parsed.analysis,
    topAlert: parsed.topAlert || null,
    highConfidenceCount: highCount,
  };
}

/**
 * 통합 실행: RSS fetch (Phase 20) + AI 분석 (Phase 37) + Sentry alert.
 * 호출처: cron `/api/cron/regulations-auto-fetch` + admin `/api/admin/regulations-status`
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

  // 3. AI 분석
  const aiResults = await aiAnalyzeRegulations(rssSummary.sources, currentSnapshot);

  // 4. 고-confidence 변경 감지 시 Sentry alert
  if (aiResults.highConfidenceCount > 0) {
    for (const a of aiResults.analysis) {
      if (a.confidence >= 90 && a.changeDetected) {
        logger.warn({
          key: a.key,
          confidence: a.confidence,
          evidence: a.latestRssEvidence,
          proposedSQL: a.proposedSQL,
          reasoning: a.reasoning,
        }, '🚨 정책 변경 감지 (AI confidence ≥ 90%) — 운영자 즉시 검토 필요');
      }
    }
  }

  logger.info({
    durationMs: Date.now() - started,
    rssMatched: rssSummary.totalMatched,
    aiHighConfidence: aiResults.highConfidenceCount,
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
  aiAnalyzeRegulations,
  loadCurrentSnapshot,
};
