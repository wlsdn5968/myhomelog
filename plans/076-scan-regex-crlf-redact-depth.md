# 076 — 잡무 3건: 스키마 스캔 정규식의 `Buffer.from` 오탐 · `aptMasterSync.js` CR CR LF 23줄 · pino redact 깊이 확장

**작성 기준 커밋**: `75f39ad` (2026-09-10) · 우선순위 P3 · 작업량 S · 의존: 없음 (074·075 와 파일 겹침 없음)

## 전제 확인 (계획자가 실제로 확인한 것)
- **[A]** `backend/test/frontend-contracts.test.js:1217` — `src.matchAll(/\.from\(\s*['"`]([a-zA-Z0-9_]+)/g)` 가 소스 전체에서 "테이블 참조"를 모은다. `Buffer.from('문자열')` 도 잡혀서 `backend/test/cache-degraded.test.js:179~182` 가 `Buffer.alloc` 으로 우회하고, 그 주석은 이미 없어진 `characterization.test.js` 를 가리킨다(066 분할 전 이름).
- **[B]** `backend/jobs/aptMasterSync.js` 에 줄끝이 `\r\r\n` 인 줄 **23개**: 79,80,85,86,87,99,100,101,102,103,104,126,127,128,129,280,281,282,347,348,349,350,351 (나머지 329줄은 `\r\n`, 단독 `\n` 0). 동작 무관·편집기 노이즈.
- **[C]** `backend/logger.js:45~58` pino `redact.paths` 에 `'*.apiKey'` 등 1단계 와일드카드만 있다. **실측(pino 10.3.1, fast-redact 의존 없음)**: `*` 는 정확히 한 단계만 매치 — `['*.apiKey']` 는 `{a:{apiKey}}` 만 가리고 `{b:{c:{apiKey}}}` 는 그대로 남는다. `'*.*.apiKey'`·`'*.*.*.apiKey'` 를 함께 주면 3단계까지 가려진다(실행으로 확인). `logger.js` 는 `module.exports = logger; module.exports.maskIp = maskIp;` 로 export 한다(총 100줄).

## 범위
- 수정: `backend/test/frontend-contracts.test.js`(정규식 1곳 + 소형 테스트 1개), `backend/test/cache-degraded.test.js`(주석 3줄), `backend/jobs/aptMasterSync.js`(줄끝만), `backend/logger.js`(redact 경로 배열 추출·확장·export).
- 신규: `backend/test/logger-redact.test.js`.
- 금지: 그 외 파일. `aptMasterSync.js` 는 **바이트 단위 줄끝 외에 어떤 변경도 금지**.

## Step A — 스캔 정규식
1. `frontend-contracts.test.js` 에서 `:1217` 의 정규식 리터럴을 파일 상단(그 테스트 함수 바깥, 인접한 곳)의 상수로 뽑고 lookbehind 로 `Buffer` 를 제외한다:
   ```js
   // SCHEMA-SCAN-RE-2026-09-10 (Plan 076): `Buffer.from('…')` 은 테이블 참조가 아니다 — lookbehind 로 제외.
   const TABLE_REF_RE = /(?<!Buffer)\.from\(\s*['"`]([a-zA-Z0-9_]+)/g;
   ```
   그리고 `:1217` 을 `for (const m of src.matchAll(TABLE_REF_RE)) {` 로 바꾼다(`.rpc(` 정규식은 그대로).
2. 같은 파일, 그 스캔 테스트 **바로 뒤**에 테스트 추가:
   ```js
   test('SCHEMA-SCAN-RE (Plan 076): Buffer.from 은 테이블 참조로 잡지 않고 supabase .from 은 잡는다', () => {
     const sample = "const b = Buffer.from('abc'); const r = await admin.from('apt_master').select('*'); db.from(`molit_transactions`)";
     const got = [...sample.matchAll(TABLE_REF_RE)].map((m) => m[1]);
     assert.deepEqual(got, ['apt_master', 'molit_transactions']);
   });
   ```
3. `cache-degraded.test.js:179~181` 주석을 사실에 맞게 고친다(코드는 그대로 `Buffer.alloc` 유지):
   ```js
         // ⚠ SCHEMA-SNAPSHOT-SCAN (frontend-contracts.test.js, TABLE_REF_RE): 소스 전체에서 `.from('…')` 을
         //   테이블 참조로 모은다. Plan 076 부터 `Buffer.from` 은 lookbehind 로 제외되지만, 여기는 그 스캔과
         //   무관하게 Buffer.alloc 으로 둔다(내용은 테스트에서 안 본다).
   ```

## Step B — 줄끝 정규화 (스크립트로만)
```bash
node -e "const fs=require('fs');const p='backend/jobs/aptMasterSync.js';const b=fs.readFileSync(p);const s=b.toString('latin1');const n=(s.match(/\r\r\n/g)||[]).length;if(n!==23){console.error('예상 23, 실제 '+n);process.exit(1)}fs.writeFileSync(p,Buffer.from(s.replace(/\r\r\n/g,()=>'\r\n'),'latin1'));console.log('정규화',n)"
```
확인: `git diff --stat -- backend/jobs/aptMasterSync.js` → `23 insertions(+), 23 deletions(-)` · `git diff -w --stat -- backend/jobs/aptMasterSync.js` → **빈 출력**(공백 외 변경 0) · `node --check backend/jobs/aptMasterSync.js` 통과. (치환 인자를 함수로 준 이유: 문자열 치환은 `$` 시퀀스를 해석한다 — 이 저장소 실사고.)

## Step C — redact 깊이
1. `logger.js` 의 `redact: { paths: [ … ], censor: '[REDACTED]', remove: false }` 에서 배열을 `pino({…})` **호출 위**의 상수로 뽑는다:
   ```js
   // REDACT-DEPTH-2026-09-10 (Plan 076): pino 의 `*` 는 정확히 한 단계만 매치한다(실측). 중첩 객체
   //   ({ config: { kakao: { apiKey } } }) 를 그대로 로그에 넣어도 가려지도록 2·3단계를 명시한다.
   const SECRET_KEYS = ['apiKey', 'api_key', 'serviceKey', 'password', 'token'];
   const REDACT_PATHS = [
     // 흔한 PII 필드명
     'email', 'phoneNumber', 'phone', 'name', 'fullName',
     'ssn', 'rrn', 'creditScore',
     // HTTP req/res 안의 토큰
     'req.headers.authorization',
     'req.headers.cookie',
     'req.headers["x-api-key"]',
     'req.headers["set-cookie"]',
     'res.headers["set-cookie"]',
     // 외부 API 키가 실수로 객체 안에 들어간 경우 — 최상위·1·2·3단계
     ...SECRET_KEYS,
     ...SECRET_KEYS.map((k) => `*.${k}`),
     ...SECRET_KEYS.map((k) => `*.*.${k}`),
     ...SECRET_KEYS.map((k) => `*.*.*.${k}`),
   ];
   ```
   `redact: { paths: REDACT_PATHS, censor: '[REDACTED]', remove: false },` 로 쓰고, 파일 끝에 `module.exports.REDACT_PATHS = REDACT_PATHS;` 추가. 기존 경로 집합은 **전부 유지**(위 배열이 기존 항목을 모두 포함하는지 diff 로 확인).
2. 신규 `backend/test/logger-redact.test.js`:
   ```js
   const test = require('node:test');
   const assert = require('node:assert/strict');
   const pino = require('pino');

   test('REDACT-DEPTH (Plan 076): 1·2·3단계 중첩 비밀값이 가려지고 일반 필드는 남는다', () => {
     const { REDACT_PATHS } = require('../logger');
     const lines = [];
     const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, { write: (s) => lines.push(s) });
     log.info({
       a: { apiKey: 'k1' }, b: { c: { token: 'k2' } }, d: { e: { f: { password: 'k3' } } },
       req: { headers: { authorization: 'Bearer x', 'user-agent': 'ua' } },
       keep: { nested: { value: 'ok' } }, aptSeq: '11350-183',
     }, 'probe');
     const o = JSON.parse(lines.join('').trim().split('\n').pop());
     assert.equal(o.a.apiKey, '[REDACTED]');
     assert.equal(o.b.c.token, '[REDACTED]');
     assert.equal(o.d.e.f.password, '[REDACTED]');
     assert.equal(o.req.headers.authorization, '[REDACTED]');
     assert.equal(o.req.headers['user-agent'], 'ua');
     assert.equal(o.keep.nested.value, 'ok');
     assert.equal(o.aptSeq, '11350-183');
     assert.ok(REDACT_PATHS.includes('req.headers.cookie') && REDACT_PATHS.includes('*.apiKey'), '기존 경로가 빠졌다');
   });
   ```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 수 **382**(380 + Step A 1개 + Step C 1개).
- 회귀 주입 2건(각각 수행 후 원복): ① `TABLE_REF_RE` 의 `(?<!Buffer)` 를 지우면 Step A 테스트 fail. ② `REDACT_PATHS` 에서 `*.*.*.` 줄을 지우면 Step C 테스트 fail.
- 커밋 3개(Step 별): `test(스캔): …(Plan 076)` / `chore(정리): aptMasterSync.js CR CR LF 23줄 정규화 (Plan 076)` / `fix(로그): pino redact 2·3단계 중첩 비밀값 (Plan 076)`.

## STOP 조건
- Step B 의 매치 수가 23 이 아니다 → 멈추고 실제 값을 보고.
- `git diff -w` 가 비어 있지 않다(줄끝 외 변경) → 원복하고 보고.
- 기존 테스트 중 logger 의 redact 결과에 의존하는 것이 fail 한다 → 출력 그대로 보고.
