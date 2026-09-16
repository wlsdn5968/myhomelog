# 086 — 공개 브리핑: 오늘 페이지의 "실거래 누적"을 앱과 같은 값·동기화 시각으로 + "지난 7일" 링크

**작성 기준 커밋**: `5d6215b` (2026-09-16) · 우선순위 P2 · 작업량 XS~S · 의존: 없음 (084 와 파일 겹침 없음)

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 같은 날 두 숫자: 공개 `/briefing/2026-09-16` "실거래 누적 **466,356**건 국토부"(동기화 시각 없음) vs 앱 브리핑 탭 "실거래 누적 **468,303**건 국토부 · 09.15 동기화" = `/api/health` `dataCounts.tx`.
- 원인: 공개 페이지는 `backend/routes/briefing.js:88~91` `briefingTicker(snap)` 이 **스냅샷에 저장된** `snap.txTotal`/`snap.syncedAt` 을 쓴다. 스냅샷은 `briefingService.buildBriefingPayload()`(`backend/services/briefingService.js:54~55, 97~98`) 가 생성 시점의 캐시 `meta:dataCounts:v2`(`require('../cache')` node-cache → `./redisCache` 폴백) 값을 담는다. 앱은 매번 `/api/health` 로 같은 캐시의 **현재** 값을 읽는다. 오늘 페이지는 생성 이후 적재가 돌면 값이 어긋난다.
- `isToday` 는 `:166` `const isToday = day === kstDayString();`, 스냅샷은 `:120` `snap = await getOrCreateSnapshot(day)`. 캐시 헤더 `:174~176`(오늘 30분). 하단 내비 `:186` `<div class="nav"><a href="/briefing/${dayNav(day,-1)}">← 전날 브리핑</a>…</div>`, `dayNav(day, delta)` 는 `:23~27`.
- 테스트 하네스: `backend/test/express5-migration.test.js:240~262` 가 `stubModule('../services/briefingService', {...})` 로 서비스를 바꿔치고 `routes/briefing` 을 로드해 핸들러를 호출한다.

## 범위
- 수정: `backend/routes/briefing.js`. 신규: `backend/test/briefing-links.test.js`. 그 외 금지(briefingService·sitemap·aptPage 는 건드리지 않는다 — 과거 날짜의 스냅샷 값은 **역사 기록이므로 그대로**).

## Step 1 — 순수 함수 2개 (파일의 `dayNav` 뒤에 추가, `module.exports` 에 노출)
```js
// BRIEF-LIVE-TOTAL-2026-09-16 (Plan 086): 오늘 페이지의 실거래 누적은 앱(/api/health)과 같은 캐시 값을 쓴다.
//   스냅샷은 생성 시점 값이라 그날 적재가 돌면 어긋났다(라이브 466,356 vs 468,303). 과거 날짜는 기록 그대로.
function mergeLiveCounts(snap, dc, isToday) {
  if (!isToday || !snap || !dc || !dc.tx) return snap;
  return { ...snap, txTotal: Number(dc.tx), syncedAt: dc.lastIngestedAt || snap.syncedAt || null };
}
// BRIEF-PAST-NAV-2026-09-16 (Plan 086): 지난 n일 링크 — 아카이브 페이지끼리의 내부 링크(서비스 시작 2026-01-01 이전은 제외).
function pastDaysNav(day, n = 7) {
  const out = [];
  for (let k = 1; k <= n; k++) { const d = dayNav(day, -k); if (d < '2026-01-01') break; out.push({ day: d, label: d.slice(5).replace('-', '.') }); }
  return out;
}
```
파일 끝: `module.exports = router; module.exports.mergeLiveCounts = mergeLiveCounts; module.exports.pastDaysNav = pastDaysNav;` (기존 export 형태를 확인해 유지).

## Step 2 — 라우트 적용
- `:166` `const isToday …` 바로 뒤(티커 `briefingTicker(snap)` 호출 **전**이어야 한다 — 실제 호출 위치를 grep 으로 확인):
```js
  // BRIEF-LIVE-TOTAL-2026-09-16 (Plan 086): briefingService.buildBriefingPayload 와 같은 캐시 경로.
  if (isToday) {
    let dc = null;
    try { dc = require('../cache').get('meta:dataCounts:v2') || null; } catch (_) { dc = null; }
    if (!dc) { try { dc = await require('../services/redisCache').rget('meta:dataCounts:v2'); } catch (_) { dc = null; } }
    snap = mergeLiveCounts(snap, dc, isToday);
  }
```
(`snap` 이 `const` 면 `let` 으로 바꾼다.)
- `:186` 내비 div 바로 뒤에:
```js
    ${(() => { const p = pastDaysNav(day); return p.length ? `<div class="nav" aria-label="지난 브리핑">지난 브리핑: ${p.map((x) => `<a href="/briefing/${esc(x.day)}">${esc(x.label)}</a>`).join(' · ')}</div>` : ''; })()}
```

## Step 3 — 테스트 `backend/test/briefing-links.test.js`
1. `mergeLiveCounts`: 오늘+dc → `txTotal`·`syncedAt` 이 dc 값 / 오늘 아님 → 입력 그대로 / dc null → 그대로.
2. `pastDaysNav('2026-09-16')` → 7개, 첫 항목 `2026-09-15`(라벨 `09.15`), 마지막 `2026-09-09`; `pastDaysNav('2026-01-03')` → 2개.
3. 렌더(express5-migration.test.js:240~262 하네스 복제): `kstDayString` → `'2026-09-16'`, `getOrCreateSnapshot` → `{ lines:[{…1개}], txTotal: 100, syncedAt: null, ecos:null, regLog:[] }` 스텁, `require('../cache').set('meta:dataCounts:v2', { tx: 123456, lastIngestedAt: '2026-09-15T17:45:00.000Z' })` 후 `/2026-09-16` 호출 → HTML 에 `123,456건`·`09.15 동기화`·`/briefing/2026-09-09` 포함, `100건` 미포함. 테스트 끝에 캐시 키 삭제.

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 수 **382 + 추가분**(3개 test() 이상).
- 회귀 주입(수행 후 원복): Step 2 의 `snap = mergeLiveCounts(...)` 줄을 지우면 렌더 테스트 fail.
- 커밋 1개: `fix(브리핑): 오늘 페이지 실거래 누적을 앱과 같은 캐시 값·동기화 시각으로 + 지난 7일 링크 (Plan 086)`.

## STOP 조건
- `briefingTicker(snap)` 호출이 `isToday` 정의보다 **앞**에 있어 순서를 바꿔야 한다 → 실제 줄을 보고하고, 티커 호출 직전에 병합하도록 위치만 조정(STOP 아님). `routes/briefing.js` 가 `../cache` 를 require 할 수 없는 구조(순환) → 멈추고 보고.
