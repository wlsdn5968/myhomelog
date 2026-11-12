/**
 * Plan 136 — 개인정보처리방침 v1.3 (2026-10-18 예고 게시, 2026-11-17 시행).
 * 지키는 것: 시행 뒤에는 개정 내용 표의 "개정" 칸이 본문에 그대로 있고, "이전" 칸 문구는 본문에 남지 않는다.
 *   NO-PAID-AI-2026-11-13: 유료 AI 를 쓰지 않으므로 본문 위탁·국외이전 표에 Anthropic 이 없어야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/privacy.html'), 'utf8');
const s = html.indexOf('<div class="card" id="revisionNotice"');
const e = html.indexOf('</div>', s);
const notice = html.slice(s, e);
const body = html.slice(e);

test('개정 내용은 본문 앞에 있고 시행일과 게시일을 적는다', () => {
  assert.ok(s > 0 && s < html.indexOf('<h2>1. 개인정보의 처리 목적</h2>'));
  assert.ok(notice.includes('2026년 11월 17일 시행'));
  assert.ok(!notice.includes('시행 예정'), '시행 뒤에도 예정이라고 적었다');
  assert.ok(notice.includes('게시일 2026년 10월 18일'));
  assert.ok(html.includes('최종 개정일: 2026년 11월 17일 (v1.3'));
});

test('이전 문구는 본문에서 사라지고 개정 문구가 본문에 있다', () => {
  for (const old of [
    '속도 제한·세션 캐시 (개인정보 미저장, 토큰 해시만)',
    '오류 모니터링 (PII 마스킹 적용)',
    'AI 채팅 사용 시',
    '오류 발생 시 마스킹된 요청 정보',
    'AI 기반 정보 정리',
  ]) {
    assert.ok(notice.includes(old), `개정 내용 표에 이전 문구 ${old}`);
    assert.ok(!body.includes(old), `본문에 이전 문구가 남았다: ${old}`);
  }
  for (const now of [
    '서비스 제공: 부동산 데이터 분석, 공공 데이터 정보 정리, 채팅 이력 보관',
    '<td>오류·성능 모니터링 (쿠키·요청 본문·IP 제외, 비밀값 마스킹)</td><td>30일</td>',
    '<td>Upstash, Inc.</td><td>미국</td>',
  ]) {
    assert.ok(body.includes(now), `본문에 개정 문구가 없다: ${now}`);
  }
  assert.ok(!/<td>[^<]*90일<\/td>/.test(body), 'Sentry 90일이 본문에 남았다');
});

test('본문 위탁·국외이전 표에 Anthropic 이 없다(무료 서비스, 유료 AI 미사용)', () => {
  assert.ok(!body.includes('Anthropic'), '본문에 Anthropic 이 남았다');
  assert.ok(notice.includes('<td>5. 처리 위탁: Anthropic, PBC (미국)</td>'));
});
