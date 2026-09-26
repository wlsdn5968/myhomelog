# 116b — 모바일 하단 탭 "도구" 바텀시트 (시안 "내집로그 모바일 탭 리디자인" 구현)

**작성 기준 커밋**: `ac3848e` (2026-09-26) · 부모: `plans/116` ② · `plans/114` P5 · **시안**: claude.ai/design 프로젝트 "내집로그 모바일 탭 리디자인"(4화면: 1a 탭 · 1b 시트 열림(대출 활성) · 1c 다크 · 1d 드로어 대안)
**게이트**: 운영자 룰 "시안 → 검토 → 구현". **운영자가 시안(특히 1b 바텀시트 vs 1d 드로어 대안 중 선택)을 검토하고 "진행" 하기 전에는 실행자를 붙이지 않는다.**

## 전제 확인 (계획자 실측 — 2026-09-26)
- 모바일 하단 탭 마크업: `frontend/index.html:3076` `<nav class="bnav" id="bnav">` 안 `.bnav-item` 5개 — `sv('news')`·`sv('map')`(기본 on)·`sv('list')`·`sv('report')`(`bnav-feature`)·**`sv('calc')`**(5번째, `aria-label="대출 한도 계산"`). 탭 높이 53px·터치 타깃 양호(07-19 실측).
- 데스크톱 "도구 ▾" 드롭다운 항목: 특약(`sv('clause')`)·청약(`sv('subs')`)·대출계산(`sv('calc')`)·규제 요약(`openRegSummary()`, 모달). 순서는 이 4개.
- `.htabs`(데스크톱 탭)는 ≤700px 에서 숨김 → 모바일에서 특약·청약·규제 요약에 닿는 탭이 없다(실측).
- 시안 확정 사양: 5번째 탭 라벨 "도구"(아이콘 스패너 또는 그리드 — Tweaks 로 선택 가능) · 탭하면 **탭바 바로 위**에 바텀시트(높이 ≈316px, 딤은 탭바 제외) · 항목 4개(아이콘+제목+한 줄 설명+→): `특약 초안 — 조건 반영 표준 특약 템플릿` · `청약 캘린더 — 청약Home 일정 + 가점 계산기` · `대출 계산 — LTV·DSR·정책자금 4종` · `규제 요약 — 금융위 고시 기준` · 드래그 핸들·`닫기` · 현재 뷰가 도구 중 하나면 "도구" 탭 활성 + 해당 항목 체크 · 다크 활성색 `#8DB3E2`(딥네이비는 다크 대비 부족) · 보고서 탭 강조색은 **기존 `bnav-feature` 스타일 그대로**(시안은 값을 몰라 네이비 알약으로 표현했을 뿐).
- 기존 모달/시트 관례: ESC 닫기(Plan 096 이 4곳에 적용) · 백드롭 클릭 닫기 · `aria-modal`.

## 범위
**건드릴 파일**: `frontend/index.html`(bnav 5번째 버튼 1개 + 시트 마크업/CSS/JS 블록 1개 + `sv()` 의 활성 탭 판정 보강) · `backend/test/mobile-tools-sheet.test.js`(신규 — 소스 정적 단언)
**건드리지 말 것**: 다른 탭 4개·탭 높이·헤더·햄버거 드로어(대안 1d 를 운영자가 고르면 그때 별도) · 각 도구 뷰 내부 · 데스크톱 `.htabs`/드롭다운

## Step 1 — 5번째 탭
`sv('calc',this)` 버튼을 `onclick="toggleToolsSheet(this)" data-view="tools" aria-label="도구" aria-haspopup="dialog" aria-expanded="false"` 로. 아이콘은 인라인 SVG(스패너; 기존 아이콘과 같은 24px stroke 스타일). 라벨 텍스트 "도구".

## Step 2 — 시트
- 마크업: `<div id="toolsSheet" role="dialog" aria-modal="true" aria-label="도구" hidden>` — 핸들·항목 4개(`<button>`; 순서 고정)·`닫기`. 각 항목 `onclick`: `closeToolsSheet(); sv('clause'|'subs'|'calc', bnavBtn)` / 규제 요약은 `closeToolsSheet(); openRegSummary()`.
- CSS: `position:fixed; left:0; right:0; bottom:var(--bnav-h, 53px)`(탭바 위) · 배경 카드색 · 상단 라운드 16px · 딤은 `#toolsSheetDim` 로 탭바 **제외** 영역만(시안 사양) · 열림/닫힘 transition 200ms · `prefers-reduced-motion` 존중 · 다크: 활성/체크 색 `#8DB3E2`.
- JS: `toggleToolsSheet(btn)`, `closeToolsSheet()`; ESC·딤 클릭·다른 탭 클릭 시 닫힘(`sv()` 진입부에서 `closeToolsSheet()` 1줄) · `aria-expanded` 동기화 · 포커스는 열릴 때 첫 항목, 닫힐 때 "도구" 탭으로.
- 활성 상태: `sv()` 가 활성 탭을 정할 때 `view ∈ {clause, subs, calc}` 이면 "도구" 탭에 `on` 을 주고, 시트 안 해당 항목에 체크 아이콘(`aria-current="true"`). 규제 요약은 모달이라 활성 표시 없음.
- **데스크톱(>700px)에서는 아무 변화 없음** — 시트·탭은 모바일 미디어쿼리 안에서만 렌더/동작(`.bnav` 가 이미 그 안에 있다).

## Step 3 — 테스트 (`backend/test/mobile-tools-sheet.test.js`, 소스 정적 단언)
① `.bnav` 안에 `data-view="calc"` 버튼이 **0회**, `data-view="tools"` 1회, `.bnav-item` 은 여전히 **5개** ② `id="toolsSheet"` 안 버튼 4개가 **이 순서**로 `sv('clause'`·`sv('subs'`·`sv('calc'`·`openRegSummary(` 를 부른다 ③ `role="dialog"`·`aria-modal`·ESC 처리(`Escape`) 문자열이 시트 블록 안에 있다 ④ 다크 활성색 `#8DB3E2` 가 미디어쿼리 다크 블록 안에 1회.

## 완료 기준
`npm run verify` 기준선 + 4 / fail 0. 배포 후 모바일 375 실측: 하단 5번째 탭이 "도구" · 탭하면 시트 4항목 · "대출 계산" 선택 시 대출 뷰로 이동하고 "도구" 탭 활성 · ESC/딤/다른 탭으로 닫힘 · 데스크톱 1280 은 변화 0(스크린샷 비교).

## STOP 조건
- `sv()` 의 활성 탭 로직이 `data-view` 와 다른 방식이면(예: 인덱스 기반) 추측하지 말고 소스에서 읽어 맞추고, 못 맞추면 멈춰라(ui-first-impression 메모리: 과거 탭 재편 때 "sv() 인덱스 활성로직 무변경" 을 지킨 이유가 있다).
- 드로어 대안(1d)을 운영자가 고르면 이 계획은 **실행하지 않고** 116b-alt 를 새로 쓴다.
