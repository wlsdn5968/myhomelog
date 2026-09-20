# 103 — "최고·최저 경신" 기준선을 2025-05 이후 → 2020-09 이후(이력 포함)로 — ⚠ 프로덕션 DDL(요약 테이블 1 + 함수 2), 운영자 승인 후 실행

**작성 기준 커밋**: `a2ebf5e` (2026-09-20) · 우선순위 P1(정확도) · 작업량 S(DDL) + XS(기록) · 의존: **101 적용 후**(요약 테이블 ≈7 MB 를 넣을 여유 확보)

## 전제 확인 (계획자가 프로덕션에서 읽기 전용으로 실측)
- 현재 `get_price_records` / `get_price_records_by_region`(둘 다 `STABLE SECURITY DEFINER`, 실행 권한 `service_role` 뿐, `supabase/schema.sql:549`·`:595`)은 **같은 단지·같은 전용면적의 직전 최고/최저**를 `molit_transactions`(2025-05-01~) 안에서만 찾는다. 화면은 "`sinceDate` 이후 적재분 안에서" 라고 정직하게 밝히고 있다(`index.html:3850`·`:5491`, `briefing.js:183`, `regionPage.js:233`).
- **2026-09-20 실측(전국·최근 7일, 비교 가능 거래)**: 지금 기준 비교 2,339건 중 **최고 경신 351 · 최저 경신 137**. 같은 거래를 이력(2020-09~2025-04, 1,290,112행)까지 넣어 비교하면 비교 2,517건 중 **최고 159 · 최저 61**. 즉 지금 "최고 경신" 으로 보여 주는 거래의 **55% 는 2020-09 이후 최고가가 아니다**(2021년 고점이 더 높다). 이력을 갖게 된 이상 기준선을 넓히는 것이 정확하다.
- 이력 힙을 단지별로 직접 읽는 방식은 느리다: 같은 쿼리에 `molit_transactions_hist` lateral 을 붙이면 **콜드 13.9초**(단지당 행이 56개 월 구간에 흩어져 있어 랜덤 읽기 — PostgREST authenticator 8초 제한 초과, 이 RPC 는 과거에도 8초 타임아웃 사고가 있었다: `priceRecordsService.js:27` 주석).
- 이력은 **불변**(2020-09~2025-04, backfill 동결 — Plan 100)이라 (단지, 면적)별 최고·최저·건수를 **한 번만** 집계해 두면 된다: 서로 다른 (apt_seq, 면적) 쌍 **81,462개**(3건 이상 54,614) → 테이블 ≈ 4 MB + PK ≈ 3 MB.
- 면적 단위: 원본 `exclu_use_ar numeric`(㎡), 이력 `smallint`(㎡×100, 32767 캡). 조인식은 `least(round(x*100), 32767)::smallint` — 캡 없이 캐스팅하면 327㎡ 초과 매물에서 `smallint out of range` 로 **함수 전체가 실패**한다.

## 실행 SQL (운영자 승인 후 리뷰어가 실행 — 순서 고정)
```sql
-- ① 요약 테이블 (정책 없는 RLS = service_role 전용. 함수는 SECURITY DEFINER 라 읽을 수 있다)
CREATE TABLE public.molit_hist_peaks (
  apt_seq text NOT NULL, exclu_use_ar smallint NOT NULL,   -- ㎡×100 (molit_transactions_hist 와 같은 단위)
  mx integer NOT NULL, mn integer NOT NULL, n integer NOT NULL,
  PRIMARY KEY (apt_seq, exclu_use_ar)
);
ALTER TABLE public.molit_hist_peaks ENABLE ROW LEVEL SECURITY;
INSERT INTO public.molit_hist_peaks
  SELECT apt_seq, exclu_use_ar, max(deal_amount), min(deal_amount), count(*) FROM public.molit_transactions_hist GROUP BY 1, 2;
-- 확인: SELECT count(*), sum(n) FROM public.molit_hist_peaks;  → 81,462 / 1,290,112
```
```sql
-- ② 두 함수의 CTE 두 곳만 바꾼다(나머지 본문은 pg_get_functiondef 로 읽은 현재 정의 그대로 — md5 361e6afc…(전국)·063487ca…(지역)).
--   maxd:  since 를 이력 시작월까지 넓힌다(화면의 "○○ 이후 적재분 안에서" 가 자동으로 2020.09.01 이 된다)
with maxd as (select max(deal_date) as d,
                     least(min(deal_date), (select to_date(min(deal_ym), 'YYYYMM') from public.molit_hist_runs)) as since
              from public.molit_transactions),
--   st:    직전 기준선 = 원본(기존 lateral 그대로) + 이력 요약
st as (
  select p.apt_seq, p.exclu_use_ar,
         greatest(s.mx, k.mx) as mx, least(s.mn, k.mn) as mn, s.n + coalesce(k.n, 0) as n
  from pairs p
  cross join lateral (
    select max(t.deal_amount) mx, min(t.deal_amount) mn, count(*) n
    from public.molit_transactions t, maxd
    where t.apt_seq = p.apt_seq and t.exclu_use_ar = p.exclu_use_ar and t.deal_date <= maxd.d - p_days
  ) s
  left join public.molit_hist_peaks k
    on k.apt_seq = p.apt_seq and k.exclu_use_ar = least(round(p.exclu_use_ar * 100), 32767)::smallint
  where s.n + coalesce(k.n, 0) >= p_min_prior
),
```
(`greatest`/`least` 는 NULL 을 무시한다 — 원본에 직전 거래가 없고 이력에만 있는 쌍도 비교된다.)
- 적용 전 검증(읽기 전용): 새 본문을 함수가 아니라 **일반 SELECT 로** 돌려 `EXPLAIN (ANALYZE)` 실행 시간이 현재(실측 평균 4.7초)보다 **1초 이상 늘지 않는지**, 결과의 `highCount`·`lowCount` 가 위 실측(159·61 부근 — 날짜가 지나면 달라진다)과 같은 방향인지 확인한다. 늘면 적용하지 않고 보고.
- 적용 후: 앱 캐시가 최대 30시간(Redis) 남는다 → `priceRecordsService` 의 캐시 키 버전을 올리는 코드 변경(아래 기록 작업)에 포함.
- 되돌리기: 두 함수를 `supabase/schema.sql` 의 현재 정의로 `CREATE OR REPLACE`, `DROP TABLE public.molit_hist_peaks;`.

## 적용 후 기록 (실행자 — haiku)
- `supabase/migrations/20260920_price_records_6y_baseline.sql`(적용 기록: ①② 원문 + 실측 수치) · `supabase/schema.sql`(테이블 추가 + 두 함수 정의를 `pg_get_functiondef` 결과로 교체 — 리뷰어가 원문을 계획서 부록으로 붙여 준다).
- `backend/services/priceRecordsService.js`: 캐시 키(`CK`·`CK_REGION`·`CK_LAST` 류)의 버전 접미를 1 올린다(옛 기준선 결과가 30시간 남지 않게). 키 이름은 파일에서 확인.
- 사용자 문구는 바꾸지 않는다(이미 `sinceDate` 를 그대로 보여 준다) — 단, `index.html:5593` 부근 주석 "우리 적재는 sinceDate(2025-05-01 실측)부터다" 를 "2020-09-01(이력 포함, Plan 103)" 로 고친다.
- `npm run verify` `fail 0`. 커밋: `feat(경신): 최고·최저 경신 기준선을 2020-09 이후 이력까지 확장 — 요약 테이블 molit_hist_peaks (Plan 103)`.

## 이후(Plan 104 와의 관계)
원본의 오래된 달을 이력으로 옮기는 순환 보관(104)을 만들 때, 옮기는 달의 (단지, 면적)별 최고·최저·건수를 `molit_hist_peaks` 에 **증분 upsert** 하면 이 함수들은 원본을 줄여도 그대로 동작한다 — 104 의 선행 조건 하나가 이 계획으로 해소된다.

## STOP 조건
- 101 이 적용되지 않아 Supabase 기준 DB 크기가 470 MB 이상이다 → 실행하지 않는다.
- 적용 전 검증에서 실행 시간이 1초 이상 늘거나 8초에 근접한다 → 적용하지 않고 실행 계획을 보고.
