-- PRICE-RECORDS-REGION-2026-08-29 (Sprint NNNNNNN-30): 시군구별 최고·최저 경신 + 전국 함수 중복 제거.
--
-- ⚠ 이 파일이 존재한다는 것이 적용됐다는 뜻이 아니다. 적용은 execute_sql 로 했고
--    pg_catalog 조회로 확인했다(prosecdef=t / search_path 고정 / acl=service_role).
--
-- [왜 지역별은 30일인가 — 실측]
--   7일 창: 107개 지역 중 **54곳이 경신 0~2건**(평균 3.3, 최대 12) → 지역 화면이 거의 빈다.
--   30일 창: 118개 지역 중 **110곳이 3건 이상**(평균 31.1, 최대 126) → 지역별로 볼 만하다.
--   전국 카드는 7일(주간 신선도), 지역은 30일. 창이 다르므로 응답의 windowDays 를 화면에 그대로
--   노출해 두 수치를 나란히 비교하는 오독을 막는다.
--
-- [왜 전체 블롭인가] 지역마다 온디맨드로 돌리면 매 요청 1.2초다. 하루 1회 전체(147kB·118개 지역·
--   1.24초)를 계산해 Redis 에 넣고, 요청마다 한 지역만 잘라 준다(서비스의 sliceRegion).
--
-- [단지당 1건] 목록은 같은 apt_seq 를 한 번만 싣는다 — 강남구 실측에서 세곡푸르지오 84.83㎡/84.84㎡ 가
--   3칸 중 2칸을 차지했다. **집계(highCount/lowCount)는 건드리지 않으므로 표시 건수는 실제 총계다.**
--   같은 이유로 전국 함수(get_price_records)도 아래에서 함께 갱신한다.

create or replace function public.get_price_records_by_region(
  p_days int default 30, p_min_prior int default 3, p_limit int default 3
) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t, maxd
  where t.deal_date > maxd.d - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= maxd.d - p_days
  ) s where s.n >= p_min_prior
),
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
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
$$;
revoke all on function public.get_price_records_by_region(int, int, int) from public, anon, authenticated;
grant execute on function public.get_price_records_by_region(int, int, int) to service_role;

-- 전국 함수: 목록만 단지당 1건으로. 집계는 무변경(실측 재확인: 243 / 109 / 1,958 동일).
create or replace function public.get_price_records(
  p_days int default 7, p_min_prior int default 3, p_limit int default 6
) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
with maxd as (select max(deal_date) as d, min(deal_date) as since from public.molit_transactions),
recent as (
  select t.apt_seq, t.apt_name, t.sigungu, t.lawd_cd, t.umd_nm, t.exclu_use_ar,
         t.deal_date, t.deal_amount, t.floor, t.build_year
  from public.molit_transactions t, maxd
  where t.deal_date > maxd.d - p_days and t.apt_seq is not null
),
pairs as (select distinct apt_seq, exclu_use_ar from recent),
st as (
  select p.apt_seq, p.exclu_use_ar, s.mx, s.mn, s.n from pairs p cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= maxd.d - p_days
  ) s where s.n >= p_min_prior
),
j as (select r.*, st.mx as prev_max, st.mn as prev_min, st.n as prev_n
      from recent r join st on st.apt_seq = r.apt_seq and st.exclu_use_ar = r.exclu_use_ar),
hi as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount desc) rn_apt
       from j where deal_amount > prev_max) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount desc limit p_limit),
lo as (select * from (select j.*, row_number() over (partition by apt_seq
         order by deal_date desc, prev_n desc, deal_amount asc) rn_apt
       from j where deal_amount < prev_min) q where rn_apt = 1
       order by deal_date desc, prev_n desc, deal_amount asc limit p_limit)
select jsonb_build_object(
  'latestDeal', (select d from maxd), 'sinceDate', (select since from maxd),
  'windowDays', p_days, 'minPrior', p_min_prior,
  'comparedCount', (select count(*) from j),
  'highCount', (select count(*) from j where deal_amount > prev_max),
  'lowCount',  (select count(*) from j where deal_amount < prev_min),
  'high', coalesce((select jsonb_agg(to_jsonb(h) - 'rn_apt' order by h.deal_date desc, h.prev_n desc, h.deal_amount desc) from hi h), '[]'::jsonb),
  'low',  coalesce((select jsonb_agg(to_jsonb(l) - 'rn_apt' order by l.deal_date desc, l.prev_n desc, l.deal_amount asc)  from lo l), '[]'::jsonb));
$$;
revoke all on function public.get_price_records(int, int, int) from public, anon, authenticated;
grant execute on function public.get_price_records(int, int, int) to service_role;

-- PostgREST 는 새 함수를 스키마 캐시에 올려야 본다. 안 하면 RPC 가 PGRST202 로 죽는다.
notify pgrst, 'reload schema';
