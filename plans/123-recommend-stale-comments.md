# 123 — 추천 엔진의 낡은 주석 2곳 정정 (동작 변경 0)

**작성 기준 커밋**: `3656bdc` (2026-09-28) · **출처**: `plans/README.md` 백로그 "추천 팬아웃 동시성 무제한 + 낡은 주석 2곳 미정정"(2026-09-06) 중 주석 부분 · **운영자 승인 2026-09-28**("권고대로" — 후속표 3번)
**성격**: 주석만 XS. 코드·테스트 변경 0(동시성 상한은 실측 없이 손대지 않는다 — 범위 밖).

## 사실 (계획자가 `backend/services/propertyService.js` 를 직접 읽음)
- 후보 컷은 렌즈 합집합이다(`:936` 부근 MULTI-LENS-2026-09-05): `LENS_PROV`(필터 있으면 45, 없으면 40) + `LENS_DEALS` 20 + `LENS_SCALE` 20 + `LENS_UNVERIFIED` 15 를 `Set` 으로 합친 `ranked`(겹침 제외 최대 100). `recommendations = ranked.map(...)`.
- 세대수·시설 보강 `const enriched = await Promise.allSettled(recommendations.map(...))`(`:1110`)는 **합집합 전체**에 대해 돈다.
- 15곳 컷은 그 **뒤**다: `:1329` `_rankedF = _rankedF.slice(0, 15);` · `:1330` `enrichedRecs = enrichedRecs.slice(0, 15);`.
- 그런데 두 주석은 15곳 상한을 전제로 쓰여 있다:
  - `:1103` `…실패 시 null(기존 동작). top-15 로 bounded, Redis 캐시로 콜드 1회만.`
  - `:1118` `//   비용: 미매칭 항목(최대 15)에만 · 인메모리/DB 캐시 공유 · 실패하면 종전 BR 경로 그대로.`

## 변경 (실행자)
- `:1103` 의 `top-15 로 bounded, Redis 캐시로 콜드 1회만.` → `렌즈 합집합 전체(겹침 제외 최대 100 — 15곳 컷은 보강 뒤 :1329)에 대해 실행, Redis 캐시로 콜드 1회만. STALE-COMMENT-2026-09-28 (Plan 123): 종전 "top-15 로 bounded" 는 MULTI-LENS(2026-09-05) 이후 사실이 아니다.`
- `:1118` 의 `비용: 미매칭 항목(최대 15)에만` → `비용: 렌즈 합집합의 미매칭 항목 전체(최대 100 — 15곳 컷은 보강 뒤)에` (나머지 문구 유지).
- 줄 번호가 달라져 있으면 인용 문자열로 찾는다. 인용 문자열이 정확히 1곳씩 없으면 STOP.

## 하지 말 것
- 코드 변경 금지(동시성 상한·렌즈 크기·15 컷 모두 그대로). 다른 주석 수정 금지.

## 완료 기준
`npm run verify` 전부 통과(테스트 수 변화 0). `git diff master --stat` = `backend/services/propertyService.js`(주석 2곳, 줄 수 ±2 안팎) + `plans/123-recommend-stale-comments.md`(사본).
