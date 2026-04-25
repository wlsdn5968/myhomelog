/**
 * Plan / 구독 식별 helper (Phase 3 결정사항, 2026-04-25)
 *
 * 이전: dailyLimit/budget 이 모든 사용자에게 동일 한도 → Pro 결제 가치 0 (전자상거래법 13조 위반 위험).
 * 해결: user_billing.status='active' & plan IN ('pro','team') 인 사용자에게 확장 한도.
 *
 * Pro / Team 한도 (Phase 3 단가 분석 기반):
 *   - 단가: 호출당 약 $0.025 (캐시 적중 95%)
 *   - Pro 9900원: 마진 보호 위해 일 100 / 월 1000 cap
 *     (월 1000회 × $0.025 = $25 = 33,000원 — Pro 가격의 3.3배 이지만 평균 사용자는 100~300회)
 *   - Team 29900원: 일 300 / 월 3000 cap (3인 공유 가정)
 */
const { getSupabaseAdmin } = require('../db/client');
const cache = require('../cache');
const logger = require('../logger');

/** 사용자 활성 plan 조회 — 60초 메모리 캐시 (모든 chat 요청마다 DB 조회 비용 차단) */
async function getActivePlan(userId) {
  if (!userId) return 'free';
  const memKey = `plan:${userId}`;
  const cached = cache.get(memKey);
  if (cached !== undefined) return cached;

  const admin = getSupabaseAdmin();
  if (!admin) {
    cache.set(memKey, 'free', 60);
    return 'free';
  }
  try {
    const { data } = await admin
      .from('user_billing')
      .select('plan, status, current_period_end')
      .eq('user_id', userId)
      .maybeSingle();
    let plan = 'free';
    if (data && data.status === 'active' && (data.plan === 'pro' || data.plan === 'team')) {
      // 만료일 체크
      if (!data.current_period_end || new Date(data.current_period_end) > new Date()) {
        plan = data.plan;
      }
    }
    cache.set(memKey, plan, 60);
    return plan;
  } catch (e) {
    logger.warn({ err: e.message, userId }, 'planService: 조회 실패 — free fallback');
    cache.set(memKey, 'free', 60);
    return 'free';
  }
}

/**
 * Plan 별 일/월 한도 (rate limit / budget cap)
 * - dailyChat: scope='chat' 의 base limit
 * - dailySearch: scope='search' 의 base limit
 * - monthlyAiUsd: budgetService 가 검사하는 월 예산 (USD)
 */
const PLAN_LIMITS = {
  free: { dailyChat: 15,  dailySearch: 5,  monthlyAiUsd: 0.5 },  // 무료: 약 20 호출 (보호용)
  pro:  { dailyChat: 100, dailySearch: 50, monthlyAiUsd: 25 },   // 9900원: 약 1000 호출
  team: { dailyChat: 300, dailySearch: 150, monthlyAiUsd: 75 },  // 29900원: 약 3000 호출
};

function getLimitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

/** 캐시 invalidate — 결제 완료/해지 시 호출 (billing 라우트 hook) */
function invalidatePlanCache(userId) {
  cache.del(`plan:${userId}`);
}

module.exports = { getActivePlan, getLimitsForPlan, invalidatePlanCache, PLAN_LIMITS };
