# 080 — 단지 상세 "종합의견" 탭의 중복 블록 제거: 단지 기본정보 2개 · 주변 학교 2개 → 각 1개

**작성 기준 커밋**: `2c8d13b` (2026-09-16) · 우선순위 P1 · 작업량 S · 의존: 없음

## 전제 확인 (계획자가 라이브·코드로 확인한 것)
- 라이브(공릉풍림아이원, 데스크탑·모바일 동일) 종합의견 탭에 **"🏢 단지 기본정보" 가 2번, "🏫 주변 학교" 가 2번** 보인다. 두 학교 블록은 출처 문구까지 다르다("카카오맵 기준" vs "카카오맵 + 학교알리미") — 같은 화면에 서로 다른 출처 주장(절대 룰 ② 정확한 출처).
- 원인(코드): `showDetail(p)`(`frontend/index.html:7555`)가 t0 를 채울 때
  - `:7701` 요약 블록 `🏢 단지 기본정보`(id 없음, `p.facility` 기반) 와
  - `:7775` `<div id="schoolsBoxT0">${_schoolsSectionHtml(p.nearbySchools, p._schoolsPending)}</div>` (`_schoolsSectionHtml` `:7522`, "카카오맵 기준")
  를 넣고, 그 뒤 지연 로드가 **같은 탭의 다른 컨테이너**를 채운다:
  - `loadFacility(p)`(`:8292`) → `#facilityBox`(`:8293`) 에 `🏢 단지 기본정보 (공공데이터포털 AptInfo)`(`:8346`)
  - `_fillDetailSchoolBoxes(r)`(`:8393`) → `#schoolBox`(`:8398`) 에 `🏫 주변 학교 (카카오맵 + 학교알리미)`(`:8428`), 그리고 `:8388` 에서 `#schoolsBoxT0` 도 다시 채운다(요약본 갱신).
  즉 요약본과 상세본이 **의도적으로 공존**하는데, 상세본이 도착한 뒤에도 요약본이 남아 중복이 된다.
- 실패 경로는 이미 있다: `loadFacility` 가 응답을 못 받으면 `fbox.style.display='none'`(`:8309`) — 이때는 요약본만 남아야 한다.

## 원칙
- 상세본(AptInfo·학교알리미 포함)이 **채워지면 요약본을 숨기고**, 상세본이 실패/부재면 요약본을 그대로 둔다. 데이터·문구·출처 표기는 바꾸지 않는다(라벨 정정은 범위 밖).

## 범위
- 수정: `frontend/index.html` 의 `showDetail`(요약 기본정보 블록에 id 부여), `loadFacility`(성공 시 요약 숨김), `_fillDetailSchoolBoxes`(`#schoolBox` 채운 뒤 요약 숨김). 그 외 금지.

## Step 1 — 요약 기본정보 블록에 id (`:7701` 부근)
`${p.facility?`<div style="background:var(--bg2);…` 로 시작하는 요약 블록의 여는 `<div` 에 `id="facilityQuickT0"` 를 추가한다(스타일·내용 불변).

## Step 2 — `loadFacility` 성공 경로 (`:8346` 이 있는 블록 끝)
`fbox.innerHTML = …` 대입 **직후**에:
```js
      // T0-DEDUP-2026-09-16 (Plan 080): 상세본(AptInfo)이 채워지면 showDetail 의 요약본은 숨긴다 — 같은 탭 중복 제거.
      try { const q = document.getElementById('facilityQuickT0'); if (q) q.style.display = 'none'; } catch(_) {}
```
실패 경로(`:8309` `fbox.style.display='none'`)는 건드리지 않는다(요약본 유지).

## Step 3 — `_fillDetailSchoolBoxes` (`:8388`·`:8398~8432`)
- `:8388` `if (t0box) t0box.innerHTML = _schoolsSectionHtml(r.nearbySchools, false);` 는 **유지**하되(상세본 실패 시 요약본이 최신이어야 함), `sbox.innerHTML = …` 대입 **직후**에:
```js
      // T0-DEDUP-2026-09-16 (Plan 080): 상세 학교 블록(#schoolBox)이 채워지면 요약 블록(#schoolsBoxT0)은 숨긴다.
      try { const q = document.getElementById('schoolsBoxT0'); if (q) q.style.display = 'none'; } catch(_) {}
```
- `sbox` 가 없거나 학교 0건이라 `sbox` 를 채우지 않는 분기에서는 요약본을 숨기지 않는다(그 분기 코드를 읽고 확인해 보고에 적는다).

## 검증·완료 기준
- `npm run verify` → `fail 0`(382). 프론트 계약 테스트가 `schoolsBoxT0`/`단지 기본정보` 문자열 개수를 세면(`grep -rn "schoolsBoxT0\|단지 기본정보" backend/test/`) 기대치를 갱신하고 보고.
- 정적 확인: `grep -c 'id="facilityQuickT0"' frontend/index.html` → 1 · `grep -c "T0-DEDUP-2026-09-16" frontend/index.html` → 2.
- 리뷰어가 배포 후 라이브에서 종합의견 탭의 "🏢 단지 기본정보"·"🏫 주변 학교" 가 각 1개인지 확인한다(실행자는 브라우저 검증 불필요).
- 커밋 1개: `fix(단지상세): 종합의견 탭 기본정보·학교 블록 중복 제거 — 상세본 도착 시 요약본 숨김 (Plan 080)`.

## STOP 조건
- `#facilityBox`/`#schoolBox` 가 t0 가 아닌 다른 탭에 있다(`grep -n 'id="facilityBox"\|id="schoolBox"'` 로 위치 확인) → 중복이 아니므로 멈추고 보고.
