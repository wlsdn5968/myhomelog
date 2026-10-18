# Plan 157: 관심 단지 "표시" 판정을 실제 토글(toggleBookmark)과 같은 규칙으로 맞춘다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 각 단계의 검증 명령을 돌려 기대 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions" 에 해당하면 멈추고 보고한다 — 즉흥적으로 고치지 않는다.
> 끝나면 `plans/README.md` 의 157 행 상태를 갱신한다(리뷰어가 색인을 관리한다고 했으면 제외).
>
> **Drift check (먼저 실행)**: `git diff --stat 217674a..HEAD -- frontend/index.html backend/test/detail-next-actions.test.js`
> 출력이 있으면 아래 "Current state" 발췌와 실제 코드를 대조하고, 다르면 STOP.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `217674a`, 2026-10-18

## Why this matters
단지 상세의 "다음에 할 일" 영역(데스크톱)과 모바일 더보기 시트, 그리고 상세 모달 헤더의 관심 버튼은
"이미 관심 단지인가" 를 **단지 이름만** 같아도 참으로 본다. 그런데 실제로 누르면 실행되는
`toggleBookmark()` 는 저장된 항목에 `aptKey` 가 있으면 **aptKey 로만** 찾는다.
그래서 다른 동네의 같은 이름 단지(예: "주공1단지", "현대")를 관심에 넣어 두면, 이 단지 화면에
"관심 해제" 라고 보이는데 누르면 "관심 단지에 추가했어요" 가 뜨며 **두 번째 항목이 추가**된다.
표시와 동작이 반대가 되는 것을 없앤다.

## Current state
- `frontend/index.html` — 단일 파일 SPA(인라인 JS, 빌드 없음).
- 단지 식별 키 (`frontend/index.html:10045-10050`):
  ```js
  function _aptKey(p){
    if (p.facility?.kaptCode) return String(p.facility.kaptCode);
    if (p.aptSeq) return String(p.aptSeq);
    const norm = s => String(s||'').normalize('NFC').replace(/\s+/g,'').toLowerCase();
    return `composite:${norm(p.aptName)}|${norm(p.area)}`;
  }
  ```
- **기준 규칙(바꾸지 않는다)** — 실제 토글 (`frontend/index.html:10055-10058`, `function toggleBookmark()` 안):
  ```js
  const key = _aptKey(p);
  let bks=getBookmarks();
  // P1: aptKey 우선 매칭, 없으면 레거시 aptName fallback
  const idx=bks.findIndex(b => b.aptKey ? b.aptKey === key : b.aptName === p.aptName);
  ```
  즉: 저장 항목에 `aptKey` 가 있으면 키만 비교, 없으면(옛 항목) 이름 비교.
- **틀린 곳 1** — "다음에 할 일" 판정 (`frontend/index.html:11687-11690`):
  ```js
  function _nxtIsBk(p){
    let key = ''; try { key = _aptKey(p); } catch(_) {}
    return getBookmarks().some(b => (b.aptKey && key && b.aptKey === key) || b.aptName === p.aptName);
  }
  ```
  `|| b.aptName === p.aptName` 때문에 키가 다른 같은 이름 항목도 참이 된다. 이 함수는 `:11694`(데스크톱 영역)와 `:11742`(모바일 시트)에서 쓰인다.
- **틀린 곳 2** — 상세 모달 헤더 관심 버튼 초기 표시 (`frontend/index.html:8925-8929`, `showDetail` 안):
  ```js
  const bks=getBookmarks();
  const isBk=bks.some(b=>b.aptName===p.aptName);
  const bkBtn=document.getElementById('bkToggle');
  bkBtn.textContent=isBk?'관심 중':'관심 추가';
  bkBtn.classList.toggle('on',isBk);
  ```
- 기존 테스트 (`backend/test/detail-next-actions.test.js:275-281`) 는 이름과 키가 **둘 다 같은** 경우만 본다:
  ```js
  test('관심 버튼 — 이미 관심이면 "관심 해제" 로 보인다 (Plan 150)', () => {
    const { ctx } = makeCtx({ bookmarks: [{ aptName: '은마', aptKey: '11680-218' }] });
    assert.ok(ctx._nxtHtml(FULL()).includes('관심 해제'));
    ...
  ```
  이 테스트 파일의 `makeCtx` 는 `getBookmarks: () => opts.bookmarks || []`, `_aptKey: (p) => (p.aptSeq ? String(p.aptSeq) : \`composite:${p.aptName}\`)` 를 가짜로 넣고(`:60-61`), `FULL()`(`:76-79`)은 `aptSeq: '11680-218'`, `aptName: '은마'` 다.
- 저장소 관례: 고친 곳 위에 `// <표식>-<날짜> (Plan NNN): 이유` 형식의 한국어 주석을 단다(예: `index.html:11689` 위의 주석들). 화면 문구는 해요체.

## Commands you will need
| Purpose | Command (저장소 루트에서) | Expected on success |
|---|---|---|
| 이 계획 테스트 | `node --test backend/test/detail-next-actions.test.js` | `ℹ fail 0` |
| 전체 검증 | `npm run verify` | 종료 코드 0, 마지막에 `ℹ fail 0` |

## Scope
**In scope**:
- `frontend/index.html` — `_nxtIsBk`(11687-11690), `showDetail` 의 `isBk` 한 줄(8926), 새 공용 함수 1개 추가
- `backend/test/detail-next-actions.test.js` — 테스트 추가

**Out of scope** (건드리지 말 것):
- `toggleBookmark()` 의 규칙 자체 — 이것이 기준이다.
- `frontend/index.html:5516`(보고서 → 관심 단지 일괄 추가)과 `:11828`(`saveClauseAptToBookmark`) — 이 둘은 **키 정보가 없는 항목을 추가할 때의 중복 방지**라 목적이 다르다. 바꾸면 기존 저장 동작이 바뀐다.
- 저장 형식(localStorage 키·필드), 서버 동기화 코드.

## Git workflow
- 브랜치: `advisor/157-bookmark-state-predicate`
- 커밋 메시지 예(저장소 관례): `fix(ui): 관심 단지 표시 판정을 토글과 같은 규칙으로 (Plan 157)` + 본문에 `[근본 원인] [Fix 내용] [회귀 위험]` 과 마지막 줄 `Co-Authored-By: ...`(운영자 지시가 있으면 그대로).
- push·PR 은 운영자가 지시할 때만.

## Steps
### Step 1: 공용 판정 함수를 만든다
`function _aptKey(p){...}` 바로 아래(`frontend/index.html:10050` 뒤)에 추가:
```js
// BK-STATE-2026-10-18 (Plan 157): "관심 단지인가" 판정은 실제 토글(toggleBookmark)과 같은 규칙이어야 한다 —
//   저장 항목에 aptKey 가 있으면 키만, 없으면(옛 항목) 이름으로. 이름만 보던 표시가 같은 이름 다른 단지에서 "관심 해제"를 띄웠다.
function _bkIndex(bks, p){
  let key = ''; try { key = _aptKey(p); } catch(_) {}
  return (bks || []).findIndex(b => b.aptKey ? b.aptKey === key : b.aptName === p.aptName);
}
```
**Verify**: `grep -c "function _bkIndex(" frontend/index.html` → `1`

### Step 2: 세 곳을 이 함수로 바꾼다
1. `toggleBookmark()` 의 `const idx=bks.findIndex(b => b.aptKey ? b.aptKey === key : b.aptName === p.aptName);` → `const idx=_bkIndex(bks, p);` (`const key = _aptKey(p);` 줄은 아래 `aptKey: key` 에서 쓰므로 **지우지 않는다**).
2. `_nxtIsBk(p)` 본문 → `return _bkIndex(getBookmarks(), p) >= 0;`
3. `showDetail` 의 `const isBk=bks.some(b=>b.aptName===p.aptName);` → `const isBk=_bkIndex(bks, p) >= 0;`

**Verify**:
- `grep -n "b.aptName === p.aptName\|b.aptName===p.aptName" frontend/index.html` → `_bkIndex` 안의 1곳만 나온다.
- `node --test backend/test/detail-next-actions.test.js` → `ℹ fail 0`(기존 테스트가 그대로 통과).

같은 단계에서 **테스트 하네스도 함께** 고친다(안 그러면 `_nxtIsBk` 가 부르는 `_bkIndex` 가 가짜 ctx 에 없어 기존 테스트가 ReferenceError 로 깨진다 — 위 Verify 를 돌리기 **전에** 할 것): `backend/test/detail-next-actions.test.js` 의 `makeCtx` 안 `vm.runInContext(` 첫 인자(현재 `extractFn(html, '_escHtml') + '\n' + extractFn(html, '_fmtSgg') + '\n' + extractFn(html, 'toggleCmp') + '\n' + NXT_JS + ...`)에서 `NXT_JS` 앞에 `extractFn(html, '_bkIndex') + '\n' +` 를 넣는다. ctx 의 가짜 `_aptKey`·`getBookmarks` 는 그대로 둔다(실물 `_bkIndex` 가 그것들을 부른다).

### Step 3: 회귀 테스트를 추가한다
`backend/test/detail-next-actions.test.js` 의 "관심 버튼" 테스트(`:275-281`) 바로 뒤에 추가. `makeCtx` 는 Step 2 에서 실물 `_bkIndex` 를 싣도록 이미 바뀌었다(가짜 함수로 대체하지 말 것).
테스트 3개:
1. 저장 `{aptName:'은마', aptKey:'99999-1'}`(키 다름) + `FULL()`(키 `11680-218`) → `_nxtHtml` 에 `'관심 추가'` 포함, `'관심 해제'` 미포함.
2. 저장 `{aptName:'은마'}`(키 없는 옛 항목) + `FULL()` → `'관심 해제'` 포함(옛 항목은 이름 비교 유지).
3. 소스 고정: `extractFn(html,'toggleBookmark')`, `extractFn(html,'_nxtIsBk')`, `showDetail` 의 `isBk` 줄이 모두 `_bkIndex(` 를 쓴다.

**Verify**: `node --test backend/test/detail-next-actions.test.js` → 새 테스트 3개 포함 `ℹ fail 0`

### Step 4: 전체 검증
**Verify**: `npm run verify` → 종료 코드 0, `ℹ fail 0`

## Test plan
- 위 Step 3 의 3개. 구조 모델은 같은 파일의 "관심 버튼" 테스트.
- 회귀 주입 확인(선택, 권장): `_nxtIsBk` 를 옛 코드로 잠시 되돌려 테스트 1이 실패하는지 본 뒤 원복.

## Done criteria
- [ ] `grep -c "function _bkIndex(" frontend/index.html` = 1
- [ ] `grep -n "b.aptName===p.aptName" frontend/index.html` 결과 0줄 (공백 없는 표기)
- [ ] `node --test backend/test/detail-next-actions.test.js` → `ℹ fail 0`, 새 테스트 3개 존재
- [ ] `npm run verify` 종료 코드 0
- [ ] `git status` 에 in-scope 2개 파일 외 변경 없음
- [ ] `plans/README.md` 157 행 갱신

## STOP conditions
- `toggleBookmark()` 의 findIndex 줄이 위 발췌와 다르다(기준 규칙이 이미 바뀌었다).
- `_nxtIsBk` 를 부르는 곳이 `:11694`·`:11742` 두 곳이 아니거나(정의 제외), 시그니처가 `_nxtIsBk(p)` 가 아니다.
- `extractFn(html, '_bkIndex')` 를 `vm.runInContext` 에 넣어도 기존 테스트가 통과하지 않으면 — 가짜 함수로 대체하지 말고 보고.

## Maintenance notes
- 앞으로 "관심 단지인가" 를 묻는 새 코드는 반드시 `_bkIndex(bks, p) >= 0` 을 쓴다.
- `:5516`·`:11828` 은 키 없는 항목을 이름으로 추가·중복 방지한다. 이 항목들은 이후 같은 이름 다른 단지를 "관심 해제" 로 보이게 할 수 있다(옛 항목 규칙). 그 정리(추가 시 aptKey 함께 저장)는 별도 계획감 — 이번엔 하지 않는다.
- 리뷰 포인트: `toggleBookmark` 의 `aptKey: key` 저장 줄이 남아 있는지.
