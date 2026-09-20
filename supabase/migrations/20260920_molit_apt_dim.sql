-- ============================================================================
-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행).
--   이 파일은 **적용 기록**이다(Plan 026 관례). plans/107a-apt-dim-preservation.md Step 0 기반.
-- ============================================================================
-- [무엇인가]
--   단지 차원 보존 테이블 molit_apt_dim 신설(apt_seq 하나당 1행) — /apt/:seq 가 MV
--   (molit_apt_index)와 원본 24개월 조회에 이은 **3번째 소스**로 읽는다(backend/routes/aptPage.js
--   loadDimRow). 원본 molit_transactions 를 16개월 창으로 자르기(Plan 107c) **전에** 이름·지번·
--   준공연도를 떠내 둔다 — 자른 뒤에도 창 밖 단지의 공개 페이지가 404 로 사라지지 않게 하기 위해서다.
-- [실측값 — 최초 채움 직후]
--   22,672행 · 3.27MB · apt_name null 0건 · jibun null 4,690건 · build_year null 0건 ·
--   거래일 범위 2025-05-01~2026-09-18 · DB 전체 405.4 → 408.7MB.
-- [⚠ 교정 — RLS 누락(약 20분 공개 쓰기 가능 상태)]
--   최초 Step 0 DDL 에 `enable row level security` 가 없었다(계획자 오류, plans/107a
--   §Step 0 정정 기록 참고). Supabase 는 public 스키마 신규 테이블에 anon/authenticated 기본
--   DML 권한을 주므로, ①(create table) 실행 후 ③(enable row level security) 실행 전까지
--   **약 20분간** `molit_apt_dim` 이 `rls_enabled=false` + 정책 0 + anon 쓰기 가능 상태로
--   노출됐다. 확인: 채움 직후 22,672행 전부 `refreshed_at` 이 최초 INSERT 시각 단일값으로
--   동일 — 그 노출 창 동안 실제 쓰기는 0건이었음을 실증했다. RLS 적용 후 public 스키마 전체를
--   훑어 RLS 꺼진 테이블 0개 확인. 교훈: `create table` 을 쓰는 순간 같은 트랜잭션/문단에
--   `enable row level security` 를 함께 적는다.
-- [교정 — 불필요한 SECURITY DEFINER 제거]
--   refresh_molit_apt_dim() 은 public 의 제 테이블(molit_apt_dim·molit_transactions)만
--   읽고 쓰므로 호출자(service_role) 권한으로 충분하다(최소 권한) — 적용본은 prosecdef=false.
-- [되돌리기 SQL]
--   DROP FUNCTION public.refresh_molit_apt_dim();
--   DROP TABLE public.molit_apt_dim;
-- ============================================================================

-- 1. CREATE TABLE — apt_seq 하나당 1행. 원본에 없어진 apt_seq 의 행은 지우지 않는다(보존이 존재 이유).
create table if not exists public.molit_apt_dim (
  apt_seq         text primary key,
  apt_name        text,
  lawd_cd         text,
  sigungu         text,
  umd_nm          text,
  build_year      smallint,
  jibun           text,
  first_deal_date date,
  last_deal_date  date,
  deal_count      integer,
  refreshed_at    timestamptz not null default now()
);

-- 2. 최초 채움 — 원본에서 apt_seq 별 최신 1건의 이름·지번(distinct on) + 집계(agg) 조인.
--    빈 테이블에 대한 최초 삽입이라 충돌 시 갱신 없이 넘어간다(do nothing) — 이후 갱신은
--    refresh_molit_apt_dim() 이 맡는다.
with src as (
  select distinct on (apt_seq)
         apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun
    from public.molit_transactions
   where apt_seq is not null
   order by apt_seq, deal_date desc, id desc
), agg as (
  select apt_seq, min(deal_date) f, max(deal_date) l, count(*)::int c
    from public.molit_transactions where apt_seq is not null group by apt_seq
)
insert into public.molit_apt_dim
      (apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun, first_deal_date, last_deal_date, deal_count, refreshed_at)
select s.apt_seq, s.apt_name, s.lawd_cd, s.sigungu, s.umd_nm, s.build_year, s.jibun, a.f, a.l, a.c, now()
  from src s join agg a using (apt_seq)
on conflict (apt_seq) do nothing;

-- 3. RLS 활성화 — ⚠ 위 [교정] 절 참고. 이 테이블은 서버(service_role)만 쓰므로 정책은 두지
--    않는다(molit_hist_peaks 와 같은 패턴: relrowsecurity=true, policies=0 → service_role 만 통과).
alter table public.molit_apt_dim enable row level security;

-- 4. 갱신 함수 — apt_name·jibun·last_deal_date·deal_count 가 바뀐 행만 쓴다(통째 upsert 금지,
--    apt_master 가 힙의 절반을 빈 공간으로 들고 있던 원인 재발 방지, plans/104 관리규칙 4).
--    first/last_deal_date·deal_count 에 least/greatest 를 쓰는 이유: 창을 자른 뒤에는 원본의
--    집계가 줄어든다 — 보존 테이블이 과거 최대치를 잊으면 안 된다. security definer 는 쓰지
--    않는다(위 [교정] 절 — public 제 테이블만 다뤄 호출자 권한으로 충분).
create or replace function public.refresh_molit_apt_dim()
returns integer language plpgsql set search_path to 'public' as $function$
declare n integer;
begin
  with src as (
    select distinct on (apt_seq)
           apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun
      from public.molit_transactions
     where apt_seq is not null
     order by apt_seq, deal_date desc, id desc
  ), agg as (
    select apt_seq, min(deal_date) f, max(deal_date) l, count(*)::int c
      from public.molit_transactions where apt_seq is not null group by apt_seq
  )
  insert into public.molit_apt_dim
        (apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun, first_deal_date, last_deal_date, deal_count, refreshed_at)
  select s.apt_seq, s.apt_name, s.lawd_cd, s.sigungu, s.umd_nm, s.build_year, s.jibun, a.f, a.l, a.c, now()
    from src s join agg a using (apt_seq)
  on conflict (apt_seq) do update set
        apt_name = excluded.apt_name, lawd_cd = excluded.lawd_cd, sigungu = excluded.sigungu,
        umd_nm = excluded.umd_nm, build_year = excluded.build_year, jibun = excluded.jibun,
        first_deal_date = least(public.molit_apt_dim.first_deal_date, excluded.first_deal_date),
        last_deal_date  = greatest(public.molit_apt_dim.last_deal_date, excluded.last_deal_date),
        deal_count = greatest(public.molit_apt_dim.deal_count, excluded.deal_count),
        refreshed_at = now()
   where public.molit_apt_dim.apt_name is distinct from excluded.apt_name
      or public.molit_apt_dim.jibun    is distinct from excluded.jibun
      or public.molit_apt_dim.last_deal_date is distinct from excluded.last_deal_date
      or public.molit_apt_dim.deal_count     is distinct from excluded.deal_count;
  get diagnostics n = row_count;
  return n;
end $function$;
