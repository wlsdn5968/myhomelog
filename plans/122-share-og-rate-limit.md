# 122 — `/share`·`/api/og` 전용 레이트리밋

**작성 기준 커밋**: `d209abc` (2026-09-28) · **출처**: `plans/README.md` 백로그 "/share 라우트 레이트리밋 없음"·"/api/og PNG 렌더가 fail-open 리미터 뒤에 있음" · **운영자 승인 2026-09-28**("권고대로" — 후속표 4번)
**성격**: 코드 S(`backend/server.js` 2곳) + 신규 테스트 1파일. DB·vercel.json 변경 0.

## 1. 사실 (계획자가 직접 읽음)
- `backend/server.js:216` `app.use('/api/', generalLimiter)` — 60/분(env `RATE_LIMIT_MAX`), scope `general`, fail-open. `/share` 는 `/api/` 밖이라 **어떤 리미터도 안 거친다**: `:313` `app.use('/share', shareRouter)`.
- `/api/og` 는 `:326` `app.use('/api/og', require('./routes/ogImage'))` — generalLimiter(60/분)만. `routes/ogImage.js` 는 satori·resvg 로 PNG 를 렌더(CPU 비용), 성공 응답만 `s-maxage=21600`(엣지 캐시)이라 **서로 다른 aptSeq 16,000여 개를 돌면 캐시가 소용없다** — IP 하나가 시간당 3,600장을 렌더시킬 수 있다.
- `/share` 는 캐시된 index.html 에 OG 메타 8개를 치환해 돌려준다(2026-09-06 증폭 결함은 `lit()` 로 수정됨) — 요청당 비용은 작지만 무제한이다.
- 리미터 팩토리 `backend/middleware/rateLimit.js` `makeRateLimiter({ limit, windowSec, scope, message, keySuffix, failClosed })` — Upstash sliding window, 운영자 계정 우회, Redis 없으면 in-memory. `COST_SENSITIVE_SCOPES = {chat, report, clause}` 만 fail-closed(유료 AI 경로). `app.set('trust proxy', 1)`(`server.js:27`)이라 `req.ip` 는 클라이언트 IP.
- 정상 트래픽: 링크 미리보기 크롤러(카카오톡·페이스북·X·디스코드)는 공유 1건당 `/share` 1회 + `og:image` 1회를 가져가고 결과를 자체 캐시한다. 앱 화면은 `/api/og` 이미지를 직접 불러오지 않는다(메타 태그에만 쓰인다).

## 2. 변경 (실행자)
`backend/server.js` 의 리미터 정의부(`dataLimiter` 정의 바로 뒤, `:214` 부근)에 두 개 추가:
```js
// SHARE-OG-LIMIT-2026-09-28 (Plan 122): /share 는 /api/ 밖이라 어떤 리미터도 없었고, /api/og 는 PNG 렌더(CPU)가
//   general(60/분)만 거쳐 서로 다른 aptSeq 를 돌면 엣지 캐시가 소용없었다. 둘 다 유료 AI 가 아니라 fail-open(가용성 우선) —
//   링크 미리보기 크롤러는 공유 1건당 1~2회만 가져가므로 아래 한도는 정상 트래픽에 닿지 않는다.
const shareLimiter = makeRateLimiter({
  limit: 60, windowSec: 60, scope: 'share', keySuffix: ':share',
  message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
});
const ogLimiter = makeRateLimiter({
  limit: 30, windowSec: 60, scope: 'og', keySuffix: ':og',
  message: '미리보기 이미지 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
});
```
마운트 교체:
- `app.use('/share', shareRouter);` → `app.use('/share', shareLimiter, shareRouter);`
- `app.use('/api/og', require('./routes/ogImage'));` → `app.use('/api/og', ogLimiter, require('./routes/ogImage'));`
(`/api/og` 는 앞의 generalLimiter 도 계속 거친다 — 실효 한도 30/분.)

## 3. 테스트 `backend/test/share-og-rate-limit.test.js` (신규)
패턴: `server.js` 소스를 `fs.readFileSync` 로 읽는 정적 단언(기존 `frontend-contracts.test.js` 가 server.js 마운트 순서를 이렇게 검사한다 — 실행자는 그 파일에서 server.js 를 읽는 부분을 찾아 같은 방식으로). 단언:
1. `app.use('/share', shareLimiter, shareRouter)` 1회, `app.use('/share', shareRouter)` 0회.
2. `app.use('/api/og', ogLimiter, require('./routes/ogImage'))` 1회.
3. `scope: 'share'` 와 `scope: 'og'` 정의 각 1회, 둘 다 `failClosed: true` 를 쓰지 않는다.
4. `backend/middleware/rateLimit.js` 의 `COST_SENSITIVE_SCOPES` 에 `share`·`og` 가 없다(fail-open 의도 고정).
5. 동작 테스트 1개: `makeRateLimiter` 를 Redis 없는 상태(in-memory 경로 — `getRedis()` 가 null 이 되도록 `require.cache` 스텁, 저장소의 `_helpers.js`·기존 스텁 관례를 따를 것)로 `{ limit: 2, windowSec: 60, scope: 'og' }` 를 만들어 같은 IP 로 3번 호출 시 3번째가 429 인지. 스텁이 과하게 복잡해지면(기존 테스트 파일 수정이 필요하면) 이 항목은 빼고 보고.

## 4. 하지 말 것 / STOP
- `rateLimit.js` 로직·`COST_SENSITIVE_SCOPES` 변경 금지. `/apt`·`/region`·`/briefing` SSR 라우트는 **범위 밖**(같은 성격이지만 이번 승인 항목이 아니다 — 계획자가 별도 판단).
- `vercel.json`·`routes/share.js`·`routes/ogImage.js` 변경 금지.

## 5. 완료 기준
`npm run verify` 전부 통과. 배포 후 리뷰어 라이브: `/share?apt=벽적골우성` 200 + 응답 헤더 `RateLimit-Limit: 60`, `/api/og/apt/41117-37` 200 + `RateLimit-Limit: 30`(Upstash 경로일 때 헤더가 붙는다 — `rateLimit.js:90-92`).
