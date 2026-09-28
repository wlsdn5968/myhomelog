# 125 — `/region/:lawdCd` CTA 딥링크(`?region=`) + 공유 URL 의 세부 지역 선택이 지워지는 기존 버그

**작성 기준 커밋**: `3656bdc` (2026-09-28) · **출처**: 백로그 "지역 페이지 딥링크 파라미터 미확인"(114 P1·045 스파이크 잔여) · **운영자 승인 2026-09-28**("권고대로" — 후속표 3번)
**성격**: 코드 S(백엔드 2파일 + 프런트 JS 2곳) + 신규 테스트 1. UI 모양 변경 0(링크 href·칩 선택 상태만).

## 1. 사실 (계획자 실측 2026-09-28)
- `backend/routes/regionPage.js:308` 지역 상세 CTA `<a class="cta" href="${ORIGIN}/">${esc(label)} 단지 검색·대출 계산 →</a>` — 앱으로 가면 어느 지역에서 왔는지 사라진다(115 가 `/apt` 에만 `?apt=&area=` 를 붙였다).
- SPA 는 이미 `?region=<광역> <세부 라벨>` 을 복원한다: `frontend/index.html` `restoreSearchFromUrl()`(`:10732`) → `setChip('ch-r', wide)` → `populateRegionSub(wide)` → 세부 칩 텍스트 정확일치(실패 시 공백 무시 포함일치)로 `on`.
- 광역·세부 라벨은 `/api/region/menu`(`backend/routes/region.js:204`)가 **코드 상수**(`LAWD_CODES`·`LAWD_CODE_TO_NAME`·`RETIRED_LAWD_CODES`)에서 만든다: 광역 = 서울·경기·인천 이면 그대로, 그 외 시도(부산·대구·대전·울산·세종·충북)는 `지방`; 라벨 = `LAWD_CODE_TO_NAME[code]` 에 `/^([가-힣]{2,}시)([가-힣]+[구군])$/ → '$1 $2'`, `지방` 이면 앞에 시도명. 라이브 메뉴 실측: `11350 → 서울 | 노원구` · `41131 → 경기 | 성남시 수정구` · `41117 → 경기 | 수원시 영통구` · `26350 → 지방 | 부산 해운대구` · `43113 → 지방 | 충북 청주시 흥덕구` · `28185 → 인천 | 연수구` · `36110 → 지방 | 세종 세종특별자치시`.
- **기존 버그(라이브 재현 2026-09-28)**: `https://myhomelog.vercel.app/?region=경기 성남시 수정구` → 광역 `경기` 는 켜지지만 **세부 선택 0**, `getRegionForSearch()` = `'경기'`. 원인(코드): `loadRegionMenu()`(`:3580` 호출, `:10608` 정의, 비동기)가 `restoreSearchFromUrl()`(`:3655`, 동기) 뒤에 끝나며 `if(on) populateRegionSub(on.textContent.trim())` 로 세부 칩을 **다시 그려** 선택을 지운다. 복원 시점엔 메뉴가 폴백(`REGION_SUB_FALLBACK`)이라 새 라벨이 없어 애초에 매칭도 안 된다. → 세부 지역이 든 **모든 공유 URL** 이 같은 증상.

## 2. 변경 (실행자)
### 2-1. 백엔드 — 라벨 규칙을 함수로 뽑아 두 곳이 공유
- `backend/routes/region.js`: `/menu` 핸들러 안의 광역·라벨 계산을 모듈 수준 순수 함수 `menuEntryForLawd(code)` 로 뽑는다 → `{ wide, label }` 또는 `null`(퇴역 코드·시도 표에 없음·이름 없음). `SIDO` 표도 함수 밖 상수로. `/menu` 는 이 함수를 쓰도록 바꾸되 **출력(JSON) 은 바이트 동일**(active 필터·정렬·캐시 헤더 그대로). `module.exports.menuEntryForLawd = menuEntryForLawd;`(라우터 export 뒤에 속성으로 — 저장소 관례 `cron.js:828` 참고).
- `backend/routes/regionPage.js:308` CTA: `menuEntryForLawd(region.lawdCd)` 가 있으면 `href="${ORIGIN}/?region=${encodeURIComponent(`${e.wide} ${e.label}`)}"`, 없으면 지금처럼 `${ORIGIN}/`. 주석 `// REGION-DEEPLINK-2026-09-28 (Plan 125): 앱 검색 조건 복원(restoreSearchFromUrl)이 읽는 ?region=<광역> <세부> — 라벨은 /api/region/menu 와 같은 함수.` `/region` 목록 페이지 CTA(`:140`)는 그대로.
### 2-2. 프런트 — 늦게 온 메뉴가 복원된 세부 선택을 지우지 않게
- `restoreSearchFromUrl()` 의 세부 매칭 블록: 매칭 여부와 무관하게 요청된 세부 목록을 `window._pendingRegionSubs = { wide, subs: [...] }` 로 남긴다(`sub.split('·')` 결과).
- `loadRegionMenu()` 의 `if(on) populateRegionSub(...)` 줄을: 다시 그리기 **전** 켜져 있던 세부 칩 텍스트를 모아 두고(`prevOn`), 다시 그린 뒤 `prevOn` 과 `_pendingRegionSubs`(광역이 현재 켜진 광역과 같을 때만)를 **restore 와 같은 규칙**(정확일치 → 공백 무시 포함일치)으로 다시 `on`, `_pendingRegionSubs` 는 비우고 `_syncRegionPick()` 호출. 매칭 함수는 restore 쪽과 한 곳에서 공유(작은 헬퍼 `_applyRegionSubs(labels)`)하고 restore 도 그 헬퍼를 쓰게 — 같은 규칙 두 사본 금지. 주석 태그 `REGION-SUB-RESTORE-2026-09-28 (Plan 125)`.
- 광역 칩을 사용자가 **직접** 바꾸는 경로(`populateRegionSub` 호출부)는 기존대로 선택을 비운다(변경 금지).
### 2-3. 테스트 `backend/test/region-deeplink.test.js` (신규)
- `menuEntryForLawd`: 위 §1 의 7개 코드가 라이브 메뉴와 같은 `{wide,label}` · 퇴역 코드(`RETIRED_LAWD_CODES` 에서 하나)·`'99999'` → `null`.
- `/menu` 출력이 함수 추출 전과 같음: 테스트 안에서 **추출 전 알고리즘을 그대로 복제한 기대값 생성기**로 전체 `LAWD_CODES` 에 대해 `{wide,label,lawdCd}` 목록을 만들어 `menuEntryForLawd` 결과와 비교(active 필터 제외 부분).
- `regionPage.js` 소스: CTA 에 `?region=${encodeURIComponent(` 1회, `menuEntryForLawd` require 1회.
- `index.html`: `_pendingRegionSubs` · `REGION-SUB-RESTORE-2026-09-28` · `function _applyRegionSubs` 각 1회 이상, `loadRegionMenu` 본문에 `_applyRegionSubs(` 호출 존재(`frontend-contracts.test.js` 의 index.html 읽기 방식을 따를 것).

## 3. 하지 말 것 / STOP
- 메뉴 JSON·캐시 헤더·active 필터 변경 금지. `populateRegionSub` 의 사용자 클릭 동작 변경 금지. CSS·마크업 변경 금지.
- `region.js` 의 다른 라우트 변경 금지. 기존 테스트 수정 금지.

## 4. 완료 기준
- `npm run verify` 전부 통과. `npm run lint`(index.html 인라인 JS 추출 포함) 통과.
- 배포 후 리뷰어 라이브(브라우저): ① `/?region=경기 성남시 수정구` → 6초 뒤 `#ch-r-sub .chip.on` = `['성남시 수정구']`, `getRegionForSearch()` = `'경기 성남시 수정구'`. ② `/region/41131` CTA href 가 `/?region=%EA%B2%BD%EA%B8%B0%20…` 이고 클릭 시 ①과 같은 상태. ③ `/?region=지방 부산 해운대구` 도 복원. ④ 광역 칩을 `서울` 로 바꾸면 세부 선택이 비워짐(기존 동작).
