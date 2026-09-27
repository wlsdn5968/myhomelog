# 107b-2 — 창 자르기 전 DDL 3건 + 코드 2건 (B1 MV · B5 경신 요약 증분 · B8 재시도 창/archived · B3 timeout 교정)

**작성 기준 커밋**: `74b6bdb` (2026-09-27) · 부모: `plans/107b-107c-window-cut-design.md` §1 · 선행: 107b-1(DONE 13d10b6) · **운영자 승인 2026-09-27**("권고대로 진행해줘. 승인할게" — 후속표 3번)
**성격**: 리뷰어가 DDL 을 순서대로 적용(각각 되돌리기 가능) → 실행자가 코드 2건 → 라이브 검증 → 그 뒤에야 107c-1.

## 전제 확인 (계획자 실측 — 2026-09-27)
- **B3 교정(이미 적용)**: `refresh_molit_apt_dim()` 이 실측 **37초**(02:33Z, 3,181행 갱신)라 PostgREST 8s 컷에 매일 실패했고, 오류 문자열은 `cronStats._pick` 이 버려 health 에 `dimRefreshed` 가 **없는 것**으로만 드러났다. `alter function … set statement_timeout = '120s'` 적용(`refresh_molit_apt_index` 와 같은 처방, `proconfig` 확인). 남은 코드 결함: 실패가 숫자로 안 남는다 → 아래 코드 2.
- **B5** `molit_hist_peaks(apt_seq, exclu_use_ar smallint ㎡×100, mx, mn, n)`, PK (apt_seq, exclu_use_ar). `get_price_records*` 의 기준선 `st` = 원본(창 안, `deal_date <= d − p_days`) 집계 + peaks — 달 M 을 원본에서 지우기 **전에** peaks 에 M 을 합쳐 두면 총합이 변하지 않는다(mx/mn 은 greatest/least 라 멱등, n 은 합산 — 삭제 전 잠깐 이중 계상되나 임계 판정에만 영향, 수 분).
- **B1** MV `molit_apt_index` 는 `FROM molit_transactions` 집계(`schema.sql:471`), 유일 인덱스 `uq_molit_apt_index(apt_name, lawd_cd, sigungu, umd_nm, build_year)`(`:465`), `refresh_molit_apt_index()` 가 `REFRESH … CONCURRENTLY`(`:839`, timeout 120s). 소비자: `search.js:234,246,386`(ilike·정렬·`_w=deal_count`)·`regionPage.js:107`·`aptPage.js:97,199`·`sitemap.js:118`(`deal_count>=3 & recent_deal_date>=1년`)·`interestWarm.js:31`·`chatDataRouter`. `molit_apt_dim` 은 27,798행(원본 22,672 + 복구 5,126)으로 **원본 apt_seq 의 상위집합**.
- **B8** `molitIngest.js:285` `retryFailedGaps(… lookbackMonths = 18)`·`:477` 호출부 `lookbackMonths: 18` — 창(16)보다 길어 옮긴 달의 error/timeout 기록을 재적재할 수 있다. `molit_ingest_runs_status_chk` = `('running','ok','error','skipped','timeout')`(110 에서 timeout 추가).

## DDL (리뷰어 · 순서 고정 · 각 단계 전후 측정)

### D1 — 경신 요약 증분 함수 (B5)
```sql
create or replace function public.upsert_hist_peaks_for_month(p_ym text)   -- 'YYYYMM'
returns integer language plpgsql set search_path to 'public' set statement_timeout to '120s' as $function$
declare n integer; d0 date := to_date(p_ym, 'YYYYMM'); d1 date := (to_date(p_ym, 'YYYYMM') + interval '1 month')::date;
begin
  insert into public.molit_hist_peaks (apt_seq, exclu_use_ar, mx, mn, n)
  select t.apt_seq, least(round(t.exclu_use_ar * 100), 32767)::smallint, max(t.deal_amount), min(t.deal_amount), count(*)
    from public.molit_transactions t
   where t.deal_date >= d0 and t.deal_date < d1 and t.apt_seq is not null
   group by 1, 2
  on conflict (apt_seq, exclu_use_ar) do update
     set mx = greatest(public.molit_hist_peaks.mx, excluded.mx),
         mn = least(public.molit_hist_peaks.mn, excluded.mn),
         n  = public.molit_hist_peaks.n + excluded.n;
  get diagnostics n = row_count; return n;
end $function$;
```
- 면적 변환 `least(round(exclu_use_ar*100),32767)::smallint` 는 `get_price_records` 의 조인 식과 **글자 단위로 같아야** 한다(다르면 조인이 빗나간다).
- 되돌리기: `drop function public.upsert_hist_peaks_for_month(text);`. 이 단계는 함수만 만들고 **호출하지 않는다**(호출은 107c-1 의 b).

### D2 — MV 를 `molit_apt_dim` 기반으로 (B1) — v2 생성 → 한 트랜잭션에서 교체
```sql
create materialized view public.molit_apt_index_v2 as
with g as (
  select d.apt_name, d.lawd_cd, d.sigungu, d.umd_nm, d.build_year,
         d.apt_seq, d.last_deal_date, d.deal_count as dim_count
    from public.molit_apt_dim d
   where d.apt_name is not null and d.lawd_cd is not null
), live as (
  select t.apt_seq, max(t.deal_date) as recent, count(*)::integer as cnt
    from public.molit_transactions t where t.apt_seq is not null group by t.apt_seq
)
select g.apt_name, g.lawd_cd, g.sigungu, g.umd_nm, g.build_year,
       greatest(max(l.recent), max(g.last_deal_date))                       as recent_deal_date,
       coalesce(sum(l.cnt), 0)::integer                                       as deal_count,       -- 원본 창 안 건수(랭킹·정렬·"최근 거래 N건")
       coalesce(sum(g.dim_count), 0)::integer                                 as deal_count_all,   -- 보존된 전체 건수(신규)
       (array_agg(g.apt_seq order by coalesce(l.recent, g.last_deal_date) desc nulls last))[1] as apt_seq
  from g left join live l on l.apt_seq = g.apt_seq
 group by g.apt_name, g.lawd_cd, g.sigungu, g.umd_nm, g.build_year;
create unique index uq_molit_apt_index_v2 on public.molit_apt_index_v2 (apt_name, lawd_cd, sigungu, umd_nm, build_year);
-- 측정: select count(*) from molit_apt_index_v2;  (기대 ≥ 23,017)  · pg_total_relation_size · 정의 검토
-- 교체(한 트랜잭션 — 독자는 커밋 전까지 옛 MV 를 본다):
begin;
  drop materialized view public.molit_apt_index;                 -- 옛 것(uq_molit_apt_index 도 함께)
  alter materialized view public.molit_apt_index_v2 rename to molit_apt_index;
  alter index public.uq_molit_apt_index_v2 rename to uq_molit_apt_index;
commit;
-- refresh_molit_apt_index() 는 이름으로 참조하므로 그대로. 첫 CONCURRENTLY 갱신 시간 측정(현재 13s).
```
- **NULL 키 주의**: 유일 인덱스는 NULL 을 서로 다른 값으로 본다 — 기존 MV 와 같은 성질이라 동작 동일. `g` 의 `where apt_name is not null and lawd_cd is not null` 로 이름 없는 행은 제외(dim 의 `apt_name` null 은 0건 실측).
- **의도된 의미 변화(B2 결정)**: `deal_count` 는 원본 창 안 건수(자르기 전에는 전 기간과 동일 → 오늘 값 변화 0). `deal_count_all` 은 새 컬럼 — 소비자 변경 없음(추가 컬럼은 `select` 목록에 없으면 무시된다).
- **오늘 즉시 효과**: 복구된 5,126 단지가 MV 에 들어와 **검색·자동완성·`/region` 주요 단지 후보**에 포함된다(사이트맵은 `recent_deal_date ≥ 1년` 필터로 제외 — B9). 이것은 117 의 마지막 조각이다.
- 되돌리기: 옛 정의(`schema.sql:471` 원문)로 같은 절차 역순.

### D3 — `archived` 상태 (B8)
```sql
alter table public.molit_ingest_runs drop constraint molit_ingest_runs_status_chk;
alter table public.molit_ingest_runs add constraint molit_ingest_runs_status_chk
  check (status = any (array['running'::text,'ok'::text,'error'::text,'skipped'::text,'timeout'::text,'archived'::text]));
```
(110 교훈: 코드가 쓰는 값은 CHECK 에 먼저.) 되돌리기: `'archived'` 뺀 배열로 재생성(그 값을 가진 행이 없을 때만).

## 코드 (실행자 · DB 변경 0)
1. **B8 lookback**: `backend/jobs/molitIngest.js:285` 기본값과 `:477` 호출부의 `lookbackMonths` 를 **16** 으로(상수 `WINDOW_MONTHS = 16` 을 한 곳에 두고 주석 `WINDOW-2026-09-27 (Plan 107b-2/B8): 원본 창(107c)과 같게 — 창 밖 달의 error/timeout 을 재적재하면 안 된다`). `retryFailedGaps` 의 `.in('status', ['error','timeout'])` 는 그대로(`archived` 는 자동 제외).
2. **B3 가시성**: `backend/routes/cron.js` `handleMolitIngest` 의 dim 갱신 블록에서 실패 시 `summary.dimRefreshFailed = 1`(성공 시 0) 을 추가하고 `cronStats.NUM` 에 `'dimRefreshFailed'` 등록. 문자열 `dimRefreshError` 는 로그로만(그대로).
3. `supabase/schema.sql` 정합: D1 함수 · D2 새 MV 정의(+`deal_count_all`, 인덱스 이름 유지) · D3 CHECK · `refresh_molit_apt_dim` 의 `set statement_timeout to '120s'` — **리뷰어가 적용한 SQL 과 글자 단위로**. 마이그레이션 기록 `supabase/migrations/20260927_window_safe_ddl.sql`(되돌리기 포함, 실측값 포함).
4. 테스트 `backend/test/window-safe-ddl.test.js`: ① `molitIngest.js` 에 `lookbackMonths: 18` 0회·`WINDOW_MONTHS = 16` 1회 ② `dimRefreshFailed` 가 NUM 에 있고 실패 분기에서 1 로 설정(스텁 rpc throw) ③ `schema.sql` 에 `upsert_hist_peaks_for_month`·`deal_count_all`·`'archived'::text` 각 1회 이상 ④ `frontend-contracts` 가 새 RPC 를 스냅샷에서 찾는다(기존 계약 테스트가 통과하면 됨).

## 완료 기준
DDL: D2 후 `count(*)` ≥ 23,017 · 복구 단지(예: `30200-736`)가 MV 에 있음 · `refresh_molit_apt_index()` 실측 시간 ≤ 60s · `search` API 로 복구 단지 이름 검색 시 결과에 포함. 코드: `npm run verify` 기준선(그때의 master) + 4. 배포 후 다음 적재(17:45Z)에 `dimRefreshed` 숫자·`dimRefreshFailed: 0`.

## STOP 조건 (실행자)
- DDL 을 직접 실행하지 마라. `schema.sql` 은 리뷰어가 보고한 **적용 SQL** 로만 맞춘다.
- `search.js` 의 `_w`·정렬·사이트맵 필터를 바꾸지 마라(B2·B9 결정은 "유지").
- `lookbackMonths` 외 `retryFailedGaps` 로직을 건드리지 마라.

## 적용 기록 (2026-09-27)
- DDL: `20260927_refresh_molit_apt_dim_timeout`(02:34Z) · D1 `20260927_upsert_hist_peaks_for_month`(02:39Z) · D2 `20260927_molit_apt_index_v2_create`(02:39Z) → `20260927_molit_apt_index_v2_swap`(02:41Z) · D3 `20260927_ingest_runs_archived_status`(02:39Z). 실측: MV 23,061행/5.59MB → **27,780행/4.96MB**, `refresh_molit_apt_index()` 13s → **3.2s**, 복구 단지 30200-736 검색 편입, `43114-58` 건수 59=59.
- ⚠ MV 는 **같은 문장에서 refresh + select 를 못 한다**(55006) — 갱신은 단독 문장으로. deal_count 가 달라진 740그룹은 전부 v2 가 큼(옛 MV 의 이름 표기 분열을 dim 최신 이름으로 합침).
- 코드: fc6d704 (506 pass) — `WINDOW_MONTHS = 16` · `dimRefreshFailed` 0/1 + NUM · `search.js` 4곳 `deal_count_all` 선택, `_n`(0 허용)/`_nAll`, 응답 `dealCountAll` · 프론트 시트 메타 "이력 N건" 폴백 · `supabase/migrations/20260927_window_safe_ddl.sql` · `window-safe-ddl.test.js`. STOP 조건 "`_w`·정렬·사이트맵 필터 유지" 는 계획자가 검색 "1건" 지어내기 결함을 발견해 **표시 건수만** `_n` 으로 분리하는 것으로 좁혀 승인(정렬 가중치 `_w` 는 유지).
- 라이브: 시티팰리스9차 `dealCount 0 / dealCountAll 146`. 17:45Z 회차 `dimRefreshed` 숫자·`dimRefreshFailed: 0` 은 시간 게이트라 미확인.
