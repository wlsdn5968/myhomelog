# 117 — 이력 전용 5,444단지 이름 복구(107a-2 · 114 P6): 공개 페이지 +34%

**작성 기준 커밋**: `ea33610` (2026-09-26) · 부모: `plans/107a-apt-dim-preservation.md` §6 · `plans/114` P6 · **운영자 승인 2026-09-26**("권고대로 진행해줘. 승인할게" — 후속표 6번)
**한 줄 요약**: `molit_transactions_hist` 에만 있는 단지 5,444개(거래 30,815건)는 협폭 backfill 이 이름을 버려 `/apt/:seq` 가 404 다. **이미 동결된 hist backfill 의 빈 cron 슬롯 10개**로 MOLIT API 를 **2,748회**(7,000이 아니다) 다시 불러 `apt_seq → 이름·지번·준공연도` 만 `molit_apt_dim` 에 채운다. 무료 API · 저장 ≈ +0.33MB · 약 2일.

## 전제 확인 (계획자가 프로덕션·코드로 직접 확인 — 2026-09-26)
1. **대상 수(실측)**: 원본에 없고 이력에만 있는 `apt_seq` **5,444**(09-20 의 5,475 중 31곳은 그새 원본 거래가 생겨 살아남) · 거래 **30,815건** · 걸친 지역 **116** · 기간 2020-09~2025-04.
2. **필요 호출 수(실측)**: 각 단지의 **최근 거래월 하나**만 부르면 이름을 얻는다 → 서로 다른 (lawd_cd, deal_ym) 조합 **2,748**개. 그중 2,735개는 `molit_hist_runs`(7,000행)에 이미 기록된 조합이다(= 예전에 성공한 호출).
3. **재사용할 코드**: `backend/jobs/molitIngest.js:498` 이 `fetchRegionMonth(lawdCd, dealYm)` 를 export 한다 — 원본 적재기와 hist backfill 이 같이 쓰는 공용 fetch(페이징·릴레이·재시도 포함). 응답 행에 `aptSeq`·`aptNm`·`umdNm`·`jibun`·`buildYear`·`sggCd` 가 들어 있다(원본 적재가 그것으로 `molit_transactions` 를 채운다). **새 HTTP 클라이언트를 만들지 않는다.**
4. **빈 슬롯**: `vercel.json` 의 `/api/cron/molit-hist-backfill?slot=0..9`(19·21·23·1·3·5·7·9·11·13시 UTC, 하루 10회)가 지금 매번 `{stopped:true, reason:'complete', done:0, elapsedMs≈450}` 로 **아무 일도 안 하고 끝난다**(health 실측). 이 슬롯이 그대로 이 작업의 실행 창이 된다.
5. **시간 예산**: `molitHistBackfill.js:29` `TIME_BUDGET_MS = 235_000`(maxDuration 300s − 65s). 이력 region-month 평균 행수 ≈ 184(1,290,112 / 7,000) → 대부분 1페이지·1~2초. 슬롯당 ≈ 100~150 조합 → 2,748 / (10 × 100~150) ≈ **2~3일**(추정, 첫 슬롯 실측으로 보정).
6. **쓰기 대상**: `molit_apt_dim`(107a, RLS on·정책 0 → service_role 만) — `insert … on conflict (apt_seq) do nothing`(원본에서 채운 22,672행은 **절대 덮어쓰지 않는다**).
7. **렌더**: `aptPage.js` 의 `loadDimRow()`(107a)가 이미 `molit_apt_dim` 을 3번째 소스로 읽는다. 이름만 채우면 404 → 200 이 된다. 다만 그 페이지는 `getTransactionsByAptSeq(seq, 24)`(원본 24개월)가 비어 **"최근 거래 없음"** 카드가 뜬다 — §Step 3 참조.
8. **사이트맵**: `sitemap.js:118` 은 MV `molit_apt_index` 에서만 단지를 뽑는다 → 복구된 단지는 **페이지는 열리지만 사이트맵에는 안 실린다**. 이건 107b(MV 재정의) 범위. 이 계획은 페이지 복구까지만.

## 범위
**건드릴 파일**: `backend/jobs/aptDimNameRecovery.js`(신규) · `backend/routes/cron.js`(hist 슬롯 핸들러에서 complete 일 때 위 잡 호출) · `backend/services/cronStats.js`(NUM 키) · `backend/routes/aptPage.js`(Step 3 문구 분기 1곳) · `backend/test/apt-dim-name-recovery.test.js`(신규) · `supabase/migrations/20260926_apt_dim_recovery_queue.sql`(**적용 기록**)
**건드리지 말 것**: `molitHistBackfill.js`(동결 유지 — 이 잡은 그 파일을 수정하지 않고 **옆에서** 실행된다) · `molit_transactions`·`molit_transactions_hist`(읽기만) · `molit_apt_dim` 의 기존 행 · `sitemap.js`·MV(107b) · `vercel.json`(슬롯 재사용이라 변경 0)

---

## Step 0 — 리뷰어 전용 DDL: 작업 큐 (운영자 승인분 · 실행자 실행 금지)
큐를 테이블로 두는 이유: 슬롯이 하루 10번 끊겨 돌므로 "어디까지 했나" 를 DB 에 남겨야 한다(hist backfill 의 `molit_hist_runs` 와 같은 발상).
```sql
create table if not exists public.apt_dim_recovery_queue (
  lawd_cd     text not null,
  deal_ym     text not null,          -- 'YYYYMM'
  apt_seqs    integer not null,       -- 이 조합이 덮는 미복구 단지 수(우선순위)
  status      text not null default 'pending' check (status in ('pending','ok','error')),
  tried_at    timestamptz,
  names_found integer,
  error_message text,
  primary key (lawd_cd, deal_ym)
);
alter table public.apt_dim_recovery_queue enable row level security;   -- ⚠ 107a 교훈: 같은 문단에

-- 채움: 각 미복구 단지의 최근 거래월 → (지역,월) 조합 2,748개. 덮는 단지 수가 많은 조합부터.
insert into public.apt_dim_recovery_queue (lawd_cd, deal_ym, apt_seqs)
with live as (select distinct apt_seq from public.molit_transactions where apt_seq is not null),
     dim  as (select apt_seq from public.molit_apt_dim),
     miss as (
       select h.apt_seq, max(h.deal_date) as last_deal
         from public.molit_transactions_hist h
        where h.apt_seq is not null
          and not exists (select 1 from live l where l.apt_seq = h.apt_seq)
          and not exists (select 1 from dim  d where d.apt_seq = h.apt_seq)
        group by h.apt_seq)
select split_part(apt_seq,'-',1), to_char(last_deal,'YYYYMM'), count(*)
  from miss group by 1,2
on conflict do nothing;
-- 검증: select count(*), sum(apt_seqs) from public.apt_dim_recovery_queue;  → 2,748 · 5,444 (실측 시점 값)
```
되돌리기: `drop table public.apt_dim_recovery_queue;`. 적용 기록은 `supabase/migrations/20260926_apt_dim_recovery_queue.sql`.

## Step 1 — 잡 `backend/jobs/aptDimNameRecovery.js` (실행자)
```
runAptDimNameRecovery({ timeBudgetMs = 200_000 })
  1. queue 에서 status='pending' 을 apt_seqs desc 로 최대 300개 읽는다.
  2. 각 (lawd_cd, deal_ym) 에 대해 fetchRegionMonth(lawd_cd, deal_ym) 호출(molitIngest.js export).
     - 응답 행에서 aptSeq 가 있는 것만 { apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun } 로 정규화
       (원본 적재기가 같은 응답에서 molit_transactions 컬럼을 만드는 정규화 코드를 **그대로 재사용**하라 — 이름 정제 규칙이 갈리면 안 된다).
     - apt_seq 별 1행(같은 응답 안에서 가장 최근 거래일의 값).
     - molit_apt_dim 에 upsert … on conflict (apt_seq) do nothing  (배치 1회).
     - first_deal_date/last_deal_date/deal_count 는 이력 테이블로 채운다: select min,max,count from molit_transactions_hist where apt_seq in (...)  (같은 배치 안 1회 조회).
     - queue 행을 ok(names_found=n) 또는 error(error_message) 로 갱신.
  3. 시간 예산 초과·연속 오류 5회면 중단. 요약 { processed, ok, err, namesInserted, remaining, elapsedMs } 반환.
```
- `molitIngest.js` 의 `molitErrReason(e)`(export 됨)로 오류 분류를 재사용하라.
- **원본 적재기(molitIngest)가 도는 17:00~19:00 UTC 슬롯과 겹치지 않는다**(hist 슬롯은 19:20 부터). 그래도 `fetchRegionMonth` 의 릴레이/재시도 정책을 바꾸지 마라.

## Step 2 — 슬롯 핸들러 배선 (`backend/routes/cron.js`)
`/api/cron/molit-hist-backfill` 핸들러에서 `runHistBackfill()` 결과가 `{ stopped: true, reason: 'complete' }` 일 때만 `runAptDimNameRecovery({ timeBudgetMs: 200_000 })` 를 **이어서** 호출하고, 그 요약을 `recordCronRun('apt-dim-recovery', summary)` 로 **별도 이름**으로 기록한다(hist 기록과 섞지 않는다). `cronStats.NUM` 에 `namesInserted`·`remaining` 추가. 큐가 비면(`remaining: 0`) 아무것도 안 하고 `{ done: true }`.
⚠ POST/GET 쌍둥이가 있으면 **둘 다**.

## Step 3 — 복구된 페이지의 정직한 문구 (`backend/routes/aptPage.js`)
dim 만 있고 원본 24개월 거래가 없는 단지는 지금 "최근 거래 없음 — 최근 24개월 안에 신고된 거래가 없어요" 카드가 뜬다. 이 문구는 사실이지만 **이력이 있다는 것을 안 알려준다**. `idx` 가 dim 에서 왔고(`loadDimRow` 반환값에 `_fromDim: true` 플래그 추가) `deal_count > 0` 이면 그 카드 아래 한 줄을 붙인다:
`2020.09 이후 이력 {deal_count}건 · 마지막 거래 {last_deal_date} — 아래 장기 추세에서 볼 수 있어요` (장기 추세 = Plan 102 `/api/transactions/history` 가 이미 hist 를 읽는다). **값을 지어내지 않는다** — 숫자는 전부 dim 행에서.

## Step 4 — 테스트 (신규 `backend/test/apt-dim-name-recovery.test.js`)
스텁 `fetchRegionMonth`(require.cache 로 `molitIngest` 교체)와 스텁 admin 으로:
1. 응답 행 → dim upsert payload 의 키가 정확히 `apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun, first_deal_date, last_deal_date, deal_count` 이고 `on conflict … do nothing` 옵션(`ignoreDuplicates: true` 또는 저장소가 쓰는 동등 표현)이 켜져 있다 — **기존 22,672행을 덮지 않는다**는 계약.
2. fetch 가 throw 하면 그 큐 행만 error 로 가고 다음 행으로 진행한다(연속 5회면 중단).
3. 시간 예산을 넘기면 남은 행은 pending 으로 남고 `remaining` 이 정확하다.
4. `cron.js` 정적 단언: hist 핸들러 POST/GET 각각에서 `runAptDimNameRecovery` 호출이 정확히 1회.

## 완료 기준
```
npm run verify                                       → 기준선 + 4 / fail 0
grep -c "runAptDimNameRecovery" backend/routes/cron.js  → 3 (require 1 + 호출 2) 또는 실제 값 보고
```
배포 후 리뷰어(첫 슬롯 19:20Z 뒤): `health.crons['apt-dim-recovery']` 에 `processed/ok/namesInserted/remaining` · DB `select status, count(*) from apt_dim_recovery_queue group by 1` · `select count(*) from molit_apt_dim` 이 22,672 에서 늘었는지 · 복구된 단지 하나(예: 큐 1순위 조합의 apt_seq)의 `/apt/:seq` 가 **200** 이고 Step 3 문구가 보이는지.

## STOP 조건
1. `fetchRegionMonth` 의 응답 행에 `aptSeq`/`aptNm` 필드명이 계획과 다르면 — `molitIngest.js` 의 정규화 코드에서 **실제 필드명을 읽어** 맞추되, 못 찾으면 멈춰라.
2. `molit_apt_dim` 기존 행이 덮이는 코드 경로가 생기면 멈춰라.
3. DDL 을 직접 실행하지 마라(Step 0 은 리뷰어).
4. `molitHistBackfill.js`·`vercel.json` 을 고쳐야 할 것 같으면 멈춰라 — 슬롯은 그대로 재사용하는 설계다.
