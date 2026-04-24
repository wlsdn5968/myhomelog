-- ============================================================================
-- Phase 4.8 — user_budget (월별 AI 사용량·비용 추적)
--
-- 목적:
--   - Anthropic API 비용 하드 가드. 일일 5회 한도 외에 월 단위 $ 상한.
--   - 비용 폭주(악성·버그) 탐지 → 429 반환 → 다음 달 1일 초기화.
--   - 관리자 대시보드 쿼리용 (MRR 대비 AI 원가 모니터링).
--
-- 설계:
--   - PK = (user_id, month) — month 는 'YYYY-MM-01' 형식 TIMESTAMPTZ (월 첫날 00:00 UTC)
--   - 토큰은 input/output 분리 (Anthropic 은 cache_creation·cache_read 도 있으나 cost_usd_x1000 에 통합)
--   - cost 는 마이크로달러 단위 정수 (정밀도 + 인덱싱 효율)
--
-- 트레이드오프:
--   - 분단위 TPS 한도가 아닌 월간 누적이라 과도기에 일시적 과소비 허용.
--     → chatLimiter + dailyLimit 가 분·일 단위 커버, user_budget 이 월 단위 상한.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_budget (
  user_id         UUID NOT NULL,
  month           DATE NOT NULL,                 -- 월 첫날 (YYYY-MM-01 UTC)
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  cost_usd_x1000  BIGINT NOT NULL DEFAULT 0,     -- 마이크로달러 ($0.001 단위)
  request_count   INTEGER NOT NULL DEFAULT 0,
  last_request_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_user_budget_month_cost
  ON public.user_budget (month, cost_usd_x1000 DESC);

COMMENT ON TABLE public.user_budget IS
  '월별 AI 사용량 — $3/user/월 하드캡 가드. cost_usd_x1000 은 마이크로달러($0.001).';
COMMENT ON COLUMN public.user_budget.cost_usd_x1000 IS
  '마이크로달러 ($0.001 단위) 정수. 예: 3,000,000 = $3. 부동소수점 누적 오차 방지.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_budget ENABLE ROW LEVEL SECURITY;

-- 본인 사용량만 조회 (구독 페이지에서 "이번 달 $1.2 / $3.0" 표시용)
DROP POLICY IF EXISTS user_budget_select_own ON public.user_budget;
CREATE POLICY user_budget_select_own ON public.user_budget
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- INSERT/UPDATE/DELETE 정책 미생성 → service_role 만 — 사용자 위조 차단

-- ── 헬퍼 함수: 원자적 upsert + 증분 ────────────────────────────────────────
-- 다수 요청이 동시에 오는 경우 UPSERT + EXCLUDED 로 원자 증분.
CREATE OR REPLACE FUNCTION public.increment_user_budget(
  p_user_id UUID,
  p_month DATE,
  p_input_tokens BIGINT,
  p_output_tokens BIGINT,
  p_cost_usd_x1000 BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.user_budget (
    user_id, month, input_tokens, output_tokens, cost_usd_x1000, request_count, last_request_at, updated_at
  ) VALUES (
    p_user_id, p_month, p_input_tokens, p_output_tokens, p_cost_usd_x1000, 1, now(), now()
  )
  ON CONFLICT (user_id, month) DO UPDATE SET
    input_tokens    = user_budget.input_tokens + EXCLUDED.input_tokens,
    output_tokens   = user_budget.output_tokens + EXCLUDED.output_tokens,
    cost_usd_x1000  = user_budget.cost_usd_x1000 + EXCLUDED.cost_usd_x1000,
    request_count   = user_budget.request_count + 1,
    last_request_at = now(),
    updated_at      = now();
END;
$$;

COMMENT ON FUNCTION public.increment_user_budget IS
  'AI 호출 후 사용량 원자 증분 — concurrent 요청 안전.';
