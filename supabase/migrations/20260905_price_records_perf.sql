-- 20260905_price_records_perf.sql — 랜딩 '최근 7일 최고·최저 경신' 집계 함수 성능
--
-- [배경 · 프로덕션 실측 2026-09-05] /api/transactions/records 503 ×2 (canceling statement due to statement timeout).
--   PostgREST 세션(authenticator 롤)의 statement_timeout 은 8s 인데 get_price_records 는 pg_stat_statements 평균 4.7s·최대 6.6s,
--   EXPLAIN ANALYZE 로는 13.1s 까지 나왔다. 원인 둘:
--   ① 라테럴 서브쿼리 안의 `from molit_transactions t, maxd` — 행마다 CTE Scan(55,475회) 을 돌렸다.
--   ② idx_molit_aptseq_area_date 가 deal_amount 를 담지 않아 쌍(apt_seq, exclu_use_ar)마다 힙 페치(58,341 버퍼).
--
-- [적용 순서 · 이미 프로덕션에 적용됨(운영자 승인 2026-09-05, Supabase MCP execute_sql)]
--   1) 커버링 인덱스(CONCURRENTLY) 2) VACUUM (ANALYZE) — 가시성 맵을 채워 Index Only Scan 의 Heap Fetches 0
--   3) 두 함수의 maxd 참조를 스칼라 서브쿼리(InitPlan) 로. 결과(집계·목록)는 동일.
-- [실측] 13.1s → 7.5s(InitPlan) → 7.3s(인덱스, VACUUM 전) → 1.26s(VACUUM 후, Heap Fetches 0).
-- ⚠ 이 파일은 기록용이다. 재적용은 아래 문장을 그대로 실행하면 된다(멱등: IF NOT EXISTS · CREATE OR REPLACE).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_molit_aptseq_area_date_amt
  ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) INCLUDE (deal_amount)
  WHERE apt_seq IS NOT NULL;

-- VACUUM (ANALYZE) public.molit_transactions;   -- 트랜잭션 밖에서 별도 실행

-- 종전 idx_molit_aptseq_area_date (apt_seq, exclu_use_ar, deal_date) 는 새 인덱스의 키 접두와 같아 중복이다.
-- 새 인덱스가 실제로 쓰이는 것을 EXPLAIN 으로 확인한 뒤 제거했다. 되돌리려면:
--   CREATE INDEX CONCURRENTLY idx_molit_aptseq_area_date ON public.molit_transactions (apt_seq, exclu_use_ar, deal_date) WHERE apt_seq IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_molit_aptseq_area_date;

CREATE OR REPLACE FUNCTION public.get_price_records(p_days integer DEFAULT 7, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- PERF-2026-09-05: maxd 참조를 스칼라 서브쿼리(InitPlan, 1회 평가)로 — 종전 `from t, maxd` 는 라테럴 안에서 행마다
--   CTE Scan(55,475회)을 돌렸다. 커버링 인덱스 idx_molit_aptseq_area_date_amt(+VACUUM) 로 Heap Fetches 0.
--   EXPLAIN ANALYZE 실측 13.1s → 1.26s. 결과(집계·목록)는 동일.
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t
  where t.deal_date > (select d from maxd) - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= (select d from maxd) - p_days
  ) s where s.n >= p_min_prior
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
$function$;

CREATE OR REPLACE FUNCTION public.get_price_records_by_region(p_days integer DEFAULT 30, p_min_prior integer DEFAULT 3, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- PERF-2026-09-05: get_price_records 와 같은 수정(maxd 스칼라 서브쿼리 + 커버링 인덱스). 결과 동일.
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t
  where t.deal_date > (select d from maxd) - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= (select d from maxd) - p_days
  ) s where s.n >= p_min_prior
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
$function$;
