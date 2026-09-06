# Plan 068: 진짜 건물 구조(`codeStr`)를 노출한다 — 14,196행 있는데 어디서도 안 쓴다

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **드리프트 점검**: `git diff --stat f29a612..HEAD -- backend/utils/buildFacility.js frontend/index.html`

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: MED(`buildFacility` 는 소비자가 여럿) · **Depends on**: 없음
- **Category**: feature(무료·비용 0) · **Planned at**: `f29a612`, 2026-09-06

## 왜 (실측)
`apt_master.facility->'_dtl'->>'codeStr'` — **14,196행** 보유. 값 분포: 철근콘크리트구조 10,633 · 철골철근콘크리트구조 2,310 · 철골콘크리트구조 617 · 콘크리트구조 360 · **조적구조 56**(노후 신호).
`buildFacility.js` 는 이 필드를 **노출하지 않는다**(`hallType`=복도유형만 있다). Plan 065 에서 "구조" 라벨 오기를 잡으면서 확인됐다.

## 요구사항
1. `buildFacility` 반환에 **`structureType`** 필드를 추가한다: `detail.codeStr` 우선, 없으면 `null`. **다른 필드는 건드리지 마라.**
   ⚠ `codeStr` 은 `_dtl`(detail 인자)에 있다 — `info` 가 아니다. 실제 위치를 코드로 확인하라.
2. **앱 단지정보 탭**(`frontend/index.html` 의 KAPT 표 — `총 세대수`·`총 동수`… 행이 있는 곳)에 `구조` 행을 추가한다. **값이 있을 때만**(미확인 원칙 — `미상` 행 금지는 기존 표와 같은 규칙).
3. `hallType`(복도유형)이 그 표에 이미 있으면 그대로 두고, 없으면 **추가하지 마라**(범위 밖).
4. **계약 테스트**: `buildFacility` 의 반환 **키 집합**이 "기존 키 전부 + `structureType`" 임을 **실행으로** 고정한다(기존 소비자가 깨지지 않았다는 증거). 소비자 목록은 `grep -rn "buildFacility(" backend/` 로 전수 확인해 보고하라.

## 범위
**In**: `backend/utils/buildFacility.js` · `frontend/index.html`(단지정보 표 1행) · `backend/test/facility-structure.test.js`(**신규 파일**)
**Out**: `backend/routes/aptPage.js`(공개 페이지 노출은 Plan 069) · `propertyService`·추천 점수 · 다른 `buildFacility` 필드 · DB

## 주의
- `frontend/index.html` 은 **CRLF**·13,000줄. 편집 스크립트는 **Write 도구**로, 앵커는 문자열 탐색 + 매치 수 단언.
- `node --check` 는 html 불가 → `npm run lint`.
- 소스 문자열 검사를 쓰면 **줄 주석 먼저 제거**(자기 주석 오검출 6회 재발).
- 테스트는 **신규 파일**에 — 단일 테스트 파일은 다른 실행자가 분할 중이다. 헬퍼도 import 하지 말고 자기 파일 안에.

## 회귀 주입 (커밋 후)
① `structureType` 을 반환에서 뺀다 → fail · ② 값 없을 때 `'미상'` 을 넣게 한다 → fail

## 완료 기준
- [ ] `buildFacility` 키 집합 계약 테스트 통과(기존 키 무손실)
- [ ] 앱 단지정보 탭에 값 있을 때만 `구조` 행
- [ ] 주입 2건 각각 fail · `npm run verify` exit 0
- [ ] `git diff --stat` 에 In 범위 파일만

## STOP 조건
- `buildFacility` 의 기존 필드 계산을 바꿔야 할 것 같다 → 보고하고 멈춰라.
- `codeStr` 이 `_dtl` 에 없고 다른 곳에 있다 → 실제 위치를 보고하고 계속.
