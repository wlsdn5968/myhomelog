# 120 — `supabase/schema.sql` 을 운영 DB 와 일치시킨다 (전수 대조 결과 4건)

**작성 기준 커밋**: `d209abc` (2026-09-28) · **출처**: `plans/README.md` 백로그 "schema.sql 이 실제 프로덕션과 일치하는지 미확정"(2026-09-06 라운드) · **운영자 승인 2026-09-28**("권고대로 진행해줘" — 후속표 4번)
**성격**: 문서(스냅샷) 동기화 XS + 적용 기록 파일 1개 + 정적 테스트 1파일. **DB 변경 0**(운영은 이미 이 상태다).

## 1. 대조 방법과 결과 (계획자 실측 2026-09-28 11:4xZ, 읽기 전용)
- 운영 카탈로그(`pg_class`·`pg_indexes`·`pg_proc`·`pg_policies`·`pg_constraint`) 목록 ↔ schema.sql 의 이름·정의를 양방향 대조.
- **일치**: 테이블 33개 전부 RLS on · 정책 42개 · 인덱스 41개(정의 문자열 정규화 비교) · 함수 16/18(공백 무시 md5) · MV `molit_apt_index`(핵심 토큰) · 배제 제약 `regulations_snapshot_no_overlap`(운영도 contype x).
- **불일치 4건** — 아래 §2 가 전부다.

## 2. 고칠 것 (실행자)
### 2-1. 옛 인덱스 정의 → 운영 정의 (`supabase/schema.sql:452`)
현재:
```sql
CREATE INDEX idx_molit_aptseq_area_date ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) WHERE (apt_seq IS NOT NULL);
```
바꿀 것(운영 `pg_indexes.indexdef` 글자 그대로):
```sql
CREATE INDEX idx_molit_aptseq_area_date_amt ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) INCLUDE (deal_amount) WHERE (apt_seq IS NOT NULL);
```
근거: `supabase/migrations/20260905_price_records_perf.sql` 이 옛 인덱스를 `_amt`(커버링)로 교체했고 운영에는 `_amt` 만 있다(`idx_molit_aptseq_area_date` 없음). 같은 줄 바로 위에 주석 1줄: `-- SCHEMA-SYNC-2026-09-28 (Plan 120): 운영 정의로 교체 — 옛 idx_molit_aptseq_area_date 는 20260905_price_records_perf 에서 _amt(INCLUDE deal_amount)로 바뀌었다.`

### 2-2. 이름 복구 큐 테이블 누락 — schema.sql 에 추가
Plan 117 이 2026-09-26 운영에 적용한 테이블이 schema.sql 에도 migrations 에도 없다. 운영 마이그레이션 이력(`supabase_migrations.schema_migrations`, version `20260926065942`, name `20260926_apt_dim_recovery_queue`)의 적용 SQL 중 **DDL 부분만** schema.sql 의 `molit_apt_dim` 정의 블록(현재 `:227` 부근 `create table if not exists public.molit_apt_dim`) 바로 뒤에 넣는다(주석 1~2줄 + 아래 글자 그대로):
```sql
-- APT-DIM-RECOVERY-QUEUE-2026-09-26 (Plan 117): 이력 전용 단지 이름 복구 작업 큐 — 2026-09-27 소진(2,748 조합 전부 ok).
create table if not exists public.apt_dim_recovery_queue (
  lawd_cd       text not null,
  deal_ym       text not null,
  apt_seqs      integer not null,
  status        text not null default 'pending' check (status in ('pending','ok','error')),
  tried_at      timestamptz,
  names_found   integer,
  error_message text,
  primary key (lawd_cd, deal_ym)
);
alter table public.apt_dim_recovery_queue enable row level security;
```
(운영 실측: 컬럼 7개·NOT NULL 3개+status·default `'pending'::text`·PK `(lawd_cd, deal_ym)`·CHECK `status = ANY (ARRAY['pending','ok','error'])`·RLS on·정책 0 — 위 DDL 과 일치.) 채움 `insert … select` 는 **넣지 않는다**(스냅샷 파일은 구조만).
그리고 **적용 기록 파일** `supabase/migrations/20260926_apt_dim_recovery_queue.sql` 을 새로 만든다 — Plan 117 계획서(`plans/117-hist-only-apt-names-recovery.md:17·53`)가 요구했지만 만들어지지 않았다. 형식은 `supabase/migrations/20260927_get_table_health_include_mv.sql` 의 머리말 박스(`-- ===`, [무엇인가]/[실측값]/[되돌리기 SQL])를 따르고, 본문은 운영 적용 SQL 전체(DDL + 채움 insert)를 **글자 그대로**(아래 §4 원문). 실측값: 적용 직후 2,748 조합·5,444 단지 · 2026-09-27 06:18Z 에 전부 `ok`(names_found 합 5,405 — 39단지는 MOLIT 응답에 없어 미복구). 되돌리기: `drop table public.apt_dim_recovery_queue;`.

### 2-3. 함수 본문 표기 차이 2건 — 운영 `pg_get_functiondef` 와 글자 단위로
- `prune_molit_ingest_runs`(`schema.sql` 해당 블록 끝): `END;` 줄을 `END $function$` 로 — 운영 본문은 `…RETURN n;\nEND $function$` 이다(세미콜론 없음). 바로 다음 줄의 `$function$` 은 지우고, 그 뒤 `;` 한 줄은 이 파일의 다른 함수 블록 관례대로 둔다. (동작 차이 없음 — 표기만.)
- `upsert_hist_peaks_for_month` 의 머리 줄 `CREATE OR REPLACE FUNCTION public.upsert_hist_peaks_for_month(p_ym text)   -- 'YYYYMM'` 에서 줄 끝 주석 `   -- 'YYYYMM'` 을 떼어 **바로 위 주석 블록 끝에** `--   p_ym 형식: 'YYYYMM'` 한 줄로 옮긴다.
- 확인: 고친 뒤 두 블록이 운영 정의와 공백 무시 md5 로 같아야 한다 — 운영 값 `prune_molit_ingest_runs = fe8ffe690a5b52a9303876765905ebad`, `upsert_hist_peaks_for_month = b1eb1c062004763027929c065b4552d7`. 계산: 블록(`CREATE OR REPLACE FUNCTION` 부터 두 번째 `$function$` 까지)을 `/\s+/g → ' '`·trim 한 문자열의 md5. 다르면 STOP 하고 차이를 보고.

### 2-4. 정적 테스트 `backend/test/schema-sql-prod-sync.test.js` (신규)
패턴: `backend/test/window-safe-ddl.test.js`(schema.sql 을 `fs.readFileSync` 로 읽어 정규식 계수). 단언:
1. `CREATE INDEX idx_molit_aptseq_area_date ON` 0회 · `CREATE INDEX idx_molit_aptseq_area_date_amt ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) INCLUDE (deal_amount) WHERE (apt_seq IS NOT NULL);` 1회.
2. `create table if not exists public.apt_dim_recovery_queue` 1회 · 그 뒤 `alter table public.apt_dim_recovery_queue enable row level security` 1회.
3. §2-3 두 함수 블록의 공백 무시 md5 가 위 운영 값과 같다(블록 추출 함수를 테스트 안에 둔다).
4. `supabase/migrations/20260926_apt_dim_recovery_queue.sql` 이 존재하고 `create table if not exists public.apt_dim_recovery_queue` 를 포함.
머리말 주석에 "운영 값은 2026-09-28 pg_catalog 실측 — 운영 함수가 바뀌면 이 테스트도 같은 커밋에서 갱신" 을 명시.

## 3. 하지 말 것 / STOP
- DB 도구·SQL 실행 금지. schema.sql 의 다른 블록 수정 금지(정렬·공백 정리 포함). 함수 본문 의미 변경 금지.
- 452행 외에 `idx_molit_aptseq_area_date`(접미사 없음)가 다른 곳에 **정의**로 있으면 STOP(주석 언급은 그대로 둔다).

## 4. 운영 적용 SQL 원문 (version 20260926065942 — 기록 파일 본문에 그대로)
```sql
-- Plan 117 Step 0 (운영자 승인 2026-09-26) — 이력 전용 단지 이름 복구 작업 큐.
--   각 미복구 단지의 최근 거래월 하나 → (지역,월) 조합 2,748개(실측). 하루 10슬롯(hist backfill 의 빈 슬롯)이
--   MOLIT API 를 다시 불러 apt_seq→이름·지번을 molit_apt_dim 에 채운다(on conflict do nothing — 기존 22,672행 불변).
-- 되돌리기: drop table public.apt_dim_recovery_queue;
create table if not exists public.apt_dim_recovery_queue (
  lawd_cd       text not null,
  deal_ym       text not null,
  apt_seqs      integer not null,
  status        text not null default 'pending' check (status in ('pending','ok','error')),
  tried_at      timestamptz,
  names_found   integer,
  error_message text,
  primary key (lawd_cd, deal_ym)
);
alter table public.apt_dim_recovery_queue enable row level security;   -- 107a 교훈: create table 과 같은 문단에

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
```

## 5. 완료 기준
`npm run verify` 전부 통과(526 + 신규). `git diff master --stat` = `supabase/schema.sql`, `supabase/migrations/20260926_apt_dim_recovery_queue.sql`(신규), `backend/test/schema-sql-prod-sync.test.js`(신규), `plans/120-schema-sql-prod-sync.md`(사본).
