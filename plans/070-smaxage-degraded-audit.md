# Plan 070: 긴 `s-maxage` 를 붙이는 36개 지점 전수 — 성공/열화를 구분하지 않는 곳을 찾아 고친다

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **드리프트 점검**: `git diff --stat f29a612..HEAD -- backend/routes/`

## Status
- **Priority**: P2 · **Effort**: M · **Risk**: MED(캐시 헤더 = 사용자 체감) · **Depends on**: 없음
- **Category**: bug class sweep · **Planned at**: `f29a612`, 2026-09-06

## 왜
이 저장소는 **열화된 응답이 엣지에 6시간 굳는 실사고**를 겪었고(2026-08-29 지역 선택기 소실), 같은 계열을 054·058·063 에서 3번 더 고쳤다. 규칙은 확립돼 있다: **성공 응답에만 긴 `s-maxage`, 열화(stale·degraded·부분 실패·빈 결과)면 `no-store`.**
아직 전수 점검은 안 했다. `grep -rn "s-maxage" backend/routes/` → **12개 파일 36지점**:
`aptPage`(완료) · `briefing` 2 · `news` 3 · `ogImage` 5 · `region` 2 · `regionPage` 2(058 완료) · `regulations` 3 · `search` 11 · `share` 2 · `sitemap` 1 · `subscription` 1 · `transactions` 3(054 완료).

## 요구사항
1. **먼저 표를 만들어라** — 36지점 각각: 파일:줄 · 어떤 응답에 붙는가 · **열화 판정이 있는가(있으면 무엇)** · 판정 **OK / 결함 / 판단불가**. 이 표가 이 계획의 1차 산출물이다. 추측으로 채우지 마라 — 각 지점의 응답 생성 코드를 읽어라.
2. "결함"인 지점만 고친다. 고치는 방식은 기존 선례를 따르라: `slice.stale ? 'no-store' : CC`(transactions.js), `(degraded || data.stale) ? 'no-store' : CC`.
3. **"열화"의 정의를 지점마다 명시**하라 — 빈 배열이 정상인 엔드포인트(예: 검색 0건)에 `no-store` 를 붙이면 캐시 효율을 망친다. **정상적 빈 결과와 열화된 빈 결과를 구분**하라(구분 불가면 "판단불가"로 두고 보고).
4. 고친 지점마다 **실행 테스트**(열화 시 `no-store`, 정상 시 기존 헤더). 신규 파일 `backend/test/cache-degraded.test.js` 에.
5. ⚠ `search.js` 는 다른 계획들(052·062)이 최근 손댔다. **캐시 헤더 줄만** 고치고 조회·그룹핑은 절대 건드리지 마라. `ogImage.js` 의 `fallback()` 규약도 유지하라.

## 범위
**In**: `backend/routes/{briefing,news,ogImage,region,regulations,search,share,sitemap,subscription}.js` 의 **캐시 헤더 분기만** · `backend/test/cache-degraded.test.js`(신규)
**Out**: `aptPage.js`·`regionPage.js`·`transactions.js`(이미 완료) · 응답 **내용**·조회·정렬 로직 · `frontend/`

## 회귀 주입 (커밋 후, 고친 지점 중 2곳)
열화 분기를 제거 → fail. 각각 원복 후 `fail 0`.

## 완료 기준
- [ ] 36지점 표(파일:줄·판정·근거)가 보고에 있다
- [ ] "결함" 판정 지점 전부 수정 + 테스트
- [ ] "판단불가" 지점은 이유와 함께 목록
- [ ] 주입 2건 fail · `npm run verify` exit 0
- [ ] `git diff --stat` 에 캐시 헤더 줄 외 변경이 없다(각 파일 diff 를 보고에 요약)

## STOP 조건
- 열화 판정을 만들려면 응답 생성 로직을 바꿔야 한다 → 그 지점은 "판단불가"로 두고 보고하라.
- 결함이 10지점을 넘는다 → 먼저 표만 보고하고 멈춰라(리뷰어가 우선순위를 정한다).
