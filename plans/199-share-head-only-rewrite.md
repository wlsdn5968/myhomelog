# Plan 199: 공유 페이지(/share)는 HTML 머리 부분만 치환한다

> 실행자 지침: 단계마다 확인 명령을 돌려 기대 결과를 본 뒤 다음으로 간다. STOP 조건이 생기면 멈추고 보고한다. 끝나면 `plans/README.md` 의 199 행을 고친다.
>
> 드리프트 확인: `git diff --stat b1cc128..HEAD -- backend/routes/share.js`

## 상태

- 우선순위: P2
- 작업량: S
- 위험: LOW
- 선행: 없음
- 분류: perf
- 작성 기준: 커밋 `b1cc128`, 2026-11-14

## 왜 하나

`/share` 는 카카오톡 같은 링크 미리보기용으로 `frontend/index.html` 전체(약 1.08MB 문자열)를 읽어 제목과 OG 메타 9~11개를 `String.replace` 로 이어서 바꾼다. replace 한 번마다 1.08MB 새 문자열이 만들어진다. 2026-11-14 계획 작성자가 로컬에서 같은 치환을 재 보니 요청 1번에 CPU 14.5ms, 머리 부분(`</head>` 앞, 약 159KB)만 치환하고 뒤를 이어 붙이면 2.7ms 였다(결과 문자열 길이 같음). 이 서비스는 Vercel Hobby 의 월 Active CPU 4시간을 팀 전체가 나눠 쓰고 2026-11-08 한도 초과로 정지된 적이 있어, 요청당 CPU 를 줄이는 것이 직접 도움이 된다. 응답 바이트 수는 줄지 않는다.

## 현재 상태

`backend/routes/share.js` (162줄)

- `:17-28` `loadHtml()` 이 파일 전체를 `cachedHtml` 에 한 번 읽어 둔다.
- `:48` `const lit = (s) => () => s;` 치환 값을 함수로 줘서 `$` 패턴 확장을 막는다(2026-09-06 실측 사고 방지, 반드시 유지).
- 세 갈래가 같은 치환을 반복한다: 목록 공유(`?list=`, `:76-87`), 비교 공유(`?cmp=`, `:106-121`), 단지 공유(`?apt=`, `:134-155`, 단지 번호가 있으면 og:image 와 twitter:image 2개 추가). 쿼리 없으면 원본 그대로(`:124-128`).
  ```js
    const rewritten = html
      .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
      .replace(/<meta name="description" content="[^"]*">/, lit(`<meta name="description" content="${d}">`))
      ...
      .replace(/<meta name="robots" content="[^"]*">/, lit(`<meta name="robots" content="noindex, follow">`));
  ```
- 측정한 머리 위치: `index.html` 에서 `<meta name="robots"` 는 379번째 문자, `twitter:description` 은 1550번째 문자. 모든 대상 태그가 `</head>` 앞에 있다(실행자가 4단계에서 다시 확인한다).
- 테스트: `backend/test/share-ssr.test.js`, `backend/test/plan166-list-share.test.js`, `backend/test/share-og-rate-limit.test.js`. 도우미 `_shareHandler`, `_shareMockRes` 는 `backend/testSupport/_helpers.js`.

## 필요한 명령

| 목적 | 명령 | 성공 기준 |
|---|---|---|
| 공유 테스트 | `cd backend && node --test test/share-ssr.test.js test/plan166-list-share.test.js test/share-og-rate-limit.test.js test/share-head-199.test.js` | 전부 pass |
| 전체 검증 | 루트에서 `npm run verify` | exit 0 |

## 범위

수정: `backend/routes/share.js`, `backend/test/share-head-199.test.js`(새로 만듦), `backend/test/share-ssr.test.js`(172~186행의 개수 기대치 두 곳만).

이 계획에서 지켜야 하는 기존 소스 계약(계획 검토 때 확인):
- `backend/test/share-ssr.test.js:168-186`: `.replace(/<...` 호출은 전부 `lit(` 로 감싼 개별 호출이어야 한다(`TAG_REPLACE_RE` 로 센다). 정규식 배열과 반복문으로 바꾸면 이 테스트가 0건을 센다. 그러니 치환 11개는 반드시 지금처럼 `.replace(/<...>/, lit(...))` 줄로 하나씩 둔다.
- `backend/test/plan166-dead-ends.test.js:50-54`(A3): `const seq = ...` 줄과 `const ogImg = seq ? escapeHtml(...) : '';` 줄을 그대로 두고, `property="og:image" content="[^"]*"` 치환은 파일 전체에 1곳, 그리고 `if (ogImg) {` 다음 줄이 `rewritten = rewritten`, 그다음 줄이 `.replace(/<meta property="og:image"` 인 모양을 유지한다. 이 파일은 고치지 않는다.

건드리지 말 것: `lit()` 와 `escapeHtml()`, 각 갈래의 제목과 설명 문구, Cache-Control 값, 쿼리 길이 제한, `frontend/index.html`.

## 단계

### 1단계: 머리와 몸통을 한 번만 나눈다

`loadHtml()` 옆에 나눠 둔 값을 기억하는 함수를 만든다:
```js
let cachedSplit = null;
function loadSplit() {
  if (cachedSplit) return cachedSplit;
  const html = loadHtml();
  if (!html) return null;
  const i = html.indexOf('</head>');
  cachedSplit = i > 0 ? { head: html.slice(0, i), tail: html.slice(i), html } : { head: html, tail: '', html };
  return cachedSplit;
}
```

### 2단계: 치환을 한 함수로 모은다

세 갈래가 똑같이 쓰는 9개 치환(title, description, og:title, og:description, og:url, twitter:title, twitter:description, canonical, robots)을 함수 하나로 만든다. 세 갈래의 robots 값은 모두 `noindex, follow` 로 같다(b1cc128 에서 확인). 함수는 머리 문자열만 받아 치환해 돌려준다:
```js
function rewriteHead(head, t, d, u) {
  return head
    .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
    // ... 지금 코드의 나머지 8줄을 한 글자도 바꾸지 않고 그대로 옮긴다
    .replace(/<meta name="robots" content="[^"]*">/, lit(`<meta name="robots" content="noindex, follow">`));
}
```
목록과 비교 갈래: `const sp = loadSplit(); ... res.send(rewriteHead(sp.head, t, d, u) + sp.tail)`.

단지 갈래는 OG 이미지 블록 모양을 지키기 위해 머리에서 이어 붙인다:
```js
  let rewritten = rewriteHead(sp.head, t, d, u);
  // (기존 주석 유지)
  if (ogImg) {
    rewritten = rewritten
      .replace(/<meta property="og:image" content="[^"]*">/, lit(`<meta property="og:image" content="${ogImg}">`))
      .replace(/<meta name="twitter:image" content="[^"]*">/, lit(`<meta name="twitter:image" content="${ogImg}">`));
  }
  rewritten += sp.tail;
```
`loadHtml()` 이 null 이면 지금처럼 `/` 로 302. 쿼리가 없을 때는 지금처럼 원본 `html` 을 그대로 보낸다.

기존 테스트 개수 기대치를 새 구조에 맞춘다(`backend/test/share-ssr.test.js`):
- 172~175행 `calls.length >= 18` 와 메시지의 "기대 18건(분기 2개 × 9치환)" → `>= 11`, "기대 11건(공통 9치환 + OG 이미지 2)".
- 184~186행 `litRefs >= 19` 와 메시지 "기대 19건 이상(치환 18 + ...)" → `>= 12`, "기대 12건 이상(치환 11 + 헬퍼 정의/주석 참조)".
- 같은 테스트의 `bare === 0`(lit 로 감싸지 않은 치환 0건) 단언은 그대로 둔다.

확인: `grep -c "\.replace(/<" backend/routes/share.js` → 11 (b1cc128 에서는 29). `cd backend && node --test test/share-ssr.test.js test/plan166-dead-ends.test.js` → 전부 pass.

### 3단계: 결과가 바이트 단위로 같은지 테스트한다

`backend/test/share-head-199.test.js` 를 만든다. 지금(b1cc128) 코드와 새 코드의 결과가 같음을 보장하려면, 테스트 안에 옛 방식(전체 문자열에 같은 치환을 이어 붙이는 함수)을 그대로 적어 두고 새 라우트 응답과 비교한다. `_shareHandler`, `_shareMockRes` 사용법은 `share-ssr.test.js` 의 기존 테스트를 따른다.
1. `?apt=래미안&area=노원구` 응답 본문이 옛 방식 결과와 정확히 같다.
2. `?apt=x&seq=11350-41` (OG 이미지 갈래) 같다.
3. `?cmp=<두 단지 base64url>` 같다.
4. `?list=<세 단지 base64url>` 같다.
5. 테스트 도우미의 `_SHARE_EXPAND_PAIR`(`backend/testSupport/_helpers.js:372`) 를 10번 이어 붙인 apt 이름으로 요청하면 응답 길이가 원본 길이 + 2,000자 이하다(확장 패턴이 다시 펼쳐지지 않는다).

확인: 공유 테스트 전부 pass.

### 4단계: 대상 태그가 모두 머리에 있는지 고정한다

같은 테스트 파일에 하나 더: `index.html` 을 읽어 `</head>` 위치를 구하고, 11개 대상 정규식 각각의 `search()` 위치가 0 이상이고 `</head>` 보다 앞인지 단언한다. 누가 메타 태그를 몸통으로 옮기면 이 테스트가 잡는다.

## 완료 기준

- [ ] `npm run verify` exit 0
- [ ] 새 테스트 pass (최소 5개)
- [ ] `grep -c "\.replace(/<" backend/routes/share.js` 가 11
- [ ] `git status --short` 에 범위 밖 파일 없음
- [ ] README 199 행 갱신

## STOP 조건

- 어떤 대상 태그가 `index.html` 의 `</head>` 뒤에 있다(4단계 단언이 처음부터 실패).
- 위에 적은 두 테스트 파일 말고 다른 테스트가 `routes/share.js` 의 소스 모양을 고정하고 있어 실패한다(`grep -ln "routes/share" backend/test` 로 먼저 목록을 보고, 처음부터 실패하면 보고).
- `plan166-dead-ends.test.js` 를 고쳐야만 통과할 것 같다. 이 파일은 고치지 않는다.

참고: `index.html` 에는 `</head>` 가 3번 나온다(b1cc128 기준 2205, 6134, 14619행). 진짜 머리 끝은 첫 번째(2205행, 문자 위치 158,999)다. 뒤의 둘은 스크립트 안 문자열로 보이지만 확인하지 않았다. `indexOf` 로 첫 번째만 쓰면 된다.

## 유지보수 메모

- `index.html` 의 `<head>` 에 큰 인라인 CSS 가 있어 머리가 159KB 다. 머리를 더 줄이면 이득이 더 커진다(별도 일).
- 새 공유 갈래를 더할 때는 공통 함수를 쓴다. 전체 문자열 `html.replace` 를 다시 쓰지 않는다.
