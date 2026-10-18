# Plan 160: 일시 장애가 지나간 뒤 화면이 스스로 회복되게 한다 (첫 화면 목록·서버 연결 표시·랭킹 카드)

> **Executor instructions**: 단계 순서대로 따르고 각 검증의 기대 결과를 확인한다. "STOP conditions" 면 멈추고 보고한다.
> 끝나면 `plans/README.md` 160 행을 갱신한다.
>
> **Drift check (먼저 실행)**: `git diff --stat 217674a..HEAD -- frontend/index.html backend/test/home-panel.test.js`
> 출력이 있으면 "Current state" 와 대조하고, 다르면 STOP.

## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `217674a`, 2026-10-18

## Why this matters
서버는 장애 때 "대체 경로" 응답(`degraded:true` — 평균가·건수를 비움)을 주고, 프런트는 그걸 정직하게 표시한다.
문제는 **장애가 지나간 뒤에도 화면이 회복되지 않는 것**이다:
1. 첫 화면(지도) 왼쪽 목록 `#homePanel` 은 처음 받은 응답을 세션 내내 붙잡는다 — 대체 응답이면 새로고침 전까지 평균가·건수가 비어 있고, 다시 불러오기 버튼도 없다.
2. 서버 연결 확인 `chkAPI` 는 페이지를 열 때 한 번(실패 시 1회 재시도)만 돈다 — 처음에 실패하면 서버가 살아나도 헤더의 "서버에 연결되지 않아요" 칩·메뉴 둘째 줄·숨김 처리(`body.api-off`)가 계속 남는다.
3. 랭킹 카드(`openRankCard`)는 저장된 대체 순위를 보면 "잠시 뒤 다시 시도해 주세요" 라고 하지만, 다시 눌러도 **다시 불러오지 않아** 계속 실패한다.
4. 지도 화면에 들어가면 같은 `/search/popular?limit=12` 를 패널과 지도 마커가 **각각** 부른다(콜드 시 약 10초짜리 요청 2번).

## Current state
`frontend/index.html` — 단일 파일 SPA(인라인 JS, 빌드 없음). API 기본 주소 `CFG.api`. 인기 응답 정규화는 공용 `_popRows(j)`(대체 응답이면 평균가·건수를 비우고 행에 `_degraded:true`). 고친 곳 위에 `// <표식>-2026-10-18 (Plan 160): 이유` 한국어 주석(저장소 관례). 화면 문구는 해요체, 내부 용어 금지.

### 1) 첫 화면 목록 — `frontend/index.html:11952-11976`
```js
let _hpData = null, _hpReq = null, _hpSido = '전국';
...
function _hpLoad(force){
  if(_hpReq || (_hpData && !force)) return;
  const list = document.getElementById('hpList');
  if(force && list) list.innerHTML = '<div class="hp-msg">불러오는 중이에요</div>';
  _hpReq = fetch(`${CFG.api}/search/popular?limit=12`, { signal: AbortSignal.timeout(12000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)))
    .then(j => {
      _hpData = j || {}; _hpRender();
      if(!(Array.isArray(_hpData.results) && _hpData.results.length)){ _hpData = null; ... '다시 불러오기' ... }
    })
    .catch(() => { _hpData = null; ... '목록을 불러오지 못했어요. <button type="button" onclick="_hpLoad(true)">다시 불러오기</button>' ... })
    .finally(() => { _hpReq = null; });
}
```
`_hpRender()` 는 지역 칩을 바꿀 때도 `_hpData` 로 다시 그린다 — **`_hpData` 를 null 로 지우면 칩 전환이 깨진다**(지우지 말 것).
대체 응답 문구 (`:12000`):
```js
const degMsg = deg ? '<div class="hp-msg">지금은 집계가 늦어져 최근 거래 표본으로 골랐어요. 평균가와 건수는 잠시 비워 둬요</div>' : '';
```
`_hpLoad()` 는 `_hpApply(v)`(화면 전환·창 크기 변경 때마다 호출)에서 불린다 — 무조건 재요청하게 만들면 창 크기 조절마다 요청이 나간다.

### 2) 서버 연결 확인 — `frontend/index.html:13691-13787` (`async function chkAPI(_isRetry)`)
성공 분기: `el.style.display='none'; document.body.classList.remove('api-off'); ... _hdSyncLine(); return true;`
실패 분기(`:13776-13786`):
```js
}catch{
  if(!_isRetry){ await new Promise(_r=>setTimeout(_r,1800)); return chkAPI(true); }
  el.textContent='서버에 연결되지 않아요';el.className='hst off';
  el.style.display='inline-flex';
  try{ document.body.classList.add('api-off'); _hdSyncLine(); }catch(_){}
  cs.textContent='● 오프라인';cs.style.color='var(--red)';
  if(bs){bs.textContent='오프라인';bs.className='sm-badge no';}
  return false;
}
```
호출부는 부팅 시 한 곳(`:3984` `chkAPI().then(ok => { if(ok) checkMolit(); ... loadMap() ... })`)뿐이다.

### 3) 랭킹 카드 — `frontend/index.html:9394-9400`
```js
async function openRankCard(){
  let ps=window._lastPopular;
  if(!ps||!ps.length){
    try{const r=await fetch(CFG.api+'/search/popular');if(r.ok){const t=await r.json();ps=_popRows(t);}}catch(_e){}
  }
  if(!ps||!ps.length){toast('랭킹 데이터를 불러오지 못했어요');return;}
  if(ps.some(p=>p&&p._degraded)){toast('지금은 집계가 늦어져 랭킹 카드를 만들 수 없어요. 잠시 뒤 다시 시도해 주세요');return;}
```
`window._lastPopular` 는 브리핑 렌더(`:6076-6077` `const ps=_popRows(pop); window._lastPopular=ps;`)에서만 채워진다.

### 4) 지도 마커 — `frontend/index.html:12975` `async function loadPopularMarkers()` 안 `:13001`:
```js
const r = await fetch(`${CFG.api}/search/popular?limit=12`, { signal: AbortSignal.timeout(12000) });
if (!r.ok) return;
const j = await r.json();
const popular = _popRows(j);
```

테스트 모델: `backend/test/home-panel.test.js` 의 `runRender`(`:38-60`) — `let` 선언과 `extractFn` 으로 뽑은 함수들을 한 스크립트로 `vm.runInContext` 하고 `globalThis.__x = ...` 로 노출하는 방식. 소스 고정 테스트도 같은 파일에 많다.

## Commands you will need
| Purpose | Command (저장소 루트) | Expected |
|---|---|---|
| 관련 테스트 | `node --test backend/test/home-panel.test.js` | `ℹ fail 0` |
| 전체 검증 | `npm run verify` | 종료 코드 0, `ℹ fail 0` |

## Scope
**In scope**: `frontend/index.html` 의 `_hpLoad`·`_hpRender` 의 `degMsg` 한 줄·`chkAPI` 실패/성공 분기·`openRankCard` 앞부분·`loadPopularMarkers` 의 fetch 3줄, 새 공용 함수 1개, 테스트(`backend/test/home-panel.test.js` 또는 새 파일 `backend/test/outage-recovery.test.js`).
**Out of scope**: 서버 응답 형식, `_popRows`, 대체 응답 문구의 뜻(버튼만 추가), 랜딩(`_landingAsyncRefresh`, `:4240`)·브리핑(`:6066`)의 인기 요청(주소가 `limit` 없이 달라 공유 대상 아님), `healthJson` 의 캐시 규칙.

## Git workflow
- 브랜치 `advisor/160-recover-after-outage`. 메시지 예: `fix(ui): 장애 뒤 첫 화면 목록·서버 연결 표시·랭킹 카드가 스스로 회복 (Plan 160)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`.
- push·PR 은 운영자 지시가 있을 때만.

## Steps
### Step 1: `?limit=12` 인기 요청을 한 번만 보내는 공용 함수
`_hpLoad` 위(`let _hpData ...` 근처)에 추가:
```js
// POPULAR-SHARED-2026-10-18 (Plan 160): 지도 화면 진입 때 목록 패널과 지도 마커가 같은 인기 12곳 요청을
//   각각 불렀다(콜드 약 10초 요청 2번). 진행 중·60초 이내 결과를 공유한다. 실패하면 바로 비워 다음 호출이 다시 부른다.
let _pop12P = null, _pop12At = 0;
function _popular12(force){
  if(!force && _pop12P && Date.now() - _pop12At < 60000) return _pop12P;
  _pop12At = Date.now();
  _pop12P = fetch(`${CFG.api}/search/popular?limit=12`, { signal: AbortSignal.timeout(12000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)))
    .catch(e => { _pop12P = null; throw e; });
  return _pop12P;
}
```
`_hpLoad` 의 `fetch(...).then(r => r.ok ? r.json() : Promise.reject(...))` 두 줄을 `_popular12(force)` 로 바꾼다(뒤의 `.then(j => ...)` 부터는 그대로).
`loadPopularMarkers` 의 `const r = await fetch(...); if (!r.ok) return; const j = await r.json();` 를 `let j; try { j = await _popular12(); } catch(_) { return; }` 로 바꾼다(바깥 try 구조 유지).
**Verify**: `grep -c "search/popular?limit=12" frontend/index.html` → `1`(공용 함수 안에만).

### Step 2: 첫 화면 목록이 대체 응답이면 다음 진입 때 다시 부른다(+버튼)
`_hpData` 에 받은 시각을 둔다: `let _hpData = null, _hpReq = null, _hpSido = '전국', _hpDataAt = 0;` 그리고 `_hpData = j || {};` 를 `_hpData = j || {}; _hpDataAt = Date.now();` 로.
`_hpLoad` 첫 줄을:
```js
// HP-DEGRADED-RETRY-2026-10-18 (Plan 160): 대체 응답(degraded)을 세션 내내 붙잡아 장애가 끝나도 평균가·건수가 비어 있었다.
//   대체 응답이면 60초가 지난 뒤의 다음 호출(화면 진입 등)에서 다시 부른다 — 창 크기 조절마다 요청이 나가지 않게 60초 간격.
const _degOld = !!(_hpData && _hpData.degraded && Date.now() - _hpDataAt > 60000);
if(_hpReq || (_hpData && !force && !_degOld)) return;
```
대체 목록을 다시 부르다 **실패**하면 지금 보이는(대체지만 쓸 만한) 목록을 오류 문구로 덮지 않게, `_hpLoad` 의 `.catch(() => { _hpData = null; ... })` 첫 줄에 `if(!force && _hpData && _hpData.degraded){ _hpDataAt = Date.now(); return; }` 를 넣는다(버튼으로 누른 `force` 재시도는 기존처럼 오류 문구를 보인다).
`degMsg` 문구 끝에 버튼을 붙인다: `... 평균가와 건수는 잠시 비워 둬요. <button type="button" onclick="_hpLoad(true)">다시 불러오기</button></div>`.
**Verify**: `node --test backend/test/home-panel.test.js` → `ℹ fail 0`(기존 테스트 유지).

### Step 3: 서버 연결 실패 뒤 1분마다 다시 확인한다
`chkAPI` 실패 분기의 `return false;` 바로 앞에:
```js
// API-RECHECK-2026-10-18 (Plan 160): 부팅 때 한 번 실패하면 서버가 살아나도 "서버에 연결되지 않아요"가 세션 내내 남았다.
//   실패 상태에서는 60초마다 한 번 다시 확인한다(타이머 하나만, 성공하면 멈춤).
if(!window._apiRecheckT) window._apiRecheckT = setInterval(() => { try{ chkAPI(true); }catch(_){} }, 60000);
```
성공 분기의 `document.body.classList.remove('api-off');` 다음 줄에:
```js
if(window._apiRecheckT){ clearInterval(window._apiRecheckT); window._apiRecheckT = null; }
```
(재확인 호출은 `chkAPI(true)` — 재시도 경로라 1.8초 대기 재귀가 없고 `healthJson(9000, true)` 로 캐시를 건너뛴다.)
**Verify**: `grep -o "_apiRecheckT" frontend/index.html | wc -l` → `5`(실패 분기 한 줄에 2회, 성공 분기 한 줄에 3회 — `grep -c` 는 줄 수라 2 가 나오므로 쓰지 말 것).

### Step 4: 랭킹 카드는 대체 순위면 한 번 다시 불러온다
`openRankCard` 의 첫 `if(!ps||!ps.length){` 조건을 `if(!ps||!ps.length||ps.some(p=>p&&p._degraded)){` 로 바꾼다(주석: `// RANKCARD-RETRY-2026-10-18 (Plan 160): 저장된 순위가 대체 경로면 한 번 다시 불러온다 — "잠시 뒤 다시" 를 눌러도 재조회가 없었다`). 다시 받은 결과가 정상이면 `window._lastPopular = ps;` 로 갱신한다(대체면 갱신하지 않음). 그 아래 기존 두 `toast` 판정은 그대로 둔다.
**Verify**: 소스에 `openRankCard` 안 `_lastPopular = ps` 대입이 1곳 있다.

### Step 5: 테스트
`backend/test/home-panel.test.js` 끝(또는 새 파일)에:
1. `_popular12` 를 `extractFn` + `vm` 으로 실행 — 같은 스크립트 문자열에 `let _pop12P = null, _pop12At = 0;` 를 먼저 넣고(최상위 `let` 은 ctx 프로퍼티로 안 보이므로 같은 `runInContext` 안에서 선언), ctx 에 가짜 `fetch`·`CFG = { api: '' }`·`AbortSignal = { timeout: () => undefined }` 를 둔다. 가짜 `fetch` 호출 수를 세어, 연속 두 번 호출 시 fetch 1회, 가짜 fetch 가 거절되면 다음 호출에 fetch 가 다시 불린다.
2. `_hpLoad` 소스에 `_degOld` 조건이 있고 `degMsg` 에 `onclick="_hpLoad(true)"` 버튼이 있다.
3. `chkAPI` 소스: 실패 분기에 `setInterval(` 과 `_apiRecheckT`, 성공 분기에 `clearInterval(window._apiRecheckT)`.
4. `openRankCard` 소스: 첫 조건에 `_degraded` 가 들어 있다.
5. `grep` 고정: `search/popular?limit=12` 리터럴이 파일 전체에 1회.
**Verify**: 해당 테스트 파일 → 새 테스트 포함 `ℹ fail 0`.

### Step 6: 전체 검증
`npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Test plan
위 Step 5 의 5개. 동작 테스트(1)는 `home-panel.test.js` 의 기존 `vm` 실행 하네스를 모델로 삼는다(가짜 `fetch`·`AbortSignal.timeout`·`CFG` 를 ctx 에 넣는다). 브라우저 확인은 이 계획의 완료 조건이 아니다(운영자 미리보기 실측은 별도).

## Done criteria
- [ ] `grep -c "search/popular?limit=12" frontend/index.html` = 1
- [ ] `grep -o "_apiRecheckT" frontend/index.html | wc -l` = 5
- [ ] `grep -n "_hpDataAt" frontend/index.html` ≥ 3줄
- [ ] 새 테스트 5개 존재, `npm run verify` 종료 코드 0
- [ ] `git status` 에 in-scope 외 변경 없음, `plans/README.md` 160 행 갱신

## STOP conditions
- `_hpLoad`·`chkAPI`·`openRankCard`·`loadPopularMarkers` 가 위 발췌와 다르다(드리프트).
- `_hpApply` 외에 `_hpLoad` 를 짧은 주기로 부르는 곳(타이머 등)이 있다 — 60초 조건으로 부족할 수 있으니 보고.
- `chkAPI(true)` 를 주기 호출하면 부팅 전용 부작용(`checkMolit`·`loadMap` 재실행 등)이 생기는 것으로 보인다 — 그 호출들은 `:3984` 의 `.then` 에만 있어야 한다. 아니면 보고.

## Maintenance notes
- 인기 응답을 새로 쓰는 화면은 `?limit=12` 면 `_popular12()` 를, 아니면 기존처럼 직접 부르되 반드시 `_popRows(j)` 를 거친다.
- 재확인 타이머는 실패 상태에서만 1분마다 `/api/health` 를 1회 부른다 — health 요청 비용(서버 측 캐시 있음)을 늘리는 쪽으로 간격을 줄이지 말 것.
- 랜딩·브리핑의 인기 요청(`limit` 없는 주소)은 이번에 묶지 않았다 — 주소가 달라 공유하면 결과 수가 바뀐다.
- 연결이 회복돼도 부팅 때만 도는 `checkMolit()`(데이터 0건이면 "데이터 없음" 배너를 띄우는 확인)은 다시 돌지 않는다 — 회복 상황에선 띄울 이유가 없어 일부러 뺐다. 지도는 부팅 때 연결 결과와 무관하게 이미 불러온다(`:3986-3988`).
