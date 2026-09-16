# 085 — 모바일 미세 조정 3건: 지도 범례의 잘린 구분자 · 헤더 아이콘 히트 영역 44px · 10px 캡션 11px

**작성 기준 커밋**: `5d6215b` (2026-09-16) · 우선순위 P3 · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- **[i] 잘린 구분자**: 모바일 지도 상단 띠에 `| 숫자 라벨 = 인기 단지 (…)` 처럼 **"|" 로 시작하는** 문장이 보인다. `frontend/index.html:2056` `<span id="popLegend" … style="font-size:10px;…;display:none">| 숫자 라벨 = 인기 단지 (최근 60일 실거래 많은 순 · 지역 쏠림 완화)</span>` — 텍스트 자체가 `| ` 로 시작한다. 앞 요소 `#mapHintTxt`(`:1354` 모바일 `display:none`)·`#mapTrustChip`(`:2038` ≤700px `display:none!important`)이 모바일에서 숨겨지므로 구분자만 남는다. 데스크탑에선 앞 요소가 보여 자연스럽다.
- **[ii] 헤더 아이콘 히트 영역**: 375px 실측에서 `#ntcBell` 30×44, `#dataStatusBtn` 27×44(모바일 최소 권장 44×44). 마크업 `:1764~1765` 는 `style="min-width:0;padding:6px 9px"` / `padding:6px 10px`. 헤더 가로 예산이 `:1330~1332` 주석대로 375px 에 맞춰 튜닝돼 있어 **버튼을 넓히면 넘친다** → 레이아웃을 바꾸지 않는 **가상요소 히트 확장**으로 해결.
- **[iii] 10px 캡션**: `#mMapCap`(`:1181` `font-size:10px`, 모바일 전용 지도 좌하단 "갱신 · 국토부·KAPT" 칩)과 `#popLegend`(`:2056` 인라인 `font-size:10px`)가 모바일에서 10px. 본문 최소 11px 로.

## 범위
- 수정: `frontend/index.html` — `#popLegend` 텍스트 1곳, CSS 규칙 추가(≤700px 미디어쿼리 안). 그 외 금지(헤더 폭 예산 주석 `:1330~1332` 의 수치 변경 금지).

## Step 1 — 구분자를 CSS 로
1. `:2056` 의 텍스트 `| 숫자 라벨 = 인기 단지 (…)` 에서 앞의 `| ` 두 글자를 제거한다(나머지 문구·title·style 불변).
2. CSS(데스크탑 기본)에 추가: `#popLegend::before{content:"| "}` — 기존 `#mapTrustChip{…}` 규칙(`:2030`) 바로 뒤.
3. `:2038` `@media(max-width:700px){ #mapTrustChip{display:none!important} }` 를 `@media(max-width:700px){ #mapTrustChip{display:none!important} #popLegend::before{content:""} }` 로.

## Step 2 — 히트 영역 확장 (≤700px 미디어쿼리, `:1334` `.hbtn{padding:5px 8px}` 규칙 뒤에 추가)
```css
  /* TAP-44-2026-09-16 (Plan 085): 375px 실측 벨 30px·상태 27px 폭. 헤더 폭 예산(위 주석) 때문에 버튼을 넓히지 않고
     가상요소로 터치 히트 영역만 44px 이상으로 확장한다(레이아웃·시각 불변). */
  #ntcBell, #dataStatusBtn, #themeToggle { position: relative; }
  #ntcBell::after, #dataStatusBtn::after, #themeToggle::after { content: ""; position: absolute; top: 50%; left: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); }
```
(`.ntc-dot` 등 기존 자식 가상요소와 충돌하는지 `grep -n "#ntcBell::after\|#dataStatusBtn::after\|#themeToggle::after"` 로 확인 — 이미 있으면 STOP.)

## Step 3 — 캡션 11px (같은 미디어쿼리 안)
```css
  #mMapCap { font-size: 11px; }
  #view-map .mtbar #popLegend { font-size: 11px; }
```

## 검증·완료 기준
- `npm run verify` → `fail 0`(382).
- 정적: `grep -c "TAP-44-2026-09-16" frontend/index.html` → 1 · `grep -c '#popLegend::before' frontend/index.html` → 2 · `grep -c '>| 숫자 라벨' frontend/index.html` → 0.
- 리뷰어가 배포 후 라이브(모바일 에뮬레이션)에서 `#popLegend` 텍스트가 "숫자 라벨" 로 시작하고, `getComputedStyle(document.querySelector('#ntcBell'),'::after').width === '44px'` 인지 확인.
- 커밋 1개: `fix(모바일): 지도 범례 잘린 구분자·헤더 아이콘 히트 44px·캡션 11px (Plan 085)`.

## STOP 조건
- `#ntcBell::after` 류 규칙이 이미 존재(다른 용도) → 보고하고 멈춘다.
