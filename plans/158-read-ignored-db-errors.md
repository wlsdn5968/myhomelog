# Plan 158: 백엔드 4곳에서 버려지던 DB 오류를 읽어 "실패가 0·빈 값으로 굳는" 일을 막는다

> **Executor instructions**: 단계 순서대로 따른다. 각 단계 검증 명령의 기대 결과를 확인한 뒤 다음으로 간다.
> "STOP conditions" 에 해당하면 멈추고 보고한다. 끝나면 `plans/README.md` 158 행을 갱신한다.
>
> **Drift check (먼저 실행)**: `git diff --stat 217674a..HEAD -- backend/server.js backend/jobs/molitIngest.js backend/routes/cron.js backend/services/popularService.js backend/services/cronStats.js`
> 출력이 있으면 "Current state" 발췌와 실제 코드를 대조하고, 다르면 STOP.

## Status
- **Priority**: P1
- **Effort**: S–M (네 부분 각각 S)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `217674a`, 2026-10-18

## Why this matters
이 저장소는 "supabase-js 는 실패해도 throw 하지 않고 `{data:null, error}` 를 돌려준다 → 오류를 안 읽으면
실패가 0·빈 값처럼 보인다" 클래스의 사고를 여러 번 겪었다(Plan 110: 상태 문자열 CHECK 위반이 90일간 조용히 실패,
Plan 113: 마지막 적재 시각 null 이 6시간 캐시에 굳음). 아래 4곳이 같은 모양으로 남아 있다:
1. **데이터 건수**: 거래·단지 수 조회가 실패하면 `tx: 0`·`apt: 0` 이 **6시간 캐시와 Redis 에 저장**된다(랜딩·브리핑 "실거래 누적"·OG 이미지).
2. **적재 실행 기록**: `molit_ingest_runs` 의 running/ok/error 기록 쓰기 실패를 안 본다. 이 기록은 "빠진 달 찾기"(`retryFailedGaps`)와 원본 자르기 전 P5 점검이 믿는 숫자다.
3. **DB 용량 점검**: 용량 RPC 가 실패하면 흔적 없이 `null` — 85%·93% 경보가 그날 건너뛰어진다(현재 87%).
4. **인기 단지 apt_seq 조회**: 정렬 없는 `.limit(3000)` 인데 PostgREST 기본 행 상한(1,000)에 조용히 잘릴 수 있고 오류도 안 읽는다 → 일부 인기 단지의 `aptSeq` 가 null(랜딩 히어로 실거래 카드 실패).

## Current state
Node 24 / Express 5.2.1, Vercel 서버리스. DB 는 supabase-js(서비스 롤 `getSupabaseAdmin()`). 로거는 `require('../logger')`(pino, `logger.warn({ err: e.message }, '한국어 메시지')` 형식). Sentry 는 `require('../sentry')` 또는 파일 상단의 `Sentry` 변수. 고친 곳 위에는 `// <표식>-2026-10-18 (Plan 158): 이유` 한국어 주석을 단다(저장소 관례, 예: `server.js:557-561`).

### 4-1. `backend/server.js:554-599` (`getDataCounts`)
```js
const [tx, apt, lastIngest] = await Promise.all([
  admin.from('molit_transactions').select('*', { count: 'exact', head: true }),
  admin.from('apt_master').select('*', { count: 'exact', head: true }),
  admin.from('molit_ingest_runs').select('finished_at').eq('status', 'ok')
    .order('finished_at', { ascending: false }).limit(1).maybeSingle(),
]);
const txLive = tx.count || 0;
const out = {
  tx: txLive,
  apt: apt.count || 0,
  lastIngestedAt: lastIngest?.data?.finished_at || null,
};
...
const ttl = out.lastIngestedAt ? 21600 : 60;
cache.set(CK, out, ttl);
if (out.lastIngestedAt) redisCache.rset(CK, out, 21600).catch(() => {});
return out;
```
`tx.error`·`apt.error` 는 어디서도 읽지 않는다. 실패값 60초 규칙(Plan 113)은 `lastIngestedAt` 에만 걸려 있다.
테스트: `backend/test/data-counts-sync.test.js` — `_makeFakeAdmin({ txCount, aptCount, ingestResult })`(`:48-71`)의 count 경로는 항상 `{ count, error: null }`. 60초 규칙 테스트가 `:168` 에 있다(이 테스트를 모델로 삼는다: `app.cache.getTtl(CK)` 로 TTL, `state.rset` 호출 수로 Redis 쓰기 확인).

### 4-2. `backend/jobs/molitIngest.js` (`ingestOne`, 190-270 / 정리 482-489)
```js
const runRes = await admin.from('molit_ingest_runs').insert({ lawd_cd: lawdCd, deal_ym: dealYm, status: 'running' }).select('id').single();
const runId = runRes.data?.id;
...
await admin.from('molit_ingest_runs').update({ status: 'ok', rows_fetched: rows.length, rows_inserted: inserted, finished_at: ... }).eq('id', runId);
return { ok: true, lawdCd, dealYm, fetched: rows.length, inserted };
} catch (e) {
await admin.from('molit_ingest_runs').update({ status: 'error', error_message: ..., finished_at: ... }).eq('id', runId);
return { ok: false, lawdCd, dealYm, error: e.message };
}
```
정리(`:482-489`): `try { await admin.from('molit_ingest_runs').update({status:'timeout',...}).eq('status','running').lt('started_at', ...) } catch (e) { logger.warn(...) }` — supabase-js 는 throw 하지 않으므로 catch 는 사실상 죽은 코드.
집계(`:541-547` 부근): `const ok = results.filter(r => r.ok).length; const err = results.filter(r => !r.ok && !r.skipped).length;` 반환 객체는 `:592` 의 `return { ... }`.
`backend/services/cronStats.js:36-47` 의 `NUM` 배열이 health 에 노출할 숫자 키 화이트리스트다(최상위 숫자 키만 통과 — 중첩 객체는 안 보인다).
테스트 모델: `backend/test/ingest-silent-holes.test.js` 의 `_fakeIngestAdmin`(`:66`)·`_loadMolitIngest`(`:133`)·`_run`(`:156`).

### 4-3. `backend/routes/cron.js:196-205` (`checkDbCapacity`)
```js
const { data, error } = await admin.rpc('get_db_size_bytes');
if (error || data == null) return null;
```
호출부는 **두 곳**이다 — retention 의 POST 처리기(`router.post('/retention'`, `:262`, 호출 `:269`)와 GET 처리기(`router.get('/retention'`, `:324`, 호출 `:329`, Vercel cron 이 실제로 쓰는 쪽). 둘 다 `const _cap = await checkDbCapacity(); if (_cap && Number.isFinite(_cap.usedMb)) { summary.dbUsedMb = ...; summary.dbPct = ...; summary.tableHealthWarns = ...; }` 블록을 갖는다. `backend/test/db-capacity-observability.test.js:41-61` 이 **처리기마다 checkDbCapacity() 호출이 정확히 1회**임을 단언한다. 테스트용 내보내기 `module.exports._checkDbCapacity`(`:831`). 테스트 모델: `backend/test/db-table-health.test.js`(가짜 `rpc(name)` `:46`, 테스트 ①~⑤).

### 4-4. `backend/services/popularService.js:173-184` (`buildPopularResults` 안)
```js
const seqMap = new Map();
try {
  const { data: seqRows } = await admin.from('molit_transactions')
    .select('apt_name, sigungu, umd_nm, apt_seq')
    .in('apt_name', names)
    .not('apt_seq', 'is', null)
    .limit(3000);
  for (const s of (seqRows || [])) {
    const k = `${s.apt_name}|${s.sigungu || ''}|${s.umd_nm || ''}`;
    if (!seqMap.has(k)) seqMap.set(k, s.apt_seq);
  }
} catch (_) { /* aptSeq 는 부가 정보 ... */ }
```
대체 원천: `molit_apt_dim`(`supabase/schema.sql:227-239`) — **apt_seq 가 기본키, 단지당 1행**, 컬럼 `apt_name, lawd_cd, sigungu, umd_nm` 포함. molit-ingest cron 이 매일 `refresh_molit_apt_dim()`(`schema.sql:829` 부근)으로 갱신하는데, 그 함수가 이름·시군구·읍면동을 **`molit_transactions` 에서 그대로 복사**하므로 키 문자열(`apt_name|sigungu|umd_nm`)이 원본과 같다(단, 이름이 바뀐 단지는 dim 이 최신 이름 1개만 가져 옛 이름 키가 매칭되지 않을 수 있다 — 그때 aptSeq 는 null, 기존 실패 처리 그대로). 이미 `routes/aptPage.js:117`·`services/aptDimService.js:34` 가 서비스 롤로 읽는다.
테스트 모델: `backend/test/apt-display-name.test.js:204-227`(`buildPopularResults(12, { client })` 에 가짜 client 주입).

## Commands you will need
| Purpose | Command (저장소 루트) | Expected |
|---|---|---|
| 개별 테스트 | `node --test backend/test/data-counts-sync.test.js` (파일명 바꿔 가며) | `ℹ fail 0` |
| 전체 검증 | `npm run verify` | 종료 코드 0, `ℹ fail 0` (테스트는 TZ=UTC 래퍼로 돈다) |

## Scope
**In scope**: `backend/server.js`(getDataCounts 만), `backend/jobs/molitIngest.js`(ingestOne·정리·요약), `backend/routes/cron.js`(checkDbCapacity·retention 호출부), `backend/services/popularService.js`(seq 조회 블록만), `backend/services/cronStats.js`(NUM 에 키 추가만), 위 4개 테스트 파일.
**Out of scope**: DB 스키마·마이그레이션·RPC(이 계획은 SQL 을 바꾸지 않는다), `retryFailedGaps` 의 선택 로직, `getDataCounts` 의 이력(hist) 분기(이미 오류를 읽는다), 프런트엔드, Redis 사용 방식.

## Git workflow
- 브랜치 `advisor/158-read-ignored-db-errors`, 4-1~4-4 각각 커밋. 메시지 예: `fix(health): 데이터 건수 조회 실패를 6시간 캐시에 굳히지 않는다 (Plan 158)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`.
- push·PR 은 운영자 지시가 있을 때만.

## Steps
### Step 1 (4-1): 건수 조회 실패는 짧게만 캐시
`getDataCounts` 에서 `out` 을 만든 직후:
```js
// COUNTS-ERR-2026-10-18 (Plan 158): 건수 조회가 실패하면 0 이 6시간 캐시·Redis 에 굳었다(Plan 113 과 같은 클래스).
const countsFailed = !!(tx.error || apt.error);
if (countsFailed) logger.warn({ txErr: tx.error?.message, aptErr: apt.error?.message }, 'getDataCounts: 건수 조회 실패 — 60초만 캐시');
```
그리고 TTL·Redis 조건을 `const ok = out.lastIngestedAt && !countsFailed; const ttl = ok ? 21600 : 60;` / `if (ok) redisCache.rset(...)` 로 바꾼다. 반환 형태(키 이름)는 바꾸지 않는다.
**Verify**: `data-counts-sync.test.js` 의 `_makeFakeAdmin` 에 `txError`·`aptError` 옵션을 더해(count 경로에서 `{ count: null, error: txError }` 반환) 테스트 2개 추가 — (a) txError 시 `app.cache.getTtl(CK)` 가 지금+60초 이하이고 `state.rset` 0회, (b) aptError 도 같음. `node --test backend/test/data-counts-sync.test.js` → `ℹ fail 0`.

### Step 2 (4-2): 적재 실행 기록 쓰기 결과를 읽는다
`ingestOne` 안 3곳의 결과를 `const { error: xErr } = await ...` 로 받아, 하나라도 오류면 `logger.warn({ lawdCd, dealYm, err: xErr.message }, 'molit_ingest_runs 기록 실패')` 를 남기고 반환 객체에 `runRecordFailed: true` 를 더한다(running insert 실패로 `runId` 가 없으면 ok/error update 는 건너뛰고 역시 `runRecordFailed: true`). 데이터 적재 성공 여부(`ok`)는 **바꾸지 않는다**.
정리(`:482-489`)는 `const { error: staleErr } = await ...; if (staleErr) logger.warn({ err: staleErr.message }, 'molit_ingest_runs stale 정리 실패 (계속 진행)');` 로 바꾸고 바깥 try/catch 는 그대로 둔다.
요약(`:541-547` 부근)에 `const runRecordFailed = results.filter(r => r.runRecordFailed).length;` 를 만들고 `:592` 반환 객체에 `runRecordFailed` 를 넣는다. `cronStats.js` 의 `NUM` 배열에 `'runRecordFailed'` 를 추가한다.
**Verify**: `ingest-silent-holes.test.js` 의 `_fakeIngestAdmin(initialRows, opts)` 에서 `molit_ingest_runs` 의 `update(patch)`(`:113` 부근)가 돌려주는 결과를 `opts.runUpdateError` 가 있으면 `{ error: opts.runUpdateError }` 로 내도록 옵션을 더한다(없으면 기존 동작). 기존 `_run` 은 `_retryFailedGaps` 만 부르므로, 새 테스트는 `_loadMolitIngest(...)` 로 모듈을 받아 `mod._ingestOne(admin, '11110', '202509')` 를 직접 부른다(MOLIT 응답은 파일의 `_dgkStub()` 사용). 같은 파일 끝에 테스트 2개 — (a) 가짜 admin 의 `molit_ingest_runs` update 가 `{ error: {message:'x'} }` 를 돌려줄 때 `ingestOne` 결과(테스트용으로 `module.exports._ingestOne = ingestOne;` 를 기존 TEST-EXPORT 줄 옆에 추가)에 `runRecordFailed: true`, `ok` 는 데이터 적재가 성공했으면 `true` 그대로, (b) `cronStats` 의 `_pick` 이 `runRecordFailed` 숫자를 통과시킨다(`require('../services/cronStats')` 에 `_pick` 이 내보내져 있지 않으면 소스에서 `NUM` 배열에 `'runRecordFailed'` 문자열이 있는지 단언). `node --test backend/test/ingest-silent-holes.test.js` → `ℹ fail 0`.

### Step 3 (4-3): 용량 점검 실패를 보이게 한다
`checkDbCapacity` 의 `if (error || data == null) return null;` 를:
```js
if (error || data == null) {
  // DBCAP-ERR-2026-10-18 (Plan 158): 실패가 null 로 사라져 85%·93% 경보가 흔적 없이 건너뛰어졌다.
  logger.warn({ err: error && error.message }, 'get_db_size_bytes 실패 — 용량 경보 판정 불가');
  return { error: (error && error.message) || 'no data' };
}
```
retention 호출부 **두 곳(POST `:269` 블록·GET `:329` 블록) 모두**에 `if (_cap && _cap.error) summary.dbCheckFailed = 1;` 를 추가하고 `NUM` 에 `'dbCheckFailed'` 를 넣는다. `checkDbCapacity()` 호출 횟수는 늘리지 않는다(위 관찰성 테스트). (`admin` 이 없을 때의 `return null` 은 그대로 둔다 — 키 미설정 로컬 환경.)
**Verify**: `db-table-health.test.js` 의 `_makeAdmin`(`:43-54`)에 옵션 `sizeError = null` 을 더해 `get_db_size_bytes` 분기를 `return Promise.resolve(sizeError ? { data: null, error: sizeError } : { data: usedBytes, error: null });` 로 바꾸고, 테스트 1개 — 가짜 `rpc('get_db_size_bytes')` 가 `{ data: null, error: {message:'timeout'} }` 일 때 `_checkDbCapacity()` 결과가 `{ error: 'timeout' }` 이고 Sentry 용량 경보는 0회. `node --test backend/test/db-table-health.test.js` 와 `node --test backend/test/db-capacity-observability.test.js` → 둘 다 `ℹ fail 0`.

### Step 4 (4-4): 인기 단지 apt_seq 를 단지 차원 테이블에서 읽는다
seq 조회 블록을 바꾼다:
```js
// POPULAR-SEQ-2026-10-18 (Plan 158): molit_transactions 에서 정렬 없이 limit(3000) 으로 읽어 PostgREST 기본 상한(1,000)에
//   조용히 잘릴 수 있었고 오류도 버렸다. 단지당 1행인 molit_apt_dim 에서 이름·시군구로 좁혀 읽는다.
const sggs = [...new Set(top.map(t => t.sigungu).filter(Boolean))];
let q = admin.from('molit_apt_dim').select('apt_name, sigungu, umd_nm, apt_seq').in('apt_name', names);
if (sggs.length) q = q.in('sigungu', sggs);
const { data: seqRows, error: seqErr } = await q.limit(1000);
if (seqErr) logger.warn({ err: seqErr.message }, 'popular: apt_seq 조회 실패 — aptSeq 없이 진행');
else if ((seqRows || []).length >= 1000) logger.warn('popular: apt_seq 조회가 1,000행 상한에 닿음 — 일부 aptSeq 누락 가능');
```
루프(`seqMap.set`)와 바깥 try/catch 는 유지한다. `popularService.js` 상단에 `logger` require 가 없으면 다른 서비스와 같은 방식으로 추가한다(`const logger = require('../logger');`).
**Verify**: `apt-display-name.test.js` 의 가짜 client 가 `from('molit_apt_dim')` 을 지원하는지 확인하고(없으면 그 테스트의 client 에 `molit_apt_dim` 분기 추가), 새 테스트 1개 — `molit_apt_dim` 이 `[{apt_name:'은마', sigungu:'강남구', umd_nm:'대치동', apt_seq:'11680-218'}]` 를 줄 때 결과 행의 `aptSeq === '11680-218'`, `molit_transactions` 에는 `apt_seq` 를 고르는 조회가 가지 않는다. `node --test backend/test/apt-display-name.test.js` → `ℹ fail 0`.

### Step 5: 전체 검증
`npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Test plan
위 Step 1~4 의 테스트(총 6개). 각각 해당 파일의 기존 테스트를 구조 모델로 쓴다. 권장: 각 단계 뒤 고친 줄을 잠시 되돌려 새 테스트가 실패하는지(회귀 감지력) 확인하고 원복.

## Done criteria
- [ ] `grep -n "countsFailed" backend/server.js` ≥ 2줄
- [ ] `grep -n "runRecordFailed" backend/jobs/molitIngest.js backend/services/cronStats.js` 가 두 파일 모두에서 나온다
- [ ] `grep -n "dbCheckFailed" backend/routes/cron.js backend/services/cronStats.js` 가 두 파일 모두에서 나온다
- [ ] `grep -c "molit_apt_dim" backend/services/popularService.js` ≥ 1 이고 `grep -c "limit(3000)" backend/services/popularService.js` = 0
- [ ] 새 테스트 6개 존재, `npm run verify` 종료 코드 0
- [ ] `git status` 에 in-scope 외 변경 없음, `plans/README.md` 158 행 갱신

## STOP conditions
- `molit_apt_dim` 에 `sigungu` 컬럼이 없거나 `supabase/schema.sql` 정의가 위와 다르다.
- `ingestOne` 의 반환 객체를 쓰는 다른 곳(`retryFailedGaps` `:450`, 본 루프 `:532`)이 새 필드 때문에 동작이 바뀌어야 하는 것으로 보인다.
- `cronStats.js` 의 `NUM` 이 배열이 아니거나 `_pick` 이 키를 다른 방식으로 거른다.
- 어떤 단계든 SQL·RPC 변경이 필요해 보인다(이 계획 범위 밖 — 운영자 승인 필요).

## Maintenance notes
- 새 supabase 호출을 추가할 때는 항상 `{ error }` 를 받아 로그를 남긴다 — "빈 결과" 와 "실패" 를 구분하는 것이 이 저장소의 반복 교훈이다.
- `runRecordFailed`·`dbCheckFailed` 는 health 의 crons 요약으로 보이지만, 현재 Redis(Upstash) 한도 초과 기간에는 crons 요약 자체가 null 이다(별도 과제). 로그(`logger.warn`)는 Vercel 런타임 로그로 보인다.
- 인기 단지 aptSeq 는 `molit_apt_dim` 갱신(매일 molit-ingest 뒤)에 의존한다 — 신규 단지는 하루 늦게 aptSeq 가 생길 수 있다(기존에도 프런트는 null 이면 실패 문구로 처리).
