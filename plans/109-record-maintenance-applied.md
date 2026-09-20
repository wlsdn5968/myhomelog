# 109 — 2026-09-20 프로덕션에 실제로 적용된 DB 작업을 저장소 기록과 일치시키기 (DB 는 건드리지 않는다)

**작성 기준 커밋**: `b0b7327` (2026-09-20) · 우선순위 P1(기록 정합) · 작업량 XS · **실행자는 DB·외부 API 를 절대 호출하지 않는다**

## 왜 필요한가
리뷰어가 운영자 승인 하에 오늘 프로덕션에 다음을 적용했다. 그런데 저장소 기록이 세 곳에서 현실과 어긋난다.
1. `supabase/migrations/20260920_prune_molit_ingest_runs.sql` 헤더가 **"미적용"** 이라고 적혀 있다(실행자가 커밋한 시점엔 사실이었다). 지금은 **적용됐다**.
2. `supabase/migrations/20260920_db_size_all_dbs.sql` 헤더에 SQL 과 무관한 문장("고정 메시지(이슈 그룹 유지) + 가변값은 extra. 실패는 삼킨다…" — 이건 JS 감시 함수 설명)이 섞여 있고, 되돌리기 SQL 과 실측값이 없다.
3. **유지보수 작업 자체가 어디에도 기록돼 있지 않다.** 특히 `molit_transactions` 의 테이블 스토리지 파라미터(`autovacuum_vacuum_scale_factor`)는 **영속 설정**인데 `supabase/schema.sql` 에 없다 → 스키마로 DB 를 재구성하면 조용히 사라진다.

## 실제로 적용된 것 (리뷰어 실측, 2026-09-20 11:4x~12:0x UTC)
| 작업 | 결과 |
|---|---|
| `ALTER TABLE public.molit_transactions SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)` | 발동 기준 94,510 → 9,496 죽은 튜플 |
| `VACUUM public.molit_transactions` | 죽은 튜플 35,379 → 0 · `get_price_records(7,3,6)` **9.3초 → 1.34초**(index-only scan 의 Heap Fetches 29,233 → 0) |
| `VACUUM FULL public.apt_master` | 49.9 → **27.9 MB** · 14,678행·facility 14,678·별칭 10,668 전부 보존 |
| `REINDEX INDEX CONCURRENTLY public.uq_molit_dedup` | 34.8 → **26.6 MB** |
| `REINDEX INDEX CONCURRENTLY public.molit_transactions_pkey` | 16.7 → **10.1 MB** (무효 인덱스 0 · `_ccnew` 잔여 0) |
| `SELECT public.prune_molit_ingest_runs(14)` | **36,274행 삭제** · 43,455 → 7,181행 · ok 를 가진 (지역,월) 쌍 **1,948 → 1,948**(불변) · ok 아닌 358행 전부 보존 |
| `VACUUM FULL public.molit_ingest_runs` | 9.6 → ≈ 1.2 MB |
| **합계** | **450.6 → 405.4 MB**(한도 500 의 81.1%) · `molit_transactions` 235.6 → 220.9 |
라이브 스모크(전부 HTTP 200): health `db {usedMb:405, pct:81, warn:false, critical:false, basis:'all-databases'}` · `dataCounts.tx` 472,302 불변 · 검색 "충무주공" 2건 · facility A43505004/2,489세대/818대 · `/api/transactions`(ok 기록 경로) 146건 · 경신 카드 2,517/159/61 · 인기 12건.

## Step 1 — `supabase/migrations/20260920_prune_molit_ingest_runs.sql` 헤더 교정
"미적용" 취지의 문장을 지우고 아래로 바꾼다(파일의 SQL 본문·되돌리기 SQL 은 그대로 둔다):
```
-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어가 운영자 승인 하에 execute_sql 로 실행). 이 파일은 적용 기록이다.
--   함수 생성: 2026-09-20 11:4x UTC · 첫 실행 SELECT prune_molit_ingest_runs(14) → 36,274행 삭제(43,455 → 7,181).
--   불변식 실측: ok 기록을 가진 (lawd_cd, deal_ym) 쌍이 삭제 전후 모두 1,948개 — 한 쌍도 잃지 않았다.
--   ok 아닌 358행(error·running)은 gap-retry 가 쓰므로 이 함수가 건드리지 않는다.
```

## Step 2 — `supabase/migrations/20260920_db_size_all_dbs.sql` 헤더 교정
JS 감시 함수를 설명하는 문장("고정 메시지(이슈 그룹 유지) + 가변값은 extra. 실패는 삼킨다…")을 **삭제**하고, 대신 아래를 헤더에 넣는다(SQL 본문은 그대로):
```
-- 2026-09-20 — 이미 프로덕션에 적용됨(리뷰어 실행). 적용 기록.
--   [왜] Supabase 무료 한도 500MB 의 기준은 **클러스터 전 DB 합계**(공식 문서 "Understanding Database and Disk Size")인데
--   두 함수는 current_database() 만 재서 14.4MB 작게 나왔다(template0 7.2 + template1 7.2).
--   [검증] 적용 후 get_db_size_bytes()·db_size_mb() 가 sum(pg_database_size(datname)) 와 같은 값을 돌려주고,
--          EXECUTE 권한은 둘 다 service_role 뿐으로 유지됨을 확인했다.
--   [되돌리기] 두 함수 본문을 각각 `select pg_database_size(current_database())` /
--              `select round(pg_database_size(current_database()) / 1048576.0, 1)` 로 되돌린다.
```

## Step 3 — 유지보수 기록 신규 파일 `supabase/migrations/20260920_maintenance_reclaim.sql`
헤더 형식은 위 두 파일과 같게("이미 프로덕션에 적용됨 — 적용 기록"), 본문에 위 **"실제로 적용된 것"** 표의 7개 명령을 실행 순서대로 SQL 로 적고, 각 줄 옆에 실측 전후 수치를 주석으로 단다. 맨 아래에 다음 주의를 적는다:
```
-- ⚠ VACUUM FULL·REINDEX 는 재실행해도 무해하지만 일시적으로 대상 크기만큼 여유 공간이 더 필요하다.
--    실행 전 SELECT round(sum(pg_database_size(datname))/1048576.0,1) FROM pg_database; 로 여유를 확인하고,
--    적재 창(17:00~19:00 UTC)과 apt-master-sync(월 20:00 UTC) 를 피한다.
-- ⚠ autovacuum 파라미터는 ALTER TABLE 로 테이블에 영속 저장된다 — 아래 schema.sql 항목과 함께 유지할 것.
```

## Step 4 — `supabase/schema.sql` 에 테이블 스토리지 파라미터 반영
`molit_transactions` 관련 선언이 있는 곳을 `grep -n "molit_transactions" supabase/schema.sql` 로 찾아, **그 테이블의 인덱스 선언들이 끝난 직후**에 한 줄 추가한다:
```sql
alter table public.molit_transactions set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
```
바로 위에 주석 한 줄: `-- AUTOVACUUM-2026-09-20 (Plan 106): 기본 임계(20% ≈ 94,510 죽은 튜플)에 못 미쳐 autovacuum 이 08-22 이후 0회였다 — 가시성 맵이 낡아 경신 집계가 콜드 9.3초(8초 제한 초과). 2% 로 낮춰 하루 한 번꼴로 돌게 한다.`
⚠ **파일의 다른 곳은 건드리지 마라.** 특히 `get_db_size_bytes`·`db_size_mb`·`prune_molit_ingest_runs` 함수 블록은 이미 맞게 기록돼 있다.

## 검증·완료 기준
- `npm run verify` → `fail 0`(현재 442 유지 — 새 테스트 없음. 스키마 스냅샷 테스트 포함).
- 정적: `grep -c "미적용\|적용 예정" supabase/migrations/20260920_prune_molit_ingest_runs.sql` = **0** · `grep -c "고정 메시지(이슈 그룹 유지)" supabase/migrations/20260920_db_size_all_dbs.sql` = **0** · `grep -c "autovacuum_vacuum_scale_factor" supabase/schema.sql` = **1** · `ls supabase/migrations/20260920_maintenance_reclaim.sql` 존재.
- `git diff --stat` 의 `supabase/schema.sql` 증감이 **+2 / −0 줄**(그 이상이면 다른 곳을 건드린 것 — 원복 후 STOP).
- 커밋 1개: `chore(db): 2026-09-20 유지보수 적용 기록 — VACUUM FULL·REINDEX·프루닝 36,274행·autovacuum 2% (Plan 109)`. 제목 다음 빈 줄, 마지막 줄에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## STOP 조건
- 두 마이그레이션 파일의 현재 헤더가 위 설명과 다르다 → 현재 내용을 인용해 보고 후 STOP.
- `schema.sql` 에서 `molit_transactions` 의 인덱스 선언 묶음을 특정할 수 없다 → 해당 구간을 인용해 보고 후 STOP.
