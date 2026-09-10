# 074 — `validatePropertySearch` 의 죽은 GET 분기 제거

**작성 기준 커밋**: `75f39ad` (2026-09-10) · 우선순위 P3 · 작업량 XS · 의존: 073 완료(반영됨)

## 전제 확인 (계획자가 실제로 확인한 것)
- `grep -rn "validatePropertySearch" backend --include=*.js | grep -v /test/` → 정의(`backend/middleware/validation.js:82`), export(`:119`), 소비자 **1곳**: `backend/routes/properties.js:11` `router.post('/recommend', validatePropertySearch, …)`. GET 소비자 없음.
- 073 이 GET 분기에 `req.sanitized` 우회를 넣고 단위 테스트(`backend/test/express5-migration.test.js:131`)로 고정했다 — 그 테스트 주석 자체가 "실소비자가 없다"고 적고 있다. 죽은 분기를 테스트가 붙들고 있는 상태.
- `validateTransactionQuery`(같은 파일 `:60~80`)의 `req.sanitized` 는 **살아있는 소비자**(`routes/transactions.js`)가 있다 — 건드리지 않는다.

## 범위
- 수정: `backend/middleware/validation.js` 의 `validatePropertySearch` 본문 머리 부분만, `backend/test/express5-migration.test.js` 의 GET 분기 테스트 1개 교체.
- 금지: `validateTransactionQuery`·`validateChatInput`·`routes/properties.js`·다른 테스트 파일.

## Step 1 — validation.js (현재 `:82~96`)
현재:
```js
function validatePropertySearch(req, res, next) {
  // POST /recommend 은 body, GET 엔드포인트는 query
  const isPost = req.method === 'POST';
  const src = isPost ? (req.body || {}) : (req.query || {});
  const { query, minPrice, maxPrice, region } = src;

  // EXPRESS5-QUERY-GETTER-2026-09-06 (Plan 073): req.body 는 body-parser 가 만든 고정 객체라
  //   직접 mutate 해도 안전(POST 는 기존 그대로). req.query 는 Express 5 부터 접근마다 재파싱되는
  //   getter라 GET 분기에서 src(=req.query)에 쓴 값은 다음 접근에서 원문으로 되돌아간다 —
  //   GET 은 req.sanitized 로 우회.
  const out = isPost ? src : (req.sanitized = req.sanitized || {});

  if (query) out.query = sanitizeString(query, 100);
```
로 바꾼다(아래 `if (query)` 부터 함수 끝까지는 그대로 — `out.` 접두 유지):
```js
function validatePropertySearch(req, res, next) {
  // DEAD-GET-BRANCH-2026-09-10 (Plan 074): 유일한 소비자는 POST /api/properties/recommend
  //   (routes/properties.js:11). GET 분기(req.query → req.sanitized)는 실소비자가 없어 제거했다.
  //   GET 소비자를 다시 붙일 때는 Express 5 의 req.query 가 접근마다 재파싱되는 getter 라
  //   req.query 에 대입하지 말고 req.sanitized 에 실어야 한다(Plan 073, validateTransactionQuery 참고).
  // EXPRESS5-BODY-2026-09-06 (Plan 073): body-parser 2.x 는 파싱 안 되면 req.body 가 undefined.
  //   req.body 는 body-parser 가 만든 고정 객체라 직접 mutate 해도 안전하다.
  const out = req.body || {};
  const { query, minPrice, maxPrice, region } = out;

  if (query) out.query = sanitizeString(query, 100);
```
확인: `grep -n "req.sanitized" backend/middleware/validation.js` → `validateTransactionQuery` 안의 줄들만 남는다(GET 분기 줄 0). `node --check` 통과.

## Step 2 — 테스트 교체 (`backend/test/express5-migration.test.js:131~141`)
`test('EXPRESS5-A(단위): validatePropertySearch GET 분기 — req.query 대신 req.sanitized 에 정제값을 싣는다', …)` 블록 **전체**를 아래로 교체(POST 분기 테스트 2개 `:143`·`:165` 는 그대로):
```js
test('DEAD-GET-BRANCH (Plan 074): validatePropertySearch 는 method 와 무관하게 req.body 만 본다 — GET 에서 req.sanitized 를 만들지 않는다', () => {
  const { validatePropertySearch } = require('../middleware/validation');
  const req = { method: 'GET', query: { query: '<i>x</i>', region: '서울' } };
  let nextCalled = false;
  validatePropertySearch(req, mkRes(), () => { nextCalled = true; });
  assert.ok(nextCalled, 'body 없는 GET 도 next() 로 통과해야 한다(검증 대상이 없으므로)');
  assert.equal(req.sanitized, undefined, '죽은 GET 분기가 되살아났다 — req.sanitized 가 만들어졌다');
  assert.equal(req.query.query, '<i>x</i>', 'req.query 를 건드리면 안 된다');
});
```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 수 **380 그대로**(1개 교체).
- 회귀 주입: Step 1 을 되돌리면(`isPost` 분기 복원) 새 테스트가 `req.sanitized` 로 fail 해야 한다 → 원복.
- 커밋 1개: `refactor(검증): validatePropertySearch 죽은 GET 분기 제거 (Plan 074)` + body 에 [근본 원인][Fix][회귀 위험].

## STOP 조건
- `validatePropertySearch` 의 GET 소비자가 실제로 있다(grep 결과가 위와 다르다) → 멈추고 보고.
