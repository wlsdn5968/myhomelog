# 124 — SSR HTML 이스케이프 통일 + og:image 이스케이프 누락 2곳

**작성 기준 커밋**: `3656bdc` (2026-09-28) · **출처**: `plans/README.md` 백로그 "SSR HTML 이스케이퍼 4벌 중 share.js 만 의미 다름"(2026-09-06) · **운영자 승인 2026-09-28**("권고대로" — 후속표 3번)
**성격**: 보안 경화 S. 출력 변화 0(문자열 입력 기준). 신규 모듈 1 + 신규 테스트 1.

## 사실 (계획자가 직접 읽음)
- 같은 함수 3벌: `backend/routes/aptPage.js:30`, `backend/routes/regionPage.js:27`, `backend/routes/briefing.js:19` —
  ```js
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  ```
- `backend/routes/share.js:30` `escapeHtml(s)` 는 `String(s || '')` 로 시작하고 `[<>"'&$]` 를 매핑표로 바꾼다 — **`$` → `&#36;` 는 SHARE-REPLACE-LITERAL-2026-09-06 의 두 번째 방어층**이고 `backend/test/share-ssr.test.js:162~227` 이 share.js 안의 `function escapeHtml(` 정의·문자 클래스·매핑표를 직접 검사한다. `s || ''` 는 0·false 를 빈 문자열로 만든다(현 호출부 `:70`·`:98-100` 은 전부 문자열이라 지금은 무해).
- og:image 가 이스케이프 없이 들어가는 곳: `regionPage.js:56`·`:62`, `briefing.js:61`·`:67` (`content="${ogImg}"`). `aptPage.js:57`·`:63` 은 `esc(ogImg)`. 지금 들어가는 값은 검증된 코드로 만든 URL 이라 무해하지만 방어층이 없다.

## 변경 (실행자)
1. 신규 `backend/utils/htmlEscape.js`:
   ```js
   'use strict';
   // ESC-UNIFY-2026-09-28 (Plan 124): SSR 라우트(aptPage·regionPage·briefing)의 같은 escape 3벌을 하나로.
   //   null/undefined → '' · 그 외(0·false 포함)는 String() — share.js 의 escapeHtml 은 '$' 방어층이 있어 별도 유지.
   function escHtml(s) {
     return String(s == null ? '' : s)
       .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }
   module.exports = { escHtml };
   ```
2. `aptPage.js`·`regionPage.js`·`briefing.js`: 로컬 `function esc(s) {…}` 정의를 지우고 그 자리에 `const { escHtml: esc } = require('../utils/htmlEscape'); // ESC-UNIFY-2026-09-28 (Plan 124)` 한 줄. 호출부 이름(`esc(`)은 그대로.
3. `regionPage.js:56·62`, `briefing.js:61·67`: `content="${ogImg}"` → `content="${esc(ogImg)}"`(4곳).
4. `share.js:30` `escapeHtml`: 첫 줄 `String(s || '')` → `String(s == null ? '' : s)` 만 바꾼다(문자 클래스·매핑표·함수 이름 유지 — share-ssr.test.js 가 검사). 주석 1줄: `// ESC-UNIFY-2026-09-28 (Plan 124): 0·false 를 빈 문자열로 만들던 s || '' 를 다른 SSR escape 와 같은 null 기준으로.`
5. 신규 테스트 `backend/test/ssr-escape-unify.test.js`:
   - `escHtml` 출력: `'<a href="x">&\'</a>'` → `'&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'` · `0` → `'0'` · `false` → `'false'` · `null`/`undefined` → `''`.
   - 세 라우트 소스에 `function esc(` 0회 · `require('../utils/htmlEscape')` 1회.
   - `regionPage.js`·`briefing.js` 소스에 `content="${ogImg}"` 0회 · `content="${esc(ogImg)}"` 2회씩.
   - share.js 의 `escapeHtml(0)` 이 `'0'` — 모듈이 escapeHtml 을 export 하지 않으면 소스에서 `String(s == null ? '' : s)` 1회 확인으로 대신.

## 하지 말 것 / STOP
- share.js 의 `escapeHtml` 을 공용 모듈로 옮기거나 이름을 바꾸지 마라(share-ssr.test.js 가 깨진다 — 깨지면 STOP). `lit()` 수정 금지.
- 출력 HTML 이 바뀌는 변경 금지(문자열 입력 기준 바이트 동일). 기존 테스트 수정 금지.

## 완료 기준
`npm run verify` 전부 통과(현재 547 + 신규). 배포 후 리뷰어 라이브: `/apt/41117-37`·`/region/41131`·`/briefing` 200, og:image 메타가 정상 URL(`&amp;` 등 이상 변환 없음 — 현재 URL 에는 escape 대상 문자가 없다).
