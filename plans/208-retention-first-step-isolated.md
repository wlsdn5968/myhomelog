# Plan 208: 보존 작업의 첫 단계가 실패해도 그날의 집계와 감시가 돌게 한다

> **실행자에게**: 이 계획을 순서대로 따른다. 단계마다 확인 명령을 돌려 기대 결과가 나온 뒤에 다음 단계로 간다.
> "멈춤 조건"에 해당하면 스스로 고치려 하지 말고 멈추고 보고한다. 끝나면 `plans/README.md` 의 208 줄 상태를 고친다.
>
> **먼저 할 일(변경 확인)**: `git diff --stat 55c56b4..HEAD -- backend/jobs/retention.js backend/routes/cron.js`
> 바뀐 것이 있으면 아래 "지금 상태"의 발췌와 실제 코드를 견준다. 다르면 멈춤 조건이다.

## 상태

- **우선순위**: P1
- **작업량**: S
- **위험**: LOW
- **선행 계획**: 없음
- **범주**: bug
- **기준**: 커밋 `55c56b4`, 2026-11-18

## 왜 필요한가

보존 작업(`/api/cron/retention`, 하루 한 번 UTC 18:00)은 탈퇴 예약이 지난 계정을 지우는 일로 시작한다. 그런데 이 예약 작업에는 다른 일이 많이 얹혀 있다. 같은 처리기 안에서 DB 용량 점검, 건수 스냅샷, 인기 단지 집계, 구별 순위 집계, 적재가 멈췄는지 보는 감시 세 가지, 금리와 브리핑 예열이 이어서 돈다. 첫 단계(`runSoftDeleteExpiry`)는 대상 조회가 실패하면 예외를 던지는데, 다른 단계와 달리 감싸져 있지 않다. 그래서 그 조회가 한 번 일시적으로 실패하면 처리기가 곧바로 500 으로 끝나고 뒤의 일이 그날 하나도 돌지 않는다. 인기 단지 집계가 하루 건너뛰면 사용자 요청이 무거운 실시간 집계를 타게 되고, 감시가 건너뛰면 적재가 멈춘 것을 그날 알 수 없다. 이 계획이 끝나면 첫 단계의 실패는 실행 기록에 남고 나머지는 계속 돈다.

## 지금 상태

- `backend/jobs/retention.js` : 보존 작업 본체. `run()` 이 단계들을 차례로 부른다.
- `backend/routes/cron.js` : 예약 작업 경로. `/retention` 처리기(POST 와 GET 두 개)가 `runRetention()` 뒤에 집계와 감시를 잇는다.

`backend/jobs/retention.js:138-149`

```js
async function runSoftDeleteExpiry(admin) {
  const { data: due, error } = await admin
    .from('account_deletion_requests')
    .select('user_id, requested_at, scheduled_hard_delete_at, hard_delete_attempts')
    .eq('status', 'pending')
    .lte('scheduled_hard_delete_at', new Date().toISOString())
    .order('hard_delete_attempts', { ascending: true })
    .order('scheduled_hard_delete_at', { ascending: true })
    .limit(100); // 한 번에 100명까지 — Vercel 함수 타임아웃 고려
  if (error) throw error;
```

이 함수가 정상으로 끝나면 `{ processed, failed, results }` 를 돌려준다(`retention.js:175`).

`backend/jobs/retention.js:365-398`

```js
async function run() {
  const started = Date.now();
  const admin = adminClient();
  logger.info('retention job 시작');

  const softDeleteResult = await runSoftDeleteExpiry(admin);
  const searchHistResult = await runSearchHistoryRetention(admin);
  const chatResult = await runChatRetention(admin);
  const ingestRunsResult = await runIngestRunsRetention(admin);
  const attributionResult = await runAttributionRetention(admin);
  const anonCapResult = await runAnonTableCaps(admin); // AUDIT-CAPS-1111
  const fakePushResult = await runFakePushPrune(admin); // AUDIT4-1114

  const summary = {
    durationMs: Date.now() - started,
    softDelete: softDeleteResult,
    searchHistory: searchHistResult,
    chat: chatResult,
    ingestRuns: ingestRunsResult,
    attribution: attributionResult,
    okPruned: ingestRunsResult && ingestRunsResult.okPruned,
    staleRunningFixed: ingestRunsResult && ingestRunsResult.staleRunningFixed,
    aiFeedbackTrimmed: anonCapResult.aiFeedbackTrimmed,
    dataErrorTrimmed: anonCapResult.dataErrorTrimmed,
    fakePushPruned: fakePushResult.fakePushPruned, // AUDIT4-1114: 가짜 푸시 구독 정리 수(0 이 정상)
    ...(ingestRunsResult && ingestRunsResult.error ? { error: ingestRunsResult.error }
      : (anonCapResult.error ? { error: anonCapResult.error }
        : (fakePushResult.error ? { error: fakePushResult.error } : {}))),
  };
  logger.info(summary, 'retention job 완료');
  return summary;
}
```

다른 단계는 스스로 실패를 감싸 `{ error: 메시지 }` 를 돌려준다. 예: `retention.js:188-191`

```js
    return { deleted: count ?? 0 };
  } catch (e) {
    ...
    return { error: e.message };
```

처리기 쪽. `backend/routes/cron.js:275-278, 342-347`

```js
router.post('/retention', async (req, res) => {
  try {
    const started = Date.now();
    const summary = await runRetention();
    ...
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'cron/retention 실패');
    try { Sentry.captureException(e, { tags: { route: 'cron.retention' } }); } catch (_) { /* 텔레메트리 실패는 삼킨다 — 본 처리를 막지 않는다 */ }
    await require('../services/cronStats').recordCronRun('retention', { ok: false, error: e.message }).catch(() => {}); // Sprint MMMMMMM-12
    res.status(500).json({ error: e.message });
  }
```

실행 기록에 남는 값: `backend/services/cronStats.js` 의 `_pick` 은 요약의 맨 위 칸 가운데 정해진 이름의 숫자만 남기고, `error` 는 글자 120자까지 남긴다. 그래서 요약의 맨 위 `error` 칸에 실패 사유를 넣으면 health 의 `crons.retention.error` 로 보인다.

`summary.softDelete` 를 읽는 다른 코드는 없다(2026-11-18, `grep -rn "softDelete\b" backend/routes backend/services backend/jobs` 에서 `retention.js` 밖 결과 없음).

저장소 규칙
- 주석은 한국어, 이름표는 `RETENTION-ISOLATE-1118`.
- 백엔드 코드는 `@sentry/node` 를 직접 부르지 않고 `../sentry` 를 부른다.
- 검사는 `node:test`, `node:assert/strict`. 가짜 DB 객체를 만드는 본보기는 `backend/test/retention-observability.test.js:25-45` 의 `_makeFakeAdmin` 이다.

## 쓸 명령

| 목적 | 명령 | 성공했을 때 |
|---|---|---|
| 검사 하나 | `cd backend` 뒤 `TZ=UTC node --test test/<파일>.test.js` (PowerShell 은 `$env:TZ='UTC'; node --test test/<파일>.test.js`) | `ℹ fail 0` |
| 전체 검증 | 저장소 루트에서 `npm run verify` | exit 0, 끝에 `ℹ fail 0` |

## 범위

**고쳐도 되는 파일**
- `backend/jobs/retention.js` (`run()` 안의 첫 단계 호출과 요약)
- `backend/test/retention-isolate-1118.test.js` (새로 만든다)
- `plans/README.md` (208 줄의 상태만)

**고치면 안 되는 것**
- `runSoftDeleteExpiry` 의 본문과 `hardDeleteUser`. 계정 삭제 동작은 그대로 둔다. 이 함수가 예외를 던지는 것도 그대로 둔다(다른 검사가 직접 부른다).
- `backend/routes/cron.js`. 처리기는 고치지 않는다.
- `backend/services/cronStats.js` 의 숫자 이름 목록(`NUM`). 마지막 항목이 `canceledRemoved` 여야 한다는 규칙이 있다.
- 기존 보존 검사 파일들(`attribution-retention-visits`, `audit-caps-1111`, `fake-push-prune-1114`, `ingest-runs-retention`, `retention-observability`, `sec-1030-lifecycle`).
- `.env` 로 시작하는 파일은 읽지도 않는다.

## Git 작업 방식

- 브랜치: `advisor/208-retention-first-step-isolated`
- 커밋 제목: `fix(retention): 계정 삭제 단계가 실패해도 뒤 단계와 집계가 계속 돎 (Sprint 1118-plan208)`. 본문에 `[근본 원인]`, `[Fix 내용]`, `[회귀 위험]`.
- 푸시하지 않는다.

## 단계

### 1단계: 첫 단계 호출을 감싼다

`backend/jobs/retention.js` 의 `run()` 에서 370행 한 줄을 아래로 바꾼다.

```js
  // RETENTION-ISOLATE-1118 (plans/208): 이 단계만 감싸지 않아서, 대상 조회가 한 번 실패하면 run() 이 통째로 던지고
  //   같은 예약 작업에 얹힌 집계와 감시(인기 단지, 구별 순위, 용량 점검, 적재 감시)가 그날 하나도 돌지 않았다.
  //   실패는 요약에 남기고 계속한다. 계정 삭제는 다음 날 같은 대상을 다시 집는다(상태가 pending 으로 남는다).
  let softDeleteResult;
  try {
    softDeleteResult = await runSoftDeleteExpiry(admin);
  } catch (e) {
    softDeleteResult = { processed: 0, failed: 0, results: [], error: e && e.message ? e.message : String(e) };
    logger.error({ err: softDeleteResult.error }, 'retention: 계정 삭제 단계 실패 (나머지 단계는 계속 진행)');
    try { require('../sentry').captureException(e, { tags: { route: 'cron.retention', step: 'soft-delete' } }); } catch (_) { /* 알림 실패가 본 처리를 막지 않는다 */ }
  }
```

`retention.js` 위쪽에 `sentry` 를 이미 불러 둔 변수가 있으면(`grep -n "require('../sentry')" backend/jobs/retention.js`) 그 변수를 쓴다.

**확인**: `cd backend` 뒤 `node -e "require('./jobs/retention')"` → 오류 없음.

### 2단계: 요약의 맨 위 `error` 에 이 실패를 가장 먼저 싣는다

`summary` 의 마지막 펼침(393-395행)을 아래로 바꾼다. 계정 삭제 실패를 맨 앞에 둔다.

```js
    ...(softDeleteResult && softDeleteResult.error ? { error: `soft-delete: ${softDeleteResult.error}` }
      : (ingestRunsResult && ingestRunsResult.error ? { error: ingestRunsResult.error }
        : (anonCapResult.error ? { error: anonCapResult.error }
          : (fakePushResult.error ? { error: fakePushResult.error } : {})))),
```

`softDelete: softDeleteResult` 줄은 그대로 둔다.

**확인**: `node -e "require('./jobs/retention')"` → 오류 없음. `grep -c "RETENTION-ISOLATE-1118" backend/jobs/retention.js` → 1 이상.

### 3단계: 회귀 검사를 쓴다

새 파일 `backend/test/retention-isolate-1118.test.js`.

`run()` 은 안에서 `adminClient()` 로 DB 객체를 만든다(`retention.js:43`). 검사에서는 이 함수가 무엇을 불러 객체를 만드는지 먼저 읽고(`retention.js:43-50` 부근), 그 모듈을 `require.cache` 로 가짜로 바꿔 끼운 뒤 `retention.js` 를 다시 읽는다. 끼우고 되돌리는 방식은 `backend/test/rent-jeonse.test.js:249-284` 를 본뜬다.

가짜 DB 객체의 동작
- `from('account_deletion_requests')` 로 시작하는 조회 사슬은 끝에서 `{ data: null, error: { message: 'boom-soft-delete' } }` 를 돌려준다. 사슬의 메서드(`select`, `eq`, `lte`, `order`, `limit`)는 자기 자신을 돌려주고, `await` 되면 위 값을 준다(`then` 을 가진 객체로 만든다).
- 그 밖의 표와 `rpc` 는 어떤 메서드 사슬이 와도 `{ data: [], count: 0, error: null }` 을 주는 관대한 가짜로 만든다(`Proxy` 로 "아무 메서드나 자기 자신을 돌려주고 await 하면 빈 성공"을 만들면 짧다).

검사 2개
1. 계정 삭제 대상 조회가 실패해도 `run()` 이 던지지 않고 요약을 돌려준다. 요약에서 `softDelete.error` 가 `'boom-soft-delete'` 이고, `error` 가 `'soft-delete: boom-soft-delete'` 이고, `searchHistory`, `chat`, `ingestRuns`, `attribution` 칸이 `undefined` 가 아니다(뒤 단계가 돌았다는 뜻).
2. `require('../services/cronStats')._pick(요약)` 의 결과에 `error` 가 `'soft-delete: boom-soft-delete'` 로 들어 있다(health 에 보인다는 뜻).

검사 끝의 `finally` 에서 끼운 모듈을 되돌린다.

**확인**: `cd backend` 뒤 `TZ=UTC node --test test/retention-isolate-1118.test.js` → `ℹ pass 2`, `ℹ fail 0`.

### 4단계: 기존 보존 검사와 전체 검증

`cd backend` 뒤 `TZ=UTC node --test test/retention-observability.test.js test/sec-1030-lifecycle.test.js test/ingest-runs-retention.test.js test/audit-caps-1111.test.js test/fake-push-prune-1114.test.js test/attribution-retention-visits.test.js` → `ℹ fail 0`.

그다음 저장소 루트에서 `npm run verify`.

**확인**: exit 0, `ℹ fail 0`, 검사 수 1,276개(1,274 + 2).

## 검사 계획

- 새 검사 2개: `backend/test/retention-isolate-1118.test.js`.
- 본보기: 가짜 DB 는 `backend/test/retention-observability.test.js:25-45`, 모듈 끼우기는 `backend/test/rent-jeonse.test.js:249-284`.

## 끝났다고 볼 조건

- [ ] `npm run verify` 가 exit 0 이고 `ℹ fail 0`
- [ ] `backend/test/retention-isolate-1118.test.js` 가 있고 2개가 통과한다
- [ ] `runSoftDeleteExpiry` 의 본문이 그대로다(`git diff backend/jobs/retention.js` 에서 138-176행 구간에 바뀐 줄이 없다)
- [ ] `backend/routes/cron.js` 를 고치지 않았다
- [ ] `git status --short` 에 범위 밖 파일이 없다
- [ ] `plans/README.md` 의 208 줄 상태를 고쳤다

## 멈춤 조건

- "지금 상태"의 발췌와 실제 코드가 다르다.
- `run()` 의 다른 단계(`runSearchHistoryRetention` 부터 `runFakePushPrune` 까지) 가운데 스스로 감싸지 않고 예외를 던지는 것이 있다. 각 함수의 본문을 읽어 `throw` 가 `try` 밖에 있는지 본다. 있으면 이 계획의 범위를 넓히지 말고 어느 함수인지 보고한다.
- `summary.softDelete` 를 읽는 코드가 `retention.js` 밖에 생겼다.
- 기존 보존 검사가 깨진다.

## 뒤에 맡을 사람에게

- 이 변경 뒤에는 계정 삭제 단계가 실패한 날에도 예약 작업의 응답이 200 이다. 실패는 health 의 `crons.retention.error` 가 `soft-delete: ...` 로 시작하는 것과 Sentry 의 `step: soft-delete` 표식으로 안다. 개인정보 삭제 기한과 닿은 일이라 이 표식이 이틀 넘게 이어지면 바로 본다.
- 같은 종류로 남은 것(이 계획 범위 밖): 적재 정체 감시가 조회 오류를 버리고 조용히 넘어간다(`backend/routes/cron.js:101-104`).
- 실행 기록 저장이 한 키를 읽고 덮어쓰는 방식이라(`backend/services/cronStats.js:173-178, 185-189`) 동시에 끝난 작업의 기록이 사라질 수 있다. 별도 계획 후보다.
