# 097 — 인기 스냅샷이 이름 미등록 필터로 1행 모자라면 저품질 폴백으로 떨어지는 회귀(090 계획 오류) 수정: 스냅샷 부족분 허용 + 스냅샷 크기 18

**작성 기준 커밋**: `5410a48` (2026-09-16) · 우선순위 **P0(라이브 품질 회귀)** · 작업량 XS · 의존: 090(병합됨)

## 전제 확인 (계획자가 라이브·DB·코드로 확인 — 추측 아님)
- 라이브 `/api/search/popular`(배포 5410a48 직후): 1위 `미가마하나임 30건(최근거래 09-02)`, `역곡신세계드림A.P.T 27건`… — 같은 시각 DB 스냅샷은 `충무주공(872) 59건, 수원센트럴아이파크자이 53건 …`. 즉 **전국 표본 폴백**(며칠치 표본이라 60일 건수가 절반 이하로 왜곡)이 사용자에게 나가고 있다.
- DB `popular_apts_snapshot` id=1: `computed_at 2026-09-15 18:56 UTC`, payload **12행**, 11번째가 `(50-5)`.
- 경로 `backend/routes/search.js:681~716`: ① 인메모리 캐시 `popular:12` → ② `readPopularSnapshot(limit)` → ③ `buildPopularResults` 라이브(anon 클라이언트, DB role statement_timeout 3s 에 RPC 가 죽으면 `usedFallback`) → 폴백은 120초 캐시 + CDN `s-maxage=120, stale-while-revalidate=600`.
- `backend/services/popularService.js:203~225` `readPopularSnapshot`:
  ```js
  const named = (data.payload || []).filter(p => !isUnnamedApt(p && p.aptName));
  if (named.length < Math.min(limit, SNAPSHOT_SIZE)) return null;   // ← 12행 중 1행이 빠지면 11 < 12 → null → 라이브 → 폴백
  ```
  `SNAPSHOT_SIZE = 12`(`:52`), `SNAPSHOT_MAX_AGE_MS = 36h`(`:33`), `anonClient = () => getSupabaseReadonly()`(`:55`, `../db/client`).
- 저장 쪽 `computeAndStoreSnapshot`(`:241`) 은 `buildPopularResults(SNAPSHOT_SIZE)` 결과를 저장한다 — 090 이후엔 이름 미등록을 뺀 뒤 저장하므로 **다음 cron(오늘 18:00 UTC retention)부터는 12행 전부 이름 있는 행**이지만, 그때까지 5시간 동안 폴백이 나가고, 앞으로도 "저장 12 = 요구 12" 라 여유가 0 이다.
- 기존 테스트: `backend/test/popular.test.js:86~96` 이 `readPopularSnapshot(12)` 를 스텁으로 호출한다(픽스처 12행, 전부 이름 있음 → 이 계획으로 깨지지 않는다). `cron-observability.test.js:134` 는 `computeAndStoreSnapshot` 을 12행 RPC 스텁으로 검증(`stored:true`) — `SNAPSHOT_SIZE` 를 18 로 올려도 `buildPopularResults(18)` 은 12행이 그대로 나와 `stored:true` 유지.

## 범위
- 수정: `backend/services/popularService.js`(상수 1 + 판정 1줄 + 주석), 신규 `backend/test/popular-snapshot-shortfall.test.js`. 그 외 금지(`search.js`·프론트 불변).

## Step 1 — `popularService.js`
- `const SNAPSHOT_SIZE = 12;` → `const SNAPSHOT_SIZE = 18; // 저장은 넉넉히(프론트 limit 12 + 여유 6) — 읽을 때 limit 개로 자른다. SNAP-SLACK-2026-09-16 (Plan 097)`
- 새 상수(바로 아래): `const SNAPSHOT_MIN_ROWS = 8; // SNAP-SLACK-2026-09-16 (Plan 097): 스냅샷이 이 이상이면 모자라도 쓴다 — 090 필터로 1행 빠진 12행 스냅샷이 null 이 되어 anon RPC(3s 컷) → 전국 표본 폴백(건수 절반 왜곡)으로 떨어진 라이브 회귀의 재발 방지. 스냅샷의 8행이 폴백 12행보다 정확하다.`
- `readPopularSnapshot` 의 판정 줄을 `if (named.length < Math.min(limit, SNAPSHOT_MIN_ROWS)) return null;` 로 바꾼다(위 주석의 `Plan 090` 설명은 유지, 한 줄 덧붙임: `// Plan 097: 부족분 허용 — 아래 SNAPSHOT_MIN_ROWS`).
- `module.exports` 에 `SNAPSHOT_MIN_ROWS, SNAPSHOT_SIZE` 추가(테스트용).

## Step 2 — 테스트 `backend/test/popular-snapshot-shortfall.test.js` (신규)
`db/client` 를 `require.cache` 로 스텁(패턴: `backend/test/cron-observability.test.js:134~175` — `getSupabaseReadonly` 가 `from('popular_apts_snapshot').select().eq().maybeSingle()` 체인을 돌려주게), `popularService` 재로드, 끝에 원복.
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
function _withSnapshot(payload, fn) {
  const clientPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], s: require.cache[svcPath] };
  const row = { payload, computed_at: new Date().toISOString() };
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }) };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { getSupabaseReadonly: () => client, getSupabaseAdmin: () => client } };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require('../services/popularService'))).finally(() => {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  });
}
const mk = (n, i) => ({ aptName: n, sigungu: `시군구${i}`, umdNm: i === 10 ? '공항동' : `동${i}`, lawdCd: '11111', dealCount60d: 60 - i, recentDealDate: '2026-09-15', lat: 37.5, lng: 127.0 });

// SNAP-SLACK-2026-09-16 (Plan 097): 2026-09-15 18:56 실제 스냅샷 모양(12행 중 11번째가 "(50-5)") 재현.
test('readPopularSnapshot — 12행 스냅샷에서 이름 미등록 1행이 빠져 11행이어도 스냅샷을 쓴다(폴백으로 안 떨어진다)', async () => {
  const payload = Array.from({ length: 12 }, (_, i) => mk(i === 10 ? '(50-5)' : `단지${i}`, i));
  await _withSnapshot(payload, async ({ readPopularSnapshot }) => {
    const got = await readPopularSnapshot(12);
    assert.ok(Array.isArray(got), '11행 스냅샷이 null 이 되면 라이브 RPC→전국 표본 폴백으로 떨어진다(라이브 회귀 재현)');
    assert.equal(got.length, 11);
    assert.ok(!got.some(p => p.aptName === '(50-5)'));
    assert.ok(got.every(p => typeof p.displayName === 'string' && p.displayName));
    assert.equal(typeof got.computedAt, 'string');
  });
});
test('readPopularSnapshot — 이름 있는 행이 SNAPSHOT_MIN_ROWS(8) 미만이면 null (너무 빈 스냅샷은 안 쓴다)', async () => {
  const payload = Array.from({ length: 12 }, (_, i) => mk(i < 5 ? `단지${i}` : `(${100 + i}-1)`, i));
  await _withSnapshot(payload, async ({ readPopularSnapshot, SNAPSHOT_MIN_ROWS }) => {
    assert.equal(SNAPSHOT_MIN_ROWS, 8);
    assert.equal(await readPopularSnapshot(12), null);
  });
});
test('SNAPSHOT_SIZE — 저장 크기 18 (요구 12 + 여유 6)', () => {
  const { SNAPSHOT_SIZE } = require('../services/popularService');
  assert.equal(SNAPSHOT_SIZE, 18);
});
```
(`isUnnamedApt` 는 `(108-1)` 같은 괄호+지번을 미등록으로 본다 — 두 번째 테스트의 픽스처가 그 규칙에 맞는지 `node -e "console.log(require('./backend/utils/aptDisplayName').isUnnamedApt('(108-1)'))"` → `true` 로 확인.)

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 413 + 3.
- 회귀 주입(수행 후 원복): 판정 줄을 옛 `Math.min(limit, SNAPSHOT_SIZE)` 로 되돌리면 첫 테스트 fail.
- 커밋 1개: `fix(인기): 스냅샷 부족분 허용(최소 8행) + 저장 18행 — 이름 미등록 필터로 1행 모자라 폴백 나가던 라이브 회귀 (Plan 097)`.

## STOP 조건
- `readPopularSnapshot` 의 코드가 위 발췌와 다르다 → 보고 후 STOP.
- 기존 `popular.test.js`·`cron-observability.test.js` 가 `SNAPSHOT_SIZE` 18 로 깨진다 → 어떤 단언인지 보고 후 STOP(임의로 픽스처를 늘리지 않는다).
