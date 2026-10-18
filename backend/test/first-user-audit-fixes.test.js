/**
 * backend/test/first-user-audit-fixes.test.js
 *
 * 2026-10-18 첫 사용자 관점 운영 실측(375·1440)에서 재현한 결함 수정을 고정한다.
 *   DM-TOP      모바일 전체 화면 상세가 헤더 아래에 깔려 닫기를 누르면 데이터 상태 창이 열렸다
 *   CHAT-WRAP   짧은 도우미 질문도 말풍선 끝 글자가 줄바꿈됐다(.bbl 의 % 상한이 내용 폭 기준)
 *   aria-label  인기 단지 행의 읽기용 이름에 화면용 <span> 조각이 들어갔다
 *   **강조**    /** 가 주석 시작으로 읽혀 보고서 확인 항목의 ** 가 그대로 보였다
 *   RATES-INIT  시중 금리·정책자금 금리가 목록 검색 뒤에만 채워져 대출 계산이 4.0% 로 계산됐다
 *   mockBanner  인라인 display:none 이 .show 를 이겨 한 번도 안 보였다
 *   dc(true)    매수가 없이 '계산하기'를 누르면 아무 반응이 없었다
 *   사업주체    청약 API 의 BSNS_MBY_NM(사업주체명)을 '시공'으로 표시했다
 *   CORS-403    허용 안 된 출처가 500·error 등급으로 응답·기록됐다
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('DM-TOP: 모바일 상세는 헤더 아래 끝(--biz-top)부터 시작한다', () => {
  assert.match(html, /\.dmbg\{padding:var\(--biz-top,54px\) 0 0!important;align-items:stretch!important\}/);
  assert.match(html, /\.dm\{[^}]*height:calc\(100vh - var\(--biz-top,54px\)\)\}/);
  assert.doesNotMatch(html, /\.dmbg\{padding:0!important;align-items:stretch!important\}/);
});

test('CHAT-WRAP: 말풍선 폭 상한은 바깥 칸에, .bbl 자체에는 % 상한이 없다', () => {
  const bbl = (html.match(/\n\.bbl\{([^}]*)\}/) || [])[1] || '';
  assert.ok(bbl, '.bbl 규칙을 찾지 못했다');
  assert.doesNotMatch(bbl, /max-width/);
  assert.doesNotMatch(html, /\.bbl\{max-width:\d+%/);
  assert.match(html, /\.msg>div:not\(\.ava\)\{max-width:90%;min-width:0\}/);
});

test('인기 단지 행 aria-label 에 HTML 조각을 넣지 않는다', () => {
  assert.match(html, /count && `거래 \$\{cnt\}건`/);
  assert.doesNotMatch(html, /count && `거래 \$\{count\}`/);
});

test('보고서 **강조** 치환은 이스케이프된 정규식이다(주석으로 읽히지 않게)', () => {
  assert.doesNotMatch(html, /\.replace\(\/\*\*\(/);
  assert.equal((html.match(/\.replace\(\/\\\*\\\*\(\[\^\*\]\+\)\\\*\\\*\/g, '<b>\$1<\/b>'\)/g) || []).length, 2);
  const re = /\*\*([^*]+)\*\*/g;
  assert.equal('a **b** c'.replace(re, '<b>$1</b>'), 'a <b>b</b> c');
});

test('RATES-INIT: 첫 health(checkMolit)에서 시중 금리·정책자금 금리를 채운다', () => {
  const start = html.indexOf('async function checkMolit(){');
  assert.ok(start > 0, 'checkMolit 를 찾지 못했다');
  const body = html.slice(start, html.indexOf('\n}', start));
  assert.match(body, /updateEcosHint\(d\.ecosRates\)/);
  assert.match(body, /updateHfRates\(d\.hfRates\)/);
});

test('mockBanner: 인라인 display:none 이 없고 dialog 역할도 붙지 않는다', () => {
  assert.doesNotMatch(html, /id="mockBanner" style="display:none"/);
  assert.doesNotMatch(html, /\['LM', 'DM', 'UM', 'SM', 'QM', 'mockBanner'\]/);
  assert.match(html, /\.mock-banner\{display:none;/);
});

test("대출 계산: 버튼으로 눌렀을 때만 매수가 안내 토스트", () => {
  assert.match(html, /onclick="dc\(true\)">계산하기<\/button>/);
  assert.match(html, /function dc\(fromBtn\)\{/);
  assert.match(html, /if\(fromBtn===true\)toast\('매수가를 입력해 주세요'\)/);
});

test("청약: BSNS_MBY_NM 은 '사업주체'로 표시한다", () => {
  assert.doesNotMatch(html, /시공: \$\{_escHtml\(it\.builder/);
  assert.match(html, /사업주체: \$\{_escHtml\(it\.builder \|\| '미상'\)\}/);
});

test('CORS-403: 허용 안 된 출처는 403, 4xx 는 warn 으로 기록', () => {
  assert.match(server, /const e = new Error\('CORS 차단: 허용되지 않은 출처'\);\n\s*e\.status = 403;\n\s*cb\(e\);/);
  assert.match(server, /logger\[status >= 500 \? 'error' : 'warn'\]\(/);
  assert.match(server, /status >= 500 \? '서버 오류가 발생했습니다\.' : '요청을 처리할 수 없어요\.'/);
});
