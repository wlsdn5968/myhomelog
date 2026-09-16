# 094 — 이력 backfill cron 을 Hobby 플랜 규칙(하루 1회)에 맞춰 "일일 슬롯 10개 + 실행당 시간예산" 으로 재설계 (배포 거부 복구)

**작성 기준 커밋**: `d5924bb` (2026-09-16) · 우선순위 **P0(배포 막힘)** · 작업량 S · 의존: 091 이 master 에 병합되어 있음(맞음)

## 전제 확인 (계획자가 라이브·문서·코드로 확인한 것 — 추측 아님)
- GitHub 커밋 상태 API: `951d341`·`d5924bb` 둘 다 Vercel 컨텍스트 `"Deployment failed."`(푸시 2초 뒤). Vercel 에는 배포 기록 자체가 없다(최신 프로덕션은 여전히 `dc5a30f`). 실패 링크는 Vercel 문서 "Usage & Pricing for Cron Jobs" 로 간다.
- 그 문서(2026-07-15 갱신): **Hobby 플랜은 cron 이 하루 1회만** — "Expressions like `0 * * * *` (per-hour) … will fail deployment with the error: *Hobby accounts are limited to daily cron jobs.*" · 프로젝트당 cron **100개** · 실행 정밀도 **±59분**("`0 1 * * *` 은 1:00~1:59 사이 아무 때").
- 원인 줄: `vercel.json` crons 마지막 항목 `{ "path": "/api/cron/molit-hist-backfill", "schedule": "20 * * * *" }` (Plan 091 이 매시로 설계 — 플랜 제약 미확인이 계획 오류).
- 같은 저장소의 검증된 선례: `molit-ingest` 는 **같은 경로에 쿼리스트링만 다른 cron 3개**(`?slot=0&slotCount=3` …)로 배포된다. `backend/test/cron-observability.test.js:417` 계약 테스트는 `c.path.split('?')[0]` 로 경로를 비교하므로 쿼리스트링은 허용된다.
- 잡 `backend/jobs/molitHistBackfill.js`: `REGION_MONTHS_PER_RUN = 30`, `limit` 상한 `Math.min(…, 120)`, 시간예산 없음. 함수 `maxDuration` 은 `vercel.json` `functions["api/index.js"].maxDuration = 300`(이미 배포되던 값).
- 실측 참고: molit-ingest 슬롯 0 은 42지역×3개월 = 126 region-month 를 17.8초(MV 갱신 6.9초 포함)에 처리(병렬). backfill 은 순차 + region-month 마다 delete·insert·upsert 3왕복 → region-month 당 1~2.5초로 본다 → 235초면 **약 100~200개**.
- MOLIT 일일 쿼터는 KST 자정(=15:00 UTC)에 초기화된다. 일간 적재(`molit-ingest`)는 17:00~17:30 UTC(±59분 → 최악 18:29). **backfill 이 쿼터를 먼저 소진해 일간 적재를 망치면 안 되므로** backfill 슬롯은 모두 **18:30 UTC 이후 ~ 다음날 15:00 UTC 이전**에 둔다.
- `backend/services/cronStats.js:173` `'molit-hist-backfill': 3`(시간) — 매시 전제. 슬롯 간 최대 공백(13:20 → 19:20, 지터 포함 ≈ 7시간)보다 커야 한다.
- 지역 수: `LAWD_CODES` 고유 코드 **125**. 대상 region-month 총수 = 125 × 75개월(2025-04 → 2019-01) = 9,375(용량 정지 470MB 가 먼저 온다).

## 목표
1. 배포가 다시 생성된다(Hobby 규칙 위반 0).
2. 하루 처리량을 무료로 최대화: **일일 cron 10개(2시간 간격) × 실행당 시간예산 235초(최대 200 region-month)**.
3. 이런 류의 실수를 테스트가 영구히 막는다(스케줄 형식 계약).

## 범위
- 수정: `vercel.json`(crons), `backend/jobs/molitHistBackfill.js`, `backend/services/cronStats.js`(기대 주기 1줄), `backend/test/molit-hist-backfill.test.js`(시나리오 2개 추가), `backend/test/cron-observability.test.js`(계약 테스트 1개 추가).
- 금지: `backend/routes/cron.js`·DDL·`supabase/schema.sql`·다른 cron 항목의 스케줄 변경, 의존성 추가, `npm install`.

## Step 1 — `vercel.json`
crons 배열의 `/api/cron/molit-hist-backfill` 항목(`"20 * * * *"`) 1개를 **삭제**하고, 아래 10개를 그 자리에 넣는다(순서 그대로, 다른 항목은 손대지 않는다):
```json
    { "path": "/api/cron/molit-hist-backfill?slot=0", "schedule": "20 19 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=1", "schedule": "20 21 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=2", "schedule": "20 23 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=3", "schedule": "20 1 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=4", "schedule": "20 3 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=5", "schedule": "20 5 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=6", "schedule": "20 7 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=7", "schedule": "20 9 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=8", "schedule": "20 11 * * *" },
    { "path": "/api/cron/molit-hist-backfill?slot=9", "schedule": "20 13 * * *" }
```
(기존 파일의 들여쓰기/줄바꿈 스타일을 따른다 — 한 항목이 4줄로 펼쳐져 있으면 같은 형식으로.) 확인: `node -e "const v=require('./vercel.json');console.log(v.crons.length)"` → **24**.

## Step 2 — `backend/jobs/molitHistBackfill.js`
- 상수: `REGION_MONTHS_PER_RUN = 200` 로 바꾸고 주석을 `// 실행당 상한 — 실제 종료는 아래 TIME_BUDGET_MS 가 결정`, `limit` 클램프의 `120` 도 `200` 으로. 새 상수 `const TIME_BUDGET_MS = 235_000;  // maxDuration 300s − 여유 65s(마지막 region-month 최대 ~10s + 응답)`, `const MAX_CONSEC_ERR = 3;  // 연속 실패(쿼터 소진·API 장애)면 남은 대상을 두들기지 않고 이번 회차를 끝낸다`.
- 파일 상단 설계 주석에 항목 추가: `//   - Vercel Hobby 플랜은 cron 이 하루 1회만(매시 표현식은 배포 자체가 거부됨 — 2026-09-16 실사례). 그래서 vercel.json 에 같은 경로를 ?slot=0~9 로 10개(2시간 간격, ±59분 지터에도 겹치지 않음) 등록하고, 한 실행은 TIME_BUDGET_MS 까지 순차 처리한다.`
- `runHistBackfill(opts)`:
  - 시작에 `const t0 = Date.now(); const budgetMs = opts.timeBudgetMs != null ? Number(opts.timeBudgetMs) : TIME_BUDGET_MS;`
  - `let budgetHit = false, consec = 0;`
  - 루프 안: 성공 분기 끝에 `consec = 0;`, catch 분기 끝에 `consec++;`. 기존 용량 체크(`(done + err) % 10 === 0`) **뒤에** 두 조건을 순서대로 넣는다:
    ```js
    if (consec >= MAX_CONSEC_ERR) {
      logger.warn({ consec, lawdCd, ym }, 'molit-hist-backfill: 연속 실패 — 이번 회차 종료(다음 슬롯이 재시도)');
      return { stopped: false, reason: 'errors', dbMb: await dbSizeMb(admin), done, rows, err, lastYm, budgetHit, elapsedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 >= budgetMs) { budgetHit = true; break; }
    ```
  - 마지막 return 에 `budgetHit, elapsedMs: Date.now() - t0` 두 필드를 추가(기존 필드·의미는 그대로: `stopped` 는 대상이 0개일 때만 true).
  - 용량 정지 return 두 곳(`reason: 'db-size'`)은 **그대로 둔다**(기존 테스트 ①이 `deepEqual` 로 고정).
- `module.exports` 에 `TIME_BUDGET_MS, REGION_MONTHS_PER_RUN` 추가.

## Step 3 — `backend/services/cronStats.js`
- `'molit-hist-backfill': 3,` → `'molit-hist-backfill': 9,` 로 바꾸고 바로 위 주석 3줄을 다음으로 교체: `// HIST-BACKFILL-2026-09-16 (Plan 091→094): Hobby 플랜(하루 1회 cron)이라 일일 슬롯 10개(2시간 간격, ±59분 지터). 최대 공백은 13:20→19:20 UTC ≈ 7h — 9h 넘게 조용하면 경보. 완주(reason:'complete')·용량 정지 뒤에도 엔드포인트는 계속 호출·기록되므로 stale 오인은 없다.`
- `recordCronRun` 요약 화이트리스트: `elapsedMs` 는 이미 NUM 목록에 있다. `budgetHit`(boolean) 은 `stopped` 가 통과되는 목록과 같은 곳에 추가한다(`grep -n "stopped" backend/services/cronStats.js` 로 위치 확인; `stopped` 가 어디에도 없으면 boolean 은 통과되지 않는 구조이므로 **추가하지 말고 보고만** 한다).

## Step 4 — 테스트
### 4-a `backend/test/molit-hist-backfill.test.js`
기존 시나리오 test 안(⑤ 뒤)에 두 블록 추가(같은 `_makeAdmin`·`_runWithStubs` 사용):
```js
  // ⑥ 시간예산: timeBudgetMs:0 이면 첫 region-month 를 끝낸 직후 멈춘다(budgetHit) — 대상이 남았으니 stopped:false
  {
    const { client } = _makeAdmin({ dbMb: 100 });
    const fetchCalls = [];
    const res = await _runWithStubs({ limit: 5, timeBudgetMs: 0 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '테스트구1': '11111', '테스트구2': '22222' });
    assert.equal(fetchCalls.length, 1, '예산 0 이면 정확히 1개만 처리하고 멈춰야 한다');
    assert.equal(res.budgetHit, true);
    assert.equal(res.stopped, false);
    assert.equal(typeof res.elapsedMs, 'number');
  }
  // ⑦ 연속 실패 3회면 남은 대상을 두들기지 않고 reason:'errors' 로 끝낸다(다음 슬롯이 재시도)
  {
    const { client, calls } = _makeAdmin({ dbMb: 100 });
    let n = 0;
    const res = await _runWithStubs({ limit: 10 }, client, async () => { n++; throw new Error('MOLIT 쿼터 소진(테스트)'); }, { '테스트구1': '11111', '테스트구2': '22222', '테스트구3': '33333', '테스트구4': '44444', '테스트구5': '55555' });
    assert.equal(n, 3, '3회 연속 실패 뒤엔 더 호출하면 안 된다');
    assert.equal(res.reason, 'errors');
    assert.equal(res.err, 3);
    assert.equal(res.stopped, false);
    assert.equal(calls.upserted.length, 0);
  }
```
(`_runWithStubs` 의 `opts` 가 `runHistBackfill(opts)` 로 그대로 전달되는지 확인 — 아니면 전달되게 고친다.) 기존 ④는 `limit:1` 이라 연속 실패 조건에 걸리지 않는다(그대로 통과해야 함).

### 4-b `backend/test/cron-observability.test.js` — 새 test 1개(기존 ④ 테스트 바로 아래)
```js
test('vercel.json cron 스케줄 — Hobby 플랜 계약: 전부 하루 1회 · hist-backfill 슬롯은 2시간 이상 간격 · 일간 적재 창(17~18시 UTC) 회피', () => {
  const fs = require('node:fs'), path = require('node:path');
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
  // HOBBY-CRON-2026-09-16 (Plan 094): 매시/분 표현식("20 * * * *")은 Vercel Hobby 에서 배포 자체가 거부된다
  //   (GitHub 상태 "Deployment failed", Vercel 에 배포 기록 없음 — 951d341·d5924bb 실사례). 분·시가 숫자여야 하루 1회다.
  const DAILY = /^\d{1,2} \d{1,2} (\*|\d{1,2}) (\*|\d{1,2}) (\*|[0-6])$/;
  for (const c of vercel.crons) assert.match(c.schedule, DAILY, `하루 1회가 아닌 cron: ${c.path} "${c.schedule}" — Hobby 플랜은 배포가 거부된다`);
  const hist = vercel.crons.filter(c => c.path.startsWith('/api/cron/molit-hist-backfill'));
  assert.ok(hist.length >= 2, 'hist-backfill 일일 슬롯이 2개 미만이다');
  assert.equal(new Set(hist.map(c => c.path)).size, hist.length, '슬롯 경로(?slot=N)가 중복된다');
  const hours = hist.map(c => Number(c.schedule.split(' ')[1])).sort((a, b) => a - b);
  for (let i = 0; i < hours.length; i++) {
    const next = i + 1 < hours.length ? hours[i + 1] : hours[0] + 24;
    assert.ok(next - hours[i] >= 2, `슬롯 간격이 2시간 미만(${hours[i]}h→${next % 24}h) — ±59분 지터에 두 실행이 겹쳐 중복 삽입 위험`);
    assert.ok(hours[i] !== 17 && hours[i] !== 18, `슬롯 ${hours[i]}h 는 일간 적재(molit-ingest 17:00~17:30 UTC, 지터 포함 18:29) 창과 겹친다 — MOLIT 쿼터 경쟁`);
  }
});
```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 **411 + 1**(4-b; 4-a 는 기존 test 내부 블록).
- 회귀 주입(수행 후 원복): (1) vercel.json 의 슬롯 하나를 `"20 * * * *"` 로 바꾸면 4-b fail. (2) 잡에서 `if (Date.now() - t0 >= budgetMs)` 줄을 지우면 ⑥ fail. (3) `consec` 체크를 지우면 ⑦ fail.
- 정적: `node -e "const v=require('./vercel.json');const h=v.crons.filter(c=>c.path.includes('molit-hist-backfill'));console.log(v.crons.length,h.length,h.map(c=>c.schedule).join('|'))"` → `24 10 20 19 * * *|20 21 * * *|…|20 13 * * *`.
- 커밋 1개: `fix(cron): Hobby 플랜 하루 1회 규칙 — hist backfill 을 일일 슬롯 10개+시간예산으로 재설계, 스케줄 계약 테스트 (Plan 094)`. 본문에 [근본 원인] 매시 cron 이 Vercel Hobby 에서 배포 거부(951d341·d5924bb) [Fix] 위 요약 [회귀 위험] 슬롯 겹침·쿼터 경쟁은 계약 테스트로 고정.

## STOP 조건
- `_runWithStubs` 가 `opts` 를 전달하지 않는 구조라 ⑥ 을 못 쓴다 → 전달하도록 1줄 고치는 것은 허용. 그 외 하네스를 새로 짜야 한다면 STOP 하고 보고.
- `cronStats.js` 의 boolean 화이트리스트 위치를 못 찾으면 `budgetHit` 추가는 생략하고 보고(테스트엔 영향 없음).
