# 107a — 단지 차원 보존 테이블 `molit_apt_dim` + `/apt/:seq` 3번째 소스 (창 자르기의 **선행조건**)

**작성 기준 커밋**: `d6e6206` (2026-09-20) · 부모: `plans/107-molit-rolling-archive.md`(부록 A-2 의 **A2-1**) · **운영자 승인 2026-09-20**("권고대로 진행해줘. 승인할게" — 후속표 3번)
**한 줄 요약**: 원본을 16개월 창으로 자르면 `/apt/:seq` 가 **404 + `noindex`** 로 사라진다. 자르기 **전에** 단지의 이름·지번·준공연도를 별도 차원 테이블에 떠내고, 페이지가 그것을 읽게 만든다. **오늘 배포해도 사용자 눈에 보이는 변화는 0** — 배선만 먼저 깐다.

---

## 전제 확인 (계획자가 프로덕션·코드·라이브로 직접 확인 — 2026-09-20)
1. **`/apt/:seq` 는 두 소스가 동시에 비면 404 다.** `backend/routes/aptPage.js:118-123`:
   ```js
   try { idx = await loadIndexRow(seq); } catch (e) { ... }                    // MV molit_apt_index
   try { txs = await svc.getTransactionsByAptSeq(seq, 24); } catch (e) { ... } // 원본 24개월, 라이브 폴백 없음
   if (!idx && (!txs || !txs.length)) return null;
   ```
   `return null` → `:318-324` 에서 `res.status(404)` + `noindex: true` + 본문 *"이 단지의 실거래 기록이 없어요. 값을 지어내지 않고 비워둡니다."*
2. **두 소스 모두 원본 `molit_transactions` 에서만 나온다.** MV 정의(`supabase/schema.sql:456-466`)는 `FROM molit_transactions` 뿐이고 이력을 참조하지 않는다.
3. **이 결함은 미래형이 아니라 현재형이다.** 실측: `molit_transactions_hist` 에만 있고 원본에는 없는 `apt_seq` 가 **5,475개**(거래 **30,962건**). 라이브 확인 — `/apt/31140-349`(271건, 최종 2021-03-16) · `/apt/11380-11371`(252건) · `/apt/41220-15`(200건) 전부 **HTTP 404**. 같은 시각 `/apt/11500-10189` 는 200.
4. **⚠ 그 5,475개는 이름을 되찾을 수 없다.** `molit_transactions_hist` 는 **`apt_seq, deal_date, exclu_use_ar, deal_amount, floor` 5컬럼뿐**이다(`information_schema` 실측). 협폭 backfill 이 `aptNm` 을 버렸고, `apt_master` 와는 `apt_seq` 로 이을 키가 없다. **§6 을 반드시 읽어라 — 이 계획은 그 5,475개를 살리지 않는다.**
5. 원본에는 필요한 컬럼이 전부 있다: `apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, jibun`. 현재 원본의 서로 다른 `apt_seq` 는 **22,672개**.
6. 부록 A 의 0단계 결론: 이름 매칭 보조 조회 6곳(`aptFacilityService.js:127`·`geocodeCacheService.js:395`·`geocacheBackfill.js:244`·`buildingRegisterService.js:68`·`search.js:577`·`:1043`)이 **날짜 하한 없이** 원본에서 지번·준공연도를 찾는다 → 보존 테이블에 **`jibun` 과 `build_year` 가 반드시 들어가야 한다**.

## 범위
**건드릴 파일**: `backend/routes/aptPage.js` · `backend/test/apt-dim-fallback.test.js`(신규) · `supabase/schema.sql` · `supabase/migrations/20260920_molit_apt_dim.sql`(신규, **적용 기록**)
**건드리지 말 것**: MV `molit_apt_index` 의 정의(107b) · `backend/routes/search.js`·`sitemap.js`·`regionPage.js`(107b) · `transactionService.js` · 원본 테이블의 어떤 행도 **삭제하지 마라**(창 자르기는 107c 다 — 이 계획은 **아무것도 지우지 않는다**).

---

## Step 0 — 리뷰어 전용 DDL (실행자는 실행 금지 · 운영자 승인분)
```sql
-- 차원 테이블: apt_seq 하나당 1행. 좁게 유지한다(현재 22,672행 × ≈60B + PK ≈ 1.5~2MB).
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

-- 채움/갱신: 원본에서 apt_seq 별 최신 1건의 이름·지번을 떠낸다.
--   ⚠ 이름은 시간에 따라 바뀔 수 있으므로(개명·표기 변경) **가장 최근 거래의 값**을 권위로 삼는다.
--   ⚠ 원본에 없어진 apt_seq 의 행은 **지우지 않는다** — 그게 이 테이블의 존재 이유다.
create or replace function public.refresh_molit_apt_dim()
returns integer language plpgsql security definer set search_path to 'public' as $function$
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

select public.refresh_molit_apt_dim();   -- 최초 채움
```
- **`where` 절이 붙은 `do update`** 인 이유: 주간 갱신이 **바뀐 행만** 쓰게 하기 위해서다. 통째 upsert 는 `apt_master` 가 힙의 절반을 빈 공간으로 들고 있던 원인이었다(`plans/104` 관리규칙 4).
- `first/last_deal_date`·`deal_count` 에 `least/greatest` 를 쓴 이유: 창을 자른 뒤에는 원본의 집계가 **줄어든다** — 보존 테이블이 과거 최대치를 잊으면 안 된다.
- 되돌리기: `drop function public.refresh_molit_apt_dim(); drop table public.molit_apt_dim;`
- 적용 기록을 `supabase/migrations/20260920_molit_apt_dim.sql` 에 되돌리기 SQL 과 함께 남긴다(Plan 026 관례).

**검증(리뷰어)**
```sql
select count(*) as rows, count(*) filter (where apt_name is null) as no_name,
       count(*) filter (where jibun is null) as no_jibun,
       round(pg_total_relation_size('public.molit_apt_dim')/1048576.0,2) as mb
  from public.molit_apt_dim;
-- 기대: rows 22,672 · mb 2 이하. no_name/no_jibun 은 0 이 아닐 수 있다(원본에 없는 단지) — 값만 기록.
select (select round(sum(pg_database_size(datname))/1048576.0,1) from pg_database) as db_mb;  -- 405.4 → 407 대 예상
```

---

## Step 1 — `/apt/:seq` 가 차원 테이블을 3번째 소스로 읽는다 (실행자)

`backend/routes/aptPage.js` 의 `loadIndexRow`(`:97-108`) 바로 아래에 새 함수를 추가한다:

```js
// APT-DIM-FALLBACK-2026-09-20 (Plan 107a): MV(molit_apt_index)도 원본 24개월 조회도 원본
//   molit_transactions 만 본다 — 원본을 16개월 창으로 자르면(107c) 창 밖 단지의 페이지가
//   404 + noindex 로 **사라진다**(aptPage.js:123 → :318). 자르기 전에 이름·지번을 떠낸
//   molit_apt_dim 을 3번째 소스로 깔아 둔다. 오늘은 dim 이 원본의 상위집합이라 동작 변화가 없다.
async function loadDimRow(aptSeq) {
  const { getSupabaseAdmin } = require('../db/client');
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from('molit_apt_dim')
    .select('apt_seq, apt_name, lawd_cd, sigungu, umd_nm, build_year, last_deal_date, deal_count')
    .eq('apt_seq', aptSeq)
    .limit(1);
  if (error) { logger.warn({ err: error.message, aptSeq }, '/apt 차원 조회 실패'); return null; }
  const r = (data || [])[0];
  if (!r) return null;
  // loadAptFacts 가 idx 와 같은 모양으로 쓰도록 컬럼명을 MV 에 맞춘다.
  return { ...r, recent_deal_date: r.last_deal_date };
}
```

`loadAptFacts`(`:118-123`)를 아래처럼 바꾼다. **`idx` 가 이미 있으면 dim 을 조회하지 마라**(왕복 낭비):

```js
  let idx = null, txs = null;
  try { idx = await loadIndexRow(seq); } catch (e) { logger.warn({ err: e.message, seq }, '/apt 인덱스 예외'); }
  try { txs = await svc.getTransactionsByAptSeq(seq, 24); } catch (e) { logger.warn({ err: e.message, seq }, '/apt 거래 예외'); }
  // APT-DIM-FALLBACK-2026-09-20 (Plan 107a): MV 에 없을 때만 차원 테이블을 본다.
  if (!idx) { try { idx = await loadDimRow(seq); } catch (e) { logger.warn({ err: e.message, seq }, '/apt 차원 예외'); } }
  if (!idx && (!txs || !txs.length)) return null;
```

**그 아래 `loadAptFacts` 본문은 한 줄도 바꾸지 마라.** `idx` 에서 `lawd_cd`·`sigungu`·`apt_name`·`umd_nm`·`build_year` 를 꺼내 쓰는 로직이 그대로 동작한다(`loadDimRow` 가 같은 키를 돌려주므로).

### ⚠ 실행자가 조심할 것
- `stat` 계산(`:336` 부근 `analyzeTransactions`)은 `txs` 가 있을 때만 돈다. dim 만 있고 거래가 없으면 `stat` 은 `null` 이고 페이지는 **거래 숫자 없이** 렌더된다 — 그게 의도다. **값을 지어내지 마라.**
- `:349` 의 `최근 24개월 ${stat.dealCount}건` 같은 문구는 `stat` 이 있을 때만 나오는 자리이므로 건드릴 필요 없다. 건드리고 싶어지면 멈춰라.

## Step 2 — 테스트 (신규 `backend/test/apt-dim-fallback.test.js`)
스텁 `admin` 으로 다음 4가지를 고정한다. 각 단언에 **왜 필요한지** 한국어 주석을 달아라.
1. **MV 에 행이 있으면 `molit_apt_dim` 을 조회하지 않는다**(왕복 낭비 방지 — 스텁의 `from` 호출 테이블 목록에 `molit_apt_dim` 이 없어야 한다).
2. **MV 가 비고 거래도 비었지만 dim 에 행이 있으면 `loadAptFacts` 가 `null` 을 반환하지 않는다** — 이게 이 계획의 본질이다(창을 자른 뒤 404 가 안 나게).
3. **MV·거래·dim 셋 다 비면 여전히 `null`**(= 404). 없는 단지를 지어내면 안 된다.
4. **dim 조회가 예외를 던져도 `loadAptFacts` 가 밖으로 던지지 않는다**(페이지가 500 으로 죽으면 안 된다).

`loadAptFacts` 가 `module.exports` 에 없으면 **테스트용으로만** `module.exports._loadAptFacts = loadAptFacts;` 를 파일 맨 아래에 추가하라(이 저장소의 기존 관례 — `cron.js` 의 `_dbCapacityLevel`, `retention.js` 의 노출 방식과 같다).

## Step 3 — `supabase/schema.sql` 정합
Step 0 의 `create table` 과 `create or replace function` 을 **이미 적용된 상태의 스냅샷**으로 반영한다. 테이블은 다른 `create table` 들과 같은 구역에, 함수는 `refresh_molit_apt_index` 근처에 알파벳/기존 배치 관례에 맞춰 넣어라. **다른 줄은 건드리지 마라**(이 파일은 과거에 드리프트로 문제가 된 적이 있다).

## 완료 기준
```
npm run verify   → tests 453 이상 / fail 0       (기준선 445 + 111 의 3 + 112 의 4 + 이 계획의 4 — 병합 순서에 따라 다르니 **실제 값을 보고**하라)
grep -c "molit_apt_dim" backend/routes/aptPage.js   → 2 이상
grep -c "molit_apt_dim" supabase/schema.sql         → 2 이상
```
**배포 후 리뷰어 확인**: `/apt/11500-10189` 가 여전히 **200**이고 본문이 종전과 같다(dim 배선이 정상 경로를 바꾸지 않았다는 증거). `/apt/31140-349` 는 **여전히 404** 여야 한다 — §6 참조.

---

## 6. 이 계획이 **하지 않는 것** (중요 · 운영자 판단 필요)
- **이력에만 있는 5,475개 단지는 이 계획으로 살아나지 않는다.** 이름이 DB 어디에도 없기 때문이다(전제 4). `molit_apt_dim` 은 **원본에 있는 22,672개**만 담는다.
- **이름 없는 페이지를 만들지 않는다.** `apt_seq` 앞자리로 `lawd_cd` 는 알 수 있으니 "강남구 (단지명 미등록)" 식 페이지 5,475개를 찍어낼 수는 있다. **하지 않는다** — 운영자가 Plan 090 에서 `(50-5)` 류 표기를 두고 *"너무 허접하잖아"* 라고 지적했고, 이름 없는 페이지 5,475개는 정확히 같은 불만을 5,475배로 만든다.
- **되살리려면 별도 계획(107a-2)이 필요하다**: `molit_hist_runs` 에 이미 기록된 7,000개 `(lawd_cd, deal_ym)` 쌍을 MOLIT API 로 **다시 조회해 `aptSeq → aptNm` 만 뽑아** dim 에 채운다. API 는 무료고 저장은 5,475행 ≈ 0.3 MB 다. 다만 7,000콜을 일일 슬롯에 나눠 돌려야 하고(Hobby cron), 이 계획의 범위 밖이다. **운영자 결정 사항으로 남긴다.**
- MV `molit_apt_index`·사이트맵·검색 랭킹(`deal_count`)의 창 대응은 **107b**, 실제 창 자르기는 **107c** 다.

## STOP 조건 (실행자)
1. **DDL 을 직접 실행하지 마라.** Step 0 은 리뷰어가 운영자 승인 하에 적용한다. 공유 프로덕션 DB다.
2. `molit_transactions` 나 `molit_transactions_hist` 의 **행을 지우거나 고치는 코드를 쓰지 마라.** 이 계획은 아무것도 지우지 않는다.
3. `loadAptFacts` 의 `idx`/`txs` 소비 로직(`:125` 이후)을 바꿔야 할 것 같으면 멈춰라 — `loadDimRow` 가 같은 키를 돌려주도록 만든 이유가 그것이다.
4. `npm run verify` 가 **기존 테스트**를 깨뜨리면 고치지 말고 멈춰서 보고하라(Plan 110·111·112 가 같은 시기에 테스트를 추가했다).
5. 404 페이지의 문구 *"이 단지의 실거래 기록이 없어요"* 를 고치고 싶어지면 멈춰라 — §6 의 5,475개 때문에 이 문구는 **사실과 다를 수 있지만**, 그 수정은 이름 문제와 함께 다뤄야 한다.
