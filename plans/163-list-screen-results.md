# Plan 163: 목록 화면 결과 영역을 시안 화면 D 대로 바꾼다 (결과 한 곳·점수 표시·면책 한 줄)

> **Drift check (먼저)**: `git diff --stat 89accb1..HEAD -- frontend/index.html` — 출력이 있으면 Current state 와 대조, 다르면 STOP.

## Status
Priority P1 · Effort M–L · Risk MED · Depends 156(시안, 운영자 "권고대로" 승인 2026-10-18) · Category ui · Planned at `89accb1`, 2026-10-18

## Why this matters
목록 화면(`sv('list')`)은 같은 결과를 사이드바(`#pList`)와 본문(`#view-list`)에 두 번 그리고, 결과 위에 큰 빨간 면책 상자를 두며, 카드 위쪽 배지 "거래활발·거래보통·거래적음"이 **실제 거래량이 아니라 점수(75·50 기준)** 로 정해져 서버 꼬리표 "거래활발"(실제 거래 50건 이상)과 같은 이름·다른 뜻이다. 시안 D(Claude Design 프로젝트 `p/f486f1ca-…`, 파일 `내집로그 리디자인 v2.dc.html` "화면 D")는 결과를 본문 한 곳에, 점수는 숫자+막대 한 가지로, 실제 거래량은 "6개월 평균 · 표본 N건"으로, 면책은 한 줄로 바꿨다. 이 계획은 **결과 영역(데스크톱·모바일)** 만 바꾼다.

## 범위 결정(운영자 권고 승인)
- 넣는다: 결과 머리·도구 줄·점수 안내 줄·새 카드(데스크톱 5열/모바일 세로)·검색 전/검색 중/0건 문구·결과 중복 제거(데스크톱 사이드바 결과 구역 숨김)·면책 한 줄.
- **넣지 않는다(시안에 없거나 결정 필요)**: "점수 기준 보기" 버튼·"예산 밖 단지도 보기"·0건 보조 버튼 3개·15건 넘게 이어 보기·사이드바 전면 개편(희망 지역 선택 창이 시안에 없음)·모바일 조건 시트 신규(기존 ☰ 드로어를 그대로 연다)·진행률 막대(실제 진행률 데이터가 없어 지어내지 않는다).

## Current state
- `frontend/index.html` 단일 파일 SPA. 결과 데이터 전역 `props`(검색 응답 배열), `searchMeta`(`regions`·`totalAptsInRegion`·`inBudget`·`totalTx`).
- `renderListGrid()` (`:7426-7539`) — `#view-list` 를 그린다. 빈 상태(`!props.length`)·metaLine(분석 지역·전체 단지·예산 매치·분석 단지 수)·`_regionEntry`(구별 "시장 요약" 버튼 최대 3, `openRegionSummary(code,name)`, 판정은 `p.lawdCd`)·빨간 면책 상자·정렬 `<select id="lstSort" onchange="renderListGrid()">`(score/priceAsc/priceDesc/newBuild/oldBuild)·필터 버튼 `#lstFltAll/#lstFltReg/#lstFltNon`(`setLstFilter`)·"총 N건"·카드(`_renderListCard`)·필터 뒤 0건 문구("분석은 됐지만 표시할 단지가 없어요")·예외 문구. 정렬·필터 로직(`_sortMap`, `window._lstFlt`, `_isRegProp`, `_curSortSel` 재선택)은 **그대로 재사용**한다.
- `setLstFilter(f, btn)` (`:7542-7558`) — 비활성 배경을 `#fff` 로 하드코딩(다크 모드 결함).
- `_renderListCard(p, i)` (`:7561-7589`) — 비교 체크박스(`.cmp-chk`, `toggleCmp(i,checked)`, `cmpSel.has(i)`), 상단 배경 `_isRegProp` 색, 이름 `p.displayName || _dispAptName(p.aptName,p.umdNm)`, `_fmtSgg(p.area) | buildYear년`, `gSVG(score,50)`, `avgPrice.toFixed(2)억`, 배지(점수 기준 거래활발…), `LTV ${p.ltv||_regLtvLabel(...)}`·`최대 ${p.maxLoan}`, 꼬리표 `_renderPTags(p.tags,3)`, `p.pros` 62자, `currentPriceByPyeong` 앞 3개 `"${pyeong}평 ${recentAvg}억"`. 카드 클릭 `showDetail(props[i])`.
- 표본 수 필드: `p.priceSampleN`(평균가의 표본 건수). 없으면 표본 줄을 생략(지어내지 않는다).
- 로딩 카드: `doSearch()` 안 `const _lg=document.getElementById('view-list'); if(_lg) _lg.innerHTML=...`(문구 "실거래로 단지를 정리하는 중이에요"·"…보통 5~15초 걸려요").
- 사이드바 결과 구역 `#s3`("조건 맞는 단지", 안에 `#pList`·`#pCnt`·`#fltTrust`) — `sv()` 가 보고서 화면에서만 `display:none !important` 인라인, 그 외 `removeProperty('display')`(`:12265-12268`). **노드는 지우지 않는다**(doSearch·renderPList 가 널 가드 없이 읽는다 — `backend/test/home-panel.test.js:166` 가 id 존재를 고정).
- 모달 키보드 가두기 `MODAL_SEL` (`:12807`) 에 모바일 도구 시트 `#toolsSheet`(`:3443`, `role="dialog" aria-modal="true"`, `hidden` 속성으로 숨김)가 없다.
- v2 토큰 ↔ 앱 변수: sf=`--bg-base`, sf2=`--bg-elev-1`, line=`--bd`, line2=`--bd2`, ink=`--t1`, ink2=`--t2`, ink3=`--t3`, pri(글자·막대)=`--acc`, pri 배경=`--acc-bg`, onpri=`--acc-ink`, prit=`--accent-tint`. 다크는 이 변수들이 이미 바뀐다 — **hex 직접 지정 금지**(시안의 주택 보유 버튼 hex 도 토큰으로).
- 문구 규칙: 해요체, 문장 속 화살표·줄표 나열 금지, 내부 용어 금지. 고친 곳 위 `// LIST-D-2026-10-18 (Plan 163): 이유` 한국어 주석.
- 고정 테스트: `backend/test/recommend.test.js:864`("분석 지역 안내 — 광역 검색은 … '전체 N개 시군구'") — `_regionLabel` 동작을 유지하면 그대로 통과해야 한다. `backend/test/home-panel.test.js:131`(`renderListGrid()` 와 `sv('list')` 문자열), `:166`(사이드바 id 목록).

## 시안 D 결과 영역 값 (데스크톱 1440, 단위 px, 글자 크기/굵기)
- 결과 영역 여백 위 28·좌우 32·아래 32, 묶음 간격 16.
- **머리**(양 끝 정렬, 아래 맞춤, 간격 24). 왼쪽(간격 6): "분석 지역 {지역}" 14 ink3 / "예산 안에 드는 단지 {searchMeta.inBudget}건" 28/700 자간 -0.02em / "전체 단지 {searchMeta.totalAptsInRegion}개 중이에요" 14 ink2. 오른쪽: 구별 텍스트 버튼 "{구} 시장 요약"(기존 `_regionEntry` 규칙·최대 3) 높이 36·좌우 6·14/600 pri.
  - `searchMeta` 가 없거나 값이 없으면 해당 줄을 생략(0 으로 지어내지 않는다). 광역 안내("{광역} 전체 N개 시군구를 분석했어요…")는 기존 문구를 머리 왼쪽 맨 아래 12/500 ink3 로 유지.
- **도구 줄**(위아래 여백 12, 위·아래 1px line, 간격 8): 칩 "전체"(선택: 테두리 pri·배경 prit·글자 pri) · 보조 "규제지역" · 보조 "비규제"(보조: 1px line2·배경 sf·글자 ink), 높이 36·좌우 14·모서리 8·14/600 / 빈 공간 / "총 {N}건" 14 ink3 / 정렬 `<select id="lstSort">` 를 보조 버튼 모양(높이 36·좌우 12·모서리 8·1px line2·14/600)으로.
- **점수 안내 줄**(간격 8): info 아이콘 18 ink3 + "점수는 과거 실거래 통계로 0부터 100까지 매긴 값이에요. 가격이 오를지 내릴지를 뜻하지 않아요." 14 ink2.
- **카드 목록**: 카드 사이 10. 데스크톱 카드 = 배경 sf·1px line·모서리 8·여백 20·24, 5열 그리드 `minmax(0,1.3fr) 150px minmax(0,1.1fr) 150px 132px`, 열 간격 24, 세로 가운데.
  1. 단지(간격 6): 이름 16/600 ink / "{구·동} · {건축년도}년" 14 ink3 / 한 줄 설명(`p.pros`, 2줄 넘으면 말줄임) 14 ink2 줄간격 1.5 / 꼬리표 줄(간격 6) — 꼬리표 높이 24·좌우 8·모서리 4·배경 sf2·12/500 ink2·테두리 없음·최대 3(`p.tags` 문자열/객체 둘 다 지원 — 객체면 `.t`).
  2. 평균가(간격 4): "6개월 평균" 12/500 ink3 / "{avgPrice}억" 20/700 ink / "표본 {priceSampleN}건" 12/500 ink3(필드 없으면 생략).
  3. 평형: 3칸 그리드(칸 사이·바깥 1px line, 모서리 6, 칸 여백 8·10, 간격 2) — 각 칸 "{pyeong}평" 12/500 ink3 위, "{recentAvg}억" 14/600 ink 아래. 3개보다 적으면 빈 칸은 둘 다 "—".
  4. 대출·점수(간격 4): "LTV {ltv}" 12/500 ink3 / "최대 대출 {maxLoan}" 14/600 ink(없으면 생략) / 점수 줄(위 여백 6, 간격 8): "점수" 12/500 ink3 · 숫자 14/700 ink · 막대(남는 폭, 높이 4·모서리 2·바탕 sf2·채움 pri, 채움 폭 = 점수%). 점수 없으면 숫자 자리에 "분석 대기", 막대 없음.
  5. 비교(오른쪽 정렬): 보조 버튼 "비교 담기"(높이 36·좌우 12·14/600, 줄바꿈 없음). 담긴 상태는 `aria-pressed="true"` + 칩 모양(테두리 pri·배경 prit·글자 pri) + 글자 "담았어요". **카드 클릭과 분리**: 버튼은 `event.stopPropagation()` 후 `toggleCmp(i, !cmpSel.has(i))` 를 부르고 다시 그린다. 기존 `.cmp-chk-input` 체크박스는 없앤다(아래 Step 4 확인 사항).
- **면책 한 줄**(카드 목록 아래, 여백 위 8): "매수·매도 추천이 아니에요. 출처 국토교통부 실거래가" 12/500 ink3.
- **모바일(≤700px)**: 결과 영역 여백 12·16. 맨 위 **조건 요약 줄**(최소 높이 56·여백 8·12·1px line2·모서리 8·배경 sf, 누르면 기존 `toggleDrawer()`): 첫 줄 "{주택 보유} · {매수 예정가}억 · 자기 자본 {자기 자본}억" 14/600 ink(값은 `#ch-h .chip.on` 텍스트·`#bp`·`#mc` 의 실제 값, 비어 있으면 그 항목 생략), 둘째 줄 "{희망 지역}" 12/500 ink3(`#ch-r .chip.on` 과 `#ch-r-sub .chip.on` 텍스트), 오른쪽 "조건" 14/600 pri. 그 아래 도구 줄은 가로 스크롤(간격 6, 정렬 → 칩 → 보조 순). 머리 큰 제목은 "예산 안에 드는 단지 {N}건" 14 ink2 한 줄로. 카드 = 여백 14·16·간격 10·배경 sf·1px line·모서리 8, 위에서 아래로: [이름 16/600 · "{구·동} · {연도}년" 12/500 ink3 | 오른쪽 비교 아이콘 버튼 44×44 `aria-label="비교 담기"`] / 평균가 줄(기준선 맞춤, 간격 8): "{avg}억" 20/700 · "6개월 평균 · 표본 N건" 12/500 ink3 / 대출·점수 줄(12/500 ink3): "LTV {ltv} · 최대 대출 {maxLoan}" · 빈 공간 · "점수" · 숫자 14/700 ink · 막대 폭 48. 모바일 카드에는 평형·꼬리표·한 줄 설명을 넣지 않는다(시안대로). 면책 한 줄은 "매수·매도 추천이 아니에요. 점수는 과거 실거래 통계예요".
- **검색 전**(가운데 정렬, 여백 32, 간격 12): list 아이콘 24 ink3 / 데스크톱 "왼쪽에서 조건을 넣고 단지 찾기를 눌러 주세요", 모바일 "메뉴에서 조건을 넣고 단지 찾기를 눌러 주세요" 20/700 / "주택 보유, 매수 예정가, 자기 자본, 희망 지역을 넣으면 예산 안에 드는 단지를 실거래가와 함께 정리해 드려요." 14 ink2 최대 폭 480 줄간격 1.6 / "매수·매도 추천이 아니에요" 12/500 ink3 위 여백 12.
- **검색 중**(여백 28·32, 간격 16): "실거래를 모아 단지를 고르고 있어요" 20/700 / "보통 5초에서 15초 걸려요. 창을 닫지 않아도 돼요." 14 ink2 / 빈 카드 3장(높이 72·좌우 24·배경 sf·1px line·모서리 8, 안에 sf2 회색 막대 모서리 4). 진행률 막대·단계 줄은 **넣지 않는다**(실제 진행률 데이터 없음).
- **0건**(필터 뒤 카드가 하나도 없을 때, 여백 28·32, 간격 16): "조건에 맞는 단지가 없어요" 28/700 자간 -0.02em / 안내 상자(여백 24·배경 sf·1px line·모서리 8): "조건을 하나씩 풀어 보면 결과가 생길 수 있어요" 16/600, 그 아래 기존 문구 "예산과 지역 조건에 맞는 단지가 부족해요. 매수가를 조금 늘리거나 가까운 구도 함께 골라 보세요." 14 ink2 / "매수·매도 추천이 아니에요" 12/500 ink3.

## Commands
관련: `node --test backend/test/home-panel.test.js backend/test/recommend.test.js backend/test/frontend-contracts.test.js` → `ℹ fail 0`. 전체: `npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Scope
In scope: `frontend/index.html`(`renderListGrid`·`setLstFilter`·`_renderListCard`·`doSearch` 의 로딩 카드 블록·`.lgv`/`.lcard` 관련 CSS·새 CSS 블록 1개·`MODAL_SEL` 한 줄·데스크톱에서 `#s3` 숨김 CSS), 새 테스트 `backend/test/list-screen-d.test.js`, 기존 테스트가 이 변경 때문에 문자열로 깨질 때 그 단언의 **문자열만**(뜻은 유지, 바꾼 것은 NOTES 에 모두 적기).
Out of scope: 사이드바 입력·관심 단지·계약 타임라인·규제 표 마크업, `renderPList`·`#pList` 노드 삭제, 정렬·필터 로직, 서버 코드, 지도·첫 화면·상세 모달, 비교 바(`.cmp-bar`) 동작.

## Git workflow
브랜치 `advisor/163-list-screen-results`. 단계별 커밋, 메시지 예: `feat(ui): 목록 화면 결과 영역을 시안 D 로 — 결과 한 곳·점수 막대·면책 한 줄 (Plan 163)` + 본문 `[근본 원인] [Fix 내용] [회귀 위험]`, 끝줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. push 금지.

## Steps
### Step 1: CSS 블록 추가(토큰만)
`.lgv`·`.lcard` 기존 규칙 근처에 `/* LIST-D-2026-10-18 (Plan 163): 시안 화면 D 결과 영역 */` 블록을 추가하고 위 값대로 클래스를 정의한다: `.ld`(결과 영역 래퍼, 데스크톱에선 `.lgv` 의 그리드 대신 세로 흐름: `#view-list.lgv` 의 `display:grid` 를 이 화면에서 덮어쓰려면 `#view-list.ld-on{display:block!important;padding:28px 32px 32px}` 처럼 클래스로), `.ld-head`·`.ld-tools`·`.ld-chip`(+`.on`)·`.ld-sel`·`.ld-note`·`.ld-card`(5열 그리드)·`.ld-tag`·`.ld-pyg`(평형 3칸)·`.ld-bar`(+채움 `.ld-bar>i`)·`.ld-cmp`(+`[aria-pressed="true"]`)·`.ld-foot`·`.ld-empty`·`.ld-skel`. 모바일 `@media(max-width:700px)` 에서 카드 세로 배치·조건 요약 줄 `.ld-sum`·도구 줄 가로 스크롤. 다크 전용 값은 쓰지 않는다(토큰이 바뀐다). 데스크톱에서 결과 중복 제거: `@media(min-width:701px){ #s3{display:none!important} }`(주석: 결과는 본문 한 곳 — 노드는 남긴다).
**Verify**: `grep -c "LIST-D-2026-10-18" frontend/index.html` ≥ 1, `grep -n "#s3{display:none!important}" frontend/index.html` 1줄.

### Step 2: 카드 함수 교체
`_renderListCard(p, i)` 를 위 "카드" 값대로 다시 쓴다(데스크톱·모바일 같은 마크업 + CSS 로 배치 전환 — 모바일에서 숨길 열은 CSS `display:none`). 모든 문자열은 `_escHtml` 을 거친다(기존과 같이). 숫자는 `Number()`. 점수 막대 채움 폭은 `Math.max(0,Math.min(100,Number(p.score)))%`. 카드 루트는 `<div class="ld-card" role="link" tabindex="0" onclick="showDetail(props[${i}])" onkeydown="if(event.key==='Enter'){showDetail(props[${i}])}">`, 비교 버튼은 `<button type="button" class="ld-cmp" aria-pressed="${cmpSel.has(i)}" onclick="event.stopPropagation();toggleCmp(${i},!cmpSel.has(${i}));renderListGrid()">`. 억 표기는 새 공용 함수 `_fmtEok(v, d)`(아래)로.
`_fmtEok` 를 `_fmtSgg` 정의 근처에 추가: `function _fmtEok(v, d){ const n = Number(v); if(!Number.isFinite(n) || n <= 0) return '—'; return n.toFixed(d == null ? 2 : d) + '억'; }`(주석: LIST-D — 억 표기 공용, 목록 화면부터 사용. 다른 화면 이관은 별도).
**Verify**: `grep -c "function _fmtEok(" frontend/index.html` = 1. `grep -n "거래활발' : s >= 50" frontend/index.html` 에서 `_renderListCard` 안의 줄이 사라진다(다른 함수의 같은 문자열은 이 계획 범위 밖 — 그대로).

### Step 3: renderListGrid 머리·도구·상태 교체
`renderListGrid` 의 빈 상태 HTML·`metaLine`·`_regionEntry` 출력 형태·빨간 면책 상자·정렬/필터 줄·0건 문구를 위 값대로 바꾼다. **유지**: `_regionLabel` 함수와 그 규칙(7개 이상이면 "{광역} 전체 N개 시군구"), `_regionEntry` 의 lawdCd 판정·최대 3, `_curSortSel` 재선택, `_sortMap`, `window._lstFlt` 필터, `_idxOf`, 예외 시 "목록을 보여주지 못했어요" 문구. 그리는 동안 `#view-list` 에 `ld-on` 클래스를 붙인다(빈 상태·결과 모두). 필터 칩의 선택 표시는 `window._lstFlt` 를 보고 매번 클래스 `on` 으로 그린다(인라인 색 금지). `setLstFilter(f)` 는 `window._lstFlt = f; renderListGrid();` 만 남긴다(하드코딩 `#fff` 제거 — 다크 결함).
모바일 조건 요약 줄(`.ld-sum`, `onclick="toggleDrawer()"`)은 결과·빈 상태 모두 맨 위에 그리되 CSS 로 데스크톱에서는 숨긴다. 요약 문구는 실제 입력값에서 만든다(비면 그 항목 생략, 전부 비면 "조건을 넣어 주세요").
**Verify**: `node --test backend/test/recommend.test.js` → `ℹ fail 0`(분석 지역 안내 유지).

### Step 4: 로딩 상태·비교 바 동기화·키보드 가두기
- `doSearch()` 의 `_lg.innerHTML=...` 로딩 카드를 위 "검색 중" 값으로 바꾸고 `_lg.classList.add('ld-on')`.
- 기존 체크박스 기반 비교 동기화 코드(`:7658` 부근 `document.querySelector(\`.cmp-chk-input[data-i="${i}"]\`)`)가 있다. 목록 카드에서 체크박스가 사라지므로 그 코드가 null 을 안전하게 다루는지 확인하고(이미 `if (cb)` 같은 가드가 있으면 그대로), 다른 화면이 `.cmp-chk-input` 을 쓰는지 `grep -n "cmp-chk-input" frontend/index.html` 로 확인한다 — 다른 사용처가 있으면 그 CSS·코드는 그대로 둔다.
- 비교 표시 동기화(확인된 사실): `toggleCmp(i, checked)`(`:7654`)는 최대 개수 초과 시 체크박스를 되돌리고 `toast` 후 return, 정상이면 `cmpSel` 갱신 후 `renderCmpBar()`. `clearCmp()`(`:7670` 부근)는 `.cmp-chk-input` 체크를 모두 해제하고, 상세 화면 동기화(`:11770` 부근 `const cb = document.querySelector(\`.cmp-chk-input[data-i="${k}"]\`); if(cb) cb.checked = cmpSel.has(k);`)도 체크박스만 갱신한다. `.cmp-chk-input` 을 쓰는 곳은 목록 카드뿐이다. 버튼으로 바꾸면 이 두 곳이 목록 표시를 갱신하지 못하므로, `clearCmp()` 끝과 `:11770` 줄 뒤에 각각 `try{ if(document.getElementById('view-list')?.classList.contains('ld-on')) renderListGrid(); }catch(_){}` 를 추가한다(이 두 줄은 In scope). 체크박스 관련 기존 코드·CSS(`.cmp-chk*`)는 null 가드가 있어 남겨 둬도 안전하다 — 지우지 않는다.
- `MODAL_SEL` 에 `#toolsSheet` 를 추가한다(주석 `// LIST-D 동반(감사 백로그): 모바일 도구 시트도 aria-modal 인데 Tab 가두기 대상이 아니었다`).
**Verify**: `grep -n "MODAL_SEL='" frontend/index.html` 줄에 `#toolsSheet` 포함.

### Step 5: 테스트 `backend/test/list-screen-d.test.js` (새 파일)
모델: `backend/test/home-panel.test.js` 의 `runRender` 방식(`extractFn` 으로 함수 소스를 뽑아 가짜 `document` 와 함께 `vm.runInContext`). 가짜 ctx 에 `props`·`searchMeta`·`cmpSel = new Set()`·`window = { _lstFlt: 'all' }`·`_escHtml`·`_fmtSgg`·`_dispAptName`·`_isRegProp`(가짜)·`_regLtvLabel`(가짜)·`_fmtEok`(실물)·`document.getElementById`(view-list·lstSort 가짜)·`document.querySelector`/`querySelectorAll`(빈 결과) 를 넣는다.
(a) 결과 2건 → `#view-list` innerHTML 에 "예산 안에 드는 단지", "점수는 과거 실거래 통계로", "매수·매도 추천이 아니에요" 가 있고, **"거래활발"·"거래보통"·"거래적음" 이 없고**, 빨간 면책 상자 문구 "아래 점수와 신호는" 이 없다.
(b) 점수 78 카드 → 막대 채움 `width:78%`, 점수 없는 카드 → "분석 대기", 막대 없음.
(c) `priceSampleN` 이 있으면 "표본 N건", 없으면 "표본" 문자열이 그 카드에 없다.
(d) 평형 1개뿐이면 나머지 2칸은 "—".
(e) 비교 버튼은 `aria-pressed` 를 갖고 `event.stopPropagation()` 을 포함하며, `cmpSel` 에 담긴 카드는 `aria-pressed="true"`.
(f) `props` 비면 검색 전 문구("단지 찾기를 눌러 주세요")와 "매수·매도 추천이 아니에요".
(g) 소스 고정: `setLstFilter` 에 `'#fff'` 없음, `#s3{display:none!important}` 가 `min-width:701px` 블록 안, `MODAL_SEL` 에 `#toolsSheet`.
**Verify**: 새 테스트 7개 `ℹ fail 0`.

### Step 6: 전체 검증
`npm run verify` → 종료 코드 0, `ℹ fail 0`.

## Done criteria
- 위 Step 1~5 의 grep·테스트 기대값 모두 충족, `npm run verify` 종료 코드 0
- `git diff --stat origin/master` 에 `frontend/index.html`·새 테스트(와 문자열만 고친 기존 테스트) 외 없음

## STOP conditions
- `renderListGrid`·`_renderListCard`·`setLstFilter` 가 위 발췌와 다르다.
- `.cmp-chk-input` 을 목록 카드 외 다른 화면이 쓰고 있어 동기화 코드를 바꿔야만 할 것 같다 — 보고.
- 기존 테스트가 **문자열이 아닌 동작** 때문에 깨진다 — 단언을 바꾸지 말고 보고.
- 사이드바 마크업을 바꿔야만 할 것 같다(범위 밖).

## Maintenance notes
- 사이드바 전면 개편(희망 지역 선택 창·관심 단지 행·계약 타임라인/규제 표 텍스트 버튼)은 시안에 선택 창 설계가 없어 다음 단계로 남긴다.
- "점수 기준 보기" 는 점수 계산식(`backend/services/propertyService.js` 종합 점수)을 그대로 문장으로 옮기는 별도 작업이 필요하다 — 지어내지 말 것.
- `_fmtEok` 는 목록 화면만 쓴다. 다른 화면의 억 표기(소수점 1·2자리 혼재)는 화면별로 옮긴다.
