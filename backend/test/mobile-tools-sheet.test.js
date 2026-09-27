/**
 * backend/test/mobile-tools-sheet.test.js
 *
 * TOOLS-SHEET-2026-09-27 (Plan 116b): 모바일 하단 5번째 탭 "대출" → "도구" 바텀시트 전환.
 * 소스 정적 단언 4종(계획서 Step 3) — frontend/index.html 은 백엔드 없이 단일 파일로 동작하므로
 * 이 저장소의 기존 관례(frontend-contracts.test.js)를 따라 fs.readFileSync 로 직접 읽어 검사한다.
 *
 * ⚠ ③번은 계획서 문구("ESC 처리(Escape) 문자열이 시트 블록 안에 있다")를 그대로 따르지 않는다.
 *   실제 소스를 읽어보면 이 코드베이스의 ESC 처리는 컴포넌트마다 개별 'Escape' 리스너를 두지 않고,
 *   전역 keydown 리스너 하나가 `closers` 배열(id·fn 쌍)을 순회하는 공유 레지스트리 패턴이다
 *   (STAB-A P1#34, Plan 096). #toolsSheet 블록 자체에는 'Escape' 문자열이 없는 것이 정상이므로,
 *   실제 동작 방식대로 "toolsSheet 가 그 closers 레지스트리에 등록돼 있는지"를 검사한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

// ── ① .bnav 안 5번째 탭 교체 — "대출"(calc) 이 "도구"(tools) 로, 탭 개수는 그대로 5개 ──────────
test('모바일 하단 탭 — .bnav 안에서 "대출"(data-view=calc) 이 "도구"(data-view=tools) 로 교체됐다 (Plan 116b)', () => {
  const m = html.match(/<nav class="bnav" id="bnav">[\s\S]*?<\/nav>/);
  assert.ok(m, 'frontend/index.html 에서 <nav class="bnav" id="bnav"> 블록을 찾지 못했다 — 마크업이 바뀌었으면 이 테스트도 갱신할 것');
  const bnav = m[0];

  assert.equal((bnav.match(/data-view="calc"/g) || []).length, 0,
    '.bnav 안에 옛 data-view="calc" 버튼이 남아 있다 — "대출" 탭이 "도구" 로 교체되지 않았다');
  assert.equal((bnav.match(/data-view="tools"/g) || []).length, 1,
    '.bnav 안에 data-view="tools" 버튼이 정확히 1개 있어야 한다');
  assert.equal((bnav.match(/class="bnav-item/g) || []).length, 5,
    '.bnav-item 탭 개수(5개: 브리핑·지도·목록·보고서·도구)가 바뀌었다 — 다른 탭을 건드리면 안 된다');

  // 새 탭의 진입점 계약 — sv() 직행이 아니라 시트를 여는 dialog 트리거
  assert.match(bnav, /id="bnavToolsBtn"/, '도구 탭 버튼에 id="bnavToolsBtn" 이 없다(JS 가 참조하는 앵커)');
  assert.match(bnav, /onclick="toggleToolsSheet\(this\)"/, '도구 탭이 toggleToolsSheet() 를 호출하지 않는다');
  assert.match(bnav, /aria-label="도구"/, '도구 탭의 aria-label 이 "도구" 가 아니다');
  assert.match(bnav, /aria-haspopup="dialog"/, '도구 탭에 aria-haspopup="dialog" 가 없다');
  assert.match(bnav, /aria-expanded="false"/, '도구 탭의 초기 aria-expanded 가 "false" 가 아니다');
  assert.match(bnav, />도구</, '도구 탭의 라벨 텍스트가 "도구" 가 아니다');
});

// ── ② 시트 안 4항목이 데스크톱 드롭다운(htabToolDd)과 같은 순서로 이동한다 ──────────────────
test('도구 바텀시트 — 항목 4개가 데스크톱 "도구 ▾" 드롭다운과 같은 순서다 (특약→청약→대출계산→규제 요약, Plan 116b)', () => {
  const m = html.match(/<div class="tsheet" id="toolsSheet"[\s\S]*?class="ts-close"[\s\S]*?<\/div>/);
  assert.ok(m, 'frontend/index.html 에서 #toolsSheet 블록을 찾지 못했다');
  const sheet = m[0];

  // 다이얼로그 계약 — 초기 hidden, role/aria-modal/aria-label
  assert.match(sheet, /id="toolsSheet" role="dialog" aria-modal="true" aria-label="도구" hidden/,
    '#toolsSheet 에 role=dialog·aria-modal·aria-label·초기 hidden 계약이 없다');

  const itemOnclicks = [...sheet.matchAll(/<button[^>]*onclick="([^"]*)"/g)]
    .map((x) => x[1])
    .filter((s) => s.includes("sv(") || s.includes('openRegSummary('));
  assert.equal(itemOnclicks.length, 4, `시트 안 이동 항목이 4개가 아니라 ${itemOnclicks.length}개다`);

  assert.ok(itemOnclicks[0].includes("sv('clause'"), `1번째 항목이 특약(sv('clause')) 이 아니다: ${itemOnclicks[0]}`);
  assert.ok(itemOnclicks[1].includes("sv('subs'"), `2번째 항목이 청약(sv('subs')) 이 아니다: ${itemOnclicks[1]}`);
  assert.ok(itemOnclicks[2].includes("sv('calc'"), `3번째 항목이 대출 계산(sv('calc')) 이 아니다: ${itemOnclicks[2]}`);
  assert.ok(itemOnclicks[3].includes('openRegSummary('), `4번째 항목이 규제 요약(openRegSummary()) 이 아니다: ${itemOnclicks[3]}`);

  // 운영자 사양: "각 항목 클릭 = closeToolsSheet() 후 이동" — 4항목 전부 closeToolsSheet() 로 시작
  itemOnclicks.forEach((s, i) => {
    assert.match(s, /^closeToolsSheet\(\);/, `${i + 1}번째 항목이 closeToolsSheet() 로 먼저 닫지 않는다: ${s}`);
  });

  // 활성 판정에 쓰이는 data-tool 은 뷰가 있는 3항목에만(규제 요약은 모달이라 활성 표시 없음)
  assert.equal((sheet.match(/data-tool="clause"/g) || []).length, 1);
  assert.equal((sheet.match(/data-tool="subs"/g) || []).length, 1);
  assert.equal((sheet.match(/data-tool="calc"/g) || []).length, 1);

  // 닫기 버튼 1개
  assert.equal((sheet.match(/class="ts-close"/g) || []).length, 1, '닫기 버튼이 없거나 1개가 아니다');
});

// ── ③ ESC 로 닫힌다 — 이 저장소의 실제 메커니즘(공유 closers 레지스트리)에 등록됐는지 확인 ─────
test('도구 바텀시트 — ESC 로 닫힌다(공유 closers 레지스트리에 등록, STAB-A P1#34 / Plan 096 패턴)', () => {
  const m = html.match(/document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape'\) return;[\s\S]*?\];/);
  assert.ok(m, "ESC 전역 키다운 리스너(closers 배열)를 찾지 못했다 — 이 코드베이스의 ESC 처리 방식이 바뀌었으면 이 테스트도 갱신할 것");
  const closersBlock = m[0];
  assert.match(closersBlock, /\{\s*id:\s*'toolsSheet',\s*fn:\s*'closeToolsSheet'\s*\}/,
    "closers 레지스트리에 { id: 'toolsSheet', fn: 'closeToolsSheet' } 항목이 없다 — ESC 로 시트가 닫히지 않는다");

  // 레지스트리가 실제로 closeToolsSheet 를 호출하는 판정 로직(열림 판정: classList.contains('open'))도 존재해야 한다
  assert.match(html, /if \(el && \(present \|\| el\.classList\.contains\('open'\)\)\) \{/,
    'closers 순회부의 열림 판정(open 클래스) 로직을 찾지 못했다 — closeToolsSheet 가 호출될 조건이 바뀌었다');

  // 딤 클릭으로도 닫힌다(시트 사양의 또 다른 닫힘 경로) — #toolsSheetDim 의 onclick
  assert.match(html, /id="toolsSheetDim" onclick="closeToolsSheet\(\)"/,
    '딤(#toolsSheetDim) 클릭이 closeToolsSheet() 를 호출하지 않는다');
});

// ── ④ 다크 활성색 #8DB3E2 — 파일 전체에 정확히 1회(변수 하나로 재사용), 모바일 다크 블록 안 ─────
test('도구 탭·시트 체크 표시 — 다크 모드 활성색 #8DB3E2 가 정확히 1회 정의되고 두 곳(탭·체크)에서 재사용된다 (Plan 116b)', () => {
  // ⚠ 계획서 문구는 "미디어쿼리 다크 블록"이지만, 이 코드베이스의 실제 다크 모드는
  //   @media(prefers-color-scheme) 가 아니라 html[data-theme="dark"] 속성 선택자다(파일 상단
  //   :root 블록·다른 컴포넌트 오버라이드 전부 이 패턴 — 소스 확인 완료). 그 실제 패턴을 검사한다.
  const hexMatches = html.match(/#8DB3E2/g) || [];
  assert.equal(hexMatches.length, 1,
    `#8DB3E2 리터럴이 파일에 ${hexMatches.length}회 등장한다 — CSS 변수(--ts-active)로 한 번만 정의하고 재사용해야 중복 실수를 막는다`);

  // .bnav 시트 CSS 가 있는 모바일 @media(max-width:700px) 블록 근처(.bnav{display:block} 바로 뒤)에서
  // html[data-theme="dark"] 속성 선택자로 정의됐는지 — 라이트/전역에 새면 라이트 대비가 깨진다.
  const anchor = html.indexOf('.bnav{display:block}');
  assert.ok(anchor >= 0, '.bnav{display:block} (모바일 전용 미디어쿼리 앵커) 를 찾지 못했다');
  const nearby = html.slice(anchor, anchor + 2000);
  assert.match(nearby, /html\[data-theme="dark"\]\{--ts-active:#8DB3E2\}/,
    '--ts-active:#8DB3E2 정의가 .bnav 모바일 미디어쿼리 블록 근처(다크 전용 속성 선택자) 안에 없다');

  // 정의된 변수가 실제로 "도구" 탭 활성색과 시트 체크 표시 색, 두 곳 모두에서 쓰인다
  assert.match(html, /#bnavToolsBtn\.on\{color:var\(--ts-active,var\(--acc\)\)\}/,
    '"도구" 탭의 .on 색이 --ts-active(다크 #8DB3E2 · 라이트는 기존 --acc 폴백) 를 쓰지 않는다');
  assert.match(html, /\.ts-check\{display:none;color:var\(--ts-active,var\(--acc\)\)/,
    '시트 체크 표시 색이 --ts-active(다크 #8DB3E2 · 라이트는 기존 --acc 폴백) 를 쓰지 않는다');
});
