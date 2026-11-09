-- 2026-11-10 보안 점검 run-1 (billing/refund-status-check-constraint-mismatch-keeps-entitlement)
-- 코드(backend/routes/billing.js 환불, 웹훅 CANCELED 정합)와 planService 는 status='refunded' 를 쓰는데,
-- 운영 DB 의 두 CHECK 제약에 refunded 가 없어 환불 기록이 제약 위반으로 실패하고 이용권이 남았다.
-- 2026-11-09 운영 읽기 확인: payments 0행, user_billing 0행(결제 미개시) -> 기존 행 영향 없음.
-- 되돌리기: refunded 행이 없을 때만 아래 두 문장을 refunded 를 뺀 목록으로 다시 실행한다.

alter table public.payments drop constraint payments_status_check;
alter table public.payments add constraint payments_status_check
  check (status = any (array['requested'::text, 'authorized'::text, 'captured'::text, 'canceled'::text, 'failed'::text, 'refunded'::text]));

alter table public.user_billing drop constraint user_billing_status_check;
alter table public.user_billing add constraint user_billing_status_check
  check (status = any (array['active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text, 'refunded'::text]));
