-- ============================================================================
-- Plan 101 + 103 — 2026-09-20 프로덕션에 **이미 적용된** SQL 원문 (리뷰어가 운영자 승인 후 execute_sql 로 실행).
--   기록 작업(마이그레이션 파일·schema.sql)은 이 파일의 문장을 그대로 옮긴다. 이 파일은 실행용이 아니다.
-- 실측: 101 전 482.2 MB → 후 442.9 MB (이력 인덱스 48.6 → 9.3 MB). 103 요약 테이블 81,462쌍·7.6 MB → 450.5 MB.
--       get_price_records(7,3,6): 최고 경신 351 → 159 · 최저 137 → 61 · sinceDate 2025-05-01 → 2020-09-01 · 웜 실행 98 → 104 ms.
-- ============================================================================

-- ── Plan 101 ────────────────────────────────────────────────────────────────
CREATE INDEX idx_molit_hist_seq ON public.molit_transactions_hist (apt_seq);
DROP INDEX public.idx_molit_hist_seq_date;

-- ── Plan 103 ① 요약 테이블 ─────────────────────────────────────────────────
CREATE TABLE public.molit_hist_peaks (
  apt_seq text NOT NULL,
  exclu_use_ar smallint NOT NULL,
  mx integer NOT NULL,
  mn integer NOT NULL,
  n integer NOT NULL,
  PRIMARY KEY (apt_seq, exclu_use_ar)
);
ALTER TABLE public.molit_hist_peaks ENABLE ROW LEVEL SECURITY;
INSERT INTO public.molit_hist_peaks
  SELECT apt_seq, exclu_use_ar, max(deal_amount), min(deal_amount), count(*) FROM public.molit_transactions_hist GROUP BY 1, 2;

-- ── Plan 103 ② 함수 2개 ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_price_records(p_days integer DEFAULT 7, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- PERF-2026-09-05: maxd 참조를 스칼라 서브쿼리(InitPlan, 1회 평가)로 — 종전 `from t, maxd` 는 라테럴 안에서 행마다
--   CTE Scan(55,475회)을 돌렸다. 커버링 인덱스 idx_molit_aptseq_area_date_amt(+VACUUM) 로 Heap Fetches 0.
--   EXPLAIN ANALYZE 실측 13.1s → 1.26s. 결과(집계·목록)는 동일.
-- BASELINE-6Y-2026-09-20 (Plan 103): 직전 최고·최저 기준선에 과거 이력(molit_transactions_hist 2020-09~2025-04)의
--   (단지, 면적)별 요약 molit_hist_peaks 를 합친다. since 도 이력 시작월까지 넓힌다. 실측(전국 7일): 최고 경신 351 → 159.
--   이력 힙을 직접 읽으면 콜드 13.9s 라 요약 테이블(PK 조회)로 붙인다 — 웜 98ms → 104ms.
with maxd as (select max(deal_date) as d,
                     least(min(deal_date), (select to_date(min(deal_ym), 'YYYYMM') from public.molit_hist_runs)) as since
              from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
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
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
-- 목록은 단지당 1건(같은 단지의 84.83/84.84㎡ 가 칸을 나눠 먹던 실측). 집계는 그대로 = 실제 총계.
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_price_records_by_region(p_days integer DEFAULT 30, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- PERF-2026-09-05: get_price_records 와 같은 수정(maxd 스칼라 서브쿼리 + 커버링 인덱스). 결과 동일.
-- BASELINE-6Y-2026-09-20 (Plan 103): get_price_records 와 같은 수정 — 기준선에 molit_hist_peaks(2020-09~2025-04 요약)를 합치고 since 를 이력 시작월까지.
with maxd as (select max(deal_date) as d,
                     least(min(deal_date), (select to_date(min(deal_ym), 'YYYYMM') from public.molit_hist_runs)) as since
              from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
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
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
agg as (select lawd_cd, count(*) cmp,
    count(*) filter (where deal_amount > prev_max) hi,
    count(*) filter (where deal_amount < prev_min) lo from j group by 1),
-- 목록은 **단지당 1건**만 싣는다: 같은 단지의 84.83㎡ / 84.84㎡ 가 3칸을 다 차지하던 실측 때문.
-- 집계(agg)는 건드리지 않으므로 표시 건수는 여전히 실제 총계다.
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
$function$
;
