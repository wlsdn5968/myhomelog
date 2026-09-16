# 081 — 단지 상세 모달 탭바: 모바일에서 화면 밖 탭 3개의 존재를 알리는 시각 단서

**작성 기준 커밋**: `2c8d13b` (2026-09-16) · 우선순위 P2 · 작업량 XS · 의존: 없음

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브 375×812(모바일 에뮬레이션)에서 상세 모달 탭바 `.rtabs` 의 `scrollWidth=605`, `clientWidth=375`. 7개 탭 중 **🎯 가격 시그널 · 🏢 단지정보 · 🏃 임장노트 3개가 화면 밖**. 4번째 탭(📝 특약 초안)은 온전히 보이고 5번째는 통째로 잘려 **"더 있다"는 단서가 없다**(가림 그라데이션 없음 `mask-image: none`, 스크롤바는 4px 얇은 바로 스크롤 중에만 보임).
- CSS 위치: `frontend/index.html:1017` `.rtabs{display:flex;…;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin}` · `:1019~1021` webkit 스크롤바 4px · `:1022` `.rtab{padding:11px 12px;font-size:12.5px;…}`.
- 탭 버튼 마크업: `:3216~3222` `<button class="rtab on" onclick="stb(this,'t0')">📊 종합의견</button>` … 7개. 탭 전환 함수 `stb(btn, id)`.

## 범위
- 수정: `frontend/index.html` 의 CSS 블록(`:1017~1024` 부근)에 규칙 추가, `stb()` 에 1줄(선택된 탭을 보이게 스크롤). 마크업·데이터·다른 함수 변경 금지.

## Step 1 — CSS (`.rtab.on{…}` 규칙 바로 뒤에 추가)
```css
/* TABS-CUE-2026-09-16 (Plan 081): 좁은 화면에서 탭바가 넘칠 때 오른쪽 끝을 흐리게 해 "더 있다"를 알린다.
   .rtabs 는 overflow-x:auto 라 스크롤은 되지만 5번째 탭이 통째로 잘려 단서가 없었다(375px 실측 605px). */
@media (max-width: 700px) {
  .rtabs { scroll-snap-type: x proximity; padding-right: 40px; }
  .rtab { scroll-snap-align: start; padding: 11px 9px; font-size: 12px; white-space: nowrap; }
  .rtabs.has-more { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent); }
}
```
## Step 2 — JS: 넘침 여부 클래스 토글 + 선택 탭 가시화
`stb(` 함수 정의를 찾아(`grep -n "function stb("`) 본문 **끝**에 추가:
```js
  // TABS-CUE-2026-09-16 (Plan 081): 선택한 탭이 화면 밖이면 보이게 스크롤. 넘침 여부로 has-more 갱신.
  try { btn.scrollIntoView({ block: 'nearest', inline: 'nearest' }); _rtabsCue(); } catch(_) {}
```
(`stb` 의 첫 인자 이름이 `btn` 이 아니면 그 이름을 쓴다.) 그리고 `stb` 바로 위에 헬퍼 추가:
```js
// TABS-CUE-2026-09-16 (Plan 081): 탭바가 오른쪽으로 더 스크롤될 수 있을 때만 has-more(끝 흐림).
function _rtabsCue(){
  const el = document.querySelector('#DM .rtabs'); if (!el) return;
  const more = el.scrollWidth - el.clientWidth - el.scrollLeft > 8;
  el.classList.toggle('has-more', more);
}
```
`showDetail(p)` 가 `document.getElementById('t0').innerHTML=` 를 채운 직후 한 줄 `try { _rtabsCue(); } catch(_) {}` 를 넣고, `.rtabs` 요소에 스크롤 리스너를 1회만 건다(`showDetail` 안, `if(!el._cueBound){el._cueBound=1;el.addEventListener('scroll',_rtabsCue,{passive:true});}`).

## 검증·완료 기준
- `node scripts/check-html.js` 류가 verify 에 있으면 통과, `npm run verify` → `fail 0`(테스트 수 382 그대로 — 프론트 계약 테스트가 `.rtabs` 문자열을 세지 않는지 `grep -n "rtabs" backend/test/*.js` 로 확인; 세면 그 테스트 기대치를 함께 갱신하고 보고).
- 회귀 주입 없음(CSS/표시 전용). 대신 보고에 `grep -c "has-more" frontend/index.html`(≥3) 과 `stb` 변경 diff 를 붙인다.
- 커밋 1개: `fix(모바일): 상세 탭바 넘침 단서(끝 흐림·선택 탭 가시화) (Plan 081)`.

## STOP 조건
- `stb(` 정의가 2개 이상이거나 첫 인자가 버튼 요소가 아니다 → 보고하고 멈춘다.
