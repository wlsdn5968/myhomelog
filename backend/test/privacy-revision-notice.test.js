/**
 * Plan 136 — 개인정보처리방침 개정 예고(2026-10-18 게시, 2026-11-17 시행 예정).
 * 지키는 것: 예고 표의 "현행" 칸은 지금 본문 문구를 그대로 옮긴 것이어야 한다(본문을 고치면 예고도 고칠 것).
 *   시행일 전까지 본문은 현행 유지 — 본문 표를 바꾸는 것은 시행일에(초안 브랜치 preview/privacy-136).
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

test('개정 예고는 본문 앞에 있고 시행 예정일·게시일을 적는다', () => {
  assert.ok(s > 0 && s < html.indexOf('<h2>1. 개인정보의 처리 목적</h2>'));
  assert.ok(notice.includes('2026년 11월 17일 시행 예정'));
  assert.ok(notice.includes('게시일 2026년 10월 18일'));
});

test('예고의 "현행" 문구는 본문에 그대로 있다(본문은 시행일 전까지 현행 유지)', () => {
  for (const cur of [
    '속도 제한·세션 캐시 (개인정보 미저장, 토큰 해시만)',
    '최대 24시간',
    '오류 모니터링 (PII 마스킹 적용)',
    'AI 채팅 사용 시',
    '오류 발생 시 마스킹된 요청 정보',
  ]) {
    assert.ok(notice.includes(cur), `예고에 ${cur}`);
    assert.ok(body.includes(cur), `본문에 ${cur}`);
  }
});
