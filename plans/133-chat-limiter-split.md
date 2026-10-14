# 133 — 무료 챗(/api/chat)을 유료 경로의 fail-closed 리미터에서 분리

**작성 기준 커밋**: `e59f588` (2026-10-14) · **발견**: 2026-10-14 Upstash Redis 무료 한도 초과 조사
**성격**: `backend/server.js` 리미터 정의 1개 추가 + `/api/chat` 마운트 1줄 교체 + 신규 테스트 1. DB·프런트·의존성·환경변수 변경 0. `backend/middleware/rateLimit.js` 는 바꾸지 않는다.
**계획자 사전 검증**(저장소 밖 사본, e59f588 기준): 신규 테스트 5/5 · **원래 코드에서는 정적 검사 2건 실패**(음성 대조) · `npm run verify` 전체 통과(테스트 613/613, Plan 134 와 합쳐 618/618) · ESLint 0.

## 1. 사실 (계획자 실측 2026-10-14)
- 운영 Upstash Redis 가 무료 한도(월 500,000 명령)를 넘어 모든 명령이 `ERR max requests limit exceeded. Limit: 500000, Usage: 500001` 로 실패 중이다(Vercel 런타임 로그 10:17~11:04Z 연속). 초기화 시점과 소진 원인은 Upstash 콘솔에서만 확인된다(운영자).
- `POST /api/chat` 실측: **HTTP 503** `{"code":"ratelimit_unavailable"}` — 모든 사용자에게 챗이 막혀 있다.
- 원인: `backend/server.js:273` `app.use('/api/chat', optionalAuth, chatLimiter, …)`. `chatLimiter` 는 `scope: 'chat'`(`server.js:201-207`)이고, `backend/middleware/rateLimit.js:50` `COST_SENSITIVE_SCOPES = new Set(['chat','report','clause'])` 에 들어 있어 Redis 오류 시 **fail-closed 503**(`rateLimit.js:118-126`).
- 그런데 `/api/chat` 은 룰베이스 데이터 라우터다: `backend/routes/chat.js` 는 `services/chatDataRouter` 만 쓰고 `callAI`·Anthropic 호출이 없다(`server.js` CHAT-ZERO-COST-2026-08-12 주석). 유료 Anthropic 경로는 `/api/report`(`routes/report.js:256`)·`/api/clause`(`routes/clause.js:117`)뿐이며 둘 다 `chatLimiter` 를 거친다(`server.js:282`, `:314`).
- 챗 일일 한도 `dailyLimit({ scope: 'chat' })` 는 Redis 실패 시 인스턴스 메모리로 내려가 계속 센다(`backend/middleware/dailyLimit.js:58-80` `memory-degraded`) — 막지 않는다.
- 기존 테스트 `backend/test/share-og-rate-limit.test.js` §3-4 가 `COST_SENSITIVE_SCOPES` 에 chat·report·clause 가 그대로 있어야 한다고 고정한다 → 목록을 바꾸지 말고 **챗 전용 리미터를 따로** 둔다.

## 2. 변경 (실행자)
적용은 계획자가 검증한 스크립트로 한다(앵커가 정확히 1회가 아니면 아무것도 쓰지 않고 중단):
`node <scratchpad>/p133_apply.js <워크트리 루트>` — 내용:
1. `const chatLimiter = makeRateLimiter({ … });` 블록 바로 뒤에 빈 줄 + 아래 블록 삽입
```js
// CHAT-FREE-LIMITER-2026-10-14 (Plan 133): /api/chat 은 룰베이스 데이터 라우터라 유료 AI 호출이 0 이다(CHAT-ZERO-COST-2026-08-12).
//   그런데 유료 경로(/api/report·/api/clause)와 같은 chatLimiter(scope 'chat' = COST_SENSITIVE → Redis 장애 시 fail-closed 503)를
//   써서, Upstash 무료 한도(월 500,000 명령) 초과로 모든 Redis 명령이 실패한 2026-10-14 에 챗이 전원 503 이었다(실측).
//   챗은 별도 scope 로 fail-open(가용성 우선) — 한도·창·키 접미사는 chatLimiter 와 같다. 일일 한도(dailyLimit scope 'chat')는
//   Redis 실패 시 인스턴스 메모리로 내려가 계속 센다. 유료 두 경로는 chatLimiter(fail-closed) 그대로.
const chatDataLimiter = makeRateLimiter({
  limit: 20,
  windowSec: 60,
  scope: 'chatdata',
  keySuffix: ':chat',
  message: '채팅 요청 한도를 초과했습니다. 1분 후 다시 시도해주세요.',
});
```
2. `/api/chat` 마운트 줄 전체를 `chatLimiter` → `chatDataLimiter` 로 교체(나머지 인자 동일).
3. 신규 테스트 `backend/test/chat-limiter-split.test.js` = 계획자 파일 `<scratchpad>/p133/chat-limiter-split.test.js` 를 바이트 그대로 복사.

기대 해시(SHA-256): `backend/server.js` = `c4e4e9eefcd8b657d8ce6257841a062a12d6675daed17dab469e832a0195dc59` · 테스트 = `629d464bcef359568d60d09963459261432063fefaf23e0c1bd75097039cbb01`.

## 3. 테스트가 고정하는 것
- 정적: `chatDataLimiter` 정의 1회·`scope: 'chatdata'`·`failClosed` 없음 / `/api/chat` 은 `chatDataLimiter` / `/api/report`·`/api/clause` 는 `chatLimiter` 유지 / `chatLimiter` 의 `scope: 'chat'` 유지.
- 동작: 실제 `makeRateLimiter` 를 "모든 명령이 실패하는 Redis" 스텁으로 돌려 `chatdata` = 통과, `chat` = 503 `ratelimit_unavailable`.
- ⚠ 스텁은 실제 클라이언트 모양(`addTelemetry` 동기 no-op + `evalsha`/`eval`)이어야 한다. 모든 속성에 비동기 함수를 주는 Proxy 는 Ratelimit 생성자의 `addTelemetry` 에서 처리되지 않은 rejection 을 만들어 파일 단위 실패가 난다(계획자 실측).

## 4. 하지 않는 것
- `COST_SENSITIVE_SCOPES` 변경 · `/api/report`·`/api/clause` 리미터 변경 · rateLimit.js 수정 · Redis 사용량 절감(소진 원인 미확인 — 운영자 콘솔 확인 뒤 별도 계획).

## 5. 배포 뒤 확인
- `POST /api/chat` `{"message":"안녕하세요"}` → 200(Redis 장애 중에도). `/api/report` 는 여전히 503(비용 보호 유지 — 의도).
