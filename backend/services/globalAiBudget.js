/**
 * 전역 AI 지출 상한 (kill-switch) — 2026-06-01
 *
 * 목적: 모든 AI 호출(callAI — 익명+로그인+cron)의 일/월 총 Anthropic 비용을 합산해
 *   GLOBAL_AI_DAILY_USD / GLOBAL_AI_MONTHLY_USD 초과 시 신규(과금) 호출을 차단.
 *   → 사용자 수·어뷰징과 무관하게 "총비용 천장"을 구조적으로 보장 (운영자 비용 폭주 걱정 해소).
 *
 * 동작:
 *   - callAI 가 캐시 미스(=실제 과금 호출) 시에만 checkGlobalAiBudget() 호출 → 캐시 히트(무료)는 영향 0.
 *   - 응답 후 recordGlobalAiUsage(usage) 로 일/월 누적 증분.
 *
 * 단위: budgetService.computeCostX1000 과 동일 — 마이크로달러 ($1 = 1,000,000).
 * 저장: Upstash Redis(다중 인스턴스 합산 정확) + 미설정 시 in-memory fallback(단일 인스턴스만, dev 용).
 * 장애 정책: Redis read 실패 시 fail-open(가용성 우선) + warn 로그.
 *   로그인 사용자에겐 per-user 월예산($3, Supabase 기반)이 별도 backstop.
 *
 * 설정(env, 기본값은 보수적 천장 — 더 낮추려면 env 로 조정):
 *   GLOBAL_AI_DAILY_USD   (기본 5)   — 일 전역 상한
 *   GLOBAL_AI_MONTHLY_USD (기본 30)  — 월 전역 상한
 *   둘 다 0 이하로 두면 비활성(무제한). 무제한 의도면 큰 값 권장.
 */
const { getRedis } = require('../redis');
const cache = require('../cache');
const logger = require('../logger');
const { computeCostX1000 } = require('./budgetService');

function _num(v, dflt) { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }
const DAILY_USD = _num(process.env.GLOBAL_AI_DAILY_USD, 5);
const MONTHLY_USD = _num(process.env.GLOBAL_AI_MONTHLY_USD, 30);
const DAILY_CAP = Math.round(DAILY_USD * 1e6);     // 마이크로달러
const MONTHLY_CAP = Math.round(MONTHLY_USD * 1e6);

const DAY_TTL = 60 * 60 * 26;        // ~26h (UTC 하루 + 버퍼)
const MONTH_TTL = 60 * 60 * 24 * 32; // ~32일

class GlobalAiBudgetExceededError extends Error {
  constructor(info) {
    super('GLOBAL_AI_BUDGET_EXCEEDED');
    this.name = 'GlobalAiBudgetExceededError';
    this.code = 'global_ai_budget';
    this.info = info || {};
  }
}

function _ymd() { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
function _ym() { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function dayKey() { return `gai:day:${_ymd()}`; }
function monthKey() { return `gai:mon:${_ym()}`; }

async function _read(key) {
  const redis = getRedis();
  if (!redis) return cache.get(key) || 0;
  try { return Number(await redis.get(key)) || 0; }
  catch (e) { return cache.get(key) || 0; } // fail-open (가용성 우선)
}

/**
 * AI 과금 호출 직전 검사 — 전역 일/월 상한 초과 여부.
 * @returns {{ allowed:boolean, scope:'daily'|'monthly'|null, dayUsedX1000, monthUsedX1000, dayCapX1000, monthCapX1000, disabled?:boolean }}
 */
async function checkGlobalAiBudget() {
  if (DAILY_CAP <= 0 && MONTHLY_CAP <= 0) return { allowed: true, disabled: true, scope: null };
  const [dayUsed, monUsed] = await Promise.all([_read(dayKey()), _read(monthKey())]);
  const overDay = DAILY_CAP > 0 && dayUsed >= DAILY_CAP;
  const overMonth = MONTHLY_CAP > 0 && monUsed >= MONTHLY_CAP;
  return {
    allowed: !overDay && !overMonth,
    scope: overDay ? 'daily' : (overMonth ? 'monthly' : null),
    dayUsedX1000: dayUsed, monthUsedX1000: monUsed,
    dayCapX1000: DAILY_CAP, monthCapX1000: MONTHLY_CAP,
  };
}

/** AI 응답 후 전역 누적 증분 (fire-and-forget, 실패해도 응답 정상) */
async function recordGlobalAiUsage(usage) {
  const cost = computeCostX1000(usage);
  if (!cost || cost <= 0) return;
  const dk = dayKey(), mk = monthKey();
  const redis = getRedis();
  if (!redis) {
    cache.set(dk, (cache.get(dk) || 0) + cost, DAY_TTL);
    cache.set(mk, (cache.get(mk) || 0) + cost, MONTH_TTL);
    return;
  }
  try {
    const [d, m] = await Promise.all([redis.incrby(dk, cost), redis.incrby(mk, cost)]);
    if (Number(d) === cost) await redis.expire(dk, DAY_TTL);   // 첫 증분 시에만 TTL 설정
    if (Number(m) === cost) await redis.expire(mk, MONTH_TTL);
  } catch (e) {
    logger.warn({ err: e.message }, 'globalAiBudget: 전역 사용량 증분 실패 (응답은 정상)');
  }
}

module.exports = {
  checkGlobalAiBudget,
  recordGlobalAiUsage,
  GlobalAiBudgetExceededError,
  GLOBAL_AI_DAILY_USD: DAILY_USD,
  GLOBAL_AI_MONTHLY_USD: MONTHLY_USD,
};
