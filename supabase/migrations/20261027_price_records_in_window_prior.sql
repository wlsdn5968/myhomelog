-- ============================================================================
-- 2026-10-27 — 운영자 SQL Editor 실행용(이 PC 에서는 계획자의 DB 쓰기가 자동 안전 검사에 막힌다). 아직 적용 안 됨.
-- 최고·최저가 경신 판정: "기간 안의 앞선 거래"도 비교한다.
--
-- [결함 — 2026-10-27 실측] get_price_records(전국 7일·첫 화면)·get_price_records_by_region(지역 30일·/region 페이지)는
--   기간 안의 거래를 **기간 시작 전 거래와만** 비교했다. 그래서 기간 안에서 더 비싼 거래가 먼저 있었어도 뒤의 싼 거래가
--   '최고가 경신'으로 셌다. 예: 노원센트럴푸르지오 84.99㎡ — 10/14 11.545억 → 10/23 11.30억 이 "최고가 경신,
--   직전 최고 10.90억"(8/22)으로 /region/11350 에 표시됐다.
--   같은 기준으로 다시 센 값(읽기 전용): 30일 최고가 1,578 → 1,466(112건 과대), 최저가 452 → 440,
--   7일 최고가 114 → 113, 최저가 59 → 59.
-- [고침] j CTE 에 같은 (단지, 면적)의 기간 안 앞선 거래 최대·최저(창 함수, 날짜·id 순)를 붙이고
--   prev_max = greatest(기간 전 최고, 기간 안 앞선 최고), prev_min = least(…). 나머지(목록·집계·출력 형식)는 그대로.
--   화면의 "직전 최고"도 이제 실제 바로 앞까지의 최고다.
-- 실행 순서: ① 아래 두 CREATE OR REPLACE 를 한 번에 Run(함수 정의만 바뀜, 데이터 변경 없음)
--   ② 확인 쿼리(맨 아래)를 Run — 결과의 hi 가 위 "고친 값"과 같으면 성공(실행 시점에 따라 조금 다를 수 있음)
--   ③ 캐시는 다음 retention cron(매일 03:00 KST 경)에 새 값으로 바뀐다.
-- 되돌리기: 20260920 BASELINE-6Y 버전(같은 파일 이력의 CREATE OR REPLACE)을 다시 Run.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_price_records(p_days integer DEFAULT 7, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with maxd as (select max(deal_date) as d,
                     least(min(deal_date), (select to_date(min(deal_ym), 'YYYYMM') from public.molit_hist_runs)) as since
              from public.molit_transactions),
recent as (
  select t.id, t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t
  where t.deal_date > (select d from maxd) - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar,
         greatest(s.mx, k.mx) as mx, least(s.mn, k.mn) as mn, s.n + coalesce(k.n, 0) as n
  from pairs p
  cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= (select d from maxd) - p_days
  ) s
  left join public.molit_hist_peaks k
    on k.apt_seq = p.apt_seq and k.exclu_use_ar = least(round(p.exclu_use_ar * 100), 32767)::smallint
  where s.n + coalesce(k.n, 0) >= p_min_prior
),
w as (select r.*,
        max(r.deal_amount) over (partition by r.apt_seq, r.exclu_use_ar order by r.deal_date, r.id rows between unbounded preceding and 1 preceding) as win_max,
        min(r.deal_amount) over (partition by r.apt_seq, r.exclu_use_ar order by r.deal_date, r.id rows between unbounded preceding and 1 preceding) as win_min
      from recent r),
j as (select w.apt_seq, w.apt_name, w.sigungu, w.lawd_cd, w.umd_nm, w.exclu_use_ar, w.deal_date, w.deal_amount, w.floor, w.build_year,
             greatest(st.mx, coalesce(w.win_max, st.mx)) as prev_max,
             least(st.mn, coalesce(w.win_min, st.mn)) as prev_min,
             st.n + count(*) over (partition by w.apt_seq, w.exclu_use_ar order by w.deal_date, w.id rows between unbounded preceding and 1 preceding) as prev_n
      from w join st on st.apt_seq = w.apt_seq and st.exclu_use_ar = w.exclu_use_ar),
hi as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount desc) rn_apt
       from j where deal_amount > prev_max) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount desc limit p_limit),
lo as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount asc) rn_apt
       from j where deal_amount < prev_min) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount asc limit p_limit)
select jsonb_build_object(
  'latestDeal',    (select d from maxd),
  'sinceDate',     (select since from maxd),
  'windowDays',    p_days,
  'minPrior',      p_min_prior,
  'comparedCount', (select count(*) from j),
  'highCount',     (select count(*) from j where deal_amount > prev_max),
  'lowCount',      (select count(*) from j where deal_amount < prev_min),
  'high', coalesce((select jsonb_agg(to_jsonb(h) - 'rn_apt' order by h.deal_date desc, h.prev_n desc, h.deal_amount desc) from hi h), '[]'::jsonb),
  'low',  coalesce((select jsonb_agg(to_jsonb(l) - 'rn_apt' order by l.deal_date desc, l.prev_n desc, l.deal_amount asc)  from lo l), '[]'::jsonb)
);
$function$;

CREATE OR REPLACE FUNCTION public.get_price_records_by_region(p_days integer DEFAULT 30, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with maxd as (select max(deal_date) as d,
                     least(min(deal_date), (select to_date(min(deal_ym), 'YYYYMM') from public.molit_hist_runs)) as since
              from public.molit_transactions),
recent as (
  select t.id, t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t
  where t.deal_date > (select d from maxd) - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar,
         greatest(s.mx, k.mx) as mx, least(s.mn, k.mn) as mn, s.n + coalesce(k.n, 0) as n
  from pairs p
  cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= (select d from maxd) - p_days
  ) s
  left join public.molit_hist_peaks k
    on k.apt_seq = p.apt_seq and k.exclu_use_ar = least(round(p.exclu_use_ar * 100), 32767)::smallint
  where s.n + coalesce(k.n, 0) >= p_min_prior
),
w as (select r.*,
        max(r.deal_amount) over (partition by r.apt_seq, r.exclu_use_ar order by r.deal_date, r.id rows between unbounded preceding and 1 preceding) as win_max,
        min(r.deal_amount) over (partition by r.apt_seq, r.exclu_use_ar order by r.deal_date, r.id rows between unbounded preceding and 1 preceding) as win_min
      from recent r),
j as (select w.apt_seq, w.apt_name, w.sigungu, w.lawd_cd, w.umd_nm, w.exclu_use_ar, w.deal_date, w.deal_amount, w.floor, w.build_year,
             greatest(st.mx, coalesce(w.win_max, st.mx)) as prev_max,
             least(st.mn, coalesce(w.win_min, st.mn)) as prev_min,
             st.n + count(*) over (partition by w.apt_seq, w.exclu_use_ar order by w.deal_date, w.id rows between unbounded preceding and 1 preceding) as prev_n
      from w join st on st.apt_seq = w.apt_seq and st.exclu_use_ar = w.exclu_use_ar),
agg as (select lawd_cd, count(*) cmp,
    count(*) filter (where deal_amount > prev_max) hi,
    count(*) filter (where deal_amount < prev_min) lo from j group by 1),
hi as (select * from (select j.*, row_number() over (partition by lawd_cd, apt_seq
         order by deal_date desc, prev_n desc, deal_amount desc) rn_apt
       from j where deal_amount > prev_max) q where rn_apt = 1),
lo as (select * from (select j.*, row_number() over (partition by lawd_cd, apt_seq
         order by deal_date desc, prev_n desc, deal_amount asc) rn_apt
       from j where deal_amount < prev_min) q where rn_apt = 1),
hi_r as (select hi.*, row_number() over (partition by lawd_cd order by deal_date desc, prev_n desc, deal_amount desc) rn from hi),
lo_r as (select lo.*, row_number() over (partition by lawd_cd order by deal_date desc, prev_n desc, deal_amount asc) rn from lo),
hi_top as (select lawd_cd, jsonb_agg(p order by rn) arr from
  (select lawd_cd, rn, to_jsonb(hi_r) - 'rn' - 'rn_apt' - 'prev_min' as p from hi_r where rn <= p_limit) z group by lawd_cd),
lo_top as (select lawd_cd, jsonb_agg(p order by rn) arr from
  (select lawd_cd, rn, to_jsonb(lo_r) - 'rn' - 'rn_apt' - 'prev_max' as p from lo_r where rn <= p_limit) z group by lawd_cd)
select jsonb_build_object(
  'windowDays', p_days, 'minPrior', p_min_prior,
  'latestDeal', (select d from maxd), 'sinceDate', (select since from maxd),
  'regions', coalesce((
    select jsonb_object_agg(a.lawd_cd, jsonb_build_object(
      'comparedCount', a.cmp, 'highCount', a.hi, 'lowCount', a.lo,
      'high', coalesce(h.arr, '[]'::jsonb), 'low', coalesce(l.arr, '[]'::jsonb)))
    from agg a left join hi_top h on h.lawd_cd = a.lawd_cd left join lo_top l on l.lawd_cd = a.lawd_cd
  ), '{}'::jsonb));
$function$;

-- ② 확인(별도로 Run): 노원구 30일 최고가 경신 건수와 노원센트럴푸르지오가 목록에서 빠졌는지
-- select (r->'regions'->'11350'->>'highCount') hi, r->'regions'->'11350'->'high' list from (select public.get_price_records_by_region() r) x;
