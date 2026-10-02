# 132 — Plan 129 2단계(코드): 검색·지도·인기 라이브 집계를 공개 키 → service_role

**작성 기준 커밋**: `b43827c` (2026-10-02) · **부모**: `plans/129-public-key-surface-reduction.md` §4 · **운영자 결정 2026-10-02**: "진행" (3초 → 8초 절충을 측정 사실과 함께 확인받음)
**성격**: 백엔드 2파일 각 1줄의 동작 변경 + 주석 + 신규 테스트 1. DB·프런트·의존성·환경변수 변경 0. **DB 권한 SQL 은 이 계획에 없다** — 배포 24시간 관찰 뒤 운영자가 직접 실행(§6).
**계획자 사전 검증**(저장소 밖 사본): 신규 테스트 3/3 · **원래 코드에서는 3개 중 2개 실패**(음성 대조) · 전체 backend 608 중 604(실패 4 는 사본에 node_modules 가 없어 생기는 OG 이미지 테스트 — 변경 무관) · ESLint 0 · check-env-example·security-regression 통과.

## 1. 사실 (계획자 실측 2026-10-02)
- `backend/routes/search.js:74` `const adminClient = () => getSupabaseReadonly();` — 이름과 달리 공개 키. 이 클라이언트로 `molit_apt_index`(MV)·`apt_master`·`molit_transactions`·`apt_geocache` 를 읽는다(자동완성·지도 `/in-bounds`·시설 대체 후보). `search_history` 3곳은 `userScopedClient(req.accessToken)`(RLS) — 대상 아님.
- `backend/services/popularService.js:68` `buildPopularResults` 기본 클라이언트 = 공개 키(`anonClient()`) — 사용자 `/api/search/popular` 의 라이브 집계(스냅샷이 36h 넘게 낡았을 때만, 결과 30분 캐시). cron 은 이미 `serviceClient()` 를 넘긴다. `readPopularSnapshot`(작은 공개 테이블 `popular_apts_snapshot`)은 공개 키 유지.
- 공개 키를 쓰는 다른 곳(규제 스냅샷·요금제)은 수 KB 공개 테이블이라 대상 아님.
- 최근 24시간 게이트웨이 로그: 공개 키 요청 302건 평균 593ms·최대 1,497ms(anon DB 상한 3s 에 근접 0). 역할별 DB `statement_timeout`: anon 3s · authenticated 8s · authenticator 8s · service_role 설정 없음(authenticator 값 상속).
- 기존 테스트 스텁은 `getSupabaseAdmin`·`getSupabaseReadonly` 를 둘 다 제공한다 — 후보 적용 뒤 기존 테스트 실패 0(전체 실행으로 확인).

## 2. 변경 (실행자) — CRLF 줄 끝 파일, **Edit 도구로 부분 교체만**
### 2-1. `backend/routes/search.js`
#### import
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
const { getUserScopedClient: userScopedClient, getSupabaseReadonly } = require('../db/client');
```
바꿀 코드:
```js
const { getUserScopedClient: userScopedClient, getSupabaseAdmin } = require('../db/client');
```

#### adminClient 정의
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
// SSOT-2026-08-09 (Plan 007): 구명 adminClient 는 실권한과 불일치(공개키 우선 readonly) —
//   db/client.getSupabaseReadonly 로 통합(키 체인 동일, 콜사이트 이름만 정리).
const adminClient = () => getSupabaseReadonly();
```
바꿀 코드:
```js
// SSOT-2026-08-09 (Plan 007): 구명 adminClient 는 실권한과 불일치(공개키 우선 readonly) —
//   db/client.getSupabaseReadonly 로 통합(키 체인 동일, 콜사이트 이름만 정리).
// PUBLIC-KEY-SURFACE-2026-10-02 (Plan 132 = Plan 129 2단계 코드): 공개 키 → service_role.
//   [왜] 공개 키(프런트 메타 태그에 공개)가 원본 거래·단지·좌표·검색 색인을 읽을 수 있어야 이 라우트가
//     동작했고, 그 때문에 누구나 같은 키로 Supabase REST 를 직접 불러 우리 레이트리밋 밖에서 대량 조회할 수
//     있었다(무료 전송량 5GB 소진 → 전 API 402 위험). 백엔드가 service_role 로 읽으면 그 테이블들의
//     공개 읽기 권한을 닫을 수 있다(DB 쪽은 배포 24시간 관찰 뒤 별도 적용 — plans/129 §4).
//   [절충 — 운영자 결정 2026-10-02] anon 의 DB statement_timeout 3s 방어층 대신 8s(authenticator)가 된다.
//     실측(전환 전 24시간): 이 경로의 공개 키 요청 302건 평균 0.6s·최대 1.5s. 아래 _softQuery 의
//     소프트 타임아웃(1~2.5s)은 그대로라 사용자 응답 시간은 같다.
//   여기서 읽는 것은 전부 공개 데이터(실거래·단지·좌표)다 — 사용자 소유 행(search_history)은 아래에서
//   종전대로 userScopedClient(RLS)로만 다룬다.
const adminClient = () => getSupabaseAdmin();
```

### 2-2. `backend/services/popularService.js`
#### 클라이언트 설명 주석
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
// 읽기용(공개 데이터) = getSupabaseReadonly, 쓰기용(RLS bypass) = getSupabaseAdmin — 키 체인 동일
```
바꿀 코드:
```js
// 스냅샷 읽기(작은 공개 테이블) = getSupabaseReadonly, 라이브 집계·쓰기 = getSupabaseAdmin
//   PUBLIC-KEY-SURFACE-2026-10-02 (Plan 132): 라이브 집계가 읽는 원본 거래·좌표는 공개 키 권한을 닫을
//   대상이라 service_role 로 읽는다(plans/129 §4). popular_apts_snapshot 은 공개 유지.
```

#### buildPopularResults 문서 주석
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
 *   미지정이면 종전과 동일하게 공개키(anon) — 사용자 요청 경로 동작 불변.
 *   cron 만 service_role 을 넘긴다(아래 computeAndStoreSnapshot 주석에 실측 근거).
```
바꿀 코드:
```js
 *   미지정이면 service_role(PUBLIC-KEY-SURFACE-2026-10-02, Plan 132 — 그전에는 공개키였다).
 *   cron 은 종전대로 service_role 과 긴 rpcTimeoutMs 를 넘긴다(아래 computeAndStoreSnapshot 주석에 실측 근거).
```

#### 기본 클라이언트
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
  const admin = opts.client || anonClient();
  if (!admin) throw new Error('Supabase 미설정');
```
바꿀 코드:
```js
  const admin = opts.client || serviceClient();
  if (!admin) throw new Error('Supabase 미설정');
```

#### computeAndStoreSnapshot 주석에 결정 기록 추가
찾을 코드(줄 전체, 파일에 정확히 1곳):
```js
  //   ⚠ 사용자 요청 경로(/popular 라이브 집계)는 종전대로 공개키 — 방어층 불변.
```
바꿀 코드:
```js
  //   ⚠ 사용자 요청 경로(/popular 라이브 집계)는 종전대로 공개키 — 방어층 불변.
  //     → 2026-10-02 (Plan 132, 운영자 결정) 사용자 경로도 service_role 로 바꿨다. 이 경로는 스냅샷이 36h 넘게
  //       낡았을 때만 타고 결과가 30분 캐시된다. anon 3s 에서 끊기면 저품질 폴백(원본 10회 페이지 조회)으로
  //       갔는데, 이제는 RPC 가 클라이언트 컷(기본 7s) 안에서 끝까지 돈다.
```


## 3. 신규 테스트 `backend/test/public-key-surface.test.js` — 아래 전문 그대로
```js
/**
 * backend/test/public-key-surface.test.js
 *
 * PUBLIC-KEY-SURFACE-2026-10-02 (Plan 132 = Plan 129 2단계 코드) — 공개 키(publishable) 노출면 축소.
 *
 * [배경] 공개 키는 프런트 메타 태그에 공개돼 있다. 백엔드의 검색·지도·인기 라이브 집계가 그 키로 원본
 * 거래·단지·좌표·검색 색인을 읽었기 때문에 그 테이블들에 공개 읽기 권한이 필요했고, 누구나 같은 키로
 * Supabase REST 를 직접 불러 우리 레이트리밋 밖에서 대량 조회할 수 있었다. 이 경로들을 service_role 로
 * 옮겨야 DB 쪽 공개 읽기 권한을 닫을 수 있다(plans/129 §4). DB 권한을 닫은 뒤 누가 이 경로를 공개 키로
 * 되돌리면 조회가 42501 로 실패한다 — 그 회귀를 여기서 막는다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('search.js — 공개 데이터 조회는 service_role(getSupabaseAdmin), 사용자 소유 행(search_history)은 userScopedClient', () => {
  const src = read('routes/search.js');
  assert.match(src, /const adminClient = \(\) => getSupabaseAdmin\(\);/,
    'search.js 의 adminClient 가 service_role 이 아니다 — DB 공개 읽기 권한을 닫으면 검색·지도가 42501 로 실패한다');
  assert.equal((src.match(/getSupabaseReadonly\(/g) || []).length, 0,
    'search.js 가 공개 키 클라이언트(getSupabaseReadonly)를 다시 호출한다');
  assert.equal((src.match(/userScopedClient\(req\.accessToken\)/g) || []).length, 3,
    'search_history 3곳(저장·조회·삭제)은 사용자 토큰 클라이언트(RLS)여야 한다 — service_role 로 바꾸면 남의 기록을 읽고 쓸 수 있다');
  assert.equal((src.match(/\.from\('search_history'\)/g) || []).length, 3);
});

// popularService 를 추적용 스텁 클라이언트로 불러 어느 역할이 무엇을 불렀는지 기록한다.
function _withTrackedClients(fn) {
  const clientPath = require.resolve('../db/client');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], g: require.cache[geoPath], s: require.cache[svcPath] };
  const used = [];
  const make = (role) => ({
    rpc: (name) => ({ abortSignal: async () => { used.push(`${role}:rpc:${name}`); return { data: null, error: { message: 'stub' } }; } }),
    from: (table) => {
      used.push(`${role}:from:${table}`);
      const chain = {
        select: () => chain, gte: () => chain, order: () => chain, eq: () => chain,
        range: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseReadonly: () => make('anon'), getSupabaseAdmin: () => make('service_role') } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: { resolveCoordBatch: async () => [] } };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require('../services/popularService'), used)).finally(() => {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  });
}

test('popularService — 라이브 집계(사용자 경로 기본값)는 service_role 로 RPC·원본을 읽고 공개 키를 쓰지 않는다', async () => {
  await _withTrackedClients(async ({ buildPopularResults }, used) => {
    const { results, usedFallback } = await buildPopularResults(12); // opts.client 없음 = /api/search/popular 라이브 경로
    assert.deepEqual(results, []);
    assert.equal(usedFallback, true, '스텁 RPC 는 실패하므로 폴백 경로까지 타야 한다(두 조회 모두 검사)');
    assert.ok(used.includes('service_role:rpc:search_popular_apts'), `집계 RPC 가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(used.includes('service_role:from:molit_transactions'), `폴백의 원본 조회가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(!used.some((u) => u.startsWith('anon:')), `라이브 집계가 공개 키를 썼다 — DB 공개 읽기 권한을 닫으면 실패한다: ${used.join(' ')}`);
  });
});

test('popularService — 스냅샷 읽기(작은 공개 테이블)는 종전대로 공개 키', async () => {
  await _withTrackedClients(async ({ readPopularSnapshot }, used) => {
    const got = await readPopularSnapshot(12);
    assert.equal(got, null);
    assert.deepEqual(used, ['anon:from:popular_apts_snapshot']);
  });
});
```

## 4. 하지 말 것 / STOP
- `readPopularSnapshot` 의 `anonClient()` · `search_history` 의 `userScopedClient` · `db/client.js` · 다른 서비스의 클라이언트 변경 금지. `_softQuery` 타임아웃·`rpcTimeoutMs` 값 변경 금지.
- DB·외부 API 호출 금지. 테스트가 실패하면 고치지 말고 출력 그대로 보고하고 STOP.

## 5. 완료 기준
1. LF 정규화 sha256(명령은 Git Bash, 워크트리 루트):
   - `backend/routes/search.js` = `9873c57dfd8588ff07054fb466fd720cca42c30371cf036a81303f8d874d789e`
   - `backend/services/popularService.js` = `bb30d51f7431739f7b5ffe203db698b5220fb2308898aa7f4e24fc6d221038ae`
   - `backend/test/public-key-surface.test.js` = `38f7ead69fe6653c51afa9a21885202ae81caac2984f39efbe5a183c590fb17e`
   - `node -e "const fs=require('fs'),c=require('crypto');for(const p of process.argv.slice(1)){const t=fs.readFileSync(p,'utf8').split(String.fromCharCode(13,10)).join(String.fromCharCode(10));console.log(p,c.createHash('sha256').update(t).digest('hex'))}" backend/routes/search.js backend/services/popularService.js backend/test/public-key-surface.test.js`
2. `npm run verify` 체인 전체 exit 0 — backend 테스트 605 → **608**.
3. `git diff master --stat` = 위 3파일 + `plans/132-public-key-stage2-code.md` 뿐.
4. 배포 후(계획자): 자동완성·`/in-bounds`·`/popular` 라이브 200 · Supabase 게이트웨이 로그에서 배포 뒤 `molit_apt_index`·`apt_master`·`molit_transactions`·`apt_geocache`·`rpc/search_popular_apts` 의 공개 키 접두어 요청 0 · Sentry 신규 0.

## 6. 이후 (이 계획 밖 — 운영자 SQL Editor 실행, 배포 24시간 뒤)
`plans/129-public-key-surface-reduction.md` §4 의 2단계 SQL(정책 3개 제거 · 원본·단지·좌표·MV 권한 회수 · `search_popular_apts` 실행 회수). 실행 전 계획자가 24시간 로그로 공개 키 사용 0 을 다시 확인하고, 실행 후 §3-3 과 같은 방식으로 확인한다. 되돌리기 SQL 은 같은 문서 §5.
