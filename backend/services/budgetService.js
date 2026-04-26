/**
 * User Budget Service (Phase 4.8/4.9)
 *
 * 책임:
 *   - 월별 AI 사용량 조회 (pre-call)
 *   - 월 한도 초과 여부 판정 → 초과 시 callAI 전에 차단
 *   - 호출 후 토큰·비용 원자 증분 (increment_user_budget RPC)
 *
 * 비용 계산 (Claude Sonnet 4 기준 — 2025.05 가격표):
 *   - input:  $3 per 1M tokens
 *   - output: $15 per 1M tokens
 *   - cache_creation: $3.75 per 1M (input × 1.25)
 *   - cache_read: $0.30 per 1M (input × 0.1)
 *
 * 상한:
 *   - USER_MONTHLY_BUDGET_USD 환경변수 (기본 $3) — 마이크로달러로 저장
 *   - anonymous 사용자는 budget 적용 X (dailyLimit 가 이미 엄격)
 *
 * 실패 모드:
 *   - Supabase 장애 시: pre-check 는 warn 로그 후 pass (대량 장애 대비)
 *   - post-increment 실패 시: warn 로그만 — 호출 자체는 이미 완료
 *     → 비용 미기록은 있지만 응답은 정상 반환. 모니터링 알람으로 대처.
 */
const { getSupabaseAdmin } = require('../db/client');
const { getActivePlan, getLimitsForPlan } = require('./planService');
const logger = require('../logger');

// Claude Sonnet 4 가격 (마이크로달러 per 1M tokens)
const PRICE = {
  input:          3_000_000,   // $3/M
  output:        15_000_000,   // $15/M
  cache_creation: 3_750_000,   // $3.75/M
  cache_read:       300_000,   // $0.30/M
};

const DEFAULT_MONTHLY_USD = parseFloat(process.env.USER_MONTHLY_BUDGET_USD || '3');
const DEFAULT_MONTHLY_X1000 = Math.round(DEFAULT_MONTHLY_USD * 1000 * 1000); // $3 → 3,000,000

// 월 첫날 (YYYY-MM-01 UTC)
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function nextMonthFirst(d = new Date()) {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return n;
}

/** Anthropic usage → 마이크로달러 비용 */
function computeCostX1000(usage) {
  if (!usage) return 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const total =
    (input * PRICE.input +
     output * PRICE.output +
     cacheCreation * PRICE.cache_creation +
     cacheRead * PRICE.cache_read) / 1_000_000;
  return Math.ceil(total);
}

/**
 * 예산 초과 여부 체크
 * @returns {{ allowed: boolean, usedX1000: number, limitX1000: number, resetAt: Date } | null}
 *   userId 가 없거나 Supabase 미설정 시 null (가드 무시)
 */
async function checkBudget(userId) {
  if (!userId) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // Phase 3 (2026-04-25): Pro/Team 플랜 별 한도 적용 — 결제 가치 보장 + Pro 단일 사용자 손실 차단
  const plan = await getActivePlan(userId);

  // Phase 5+ (2026-04-26): admin 무제한 — 월 예산 체크도 skip
  if (plan === 'admin') {
    return { allowed: true, usedX1000: 0, limitX1000: Number.MAX_SAFE_INTEGER, resetAt: nextMonthFirst(), plan };
  }

  const planLimits = getLimitsForPlan(plan);
  const limitX1000 = Math.round(planLimits.monthlyAiUsd * 1000 * 1000);

  const mkey = monthKey();
  try {
    const { data, error } = await admin
      .from('user_budget')
      .select('cost_usd_x1000, input_tokens, output_tokens')
      .eq('user_id', userId)
      .eq('month', mkey)
      .maybeSingle();
    if (error) throw error;
    const usedX1000 = data?.cost_usd_x1000 || 0;
    return {
      allowed: usedX1000 < limitX1000,
      usedX1000,
      limitX1000,
      resetAt: nextMonthFirst(),
      plan,
    };
  } catch (e) {
    logger.warn({ err: e.message, userId }, 'budget 조회 실패 — pass-through');
    return null;
  }
}

/**
 * AI 호출 후 사용량 증분
 * @param {string} userId
 * @param {object} usage — Anthropic response.usage
 */
async function recordUsage(userId, usage) {
  if (!userId || !usage) return;
  const admin = getSupabaseAdmin();
  if (!admin) return;

  const costX1000 = computeCostX1000(usage);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;

  try {
    const { error } = await admin.rpc('increment_user_budget', {
      p_user_id: userId,
      p_month: monthKey(),
      p_input_tokens: input,
      p_output_tokens: output,
      p_cost_usd_x1000: costX1000,
    });
    if (error) throw error;
  } catch (e) {
    logger.warn({ err: e.message, userId, costX1000 }, 'budget 증분 실패 — 응답은 정상 반환');
  }
}

function formatUsd(x1000) {
  return '$' + (x1000 / 1000 / 1000).toFixed(2);
}

module.exports = {
  checkBudget,
  recordUsage,
  computeCostX1000,
  formatUsd,
  DEFAULT_MONTHLY_X1000,
  DEFAULT_MONTHLY_USD,
  monthKey,
  nextMonthFirst,
};
