# Plan 161: health 의 무거운 건수 조회를 요청 경로에서 빼고 하루 1회 DB 스냅샷으로 읽는다

> **Executor instructions**: 단계 순서대로 따르고 각 검증의 기대 결과를 확인한다. "STOP conditions" 면 멈추고 보고한다.
> 끝나면 `plans/README.md` 161 행을 갱신한다(리뷰어가 색인을 관리한다고 했으면 제외).
>
> **Drift check (먼저 실행)**: `git diff --stat 3887263..HEAD -- backend/server.js backend/routes/cron.js backend/services/snapshotStore.js`
> 출력이 있으면 "Current state" 와 대조하고, 다르면 STOP.

## Status
- **Priority**: P1
- **Effort**: M
- **Risk**: MED (health 응답·여러 화면이 읽는 캐시 키를 다룬다)
- **Depends on**: none (Plan 158 완료 상태 위에서 작성)
- **Category**: perf / reliability
- **Planned at**: commit `3887263`, 2026-10-18

## Why this matters
2026-10-18 운영 실측(Supabase 게이트웨이·DB 로그):
- count=exact HEAD 요청 500 이 14회. **전부 응답 8.4~10.9초** = DB 역할 `authenticator` 의 `statement_timeout=8s` 초과 취소(DB 로그 "canceling statement due to statement timeout" 동시각).
- 두 묶음 모두 **운영 배포 25~30초 뒤**(01:40:18 배포 b8c12c4 → 01:40:41~59 실패, 04:34:26 배포 c1a8cb7 → 04:34:55~57 실패). 그 두 창(약 100초)에만 `apt_master` HEAD count 38회·`molit_transactions` 8회·`molit_transactions_hist` 7회.
- 평소엔 같은 count 가 DB 안에서 즉시 끝난다(`select count(*) from apt_master` = 14,690, `molit_transactions` = 453,352 즉시).
원인: 새 서버리스 인스턴스는 첫 `/api/health` 에서 **무거운 정확 건수 10개를 동시에** 날린다 — `getDataCounts` 3개(원본 45만·이력 136만 행 전체 count 포함) + `getFacilityQuality` 7개(apt_master JSON 조건 count). 인스턴스끼리 공유되던 Redis 캐시는 Upstash 한도 초과(2026-10-05~)로 비어 있어 **인스턴스마다 다시 센다**. 배포 직후 여러 인스턴스가 겹치면 무료 DB 가 포화돼 작은 표 count 까지 8초를 넘긴다.
건수는 하루 1회(적재 17:00~17:30 UTC) 뒤에만 바뀐다. **하루 1회 cron 이 한 번 세서 DB 스냅샷(`computed_snapshots`)에 저장하고, health 는 그 한 행만 읽게** 하면 요청 경로의 무거운 조회가 사라진다. 덤으로 `getFacilityQuality` 도 `count || 0` 으로 오류를 버려 실패 시 0 이 6시간 굳는 같은 클래스 결함(Plan 158 과 동일)이 있어 함께 고친다.

## Current state
- Node 24 / Express 5.2.1, Vercel 서버리스(진입 `api/index.js` → `require('../backend/server')`). 공유 메모리 캐시 `backend/cache.js`(node-cache, `server.js:66` `const cache = require('./cache');`). 로거 `backend/logger.js`.
- **`backend/services/snapshotStore.js`** (Plan 142, 그대로 쓴다 — 수정 금지): `getSnapshot(key, maxAgeMs)`·`getLastSnapshot(key)` → `{ payload, computedAt }` 또는 null, `putSnapshot(key, payload)`. **절대 throw 하지 않는다**. 테이블 `computed_snapshots(key text pk, payload jsonb, computed_at timestamptz)` 는 이미 운영에 있다(사용 예 `services/priceRecordsService.js:21`).
- **`backend/server.js:538-626`** `async function getDataCounts(opts)` — 캐시 키 `meta:dataCounts:v2`(메모리 → Redis `rget` → DB). DB 단계: `molit_transactions`·`apt_master` count exact head + `molit_ingest_runs` 최신 ok 1건, `opts.includeHist` 면 `molit_transactions_hist` count. Plan 158 이후 `countsFailed`(tx/apt 오류) 또는 `lastIngestedAt` 없음이면 60초만 메모리 캐시·Redis 미기록, 성공이면 6시간 + Redis. 함수 안에서 `require('./db/client')`·`require('./services/redisCache')` 를 **함수 안에서(지연) require** 한다 — 테스트 스텁이 이 지연 require 에 의존한다.
- **`backend/server.js:633-690`** `async function getFacilityQuality()` — 캐시 키 `meta:facilityQuality`, `admin.from('apt_master')` count exact head 7개를 `Promise.all`, 각 결과를 `x.count || 0` 으로 읽고(**`.error` 를 안 본다**), `cache.set(CK, out, 21600)`. 바깥 `catch (e) { return null; }`.
- **health 호출부** `backend/server.js:742` `const _dataCounts = await getDataCounts({ includeHist: true });` 와 `:750-751`:
  ```js
  let _facQuality = cache.get('meta:facilityQuality');
  if (_facQuality === undefined) { _facQuality = null; getFacilityQuality().catch(() => {}); }
  ```
- 같은 캐시 키를 읽는 다른 곳(바꾸지 않는다, 그대로 동작해야 함): `routes/briefing.js:150-151`·`services/briefingService.js:54-55` 가 `cache.get('meta:dataCounts:v2')` → Redis `rget` 순으로 읽는다.
- 테스트 내보내기 `server.js:889-892` `module.exports._getDataCounts = getDataCounts;`. 이 함수를 고정하는 테스트: `backend/test/data-counts-sync.test.js`(admin `from()` 정확히 3회·반환 3키·TTL·rset 횟수 등), `backend/test/window-safe-readers.test.js`(includeHist 분기). `backend/test/facility.test.js:566` 은 소스에서 `async function getFacilityQuality` 를 찾아 본문을 검사한다(**파일 위치가 바뀌면 깨질 수 있다** — 아래 Step 1 참고).
- **daily cron**: `vercel.json` 의 `/api/cron/retention` 이 `"0 18 * * *"`(적재 17:00~17:30 UTC 뒤). `backend/routes/cron.js` 에 POST(`router.post('/retention'`, `:262`)·GET(`router.get('/retention'`, `:324`, Vercel cron 이 실제로 부르는 쪽) **두 처리기**가 같은 순서로 `runRetention()` → `checkDbCapacity()` → `summary` 채움 → `recordCronRun('retention', summary)` 를 한다. `backend/test/db-capacity-observability.test.js:41-61` 이 처리기마다 `checkDbCapacity()` 호출이 정확히 1회임을 단언한다.
- `routes/cron.js` 는 `server.js` 를 require 하지 않는다(서버가 cron 라우터를 require 하므로 반대 방향 require 는 순환이다 — 하지 말 것).
- 관례: 고친 곳 위에 `// <표식>-2026-10-18 (Plan 161): 이유` 한국어 주석. 커밋 본문 `[근본 원인] [Fix 내용] [회귀 위험]`.

## Commands you will need
| Purpose | Command (저장소 루트) | Expected |
|---|---|---|
| 관련 테스트 | `node --test backend/test/data-counts-sync.test.js backend/test/window-safe-readers.test.js backend/test/facility.test.js backend/test/db-capacity-observability.test.js backend/test/briefing-links.test.js` | `ℹ fail 0` |
| 전체 검증 | `npm run verify` | 종료 코드 0, `ℹ fail 0` |

## Scope
**In scope**: `backend/server.js`(두 함수를 새 모듈로 옮기고 import·re-export, health 두 곳), 새 파일 `backend/services/healthCounts.js`, `backend/routes/cron.js`(retention 처리기 두 곳에 스냅샷 갱신 호출 추가), `backend/services/cronStats.js`(`NUM` 에 키 2개 추가만), 새 테스트 파일 `backend/test/health-counts-snapshot.test.js`, 그리고 위치 이동 때문에 깨지는 경우에 한해 `backend/test/facility.test.js:566` 부근의 **소스 경로만**.
**Out of scope**: `services/snapshotStore.js`(수정 금지), DB 스키마·RPC·SQL, `vercel.json`(새 cron 추가 금지 — 기존 retention 에 얹는다), 캐시 키 이름(`meta:dataCounts:v2`·`meta:facilityQuality`) 변경, briefing 쪽 읽기 코드, 프런트엔드, health 응답의 키 이름·형태.

## Git workflow
- 브랜치 `advisor/161-health-counts-snapshot`. 단계별 커밋. 메시지 예: `perf(health): 무거운 건수 조회를 하루 1회 DB 스냅샷으로 (Plan 161)`.
- push·PR 은 운영자 지시가 있을 때만.

## Steps
### Step 1: 두 함수를 새 모듈로 옮긴다(동작 변화 0)
`backend/services/healthCounts.js` 를 만들고 `server.js:533-626`(getDataCounts 위 설명 주석 포함)과 `:628-690`(getFacilityQuality 위 주석 포함) 을 **그대로** 옮긴다. 옮기면서 경로만 고친다: 함수 안의 `require('./db/client')` → `require('../db/client')`, `require('./services/redisCache')` → `require('./redisCache')`. 모듈 상단: `'use strict'; const cache = require('../cache'); const logger = require('../logger');`. 내보내기: `module.exports = { getDataCounts, getFacilityQuality };`.
`server.js` 에서는 두 함수 정의를 지우고 그 자리에 `const { getDataCounts, getFacilityQuality } = require('./services/healthCounts');` 한 줄. `module.exports._getDataCounts = getDataCounts;` 는 그대로 둔다.
⚠ **지연 require 를 모듈 상단으로 끌어올리지 말 것** — 테스트는 `server.js` 를 require 하기 전에 `require.cache` 에 `db/client`·`services/redisCache` 스텁을 넣는다. 함수 안 지연 require 라야 스텁이 먹는다.
`backend/test/facility.test.js:566` 부근이 `server.js` 소스에서 `async function getFacilityQuality` 를 찾는다면, 읽는 파일 경로만 `services/healthCounts.js` 로 바꾼다(단언 내용은 바꾸지 않는다).
**Verify**: 위 "관련 테스트" 명령 → `ℹ fail 0`. `grep -c "async function getDataCounts\|async function getFacilityQuality" backend/server.js` → `0`, 같은 grep 을 `backend/services/healthCounts.js` 에 → `2`.

### Step 2: getFacilityQuality 가 오류를 읽게 한다
`Promise.all` 결과 7개 중 하나라도 `.error` 가 있으면 `logger.warn({ errs: <오류 메시지 배열> }, 'facilityQuality: 건수 조회 실패 — 캐시하지 않음')` 후 **`return null`**(캐시·0 저장 금지). 주석 `// FACQ-ERR-2026-10-18 (Plan 161): count 오류를 || 0 으로 버려 실패 시 0 이 6시간 굳었다(Plan 158 과 같은 클래스).`
**Verify**: Step 5 의 테스트 (c).

### Step 3: 스냅샷 갱신·읽기 함수를 추가한다 (`healthCounts.js`)
```js
// HEALTH-SNAPSHOT-2026-10-18 (Plan 161): 새 인스턴스가 첫 health 에서 무거운 count 10개를 동시에 날려
//   배포 직후 DB 가 포화(statement_timeout 8s 초과 500, 운영 로그 실측)됐다. 건수는 하루 1회 적재 뒤에만 바뀌므로
//   retention cron(18:00 UTC)이 한 번 세어 computed_snapshots 에 두고, health 는 그 한 행만 읽는다.
const SNAP_COUNTS = 'health:dataCounts:v1';
const SNAP_FACQ = 'health:facilityQuality:v1';

/** cron 전용 — 캐시를 비우고 실제로 다시 센 뒤 성공한 값만 스냅샷에 둔다. 절대 throw 하지 않는다. */
async function refreshHealthSnapshots() {
  const out = { counts: false, facility: false };
  try {
    const { putSnapshot } = require('./snapshotStore');
    cache.del('meta:dataCounts:v2');
    const dc = await getDataCounts({ includeHist: true, skipRedis: true });
    if (dc && dc.lastIngestedAt && Number(dc.tx) > 0 && Number(dc.apt) > 0) { await putSnapshot(SNAP_COUNTS, dc); out.counts = true; }
    cache.del('meta:facilityQuality');
    const fq = await getFacilityQuality();
    if (fq && Number(fq.total) > 0) { await putSnapshot(SNAP_FACQ, fq); out.facility = true; }
  } catch (e) { logger.warn({ err: e && e.message }, 'health 스냅샷 갱신 실패'); }
  return out;
}

/** health 전용 — 메모리 → 스냅샷(한 행) → (스냅샷이 아직 없을 때만) 기존 실시간 계산. */
async function readDataCounts() {
  const hit = cache.get('meta:dataCounts:v2');
  if (hit) return hit;
  try {
    const { getLastSnapshot } = require('./snapshotStore');
    const s = await getLastSnapshot(SNAP_COUNTS);
    if (s && s.payload && s.payload.lastIngestedAt) {
      cache.set('meta:dataCounts:v2', s.payload, 1800); // 30분 — 같은 키를 읽는 브리핑도 그대로 쓴다
      return s.payload;
    }
  } catch (_) { /* 스냅샷 실패는 아래 기존 경로로 */ }
  return getDataCounts({ includeHist: true });
}

/** health 전용 — 메모리 → 스냅샷. 둘 다 없으면 null 을 주고 (스냅샷이 아예 없을 때만) 백그라운드 계산. */
async function readFacilityQuality() {
  const hit = cache.get('meta:facilityQuality');
  if (hit !== undefined) return hit;
  try {
    const { getLastSnapshot } = require('./snapshotStore');
    const s = await getLastSnapshot(SNAP_FACQ);
    if (s && s.payload) { cache.set('meta:facilityQuality', s.payload, 1800); return s.payload; }
  } catch (_) { /* 아래로 */ }
  getFacilityQuality().catch(() => {});
  return null;
}
```
`getDataCounts` 에 `opts.skipRedis` 지원을 추가한다: `if (!opts || !opts.skipRedis) { ...기존 Redis rget 블록... }` 로 감싸기만(기본 동작 불변). `module.exports` 에 `refreshHealthSnapshots, readDataCounts, readFacilityQuality, SNAP_COUNTS, SNAP_FACQ` 추가.
**Verify**: "관련 테스트" → `ℹ fail 0`(기존 동작 불변).

### Step 4: health 와 cron 을 연결한다
- `server.js` health: `:742` `await getDataCounts({ includeHist: true })` → `await readDataCounts()`. `:750-751` 두 줄 → `const _facQuality = await readFacilityQuality();`. import 한 줄에 `readDataCounts, readFacilityQuality` 추가.
- `routes/cron.js` retention **POST·GET 두 처리기 모두**, `if (_cap && _cap.error) summary.dbCheckFailed = 1;` 줄 바로 다음에:
  ```js
  // HEALTH-SNAPSHOT-2026-10-18 (Plan 161): 하루 1회 건수 스냅샷 갱신 — 실패해도 retention 은 계속(함수가 throw 하지 않는다).
  const _hs = await require('../services/healthCounts').refreshHealthSnapshots();
  summary.healthSnapCounts = _hs.counts ? 1 : 0;
  summary.healthSnapFacility = _hs.facility ? 1 : 0;
  ```
  (`checkDbCapacity()` 호출 수는 그대로.) `backend/services/cronStats.js` 의 `NUM` 배열에 `'healthSnapCounts', 'healthSnapFacility'` 를 추가한다(이 파일은 이 두 문자열 추가만 허용 — In scope 에 포함).
**Verify**: `node --test backend/test/db-capacity-observability.test.js` → `ℹ fail 0`. `grep -c "refreshHealthSnapshots" backend/routes/cron.js` → `2`.

### Step 5: 테스트 `backend/test/health-counts-snapshot.test.js` (새 파일)
모델: `backend/test/data-counts-sync.test.js` 의 `require.cache` 스텁 방식(db/client·services/redisCache 를 스텁하고 모듈을 다시 require). 스냅샷은 `services/snapshotStore` 를 `require.cache` 로 스텁해 `getLastSnapshot`·`putSnapshot` 호출을 기록한다.
(a) `readDataCounts` — 메모리 캐시가 비고 스냅샷이 `{ tx: 100, apt: 10, lastIngestedAt: '2026-10-18T17:30:00Z' }` 면 그 값을 돌려주고 **admin `from()` 호출 0회**, 이후 `cache.get('meta:dataCounts:v2')` 가 그 값.
(b) `readDataCounts` — 스냅샷이 null 이면 기존 `getDataCounts` 경로로 간다(admin `from()` 이 호출됨).
(c) `getFacilityQuality` — 7개 중 하나가 `{ count: null, error: {message:'timeout'} }` 면 `null` 을 돌려주고 `cache.get('meta:facilityQuality')` 가 `undefined`(0 저장 안 함).
(d) `refreshHealthSnapshots` — 정상 스텁이면 `putSnapshot` 이 `health:dataCounts:v1`·`health:facilityQuality:v1` 로 각 1회, 반환 `{counts:true, facility:true}`; tx count 가 오류면 `counts:false` 이고 그 키로 `putSnapshot` 0회.
(e) 소스 고정: `server.js` health 핸들러에 `readDataCounts()`·`readFacilityQuality()` 가 있고 `getFacilityQuality().catch` 가 `server.js` 에 없다.
**Verify**: `node --test backend/test/health-counts-snapshot.test.js` → 새 테스트 5개 `ℹ fail 0`.

### Step 6: 전체 검증
`npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Test plan
Step 5 의 5개 + 기존 관련 테스트 무변경 통과. 권장 회귀 주입: `readDataCounts` 에서 스냅샷 분기를 지우면 (a) 가 실패해야 한다.

## Done criteria
- [ ] `grep -c "async function getDataCounts\|async function getFacilityQuality" backend/server.js` = 0, `backend/services/healthCounts.js` = 2
- [ ] `grep -c "refreshHealthSnapshots" backend/routes/cron.js` = 2
- [ ] `grep -n "readDataCounts()\|readFacilityQuality()" backend/server.js` 2줄 이상
- [ ] 새 테스트 5개, `npm run verify` 종료 코드 0
- [ ] `git diff --stat origin/master` 에 in-scope 파일만

## STOP conditions
- 함수를 옮긴 뒤 `data-counts-sync`·`window-safe-readers` 테스트가 깨지고, 원인이 경로 수정만으로 안 풀린다(스텁 방식과 충돌) — 테스트 단언을 바꾸지 말고 보고.
- `computed_snapshots`·`snapshotStore` 의 함수 이름·반환 형태가 위와 다르다.
- retention 처리기가 위 설명(두 처리기, `dbCheckFailed` 줄)과 다르다.
- 순환 require 가 필요해 보인다.

## Maintenance notes
- 운영 첫 배포 뒤 **첫 18:00 UTC retention 전까지는 스냅샷이 없어** health 가 기존 실시간 경로를 쓴다(지금과 동일). 리뷰어는 배포 후 retention 을 한 번 수동 실행(GET `/api/cron/retention`, CRON_SECRET 필요 — 운영자만)하거나 다음 18:00 UTC 뒤 `computed_snapshots` 에 두 키가 생겼는지 확인한다.
- `lastIngestedAt` 은 스냅샷 시각(18:00 UTC) 기준이라 적재(17:00~17:30) 뒤 최대 약 30분은 전날 값일 수 있다 — 표시용으로 허용 범위.
- Redis 가 다시 살아나도 이 경로는 그대로 둔다(인스턴스 수와 무관하게 DB 한 행 읽기).
