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
