# 096 — Escape 키로 닫히지 않는 오버레이 4곳(알림 센터·햄버거 드로어·규제 요약·단지 비교)을 전역 Escape 핸들러에 등록

**작성 기준 커밋**: `e95d0cc` (2026-09-16) · 우선순위 P2(a11y·라이브 실측 결함) · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 코드로 직접 확인 — 줄 번호는 `e95d0cc` 기준)
- 전역 Escape 핸들러 `frontend/index.html:11517~11536`:
  ```js
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const closers = [
      { id: 'QM', fn: 'closeQuotaModal' },  // quota 모달 (z-index 9998)
      … (ERM, DSM, CARDOV, RGM, DM, SM, UM 순) …
      { id: 'LM', fn: 'closeLogin' },       // 로그인
    ];
    for (const { id, fn } of closers) {
      const el = document.getElementById(id);
      if (el && el.classList.contains('open')) {
        const closer = window[fn];
        if (typeof closer === 'function') { closer(); return; } // 한 번에 하나만 닫음
      }
    }
  });
  ```
  판정이 **`open` 클래스 + `window[fn]`(전역 함수)** 두 가지에 의존한다.
- 라이브 실측(2026-09-16, 데스크톱·모바일): 아래 4곳은 ESC 로 안 닫힌다.
  | 오버레이 | 요소 | 열림 판정 | 닫기 | 왜 안 닫히나 |
  |---|---|---|---|---|
  | 알림 센터 | `<div class="smbg" id="NTC">`(`:3306`) | `openNtc()` 가 `open` 추가(`:9643`) | `closeNtc()`(`:9650`, 전역 함수) | closers 에 없음 |
  | 모바일 햄버거 드로어 | `#drawerBg`(`:1689`, `.drawer-bg.open{display:block}` `:1304`, z9990) | `toggleDrawer()` 가 `bg.classList.toggle('open', opening)` | `closeDrawer()`(`:11708`, 전역) | closers 에 없음 |
  | 규제 요약 | `#regSummaryModal` 동적 생성, `className='dmbg'`(**`open` 클래스 없음**), z99998(`:5236~5241`) | 존재 = 열림 | ✕ 버튼이 `.remove()`(`:5245`) | `open` 검사로는 못 잡음 + 닫기 함수 없음 |
  | 단지 비교 | `#cmpModal` 동적 생성, `className='smbg open'`, z9999(`:7135~7141`) | 존재 = 열림 | ✕ 버튼이 `.remove()`(`:7147`) | 닫기 함수 없음(backdrop 클릭 핸들러 `:11541` 는 `open` 만 떼고 요소는 남긴다 — inline `display:flex` 라 여전히 보임) |
- 계약 테스트 관례: `backend/test/frontend-contracts.test.js`(현재 test 69개) 가 `fs.readFileSync(path.join(__dirname, '../../frontend/index.html'))` 로 읽어 정규식 `html.match(...)` 으로 소스 조각을 잡아 단언한다(`:242~250`). 마지막 test 는 `:1995` "Plan 093 — …".
- `frontend/index.html` 의 인라인 JS 는 `npm run verify` 의 lint 가 검사한다(Plan 020).

## 범위
- 수정: `frontend/index.html`(핸들러 1곳 + 전역 닫기 함수 2개), `backend/test/frontend-contracts.test.js`(test 1개 추가). 그 외 금지.
- 기존 ✕ 버튼의 `onclick="… .remove()"` 는 **바꾸지 않는다**(diff 최소).

## Step 1 — 핸들러(`:11517~11536`)에 `present` 플래그와 4개 항목 추가
closers 배열을 아래처럼 바꾼다(기존 9개 항목과 주석은 그대로 두고 **앞에 2개, 뒤에 2개** 추가; 루프 조건에 `present` 분기):
```js
  const closers = [
    // ESC-2026-09-16 (Plan 096): 동적 생성 모달은 open 클래스가 없다 — present:true 는 "요소가 있으면 열림" 판정.
    { id: 'regSummaryModal', fn: '_closeRegSummary', present: true }, // 규제 요약 (z99998, 동적 생성)
    { id: 'cmpModal', fn: '_closeCmpModal', present: true },          // 단지 비교 (z9999, 동적 생성)
    { id: 'QM', fn: 'closeQuotaModal' },  // quota 모달 (z-index 9998)
    … 기존 항목 8개 그대로 …
    { id: 'LM', fn: 'closeLogin' },       // 로그인
    { id: 'NTC', fn: 'closeNtc' },        // 알림 센터 (smbg z500) — Plan 096
    { id: 'drawerBg', fn: 'closeDrawer' }, // 모바일 햄버거 드로어 (z9990) — 마지막: 위에 뜬 모달부터 닫는다 — Plan 096
  ];
  for (const { id, fn, present } of closers) {
    const el = document.getElementById(id);
    if (el && (present || el.classList.contains('open'))) {
```
(루프의 나머지 3줄은 그대로.)

## Step 2 — 전역 닫기 함수 2개 (최상위 `function` 선언 — `window[fn]` 으로 잡혀야 하므로 IIFE·블록 안에 넣지 않는다)
- `openRegSummary()` 함수가 **끝나는 줄 바로 뒤**에:
  ```js
  // ESC-2026-09-16 (Plan 096): Escape 핸들러용 — 동적 생성 모달은 닫기 = 제거.
  function _closeRegSummary(){ const m=document.getElementById('regSummaryModal'); if(m) m.remove(); }
  ```
- `_cmpModalShell()` 함수가 **끝나는 줄 바로 뒤**에:
  ```js
  // ESC-2026-09-16 (Plan 096): Escape 핸들러용. backdrop 클릭은 open 만 떼고 요소를 남기므로(inline display:flex) 여기서는 제거한다.
  function _closeCmpModal(){ const m=document.getElementById('cmpModal'); if(m) m.remove(); }
  ```
  두 함수가 최상위인지: `openRegSummary` 는 `onclick="openRegSummary()"` 로 호출되는 전역 함수이므로 그 옆은 최상위다(같은 `<script>` 안, 다른 함수 본문 밖). `_cmpModalShell` 도 같은 방식으로 확인(`grep -n "_cmpModalShell()" frontend/index.html` 로 호출부가 최상위 함수 안인지 본다).

## Step 3 — 계약 테스트 (`frontend-contracts.test.js` 파일 끝)
```js
test('Plan 096 — Escape 핸들러가 알림 센터·드로어·규제 요약·단지 비교도 닫는다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/const closers = \[[\s\S]*?\n  \];/);
  assert.ok(m, 'Escape 핸들러의 closers 배열을 찾지 못했다');
  const src = m[0];
  for (const id of ['NTC', 'drawerBg', 'cmpModal', 'regSummaryModal']) assert.ok(src.includes(`id: '${id}'`), `${id} 가 Escape closers 에 없다`);
  assert.match(src, /id: 'regSummaryModal', fn: '_closeRegSummary', present: true/);
  assert.match(src, /id: 'cmpModal', fn: '_closeCmpModal', present: true/);
  assert.match(html, /\(present \|\| el\.classList\.contains\('open'\)\)/, 'present 분기가 없다 — 동적 생성 모달은 open 클래스가 없어 못 닫는다');
  assert.match(html, /\nfunction _closeRegSummary\(\)\{/, '_closeRegSummary 전역 함수가 없다');
  assert.match(html, /\nfunction _closeCmpModal\(\)\{/, '_closeCmpModal 전역 함수가 없다');
  // 순서 = z-index 역순(위에 뜬 것부터): regSummary(99998) → cmp(9999) → QM(9998) … ; 드로어는 마지막
  const idx = (id) => src.indexOf(`id: '${id}'`);
  assert.ok(idx('regSummaryModal') < idx('cmpModal') && idx('cmpModal') < idx('QM'), 'closers 순서가 z-index 역순이 아니다');
  assert.ok(idx('drawerBg') > idx('LM') && idx('NTC') > idx('LM'), 'NTC·드로어는 기존 항목 뒤여야 한다');
});
```
(이 파일이 이미 `fs`/`path`/`assert` 를 상단에서 require 하고 있으면 test 안의 require 는 중복이어도 무방 — 기존 스타일에 맞춘다.)

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 **+1**(frontend-contracts 70개).
- 회귀 주입(수행 후 원복): closers 에서 `{ id: 'NTC', … }` 줄을 지우면 새 test 가 `NTC 가 Escape closers 에 없다` 로 fail.
- 정적: `grep -n "present ||" frontend/index.html` 1건 · `grep -n "^function _closeRegSummary\|^function _closeCmpModal" frontend/index.html` 2건.
- 리뷰어 라이브(배포 후): 알림 센터를 열고 `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` → `#NTC` 에서 `open` 이 사라짐; 비교 모달·규제 요약도 같은 방법으로 요소가 제거됨.
- 커밋 1개: `fix(a11y): Escape 로 알림 센터·햄버거 드로어·규제 요약·단지 비교 모달도 닫기 (Plan 096)`.

## STOP 조건
- 핸들러 코드가 위 발췌와 다르다(드리프트) → 현재 코드를 보고하고 STOP.
- `_cmpModalShell`/`openRegSummary` 가 최상위가 아니라 IIFE·객체 안에 있다 → 보고하고 STOP(전역 노출 방식이 달라진다).
