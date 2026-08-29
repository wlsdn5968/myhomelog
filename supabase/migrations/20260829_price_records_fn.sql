-- PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 브리핑 "최근 실거래 최고·최저 경신" 재료.
--
-- [왜 DB 함수인가] 같은 단지·같은 전용면적의 **직전 최고/최저**와 비교해야 하는데,
--   PostgREST 로는 집계를 못 한다. JS 로 하면 비교 대상 4만행을 1000행씩 41왕복 해야 한다.
--   라이브 실측: 이 쿼리 자체가 2.5초대(EXPLAIN ANALYZE) — 그래서 **하루 1회 계산 후 캐시**가 전제다.
--   (선례: get_br_backfill_candidates / search_popular_apts / geocache_backfill_candidates)
--
-- [왜 이 문턱인가]
--   · p_min_prior(직전 거래 최소 건수) — TRUST 게이트와 같은 취지. 거래 1~2건짜리 단지의
--     "최고가 경신"은 통계가 아니라 잡음이다(유령단지 사고 이력).
--   · 같은 apt_seq + 같은 exclu_use_ar 로만 비교 — 평형이 다르면 애초에 비교 대상이 아니다.
--   · 층 차이는 보정하지 않는다(추정 금지). 대신 prev_n 을 그대로 내보내 사용자가 판단하게 한다.
--
-- [정렬] 경신폭(%) 순이 아니라 **최근 거래일 → 직전 표본 많은 순**이다.
--   %로 정렬하면 거래가 드문 대형평형이 상위를 독식한다(실측: 상위 12건 중 152㎡·164㎡·124㎡ 포함).
--   그건 "놀라운 거래"가 아니라 "데이터가 적은 거래"를 보여주는 것이다.
--
-- [절대 룰] 이 함수는 사실만 낸다 — 매수·매도 추천도, 미래 가격 예측도 아니다.
--   비교 기준일(sinceDate)을 함께 반환해 "역대 최고가"로 과장되지 않게 한다(적재 시작 2025-05-01).
create or replace function public.get_price_records(
  p_days int default 7,
  p_min_prior int default 3,
  p_limit int default 6
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with maxd as (
  select max(deal_date) as d, min(deal_date) as since from public.molit_transactions
),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t, maxd
  where t.deal_date > maxd.d - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n
  from pairs p
  cross join lateral (
    select max(t.deal_amount) as mx, min(t.deal_amount) as mn, count(*) as n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq
      and t.exclu_use_ar = p.exclu_use_ar
      and t.deal_date <= maxd.d - p_days
  ) s
  where s.n >= p_min_prior
),
j as (
  select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
  from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar
),
hi as (
  select * from j where deal_amount > prev_max
  order by deal_date desc, prev_n desc, deal_amount desc limit p_limit
),
lo as (
  select * from j where deal_amount < prev_min
  order by deal_date desc, prev_n desc, deal_amount asc limit p_limit
)
select jsonb_build_object(
  'latestDeal',    (select d from maxd),
  'sinceDate',     (select since from maxd),
  'windowDays',    p_days,
  'minPrior',      p_min_prior,
  'comparedCount', (select count(*) from j),
  'highCount',     (select count(*) from j where deal_amount > prev_max),
  'lowCount',      (select count(*) from j where deal_amount < prev_min),
  'high', coalesce((select jsonb_agg(to_jsonb(h) order by h.deal_date desc, h.prev_n desc, h.deal_amount desc) from hi h), '[]'::jsonb),
  'low',  coalesce((select jsonb_agg(to_jsonb(l) order by l.deal_date desc, l.prev_n desc, l.deal_amount asc)  from lo l), '[]'::jsonb)
);
$$;

-- 백엔드는 service_role(admin 클라이언트)로만 호출한다 — anon/authenticated 에 직접 노출하지 않는다
-- (get_br_backfill_candidates 와 동일 정책).
revoke all on function public.get_price_records(int, int, int) from public, anon, authenticated;
grant execute on function public.get_price_records(int, int, int) to service_role;
