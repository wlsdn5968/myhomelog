# 098 — 챗 PII 차단이 **봇 자신의 답변**(디딤돌 안내의 콜센터 `1599-0001`)을 계좌번호로 오탐해 이후 모든 질문을 400 으로 죽이는 결함 + 프론트가 그 400 을 "일시 오류"·"응답을 받지 못했어요" 두 말풍선으로 위장하는 결함

**작성 기준 커밋**: `6a6436a` (2026-09-16) · 우선순위 **P0(운영자 실사고, 챗 전면 불능)** · 작업량 S · 의존: 없음

## 전제 확인 (계획자가 라이브 재현·서버 로그·코드로 확인 — 추측 아님)
- **라이브 재현(이력 누적 전송, 2026-09-16 13:2x UTC)**: `5억이면 대출 얼마까지 돼?`(200) → `디딤돌 조건 알려줘`(200, 답변에 "1599-0001") → 이후 `대출계산기`·`특약초안`·`관심단지 소식 알려줘`·`동탄 규제 맞아?`·`은마 시세`·`공덕 시세`·`요즘 인기 단지 알려줘`·`노원구 인기단지` **8건 전부 400 `pii_blocked`(계좌번호)**. 운영자 세션 서버 로그(13:18 UTC): regulation 200 → policyLoan 200 → `chat-pii-block` 400 ×2(`types:["계좌번호"]`, scope message+context).
- `backend/routes/chat.js:18~23` `PII_PATTERNS.bankAcct = /\b\d{3,6}\s*-?\s*\d{2,6}\s*-?\s*\d{2,7}\b/g` — `1599-0001` 과 ISO 날짜 `2026-09-15` 도 매칭된다. `:40~68 collectClientPIIText(message, context)` 는 `context.history[*].content` 를 **role 구분 없이** 전부 모은다(주석은 "history 경유 PII 우회 차단" 의도). `:75~84` 가 400 `{ error, code:'pii_blocked', types }` 응답.
- 답변 원문: `backend/services/chatDataRouter.js:486` `'… 주택도시기금(nhuf.molit.go.kr) · 1599-0001 에서 확정 확인.'` — 서버가 만든 사실 정보(개인정보 아님). **이 문구는 바꾸지 않는다.**
- 프론트 `frontend/index.html:12619` fetch → `:12688` `} else if(!r.ok){ throw new Error('http_' + r.status); }` → catch(`:12713~12730`)에서 `http_400` 은 어느 분기에도 안 걸려 `'⚠ 일시 오류 — 잠시 후 다시 시도해주세요.'` 를 addMsg 하고, **`replied` 를 true 로 바꾸지 않아** 바로 아래 `if(!replied){ … addMsg('ai','💬 응답을 받지 못했어요.…') }`(`:12733~12735`) 가 두 번째 말풍선을 붙인다 — 운영자 스크린샷 그대로.
- 기존 테스트: PII 관련 0건(`grep -rn "pii_blocked\|detectPII" backend/test` 없음). `chat.js` 는 `module.exports = router;`(`:115`) 만. 다른 테스트들이 `require('../services/chatDataRouter')` 를 env 없이 로드하므로 `routes/chat` 도 로드 가능하다고 본다(아니면 STOP 조건).

## 범위
- 수정: `backend/routes/chat.js`, `frontend/index.html`(비-OK 분기 + catch 끝 1줄), `backend/test/frontend-contracts.test.js`(test 1개 추가). 신규: `backend/test/chat-pii-scope.test.js`.
- 금지: `chatDataRouter.js` 문구 변경, PII 패턴의 ssn/phone/card/passport 변경, 다른 파일.

## Step 1 — `backend/routes/chat.js`
1. `collectClientPIIText` 의 history 루프를 아래로:
   ```js
   // PII-SCOPE-2026-09-16 (Plan 098): assistant 답변은 서버가 만든 텍스트(콜센터 1599-0001 등)라 검사 대상이
   //   아니다 — 검사하면 그 답변이 이력에 남는 순간 이후 모든 질문이 400 으로 죽는다(2026-09-16 운영자 실사고).
   //   사용자 입력(role 이 'assistant' 가 아닌 이력·message·session 자유입력)만 본다.
   for (const h of hist) { if (h && typeof h.content === 'string' && h.role !== 'assistant') parts.push(h.content); }
   ```
2. `detectPII(text)` 첫 줄 `const t = String(text || '');` 를
   ```js
   // PII-DATE-2026-09-16 (Plan 098): ISO 날짜(2026-09-15)가 bankAcct 패턴(\d{3,6}-\d{2,6}-\d{2,7})에 걸려 "계좌번호" 오탐 — 날짜를 지운 뒤 검사한다.
   const t = String(text || '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
   ```
   로 바꾼다(다른 패턴엔 영향 없음: ssn 은 6-7자리, phone 은 01x 로 시작).
3. 파일 끝 `module.exports = router;` 뒤에 `module.exports._pii = { detectPII, collectClientPIIText }; // 테스트용(Plan 098) — 라우트 동작 불변` 추가.

## Step 2 — `frontend/index.html`
1. `:12688` 의
   ```js
    } else if(!r.ok){
      throw new Error('http_' + r.status);
    } else {
   ```
   을
   ```js
    } else if(!r.ok){
      // CHAT-ERR-HONEST-2026-09-16 (Plan 098): 서버가 준 사유(error)를 그대로 보여준다 — 400(pii_blocked 등)을 "일시 오류"로 위장하지 않는다.
      const j=await r.json().catch(()=>({}));
      rmTyp();
      addMsg('ai', (j && typeof j.error === 'string' && j.error.trim()) ? j.error : `⚠ 요청을 처리하지 못했어요 (HTTP ${r.status}). 잠시 후 다시 시도해주세요.`);
      replied=true;
    } else {
   ```
   로 바꾼다(`addMsg` 는 `_escHtml` 처리라 서버 문자열 표시가 안전 — `:12690` 근처 주석과 같은 전제).
2. catch 블록의 `addMsg('ai', userMsg);`(`:12729`) 바로 다음 줄에 `replied=true; // Plan 098: 아래 generic fallback 이 두 번째 말풍선을 붙이지 않게` 추가.

## Step 3 — 테스트
### 3-a `backend/test/chat-pii-scope.test.js` (신규)
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// PII-SCOPE-2026-09-16 (Plan 098): routes/chat 의 PII 검사 범위 계약. 라우트 로드 자체가 env 를 요구하지 않는다(다른 라우트 테스트와 동일).
const { _pii } = require('../routes/chat');
test('PII 검사 — assistant 답변(콜센터 1599-0001)은 검사 대상이 아니다 (이력에 남아도 다음 질문이 400 이 되지 않는다)', () => {
  const text = _pii.collectClientPIIText('노원구 인기단지', { history: [
    { role: 'user', content: '디딤돌 조건 알려줘' },
    { role: 'assistant', content: '자격·서류 요건은 별도예요 — 주택도시기금(nhuf.molit.go.kr) · 1599-0001 에서 확정 확인.' },
  ], session: {} });
  assert.deepEqual(_pii.detectPII(text), []);
});
test('PII 검사 — user 이력의 휴대전화번호는 여전히 차단된다 (이력 경유 우회 방지 유지)', () => {
  const text = _pii.collectClientPIIText('그래서 얼마야', { history: [{ role: 'user', content: '제 번호는 010-1234-5678 이에요' }] });
  assert.ok(_pii.detectPII(text).includes('휴대전화번호'));
});
test('PII 검사 — ISO 날짜(2026-09-15)는 계좌번호가 아니다', () => {
  assert.deepEqual(_pii.detectPII('2026-09-15 거래 알려줘'), []);
});
test('PII 검사 — 실제 계좌번호 형태는 차단된다', () => {
  assert.ok(_pii.detectPII('계좌 110-123-456789 로 보내주세요').includes('계좌번호'));
});
```
### 3-b `backend/test/frontend-contracts.test.js` 파일 끝
```js
test('Plan 098 — 챗 비-OK 응답은 서버 사유를 그대로 보여주고, 실패 말풍선은 한 번만 붙는다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.equal((html.match(/CHAT-ERR-HONEST-2026-09-16/g) || []).length, 1, '비-OK 분기 패치 마크가 정확히 1회여야 한다');
  assert.ok(!html.includes("throw new Error('http_' + r.status)"), '400 을 예외로 던져 "일시 오류"로 위장하는 옛 분기가 남아 있다');
  assert.match(html, /addMsg\('ai', userMsg\);\s*\n\s*replied=true;/, 'catch 에서 replied=true 를 안 세우면 "응답을 받지 못했어요" 가 두 번째 말풍선으로 붙는다');
});
```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 **417 + 5**.
- 회귀 주입(수행 후 원복): (1) history 루프의 `&& h.role !== 'assistant'` 제거 → 3-a 첫 테스트 fail. (2) catch 의 `replied=true;` 제거 → 3-b fail.
- 정적: `grep -n "h.role !== 'assistant'" backend/routes/chat.js` 1건 · `grep -c "CHAT-ERR-HONEST-2026-09-16" frontend/index.html` = 1.
- 리뷰어 라이브(배포 후): 위 10개 질문을 이력 누적으로 보내 **전부 200**, 그리고 사용자 메시지에 `010-1234-5678` 을 넣으면 400 이고 프론트에 서버 사유 문장이 그대로 뜬다.
- 커밋 1개: `fix(챗): PII 검사를 사용자 입력만으로 한정 — 봇 답변의 1599-0001 오탐으로 이후 질문 전부 400 + ISO 날짜 제외 + 비-OK 사유 그대로 표시·이중 말풍선 제거 (Plan 098)`.

## STOP 조건
- 테스트에서 `require('../routes/chat')` 가 env 부재로 throw → 어떤 모듈이 throw 하는지 보고하고 STOP(함수를 별도 파일로 옮기는 것은 이 계획 범위 밖).
- 프론트 `:12688` 부근 코드가 위 발췌와 다르다 → 보고 후 STOP.
