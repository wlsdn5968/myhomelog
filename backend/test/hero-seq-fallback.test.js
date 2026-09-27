/**
 * backend/test/hero-seq-fallback.test.js
 *
 * Plan 116a 보완 — 랜딩 히어로 실거래 카드(Plan 116a)가 프로덕션에서 "실거래 흐름을
 * 불러오지 못했어요" 로 뜨는 문제. 원인: 인기 목록(/api/search/popular)은 하루 1회
 * 스냅샷(popular_apts_snapshot)에서 나오는데, 116a 배포 직후의 어제 스냅샷엔 aptSeq 키가
 * 없었다(실측). 데이터 자체는 있고(검색 API·/transactions/history 정상) seq 를 잇는
 * 고리 하나만 빠져 있었다 — _loadHeroChart 에 이름→seq 검색 폴백을 추가했다.
 *
 * Plan 116b 보완 — 같은 커밋에 모바일(375×812) 리뷰어 실측 1건 더: "도구" 바텀시트가 열려
 * 있을 때 우하단 FAB(⭐ 관심단지 #fabBM, 💬 데이터 도우미 #fabAI)의 z-index(850)가 시트
 * (511)보다 높아 "규제 요약" 행 화살표를 가렸다. toggleToolsSheet/closeToolsSheet 가
 * body.tools-sheet-open 클래스를 여닫고, 모바일 미디어쿼리에서 그 클래스일 때 두 FAB 를
 * visibility:hidden 처리한다.
 *
 * 렌더 실행 환경이 없는 index.html 이라 hero-real-data-card.test.js 와 같은 방식으로
 * **소스 정적 단언**만 한다(기존 테스트는 수정하지 않는다).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '../../frontend/index.html');

function readIndexHtml() {
  return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

// _loadHeroChart 함수 본문만 추출 (hero-real-data-card.test.js 와 동일한 경계 탐색 방식).
function extractLoadHeroChartBody(html) {
  const fnStart = html.indexOf('async function _loadHeroChart(');
  assert.ok(fnStart >= 0, '_loadHeroChart 함수를 못 찾았다 — 함수명이 바뀌었으면 이 테스트도 갱신할 것');
  const fnEnd = html.indexOf('\nasync function ', fnStart + 1);
  const fnEndAlt = html.indexOf('\nfunction ', fnStart + 1);
  const boundary = [fnEnd, fnEndAlt].filter(i => i > fnStart).sort((a, b) => a - b)[0];
  assert.ok(boundary > fnStart, '_loadHeroChart 다음 함수 경계를 못 찾았다 — 구간 추출이 틀렸을 수 있다');
  return html.slice(fnStart, boundary);
}

// ① _loadHeroChart 본문 안에 이름→seq 검색 폴백 호출(/search/apt?q=)이 있다 — 기존 자동완성이
//   쓰는 것과 같은 엔드포인트로 스냅샷에 aptSeq 가 없을 때도 seq 를 해결할 수 있어야 한다.
test('HERO-SEQ-FALLBACK — _loadHeroChart 본문이 /search/apt?q= 를 호출한다', () => {
  const html = readIndexHtml();
  const fnBody = extractLoadHeroChartBody(html);
  assert.ok(fnBody.includes('/search/apt?q='),
    '_loadHeroChart 가 /search/apt?q= 를 호출하지 않는다 — aptSeq 결손 시 이름→seq 폴백이 빠졌다');
});

// ② 그 폴백은 aptSeq 가 없을 때만 타야 한다 — aptSeq 가 이미 있는 정상 경로에서 불필요한
//   왕복이 매번 추가되면 안 된다(회귀). 조건에 `!top.aptSeq` (또는 동등 표현)가 있어야 한다.
test('HERO-SEQ-FALLBACK — 폴백 호출이 aptSeq 결손(!top.aptSeq) 조건으로만 게이팅된다', () => {
  const html = readIndexHtml();
  const fnBody = extractLoadHeroChartBody(html);
  const searchIdx = fnBody.indexOf('/search/apt?q=');
  assert.ok(searchIdx >= 0, '/search/apt?q= 호출을 못 찾았다 — 위 테스트가 먼저 실패했을 것');
  // 폴백 호출 바로 앞 구간(중첩 try/템플릿 리터럴 중괄호 때문에 브레이스 매칭 대신 근접 창으로 확인)에
  // if 조건문과 aptSeq 결손 표현이 함께 있어야 한다 — 무조건 호출이거나 다른 조건이면 안 된다.
  const windowStart = Math.max(0, searchIdx - 400);
  const before = fnBody.slice(windowStart, searchIdx);
  assert.ok(/if\s*\(/.test(before),
    '/search/apt?q= 호출 앞 근처에서 if 조건문을 찾지 못했다 — 무조건 호출일 수 있다');
  const isGatedByMissingSeq = /!\s*top\.aptSeq/.test(before) ||
    /top\.aptSeq\s*(==|===)\s*(null|undefined|false|0|'')/.test(before);
  assert.ok(isGatedByMissingSeq,
    `/search/apt?q= 호출 앞 조건에 aptSeq 결손 게이트(!top.aptSeq 또는 동등 표현)가 안 보인다: "${before.trim()}"`);
});

// ③ (Plan 116b 보완) "도구" 시트가 열려 있는 동안 우하단 FAB 가 시트를 가리지 않아야 한다 —
//   toggleToolsSheet/closeToolsSheet 가 body.tools-sheet-open 을 여닫고, 모바일 CSS 가 그
//   클래스일 때 두 FAB(.fab-ai, .fab-bm)를 실제로 숨겨야 한다. 함수 본문과 CSS 양쪽 모두에서
//   'tools-sheet-open' 문자열이 등장해야 한다(한쪽만 있으면 토글은 되는데 숨김이 없거나, 그 반대).
test('TOOLS-SHEET-FAB — tools-sheet-open 클래스가 toggleToolsSheet/closeToolsSheet 본문과 CSS 양쪽에 있다', () => {
  const html = readIndexHtml();
  const toggleStart = html.indexOf('function toggleToolsSheet(');
  assert.ok(toggleStart >= 0, 'toggleToolsSheet 함수를 못 찾았다');
  const closeStart = html.indexOf('function closeToolsSheet(', toggleStart);
  assert.ok(closeStart > toggleStart, 'closeToolsSheet 함수를 못 찾았다');
  // closeToolsSheet 다음 함수 경계까지를 두 함수의 합친 본문으로 본다.
  const afterCloseFnEnd = html.indexOf('\nfunction ', closeStart + 1);
  assert.ok(afterCloseFnEnd > closeStart, 'closeToolsSheet 다음 함수 경계를 못 찾았다');
  const combinedBody = html.slice(toggleStart, afterCloseFnEnd);
  assert.ok(combinedBody.includes('tools-sheet-open'),
    'toggleToolsSheet/closeToolsSheet 본문에 tools-sheet-open 클래스 토글이 없다 — FAB 를 숨길 신호가 안 나간다');

  // CSS 쪽: 모바일 전용 규칙으로 두 FAB(.fab-ai, .fab-bm)를 실제로 숨겨야 한다.
  const cssRuleMatch = html.match(/body\.tools-sheet-open[^{]*\{[^}]*\}/);
  assert.ok(cssRuleMatch, 'body.tools-sheet-open 를 셀렉터로 쓰는 CSS 규칙을 못 찾았다');
  assert.ok(/\.fab-ai/.test(cssRuleMatch[0]) && /\.fab-bm/.test(cssRuleMatch[0]),
    `body.tools-sheet-open CSS 규칙이 .fab-ai/.fab-bm 를 모두 다루지 않는다: "${cssRuleMatch[0]}"`);
  assert.ok(/visibility\s*:\s*hidden/.test(cssRuleMatch[0]),
    'body.tools-sheet-open CSS 규칙이 visibility:hidden 을 쓰지 않는다 — display:none 은 레이아웃/기존 노출 로직과 충돌할 수 있다');
});
