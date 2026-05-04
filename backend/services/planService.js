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

// Phase 5+ (2026-04-26): 관리자 화이트리스트 — 무제한 사용 (운영자 본인용)
// ADMIN_EMAILS 환경변수 (콤마구분) 로 운영, 미설정 시 빈 배열 (whitelist 비활성)
// P1-15 (2026-05-04): 기본값 'wlsdn5968@gmail.com' 하드코딩 제거 — production env 없으면 운영자 이메일 노출 risk
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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

  // 관리자 체크 — auth.users 에서 email 조회 후 화이트리스트 매칭
  if (ADMIN_EMAILS.length > 0) {
    try {
      const { data } = await admin.auth.admin.getUserById(userId);
      const email = data?.user?.email?.toLowerCase();
      if (email && ADMIN_EMAILS.includes(email)) {
        cache.set(memKey, 'admin', 60);
        return 'admin';
      }
    } catch (e) {
      logger.warn({ err: e.message, userId }, 'planService: admin email 조회 실패 — 일반 plan 으로 진행');
    }
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
 * - dailyReport: scope='report' 의 base limit (Phase B-5: 보고서 비용 4배 단가 → 별도 scope)
 * - monthlyAiUsd: budgetService 가 검사하는 월 예산 (USD)
 *
 * Phase B-4 (2026-05-01): pro/team monthlyAiUsd 재조정 — 적자 마진 -300% → 흑자 전환
 *   pro: $25 → $10 (가격 ₩9900≒$7.4 의 135% — 마진 보호)
 *   team: $75 → $30 (가격 ₩29900≒$22 의 136%)
 */
const PLAN_LIMITS = {
  free: { dailyChat: 15,  dailySearch: 5,  dailyReport: 1,  monthlyAiUsd: 0.5 },  // 무료: 보호용
  pro:  { dailyChat: 100, dailySearch: 50, dailyReport: 5,  monthlyAiUsd: 10 },    // 9900원: 적자 차단
  team: { dailyChat: 300, dailySearch: 150, dailyReport: 15, monthlyAiUsd: 30 },   // 29900원: 적자 차단
  // 관리자 — 무제한 (운영자 본인용. Anthropic 비용은 본인 책임)
  // ※ 자가소비 폭주 방지 모니터링은 Phase C-1 (사용량 대시보드) 에서 처리
  admin: { dailyChat: Infinity, dailySearch: Infinity, dailyReport: Infinity, monthlyAiUsd: Infinity },
};

function getLimitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

/** 캐시 invalidate — 결제 완료/해지 시 호출 (billing 라우트 hook) */
function invalidatePlanCache(userId) {
  cache.del(`plan:${userId}`);
}

module.exports = { getActivePlan, getLimitsForPlan, invalidatePlanCache, PLAN_LIMITS };
