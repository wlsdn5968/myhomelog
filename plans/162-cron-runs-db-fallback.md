# Plan 162: cron 실행 기록을 Redis 와 DB 스냅샷에 함께 남겨 Redis 장애 중에도 감시가 멈추지 않게 한다

> **Drift check (먼저)**: `git diff --stat 59d7ad7..HEAD -- backend/services/cronStats.js backend/services/snapshotStore.js` — 출력이 있으면 Current state 와 대조, 다르면 STOP.

## Status
Priority P2 · Effort S–M · Risk LOW · Depends 161(완료) · Category reliability · Planned at `59d7ad7`, 2026-10-18

## Why this matters
cron 실행 기록(`backend/services/cronStats.js`)은 Upstash Redis 에만 저장된다. Redis 가 무료 한도 초과로 2026-10-05 부터 쓰기 실패 중이라:
- `recordCronRun` 실패가 로그 없이 삼켜진다(`catch (_) {}`) — 기록이 안 남는 이유를 알 수 없다.
- `getCronRuns` 가 null 이면 health 의 `crons` 가 null, `routes/cron.js` `checkCronStaleness` 는 "안 돈 cron" 감시를 **침묵**한다. 읽기가 간헐 성공하면 10-05 의 옛 시각이 읽혀 반대로 오경보가 날 수 있다.
DB 기반 저장소 `services/snapshotStore.js`(Plan 142, 테이블 `computed_snapshots`)가 이미 있다. 실행 기록을 거기에도 남기고 읽을 때 둘을 합치면 Redis 상태와 무관하게 최신 기록이 보인다.

## Current state
- `backend/services/cronStats.js`: `const { getRedis } = require('../redis'); const KEY = 'cronstat:v1'; const KEEP = 14;`
  - `recordCronRun(name, summary)` — `entry = { name, at: new Date().toISOString(), ..._pick(summary) }` 를 Redis 의 `{ [name]: [entry...] }` 객체 맨 앞에 넣고 `KEEP` 개로 자른 뒤 `r.set(KEY, prev, { ex: 30일 })`. 전부 `try { ... } catch (_) {}`, Redis 없으면 return.
  - `getCronRuns()` — Redis `r.get(KEY)` 또는 null. `getCronLatest()` — 잡별 `list[0]` 만, 없으면 null.
  - `_pick`·`NUM`·`CRON_MAX_AGE_H`·`findStaleCrons` 등은 그대로 둔다.
- `backend/services/snapshotStore.js`(수정 금지): `getLastSnapshot(key)` → `{ payload, computedAt }`|null, `putSnapshot(key, payload)`. **절대 throw 하지 않는다.** 모듈 상단에서 `require('../db/client')` 를 부른다(admin 이 없으면 no-op).
- 사용처: `services/healthObserveCache.js`(getCronLatest), `routes/cron.js` `checkCronStaleness`(getCronLatest → findStaleCrons). 이 둘은 바꾸지 않는다.
- 테스트: `backend/test/cron-observability.test.js`(cronStats 동작 고정 — Redis 스텁). 관례: 고친 곳 위 `// CRON-DB-2026-10-18 (Plan 162): 이유` 한국어 주석.

## Commands
관련: `node --test backend/test/cron-observability.test.js` → `ℹ fail 0`. 전체: `npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Scope
In scope: `backend/services/cronStats.js`, 새 테스트 `backend/test/cron-runs-db-fallback.test.js`.
Out of scope: snapshotStore.js, routes/cron.js, healthObserveCache.js, SQL·스키마, `_pick`/`NUM`/`CRON_MAX_AGE_H` 내용.

## Git workflow
브랜치 `advisor/162-cron-runs-db-fallback`. 메시지 예: `fix(cron): 실행 기록을 DB 스냅샷에도 남겨 Redis 장애 중 감시 유지 (Plan 162)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`, 끝줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. push 금지.

## Steps
### Step 1: 기록을 두 곳에(서로 독립)
`recordCronRun` 을 두 부분으로 나눈다. ① 기존 Redis 블록은 그대로 두되 `catch (e)` 에서 `logger.warn({ err: e && e.message, name }, 'cron 실행 기록 Redis 저장 실패')` (상단에 `const logger = require('../logger');`). ② 그 뒤에 **별도 try** 로 DB:
```js
// CRON-DB-2026-10-18 (Plan 162): Redis(Upstash) 한도 초과로 기록이 사라져 health.crons·안 돈 cron 감시가 멈췄다.
//   같은 항목을 DB 스냅샷(computed_snapshots, 키 cronstat:db:v1)에도 남긴다 — 두 저장은 서로를 막지 않는다.
try {
  const { getLastSnapshot, putSnapshot } = require('./snapshotStore');
  const cur = await getLastSnapshot(DB_KEY);
  const all = (cur && cur.payload && typeof cur.payload === 'object') ? cur.payload : {};
  const list = Array.isArray(all[entry.name]) ? all[entry.name] : [];
  all[entry.name] = [entry, ...list].slice(0, KEEP);
  await putSnapshot(DB_KEY, all);
} catch (e) { logger.warn({ err: e && e.message, name }, 'cron 실행 기록 DB 저장 실패'); }
```
`const DB_KEY = 'cronstat:db:v1';` 를 상단 상수 옆에. `entry` 는 한 번만 만들어 두 저장에 같은 값을 쓴다(Redis 가 없어도 DB 저장은 해야 하므로 `if (!r) return;` 을 Redis 블록 안으로 옮긴다).
**Verify**: `node --test backend/test/cron-observability.test.js` → `ℹ fail 0`.

### Step 2: 읽을 때 합친다
`getCronRuns()` 를: Redis 값(`r.get(KEY)`, 실패 시 null)과 DB 값(`getLastSnapshot(DB_KEY)?.payload`, 실패 시 null)을 둘 다 읽고, 둘 다 null 이면 null. 아니면 잡 이름별로 두 목록을 합쳐 `at` 이 같은 항목은 하나만 남기고(`at` 문자열 기준 중복 제거) `at` 내림차순 정렬 후 `KEEP` 개. 주석 `// CRON-DB-2026-10-18 (Plan 162): Redis 와 DB 중 더 최근 기록이 이긴다 — Redis 읽기만 간헐 성공해 옛 시각이 보이던 오경보·침묵을 막는다.`
`getCronLatest()` 는 그대로(이 함수를 거친다).
**Verify**: 관련 테스트 → `ℹ fail 0`.

### Step 3: 새 테스트 `backend/test/cron-runs-db-fallback.test.js`
`require.cache` 로 `backend/redis.js`(getRedis)·`backend/services/snapshotStore.js` 를 스텁하고 cronStats 를 다시 require(모델: cron-observability.test.js 의 스텁 방식).
(a) Redis 없음(getRedis → null) 이어도 `recordCronRun('retention', {ok:true})` 후 putSnapshot 이 `cronstat:db:v1` 로 1회, payload.retention[0].name === 'retention'.
(b) Redis set 이 throw 해도 DB 저장은 된다.
(c) `getCronRuns` — Redis 에 retention `at: '2026-10-05T18:00:00Z'`, DB 에 `at: '2026-10-18T18:00:00Z'` → 결과 retention[0].at 이 10-18.
(d) 둘 다 null → `getCronRuns()` null, `getCronLatest()` null.
(e) 같은 `at` 이 양쪽에 있으면 한 번만 나온다.
**Verify**: 새 테스트 5개 `ℹ fail 0`. 권장 회귀 주입: 합치기 대신 Redis 우선으로 되돌리면 (c) 실패.

### Step 4: `npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Done criteria
- `grep -c "cronstat:db:v1" backend/services/cronStats.js` ≥ 1
- `grep -n "catch (_) { /\* 관측 실패가" backend/services/cronStats.js` 0줄(삼키던 catch 가 경고 로그로 바뀜)
- 새 테스트 5개, `npm run verify` 종료 코드 0, `git diff --stat origin/master` 에 in-scope 파일만

## STOP conditions
- snapshotStore 함수 이름·반환 형태가 위와 다르다.
- 기존 cron-observability 테스트가 DB 저장 추가 때문에 깨지고 스텁 추가로 안 풀린다(단언을 바꾸지 말고 보고).

## Maintenance notes
- DB 저장은 cron 회차마다 한 행 갱신(하루 약 20회, 수십 KB) — 용량 영향 무시 수준. 두 cron 이 같은 순간 끝나면 DB 쪽은 마지막 쓰기만 남을 수 있다(Redis 쪽과 합쳐 읽으므로 대개 보완됨).
- Redis 가 복구돼도 이중 기록은 유지한다.
