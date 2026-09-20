# 111 — DB 용량을 "관리 가능"하게: 시계열 기록 + 테이블별 급증·autovacuum 정지 감시

**작성 기준 커밋**: `1af564e` (2026-09-20) · 근거: `plans/104-db-capacity-management.md` §8.4 · **의존**: 105(용량 측정식·경보) 배포 완료 상태를 전제로 한다
**왜 지금**: 425 MB(85% 경보) 도달 예상이 **2026-10-24~29**(약 5주)다. 그 전에 "얼마나 빨리 차고 있는가" 를 **숫자로** 볼 수 있어야 Plan 107 의 착수 시점과 창 크기를 감으로 정하지 않는다.

## 전제 확인 (계획자가 코드·프로덕션으로 확인 — 2026-09-20)
- `backend/routes/cron.js:190-208` `checkDbCapacity()` 는 `rpc('get_db_size_bytes')` 로 재서 **임계(85/93%)에서만** Sentry 로 보낸다. 반환값 `{ usedMb, limitMb, level }` 은 **어디에도 저장되지 않고 버려진다**.
- 호출 위치는 **POST `:235`·GET `:283` 쌍둥이 양쪽**에 정상 배선돼 있다(105 가 한 일). 그러나 둘 다 `recordCronRun('retention', summary)`(`:217`)**보다 뒤**라, 지금 구조로는 잰 값을 retention 요약에 실을 자리가 없다.
- `cronStats._pick()` 은 `NUM` 화이트리스트에 든 **숫자 키만** 통과시킨다(`backend/services/cronStats.js:34-`). Plan 110 이 같은 이유로 평탄화 키를 추가했다.
- `pg_stat_user_tables` 는 PostgREST 로 직접 못 읽는다 → 테이블별 통계는 `get_db_size_bytes` 와 같은 **`SECURITY DEFINER` 함수**가 필요하다(**DDL = 운영자 승인 필요**).
- 현재 감시가 못 잡는 것(§8.4 실측): ① 용량 시계열 ② 테이블별 급증 ③ **autovacuum 정지** — `apt_geocache` 가 `last_autovacuum = 2026-08-22`(29일 전)로 멈춰 죽은 튜플 14.04% 인데 어떤 신호로도 안 보였다 ④ 인덱스 부풀음 재발.

## 범위
**건드릴 파일**: `backend/routes/cron.js` · `backend/services/cronStats.js` · `backend/test/db-capacity-observability.test.js`(신규) · (2단계) `supabase/schema.sql` · `supabase/migrations/20260921_db_table_stats.sql`(신규)
**건드리지 말 것**: `backend/jobs/retention.js`(110 이 방금 바꿨다) · `backend/server.js` 의 health `db` 블록(105 가 확정) · `dbCapacityLevel()` 의 임계 상수 85/93 · 다른 cron 핸들러.

---

## 1단계 — 용량 시계열을 health 에 남긴다 (코드만 · DB 변경 0 · 승인 불필요)

### Step 1-1. `checkDbCapacity()` 를 `recordCronRun` **앞으로** 옮기고 결과를 요약에 싣는다
`backend/routes/cron.js` POST `/retention` 핸들러에서:
- `:235` 의 `await checkDbCapacity(); // Plan 105 — DB 용량 감시` 줄을 **삭제**하고,
- `:213` `const summary = await runRetention();` **바로 뒤**에 다음을 넣는다:

```js
// DB-CAPACITY-SERIES-2026-09-21 (Plan 111): 종전엔 checkDbCapacity() 가 recordCronRun 뒤에 있어
//   잰 값이 그대로 버려졌다 — "지난달 대비 얼마나 늘었나" 를 물을 수단이 없었다(plans/104 §8.4).
//   측정을 앞으로 당겨 retention 요약에 실어 cronStats 에 남긴다. 실패해도 retention 은 계속 간다.
const _cap = await checkDbCapacity();
if (_cap && Number.isFinite(_cap.usedMb)) {
  summary.dbUsedMb = _cap.usedMb;
  summary.dbPct = Math.round((_cap.usedMb / _cap.limitMb) * 100);
}
```

**GET 쌍둥이(`:283` 부근)에도 똑같이 적용한다.** 이 저장소는 쌍둥이 한쪽만 고쳐 라이브에서 안 먹은 사고가 반복됐다(094·105 기록). 두 핸들러 모두에서 `checkDbCapacity()` 호출이 **정확히 1회씩** 남아야 한다.

### Step 1-2. `cronStats.js` 의 `NUM` 에 키 2개 추가
`backend/services/cronStats.js` 의 `NUM` 배열에, Plan 110 이 추가한 `'okPruned', 'staleRunningFixed'` 바로 아래에:

```js
    // DB-CAPACITY-SERIES-2026-09-21 (Plan 111): 용량 추세를 health 에 남긴다 —
    //   경보(85%)는 임계를 넘어야 울리므로, 그 전에 "차오르는 속도" 를 볼 지표가 따로 필요하다.
    'dbUsedMb', 'dbPct',
```

### Step 1-3. 테스트 (신규 `backend/test/db-capacity-observability.test.js`)
`backend/test/retention-observability.test.js` 를 패턴으로 삼되 **그 파일은 수정하지 마라**. 고정할 것:
1. `_pick({ dbUsedMb: 405.4, dbPct: 81 })` 가 두 키를 **통과시킨다**.
2. `_pick({ db: { usedMb: 405.4 } })` 는 `usedMb` 를 통과시키지 **않는다**(중첩은 안 보인다 — 110 과 같은 회귀).
3. `cron.js` 소스 정적 단언: `checkDbCapacity()` 호출이 **정확히 2회**(쌍둥이 각 1회) 등장하고, 두 핸들러 모두에서 `recordCronRun` 보다 **앞선 위치**에 있다. (문자열 인덱스 비교로 충분하다 — `indexOf('checkDbCapacity()') < indexOf("recordCronRun('retention'")` 를 POST/GET 구간을 잘라 각각 검사)

### 1단계 완료 기준
```
npm run verify        → tests 448 이상 / fail 0   (현재 445 + 신규 3)
grep -c "checkDbCapacity()" backend/routes/cron.js   → 3   (정의 1 + 호출 2)
grep -c "dbUsedMb" backend/services/cronStats.js     → 1
```
배포 후 **다음 retention 회차(18:00 UTC)** 에 `/api/health` 의 `crons['retention']` 에 `dbUsedMb`·`dbPct` 가 보이면 성공. 안 보이면 `NUM` 등록이나 쌍둥이 배선을 다시 본다.

---

## 2단계 — 테이블별 급증·autovacuum 정지 감시 (**DDL 1문 = 운영자 승인 필요**)

### Step 2-1. 리뷰어가 적용할 DDL (운영자 승인 전에는 실행 금지)
```sql
CREATE OR REPLACE FUNCTION public.get_table_health()
RETURNS TABLE(relname text, total_mb numeric, dead_pct numeric, days_since_autovacuum integer)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select c.relname::text,
         round(pg_total_relation_size(c.oid)/1048576.0, 1),
         round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 2),
         extract(day from now() - greatest(s.last_autovacuum, s.last_vacuum))::integer
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_stat_user_tables s on s.relid = c.oid
   where n.nspname = 'public' and c.relkind = 'r'
     and pg_total_relation_size(c.oid) > 1048576
   order by pg_total_relation_size(c.oid) desc
$function$;
```
- **분모에 주의**: `n_dead_tup / (n_live_tup + n_dead_tup)` 이다. 2026-09-20 감사에서 에이전트 2개가 분모를 `n_live_tup` 만으로 잡아 14.04%를 16.33%로 과대 보고했다.
- 1 MB 미만 테이블은 제외한다(소음).
- 적용 기록은 `supabase/migrations/20260921_db_table_stats.sql` 에 **되돌리기 SQL(`DROP FUNCTION public.get_table_health();`)과 함께** 남긴다(Plan 026 관례).

### Step 2-2. `checkDbCapacity()` 안에서 두 가지를 더 본다
`rpc('get_table_health')` 를 부르고, 아래 조건에 걸리는 테이블이 있으면 **기존 용량 경보와 별개의 Sentry 메시지**(고정 문구 + `tags: { monitor: 'db-table-health' }`)로 보낸다:
- `dead_pct >= 20` **이고** `days_since_autovacuum >= 14` → `warning` (autovacuum 이 사실상 멈춘 테이블)
- 직전 회차 대비 `total_mb` 가 **+20% 이상** 증가 → `warning` (테이블별 급증). 직전 값은 `cronStats` 의 retention 기록에서 읽는다 — 새 저장소를 만들지 마라.
RPC 실패는 **삼키고 진행**한다(용량 경보 본체를 막으면 안 된다). 요약에는 `tableHealthWarns`(숫자)만 싣고 `NUM` 에 등록한다.

### Step 2-3. 테스트
스텁 `admin.rpc` 로 `get_table_health` 응답을 주입해 ① 임계 미만이면 Sentry 호출 0 ② `dead_pct 25 / days 30` 이면 정확히 1회 ③ RPC 가 throw 해도 `checkDbCapacity` 가 **예외를 밖으로 내보내지 않고** `usedMb` 는 그대로 반환하는지 고정.

---

## STOP 조건 (실행자는 아래에 해당하면 멈추고 보고하라)
1. `cron.js` 의 POST/GET 쌍둥이 구조가 위 설명과 다르면(예: 이미 한쪽이 리팩터됨) **추측해서 맞추지 말고 멈춰라**.
2. `npm run verify` 가 **기존 테스트**를 깨뜨리면 멈춰라. 특히 `backend/test/retention-observability.test.js`·`ingest-runs-retention.test.js`(Plan 110)는 **이 계획의 범위가 아니다** — 그 파일을 고쳐야 통과한다면 그 사실 자체를 보고하라(Plan 106↔110 에서 같은 충돌이 실제로 있었다).
3. 2단계 DDL 을 **네가 직접 실행하지 마라**. 공유 프로덕션 DB다 — 계획서에 SQL 만 남기고 리뷰어가 운영자 승인 후 적용한다.
4. Sentry 메시지 문구에 **측정값을 넣지 마라**(이슈가 매번 새 그룹으로 쪼개진다). 값은 `extra` 로 보낸다 — 105 가 세운 규약이다.

## 유지보수 메모
- 임계 상수(85/93, dead 20%, 14일, +20%)는 전부 **한 곳에** 상수로 두고 테스트에서 참조한다. 흩어지면 다음 사람이 한쪽만 고친다.
- 이 계획이 끝나면 `plans/104` §5 관리 규칙 6개 중 **규칙 3(적재 후 재측정)·6(분기 부풀음 점검)** 이 비로소 관측 가능해진다. 규칙 6 의 T0 기준선은 §8.4 에 고정돼 있다(`uq_molit_dedup` 59.09 B/행 · `molit_transactions_pkey` 22.51 B/행).
