# Plan 069: 공개 단지 페이지 2탄 — 학교·주소·구조 + desc 출처 문구 (전부 캐시 데이터, 외부 호출 0)

> **실행자 안내**: 끝까지 읽고 검증 명령을 실제로 돌려라. STOP 조건이면 멈추고 보고하라.
> **전제**: Plan 068(`structureType`) 머지 완료(`682729f`). **드리프트 점검**: `git diff --stat 682729f..HEAD -- backend/routes/aptPage.js`

## Status
- **Priority**: P2 · **Effort**: S · **Risk**: LOW-MED(공개 SSR·6h 캐시) · **Depends on**: 068
- **Category**: feature(무료·비용 0) · **Planned at**: 2026-09-06

## 전제 확인 (계획자가 코드로 확인함 — 실행자는 재확인만)
- `backend/services/schoolService.js:254` `getCachedSchoolsBatch(apts)` — **DB 캐시(`apt_schools`)만 읽는다**, Kakao 호출 없음. `apt_schools.schools` 는 `[...초, ...중, ...고]` 순 배열(`:196-226` 정규화). 키는 `buildKey({ kaptCode, aptName, sigungu, umdNm })`(`:49`).
- `backend/services/geocodeCacheService.js` export 에 `resolveCoordFromCacheOnly` 가 있다 — 시그니처는 **실행자가 읽어라**.
- `buildFacility` 반환에 `address`(도로명→지번 폴백)와 `structureType`(068) 이 있다.
- `aptPage.js` 의 `buildAptInfoCard(row)` 가 `fac` 를 이미 만든다 — 학교·주소·구조는 **그 `fac` 와 `row` 를 재사용**한다.

## ⚠ 절대 제약
- **외부 API 호출 0.** `resolveSchools`·`kakaoSearchSchools`·`resolveCoord`(캐시 미스 시 Kakao 호출) 는 **호출 금지**. 캐시 전용 함수만. 운영자 절대 방침(유료 경로 금지)이고, 공개 페이지는 봇 트래픽이 많다.
- 값 없으면 **행/카드 생략**(미확인 원칙). `0`·`미상` 금지.
- **KAPT 도보시간(`walkSubwayMin`·`walkBusMin`) 금지** — 자기신고값(실측 일치 42.6%).
- 유사도 매칭 금지 — 학교·좌표 키는 063 이 확정한 `row`(alias/완전일치로 고른 apt_master 행)로만 만든다.

## 요구사항
1. **desc 출처 문구**(거래 있음 분기): 지금 `facts` 에 KAPT 사실(세대수·준공)이 섞이는데 문구는 "국토교통부 실거래 신고 자료 정리" 뿐이다 → KAPT fact 가 하나라도 있으면 **"국토교통부 실거래·K-apt 단지정보 정리"** 로. 거래 0 분기(065 가 고침)는 **손대지 마라**. `— 매수 추천이 아닙니다.` 전 분기 유지.
2. **단지정보 카드에 행 추가**: `구조`(`fac.structureType`) · `주소`(`fac.address`). 값 있을 때만.
3. **주변 학교 카드**(신규): `getCachedSchoolsBatch([{ kaptCode: row.kapt_code, aptName: row.apt_name, sigungu, umdNm }])` 로 캐시만 조회 → 있으면 초·중·고 순으로 **이름 + 거리(m)** 표. 출처 표기: `카카오 지도 · 교육청 공시(캐시)`. 없으면 카드 없음. ⚠ 배치 함수 인자 형태를 **소스에서 확인**하라(`apts` 원소 필드명).
4. **지도에서 보기 링크**: `resolveCoordFromCacheOnly` 로 좌표가 **캐시에 있을 때만** 앱 딥링크(기존 CTA `${ORIGIN}/` 의 쿼리 규약을 `frontend/index.html` 에서 **확인**해 같은 형식으로)에 좌표·단지명을 실어 "지도에서 보기" 를 단다. 지도 임베드 금지(공개 페이지는 정적 HTML 유지).
5. **캐시 오염 방지**: 학교·좌표 조회가 **오류**면 063 의 `aptMasterErrored` 와 같은 방식으로 긴 캐시를 막는다(정말 없음과 구분). `thin`·`noindex` 불변.
6. 왕복: 기존 `apt_master` 1회 + 학교 1회 + 좌표 1회 = 최대 **3회**. 학교·좌표는 `Promise.all` 로 병렬.

## 범위
**In**: `backend/routes/aptPage.js` · `backend/test/apt-page-enrich.test.js`(**신규**)
**Out**: `schoolService.js`·`geocodeCacheService.js`·`buildFacility.js`(읽기만) · `frontend/index.html` · Kakao 호출 · `thin`/캐시 정책의 기존 부분

## 테스트 (신규 파일, 실행)
① 학교 캐시 있음 → 카드 렌더, 초·중·고 순 · ② 캐시 없음 → 카드 없음(`학교` 문자열 없음) · ③ 학교/좌표 조회 **오류** → 긴 캐시 안 붙음 · ④ 좌표 없음 → "지도에서 보기" 없음 · ⑤ `structureType`·`address` 값 없을 때 행 없음 · ⑥ 거래 있음 + KAPT fact → desc 에 `K-apt` 출처 포함, 거래 있음 + KAPT fact 없음 → **기존 문구 그대로** · ⑦ Kakao 호출 함수가 이 파일에서 **참조되지 않는다**(소스 계약, 줄 주석 제거 후)

## 회귀 주입 (커밋 후)
① 학교 조회를 `resolveSchools`(Kakao 호출)로 바꾼다 → ⑦ fail · ② 조회 오류에도 긴 캐시 → ③ fail

## 완료 기준
- [ ] 외부 호출 0(⑦) · 값 없으면 생략 · 도보시간 없음
- [ ] desc 가 출처를 정확히 말한다(⑥, 거래 0 분기 불변)
- [ ] 왕복 ≤3 · 오류 시 긴 캐시 없음
- [ ] `npm run verify` exit 0 · 주입 2건 fail

## STOP 조건
- 캐시 전용 함수의 시그니처가 공개 페이지에서 쓰기 어렵다(예: 좌표까지 요구) → 보고하고 멈춰라. **Kakao 를 부르는 우회는 금지.**
- 딥링크 쿼리 규약을 `frontend/index.html` 에서 못 찾는다 → 링크 없이 나머지만 하고 보고.
