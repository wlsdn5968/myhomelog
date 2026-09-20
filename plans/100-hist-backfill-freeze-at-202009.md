# 100 — 이력 backfill 을 2020-09 에서 동결 (DB 가 Supabase 무료 한도 500MB 의 96% — 정지 기준이 잘못된 값을 재고 있었다)

**작성 기준 커밋**: `b739076` (2026-09-20) · 우선순위 **P0(용량)** · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 DB·공식 문서·코드로 확인 — 추측 아님)
- DB 실측(2026-09-20 01:50 UTC, 읽기 전용): `sum(pg_database_size(datname))` = **482.2 MB** (`postgres` 467.8 + `template0` 7.2 + `template1` 7.2). `molit_transactions_hist` 1,290,112행·122.7 MB(힙 74.0 + 인덱스 48.6), `deal_date` 2020-09-01 ~ 2025-04-30. `molit_hist_runs` **7,000행 = 56개월 × 125지역**(2020-09 ~ 2025-04 전부 완료, 오류 0).
- Supabase 공식 문서 "Understanding Database and Disk Size": 데이터베이스 크기는 **클러스터의 모든 DB 합계**(`select sum(pg_database_size(pg_database.datname)) from pg_database`)이고 "Free Plan projects enter read-only mode when your database size exceeds 500 MB".
- 잡의 정지 기준 `DB_STOP_MB = 470` 은 RPC `db_size_mb()` = `pg_database_size(current_database())`(**현재 DB 만**, 지금 467.8)와 비교한다 → Supabase 기준으로는 14.4 MB 더 큰 값(484.4)에서야 멈춘다. 게다가 `molit_transactions` 가 월 ≈14 MB 씩 자라므로 470 에서 멈춰도 약 5주 뒤 500 MB 에 닿는다(계획 091 의 설계 오류 — 계획자 책임).
- 코드 `backend/jobs/molitHistBackfill.js`: `const FLOOR_YM = '201901';  // 이론상 하한(용량이 먼저 멈춘다)`. `nextTargets()` 는 `START_YM(202504)` 부터 `FLOOR_YM` 까지 거꾸로 돌며 `molit_hist_runs` 에 없는 (지역, 월)만 고른다 → 대상이 0개면 `runHistBackfill` 이 `{ stopped: true, reason: 'complete', … }` 를 돌려주고 MOLIT 호출·삽입이 없다.
- 용량을 되찾는 작업(인덱스 교체 등, 별도 계획 101 — 운영자 승인 필요)을 하면 현재 DB 가 470 아래로 내려가 **backfill 이 다시 돌며 되찾은 공간을 먹는다** → 임계값 조정이 아니라 **하한 고정**으로 멈춰야 한다.

## 범위
- 수정: `backend/jobs/molitHistBackfill.js`(상수 1 + 주석 + export 1), `backend/test/molit-hist-backfill.test.js`(test 1개 추가). 그 외 금지(`vercel.json`·`cronStats.js`·DDL 불변 — cron 슬롯은 그대로 돌며 `stopped:true` 를 기록한다).

## Step 1 — `backend/jobs/molitHistBackfill.js`
1. `const FLOOR_YM = '201901';                 // 이론상 하한(용량이 먼저 멈춘다)` 를 아래로 교체:
   ```js
   // HIST-FREEZE-2026-09-20 (Plan 100): 2020-09 에서 동결. 2026-09-20 실측 — 56개월×125지역(7,000 region-month,
   //   1,290,112행) 완료 시점에 Supabase 기준 DB 크기가 482.2/500 MB 였다. Supabase 의 무료 한도는 **클러스터 전
   //   DB 합계**(postgres + template0 + template1 = +14.4 MB)인데 아래 DB_STOP_MB 는 db_size_mb()(현재 DB 만)와
   //   비교해 14.4 MB 늦게 멈춘다. 용량을 되찾아도 다시 채우지 않도록 임계값이 아니라 하한을 고정한다.
   const FLOOR_YM = '202009';
   ```
2. `const DB_STOP_MB = 470;` 줄의 주석 끝에 ` ⚠ db_size_mb() 는 현재 DB 만 잰다 — Supabase 한도 기준(전 DB 합계)으로는 +14.4 MB (Plan 100)` 를 덧붙인다(값은 바꾸지 않는다 — 기존 테스트가 470 을 고정).
3. `module.exports` 에 `FLOOR_YM` 추가.

## Step 2 — 테스트 (`backend/test/molit-hist-backfill.test.js` 파일 끝에 새 test)
기존 `_makeAdmin`·`_runWithStubs` 헬퍼를 그대로 쓴다(시나리오 ⑤ 와 같은 방식).
```js
test('FLOOR_YM — 2020-09 에서 동결: START_YM~2020-09 가 끝났으면 2020-08 이전은 대상이 아니다 (용량 보호, Plan 100)', async () => {
  const { prevYm, START_YM, FLOOR_YM } = require('../jobs/molitHistBackfill');
  assert.equal(FLOOR_YM, '202009');
  const doneRuns = [];
  for (let ym = START_YM; ym >= '202009'; ym = prevYm(ym)) doneRuns.push({ lawd_cd: '11111', deal_ym: ym });
  const { client, calls } = _makeAdmin({ dbMb: 100, doneRuns });
  let fetchCalled = false;
  const res = await _runWithStubs({ limit: 5 }, client, async () => { fetchCalled = true; return []; }, { '테스트구': '11111' });
  assert.equal(fetchCalled, false, '2020-08 이전을 가져오면 안 된다 — 되찾은 DB 공간을 backfill 이 다시 채운다');
  assert.equal(res.stopped, true);
  assert.equal(res.reason, 'complete');
  assert.equal(calls.inserted.length, 0);
});
```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 423 + 1.
- 회귀 주입(수행 후 원복): `FLOOR_YM` 을 `'201901'` 로 되돌리면 새 test 가 fail(상수 단언 + fetch 호출).
- 커밋 1개: `fix(데이터): 이력 backfill 을 2020-09 에서 동결 — DB 482/500MB, 정지 기준이 현재 DB 만 재던 오류 (Plan 100)`. 본문에 [근본 원인] Supabase 한도는 전 DB 합계인데 db_size_mb() 는 현재 DB 만 + 월 14MB 증가 미반영 [Fix] 하한 고정 [회귀 위험] cron 슬롯은 그대로 돌며 stopped:true/complete 만 기록.

## STOP 조건
- `_runWithStubs`/`_makeAdmin` 시그니처가 위 사용법과 다르다 → 기존 ⑤ 시나리오를 보고 같은 방식으로 맞추되, 헬퍼 자체를 바꿔야 하면 STOP.
