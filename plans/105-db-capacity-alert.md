# 105 — DB 용량 감시를 Supabase 측정식으로 바로잡고 85% / 93% 에서 Sentry 경보 (94% 가 될 때까지 아무도 몰랐다)

**작성 기준 커밋**: `3501c49` (2026-09-20) · 우선순위 **P0(재발 방지)** · 작업량 S · 의존: 없음 · ⚠ Step 0 은 프로덕션 DDL(함수 2개 본문 교체) — 운영자 승인 후 리뷰어가 실행

## 전제 확인 (계획자가 프로덕션·코드로 확인)
- Supabase 무료 한도 500 MB 의 기준은 `sum(pg_database_size(datname))`(전 DB 합계, 공식 문서). 2026-09-20 실측: 합계 505,622,705 B(**482.2 MB**) vs `public.get_db_size_bytes()` 490,507,411 B(467.8 MB) — 함수 본문이 `select pg_database_size(current_database())` 라 **14.4 MB 작게** 나온다. `public.db_size_mb()`(backfill 정지용)도 같은 식.
- 라이브 `/api/health` → `"db":{"usedMb":468,"limitMb":500,"pct":94,"warn":true}`. `backend/server.js:521~538` `getDbUsage()` 가 RPC `get_db_size_bytes` 를 읽어 `warn: pct >= 80` 만 세운다(6h 캐시). **경보 발송은 없다.**
- 경보 패턴: `backend/routes/cron.js:87~111` `checkIngestFreshness()` — `Sentry.captureMessage(고정 메시지, { level, tags:{ route:'cron.retention', monitor:'…' }, extra:{…} })`, 실패는 `logger.warn` 으로 삼킴. retention 은 **POST(`:181`)·GET(`:233`) 쌍둥이**이고 계약 테스트 `backend/test/cron-observability.test.js:420~432` 가 양쪽에 `await checkCronStaleness()`·`await checkRegionIngestFreshness()` 가 있는지 본다(쌍둥이 한쪽만 고쳐 사고 난 전례).

## Step 0 — DDL (**리뷰어가 직접 실행한다 — 실행자는 건너뛴다**)
> 실행자에게: 아래 SQL 은 리뷰어가 프로덕션에 적용한다. 너는 Step 1~3(코드·테스트·기록)만 하고, 맨 아래 STOP 조건의 "Step 0 이 적용되지 않았다" 항목은 **무시**하라.
> ⚠ **`supabase/schema.sql` 은 `:541` 의 `get_db_size_bytes` 와 `:961` 의 `db_size_mb` 두 함수 본문만** 고친다(2026-09-20 기준 줄 번호 — grep 으로 재확인). 파일의 **다른 곳은 절대 건드리지 마라** — 다른 실행자가 같은 시각에 `:694`~`:723` 구간에 함수를 추가하고 있다.
```sql
CREATE OR REPLACE FUNCTION public.get_db_size_bytes() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select sum(pg_database_size(datname))::bigint from pg_database $function$;
CREATE OR REPLACE FUNCTION public.db_size_mb() RETURNS numeric LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$ select round(sum(pg_database_size(datname)) / 1048576.0, 1) from pg_database $function$;
-- 확인: select public.get_db_size_bytes(), public.db_size_mb();   → 합계 쿼리와 같은 값. 권한(EXECUTE)은 CREATE OR REPLACE 로 바뀌지 않는다.
```
(되돌리기: 본문을 `pg_database_size(current_database())` 로.)

## 범위 (실행자)
- 수정: `backend/routes/cron.js`(감시 함수 1 + 쌍둥이 양쪽 호출), `backend/server.js`(`getDbUsage` 임계·필드), `backend/test/cron-observability.test.js`(계약 단언 추가), `supabase/schema.sql`(두 함수 본문), 신규 `supabase/migrations/20260920_db_size_all_dbs.sql`(적용 기록), `backend/test/db-capacity-alert.test.js`.

## Step 1 — `backend/routes/cron.js`
`checkRegionIngestFreshness` 정의 **뒤**에 추가:
```js
// DB-CAPACITY-2026-09-20 (Plan 105): Supabase 무료 한도(500MB, 전 DB 합계 — 초과 시 읽기 전용)를 매일 본다.
//   2026-09-20 실사고: health 의 warn 플래그만 있고 경보가 없어 96%(482MB)가 될 때까지 아무도 몰랐다.
//   고정 메시지(이슈 그룹 유지) + 가변값은 extra. 실패는 삼킨다(감시가 retention 을 죽이면 안 된다).
const DB_CAPACITY_WARN_PCT = 85, DB_CAPACITY_ERROR_PCT = 93;
function dbCapacityLevel(usedMb, limitMb) {
  if (!(usedMb > 0) || !(limitMb > 0)) return null;
  const pct = (usedMb / limitMb) * 100;
  return pct >= DB_CAPACITY_ERROR_PCT ? 'error' : pct >= DB_CAPACITY_WARN_PCT ? 'warning' : null;
}
async function checkDbCapacity() {
  try {
    const { getSupabaseAdmin } = require('../db/client');
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data, error } = await admin.rpc('get_db_size_bytes');
    if (error || data == null) return null;
    const usedMb = Math.round(Number(data) / 1048576 * 10) / 10;
    const limitMb = parseInt(process.env.DB_LIMIT_MB || '500', 10);
    const level = dbCapacityLevel(usedMb, limitMb);
    if (level) {
      Sentry.captureMessage('cron 감시: DB 용량이 무료 한도에 근접 — 초과 시 읽기 전용(적재·저장 중단)', {
        level, tags: { route: 'cron.retention', monitor: 'db-capacity' }, extra: { usedMb, limitMb, pct: Math.round(usedMb / limitMb * 100) },
      });
      logger[level === 'error' ? 'error' : 'warn']({ usedMb, limitMb }, 'DB 용량 임계 초과');
    }
    return { usedMb, limitMb, level };
  } catch (e) { logger.warn({ err: e.message }, 'DB 용량 점검 실패(무시)'); return null; }
}
```
POST·GET 두 핸들러의 `await checkRegionIngestFreshness();` **바로 다음 줄**에 각각 `await checkDbCapacity(); // Plan 105 — DB 용량 감시` 추가. 파일 끝 `module.exports = router;` 뒤에 `module.exports._dbCapacityLevel = dbCapacityLevel; // 테스트용` 추가.

## Step 2 — `backend/server.js` `getDbUsage()`
`const out = { usedMb, limitMb, pct, warn: pct != null && pct >= 80 };` 를 `const out = { usedMb, limitMb, pct, warn: pct != null && pct >= 85, critical: pct != null && pct >= 93, basis: 'all-databases' }; // Plan 105: 측정식 = sum(pg_database_size) — Supabase 한도 기준` 로. (RPC 이름·캐시는 그대로.)

## Step 3 — 테스트
- `backend/test/db-capacity-alert.test.js`: `require('../routes/cron')._dbCapacityLevel` — `(424,500)`→`null`, `(425,500)`→`'warning'`, `(464.9,500)`→`'warning'`, `(465,500)`→`'error'`, `(0,500)`·`(100,0)`→`null`. (cron 라우트 로드가 env 없이 되는지는 기존 테스트들이 `require('../routes/cron')` 를 하는지 `grep -rn "routes/cron'" backend/test` 로 확인 — 안 되면 소스 계약(정규식으로 함수 본문을 잘라 `new Function`)으로 대체하고 보고.)
- `cron-observability.test.js` 의 쌍둥이 루프(`:426~432`) 안에 `assert.match(part, /await checkDbCapacity\(\)/, \`retention ${name} 에 DB 용량 감시가 없다\`);` 추가.
- `supabase/schema.sql` 의 두 함수 본문을 Step 0 과 같게 교체, 마이그레이션 기록 파일은 `supabase/migrations/20260916_molit_hist.sql` 형식("이미 프로덕션에 적용됨 — 적용 기록").

## 검증·완료 기준
- `npm run verify` `fail 0`(436 + 신규 ≥ 1). 회귀 주입: GET 핸들러의 `await checkDbCapacity();` 를 지우면 계약 테스트 fail.
- 리뷰어 라이브: `/api/health` `db.usedMb` 가 합계 쿼리 값과 일치, `basis:'all-databases'`. 다음 retention(18:00 UTC) 뒤 Sentry 에 `monitor:db-capacity` 이슈(현재 85% 이상이면 warning).
- 커밋: `feat(감시): DB 용량을 Supabase 측정식(전 DB 합계)으로 — 85%/93% Sentry 경보, retention 쌍둥이 양쪽 (Plan 105)`.

## STOP 조건
- Step 0 이 적용되지 않았다(리뷰어가 알려 준다) → 코드만 먼저 가도 동작은 하지만(14.4 MB 작게 봄) `basis` 문구가 거짓이 된다 → 멈추고 보고.
