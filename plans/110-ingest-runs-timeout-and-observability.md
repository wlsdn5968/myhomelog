# 110 — 적재 기록 정리가 조용히 전부 실패하고 있었다: `timeout` 을 금지하던 CHECK(DDL 적용 완료) + 실패가 health 에 안 보이는 구멍 + 1단계 실패가 2단계를 막는 구조

**작성 기준 커밋**: `bf92040` (2026-09-20) · 우선순위 **P0(방금 배포한 Plan 106 이 프로덕션에서 동작 못 함)** · 작업량 S · 발견: Plan 105/106 실행 전 적대 검증 워크플로(렌즈 1·5) → 리뷰어가 프로덕션에서 재확인

## 전제 확인 (리뷰어가 프로덕션·코드로 직접 확인 — 추측 아님)
1. **CHECK 가 `timeout` 을 금지하고 있었다.** `molit_ingest_runs_status_chk` = `CHECK (status = ANY (ARRAY['running','ok','error','skipped']))`. 그런데 `backend/jobs/molitIngest.js:377` 과 `backend/jobs/retention.js:195` 는 2시간 넘게 남은 `running` 행을 **`status: 'timeout'`** 으로 UPDATE 한다 → **CHECK 위반으로 항상 실패**.
   - 실측 증거: `status='timeout'` 행이 **한 번도 존재한 적 없다(0건)**. 멈춘 `running` 행 **21건**(전부 `lawd_cd=41173`/`deal_ym=202510`), 가장 오래된 것이 **2026-06-22**(90일째, `finished_at` NULL).
   - 부수 피해: gap-retry 의 `.in('status', ['error', 'timeout'])`(`molitIngest.js:310`) 중 `'timeout'` 분기는 **죽은 코드**였다 → 중간에 죽은 적재는 영영 재시도되지 않았다.
   - **✅ DDL 은 리뷰어가 이미 적용했다**(2026-09-20 12:1x UTC): 제약을 `ARRAY['running','ok','error','skipped','timeout']` 로 넓혔고 `convalidated = true` 확인. 기존 값이 전부 새 목록의 부분집합이라 검증은 즉시 통과했다.
2. **그 실패가 Plan 106 을 막는다.** `runIngestRunsRetention`(`retention.js:186~209`)은 ① 오래된 `running` → `timeout` UPDATE 후 `if (e1) throw e1;` ② 그다음에 `admin.rpc('prune_molit_ingest_runs', …)`. ①이 던지면 ②는 **실행되지 않는다**. 대상 행이 21건 있었으므로 오늘 18:00 UTC 정리 작업은 프루닝에 도달하지 못했을 것이다. (DDL 로 ①은 이제 성공한다 — 그래도 아래 Step 1 로 둘을 독립시킨다.)
3. **실패가 어디에도 안 보인다.** `retention.js` 의 `run()`(`:240~`)이 만드는 summary 는 `{ durationMs, softDelete, searchHistory, chat, ingestRuns: {...}, attribution }` — **중첩**이다. `backend/services/cronStats.js` 의 `_pick()`(`:27~62`)은 `summary[k]`(**최상위 키만**)와 `summary.error` 만 본다 → `ingestRuns.error`·`ingestRuns.okPruned` 는 `health.crons['retention']` 에 **절대 나타나지 않는다**. `retention.js` 는 Sentry 를 import 하지도 않는다(`grep -n "Sentry" backend/jobs/retention.js` → 0건). 즉 이 잡은 **90일 동안 매일 조용히 실패**하고 있었고 감지할 방법이 0이었다.

## 범위
- 수정: `backend/jobs/retention.js`, `backend/services/cronStats.js`, `supabase/schema.sql`, **`backend/test/ingest-runs-retention.test.js`(단언 2개만 — 아래 Step 6)**. 신규: `supabase/migrations/20260920_ingest_runs_timeout_status.sql`(적용 기록), `backend/test/retention-observability.test.js`.

## Step 6 — 기존 테스트의 오류 메시지 단언 2개를 새 계약에 맞춘다 (계획자 보정 2026-09-20)
**왜 필요한가**: Plan 106 이 오늘 만든 `backend/test/ingest-runs-retention.test.js` 가 `out.error` 를 **원문 그대로**라고 정확 일치로 고정했다(단일 단계 시절의 구현 세부를 단언한 것). Step 1 이 두 단계를 독립시키면서 **어느 단계가 실패했는지**를 접두사로 밝히므로 그 단언이 깨진다. 접두사를 빼면(단일 실패 시 원문 유지) `health.crons['retention'].error` 만 보고는 어느 단계가 죽었는지 알 수 없어 이 계획의 목적(감지 가능하게 만들기)을 잃는다 → **접두사를 유지하고 단언을 갱신**한다.
- `assert.equal(out.error, 'function prune_molit_ingest_runs does not exist');` → `assert.equal(out.error, 'prune: function prune_molit_ingest_runs does not exist', 'Plan 110: 두 단계가 독립이라 어느 쪽이 실패했는지 접두사로 구분한다');`
- `assert.equal(out.error, 'fetch failed');` → `assert.equal(out.error, 'prune: fetch failed', 'Plan 110: 두 단계가 독립이라 어느 쪽이 실패했는지 접두사로 구분한다');`
- **그 두 줄 외에는 이 파일을 건드리지 않는다**(테스트 이름·스텁·다른 단언 전부 유지).
- 금지: `molitIngest.js`(같은 UPDATE 를 쓰지만 그쪽은 자체 catch 로 격리돼 있고 DDL 로 이미 고쳐졌다) · 다른 retention 하위 작업 · DB 추가 변경.

## Step 1 — `backend/jobs/retention.js`: 두 단계를 독립시키고 실패를 드러낸다
`runIngestRunsRetention` 을 아래 구조로 바꾼다(기존 주석 블록은 유지하고, 각 단계를 **자기 try 로 감싼다**):
```js
async function runIngestRunsRetention(admin) {
  const out = { staleRunningFixed: 0, okPruned: 0, error: null };
  // STEP-ISOLATION-2026-09-20 (Plan 110): 종전엔 ①이 throw 하면 ②(프루닝 RPC)가 통째로 건너뛰어졌다.
  //   실제로 CHECK 제약이 'timeout' 을 금지해 ①이 90일간 매일 실패했고, 그 사실이 어디에도 안 보였다.
  //   두 단계는 서로 독립이므로 각자 실패하고 각자 기록한다.
  try {
    const staleCut = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { count: sc, error: e1 } = await admin.from('molit_ingest_runs')
      .update({ status: 'timeout', finished_at: new Date().toISOString(), error_message: 'stale running (retention cleanup)' }, { count: 'exact' })
      .eq('status', 'running')
      .lt('started_at', staleCut);
    if (e1) throw e1;
    out.staleRunningFixed = sc ?? 0;
  } catch (e) {
    out.error = `staleRunning: ${e.message}`;
    logger.warn({ err: e.message }, 'retention: 고아 running 정리 실패 (프루닝은 계속 진행)');
  }
  try {
    const { data: pruned, error: e2 } = await admin.rpc('prune_molit_ingest_runs', { p_keep_days: INGEST_RUNS_OK_RETENTION_DAYS });
    if (e2) throw e2;
    out.okPruned = Number(pruned) || 0;
  } catch (e) {
    out.error = out.error ? `${out.error} | prune: ${e.message}` : `prune: ${e.message}`;
    logger.warn({ err: e.message }, 'retention: molit_ingest_runs 프루닝 실패');
  }
  logger.info({ ...out, okRetentionDays: INGEST_RUNS_OK_RETENTION_DAYS }, 'retention: molit_ingest_runs 정리');
  return out;
}
```
(`error_message` 컬럼이 기존 코드에 있었는지 `git show HEAD:backend/jobs/retention.js` 로 확인해 **기존 필드 그대로** 쓸 것. 없으면 빼라.)

## Step 2 — `retention.js` 의 `run()`: 중첩 결과를 최상위로도 올린다
`const summary = { … }` 를 만드는 곳에서, 기존 중첩 키는 **그대로 두고** 아래 세 줄을 summary 에 추가한다(로그·반환 모양은 상위 호환):
```js
    // OBSERV-FLAT-2026-09-20 (Plan 110): cronStats._pick 은 최상위 키만 본다 — 중첩된 ingestRuns 의
    //   성과·실패가 health.crons['retention'] 에 90일간 한 번도 안 보였다. 평탄화 키를 함께 싣는다.
    okPruned: ingestRunsResult && ingestRunsResult.okPruned,
    staleRunningFixed: ingestRunsResult && ingestRunsResult.staleRunningFixed,
    ...(ingestRunsResult && ingestRunsResult.error ? { error: ingestRunsResult.error } : {}),
```

## Step 3 — `backend/services/cronStats.js`
`NUM` 배열에 `'okPruned'`, `'staleRunningFixed'` 를 추가한다(`'unchanged'` 가 있는 줄 근처). `error` 는 `_pick` 이 이미 `summary.error` 를 통과시키므로 추가 작업 불필요.

## Step 4 — 기록
- `supabase/schema.sql`: `molit_ingest_runs` 의 CHECK 제약 선언을 찾아(`grep -n "molit_ingest_runs_status_chk\|status.*running.*ok.*error.*skipped" supabase/schema.sql`) `'timeout'` 을 목록에 추가한다. **그 한 줄만** 고친다.
- 신규 `supabase/migrations/20260920_ingest_runs_timeout_status.sql` — 형식은 `20260920_hist_index_swap.sql` 을 따른다("이미 프로덕션에 적용됨 — 적용 기록"). 본문:
  ```sql
  ALTER TABLE public.molit_ingest_runs DROP CONSTRAINT molit_ingest_runs_status_chk;
  ALTER TABLE public.molit_ingest_runs ADD CONSTRAINT molit_ingest_runs_status_chk
    CHECK (status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text, 'skipped'::text, 'timeout'::text]));
  ```
  헤더에 근거를 적는다: 코드가 90일간 쓰려 한 `'timeout'` 이 CHECK 에 없어 UPDATE 가 매번 실패 → `timeout` 행 0건·멈춘 `running` 21건(최고령 2026-06-22)·gap-retry 의 `'timeout'` 분기 사문화. 되돌리기는 `'timeout'` 을 뺀 원래 배열로 재생성.

## Step 5 — 테스트 `backend/test/retention-observability.test.js` (신규)
`backend/test/ingest-runs-retention.test.js` 의 스텁 패턴을 재사용한다.
1. **단계 독립**: 1단계 UPDATE 가 오류를 돌려주는 스텁에서도 `rpc('prune_molit_ingest_runs', …)` 가 **호출되고** `okPruned` 가 채워지며 `out.error` 에 `staleRunning:` 이 들어간다.
2. **프루닝 실패도 기록**: rpc 가 오류를 돌려주면 `out.error` 에 `prune:` 이 들어가고 예외가 밖으로 나가지 않는다.
3. **평탄화**: `cronStats._pick({ durationMs: 1, ingestRuns: { okPruned: 7, staleRunningFixed: 2 }, okPruned: 7, staleRunningFixed: 2 })` 가 `okPruned`·`staleRunningFixed` 를 통과시킨다(중첩만 있을 때는 통과되지 않는다는 것도 같은 테스트에서 단언해 회귀를 고정).

## 검증·완료 기준
- `npm run verify` `fail 0`(현재 442 + 신규 3).
- 회귀 주입(수행 후 원복): (1) Step 1 의 두 try 를 하나로 합치면 테스트 1 fail. (2) `NUM` 에서 `'okPruned'` 를 빼면 테스트 3 fail.
- 정적: `grep -c "timeout" supabase/schema.sql` ≥ 1 · `grep -c "okPruned" backend/services/cronStats.js` = 1.
- 리뷰어 라이브(배포 후 18:00 UTC retention): `health.crons['retention']` 에 `staleRunningFixed: 21`(첫 회차)·`okPruned` 가 보이고, DB 에서 `status='timeout'` 행이 21건 생기며 `status='running'` 이 0건이 된다.
- 커밋 1개: `fix(적재기록): timeout 을 금지하던 CHECK 로 정리가 90일간 조용히 실패 — 단계 독립·health 노출·제약 확장 기록 (Plan 110)`. 제목 다음 빈 줄, 마지막 줄에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## STOP 조건
- `retention.js` 의 `runIngestRunsRetention`·`run()` 이 위 발췌와 다르다 → 현재 코드를 인용해 보고 후 STOP.
- `schema.sql` 에 `molit_ingest_runs` 의 CHECK 선언이 없다 → 보고 후 STOP(마이그레이션 기록만 남기고 schema.sql 은 건드리지 않는다).
