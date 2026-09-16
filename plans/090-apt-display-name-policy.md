# 090 — 단지 표시 이름 정책: 지번만 있는 이름("(50-5)")·지번 괄호 접미("충무주공(872)")를 모든 노출 지점에서 정리하고, 이름 미등록 단지는 인기 순위에서 제외

**작성 기준 커밋**: `dc5a30f` (2026-09-16) · 우선순위 **P1** · 작업량 M · 의존: 없음

## 전제 확인 (계획자가 DB·라이브·코드로 확인한 것)
- **DB 실측**(`molit_apt_index` 22,969행): 이름이 지번/괄호뿐인 단지 **96개**(`(50-5)` 공항동 36건 · `(207-3)` 서동 33건 · `(63-21)` …, 합계 거래 201건), 그중 **40개는 `apt_master.molit_aliases` 로 KAPT 정식명을 찾을 수 있다**(예 `(807-1)` 구로동 → 구로금호어울림 A15283803). 이름 뒤에 지번 괄호가 붙은 단지 **791개**(`충무주공(872)`, `한진(609-1)`, `장안현대홈타운(336)` …). 라이브 인기 TOP12 의 11번이 `(50-5)`(강서구 공항동, apt_seq `11500-10189`, 2026년 준공 신축 — KAPT 미등록).
- **원인**: MOLIT 원문 `apt_name` 이 어느 계층에서도 정제되지 않는다. `popularService.js:128~134` `_cleanName` 은 앞의 "동," 만 제거 · `search.js:496~508`(molit 행)·`:532~542`(master 행) · `chatDataRouter.js:342/356/396/406/420/431/438/546` · `aptPage.js:130(aptName)/:429(같은 동 링크)` · `regionPage.js:288` · `briefing.js:165` · `ogImage.js:37~60` · 프론트 `index.html:12065(자동완성)/11775~11776(마커)/7574·7606(모달 제목)/7020(목록)/9490(관심단지)/5573(브리핑 TOP5)` — 194곳 참조 중 정제 0곳(조사 에이전트 전수 + 계획자 재확인).
- 기존 유틸은 지번 괄호를 다루지 않는다: `backend/utils/aptName.js` `baseAptName`(동·단일 문자 괄호만, `:49~53`), `backend/utils/aptNameMatch.js` `normalizeName`(공백·%·_ 만).

## 정책 (표시 전용 — `aptName`·`aptSeq`·조회 키는 절대 바꾸지 않는다)
1. **KAPT 정식명이 있으면 그것**(`apt_master.apt_name`; 검색 master 행·상세 facility·별칭 역조회로 알 때).
2. **이름 미등록**(정규식 `^\(?\s*\d+(?:-\d+)?\s*\)?$` 또는 `^\([^)]*\)$` 또는 한글·영문 2자 미만) → `"{umdNm} {지번}번지 단지 (이름 미등록)"` 예: `공항동 50-5번지 단지 (이름 미등록)`. 지번은 인자 `jibun` 이 없으면 이름에서 `\d+(-\d+)?` 를 뽑는다.
3. **지번 괄호 접미** `\s*\(\s*(\d+(?:-\d+)?)\s*\)\s*$` → `"{base} ({지번}번지)"` 예: `충무주공 (872번지)` — 지번은 같은 동의 동명 단지를 구분하는 값이라 **지우지 않고 뜻을 밝힌다**.
4. **인기 순위**(TOP12·브리핑 TOP5·챗 인기)에서 2번(이름 미등록)은 **제외**(KAPT 이름으로 대체된 경우는 유지). 검색·상세·공개 페이지에서는 제외하지 않고 2번 라벨로 노출(실거래는 사실이므로).

## 범위
- 신규: `backend/utils/aptDisplayName.js`, `backend/test/apt-display-name.test.js`.
- 수정: `backend/services/popularService.js`, `backend/routes/search.js`, `backend/services/chatDataRouter.js`, `backend/routes/aptPage.js`, `backend/routes/regionPage.js`, `backend/routes/briefing.js`(TOP5 렌더), `backend/routes/ogImage.js`, `frontend/index.html`(위 6지점 + 헬퍼 1개).
- 금지: `molit_apt_index`·DB·`aptName` 값 변경, 검색 매칭 로직 변경, 관심단지 저장 형식 변경.

## Step 1 — `backend/utils/aptDisplayName.js`
```js
'use strict';
// APT-DISPLAY-NAME-2026-09-16 (Plan 090): 표시 전용. 조회 키(aptName/aptSeq)는 절대 이 결과로 바꾸지 않는다.
const UNNAMED_RE = /^\(?\s*\d+(?:-\d+)?\s*\)?$/;
const PAREN_ONLY_RE = /^\([^)]*\)$/;
const JIBUN_SUFFIX_RE = /\s*\(\s*(\d+(?:-\d+)?)\s*\)\s*$/;
function isUnnamedApt(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return true;
  if (UNNAMED_RE.test(s) || PAREN_ONLY_RE.test(s)) return true;
  return s.replace(/[^가-힣A-Za-z]/g, '').length < 2;
}
function displayAptName(name, { umdNm, jibun, kaptName } = {}) {
  if (kaptName && String(kaptName).trim()) return String(kaptName).trim();
  const s = String(name == null ? '' : name).trim();
  if (isUnnamedApt(s)) {
    const jb = (jibun && String(jibun).trim()) || (s.match(/\d+(?:-\d+)?/) || [''])[0];
    return [umdNm ? String(umdNm).trim() : '', jb ? `${jb}번지` : '', '단지 (이름 미등록)'].filter(Boolean).join(' ');
  }
  const m = s.match(JIBUN_SUFFIX_RE);
  return m ? `${s.slice(0, m.index).trim()} (${m[1]}번지)` : s;
}
module.exports = { isUnnamedApt, displayAptName, UNNAMED_RE, JIBUN_SUFFIX_RE };
```
프론트에도 **같은 두 정규식·같은 규칙**의 `_dispAptName(name, umdNm, kaptName)` 을 넣는다(`_fmtSgg` 근처). 드리프트 방지: 테스트에서 `frontend/index.html` 소스에 `UNNAMED_RE`·`JIBUN_SUFFIX_RE` 의 **정규식 리터럴 문자열이 그대로** 들어 있는지 단언한다.

## Step 2 — 백엔드 적용 지점
- `popularService.js`: `_row(t, c)` 에 `displayName: displayAptName(_cleanName(t.apt_name), { umdNm: t.umd_nm })` 추가. `buildPopularResults(limit)` 는 후보를 `limit + 6` 으로 넉넉히 만든 뒤 **`isUnnamedApt(_cleanName(name))` 인 행을 버리고** 상위 `limit` 개를 돌려준다(21일 필터·시군구 캡 뒤, 저장 전). `readPopularSnapshot` 도 반환 전에 같은 필터·`displayName` 부여(옛 스냅샷 대비).
  - 별칭 역조회로 KAPT 이름을 붙이는 건 **이 계획에서 하지 않는다**(인기 후보 ≤ 18개라 가능하지만 스냅샷·캐시 경로가 3개라 범위가 커진다 — 후속).
- `search.js`: molit 행(`:496~508`)에 `displayName: displayAptName(grp.baseName, { umdNm: row.umd_nm })`, master 행(`:532~542`)에 `displayName: base`(이미 KAPT 정식명).
- `chatDataRouter.js`: 위 8개 지점의 `aptName` 표시를 `displayAptName(name, { umdNm })` 로 감싼다(`displayName` 변수 `:420` 은 `am.apt_name` 이면 그대로, molit 이면 감싼다). 후속 칩 `:438` 은 **검색 키가 되므로 원문 유지**.
- `aptPage.js`: `loadAptFacts` 의 `aptName`(`:130`) 은 조회 키라 유지하고, **표시용** `displayName = displayAptName(aptName, { umdNm: umd, kaptName: (apt_master 매칭 row && row.apt_name) })` 를 만들어 h1(`:435`)·title(`:447`)·desc(`:458~461`)·OG 카드(`ogImage.js` `card.title`)에 쓴다. "같은 동 다른 단지" 링크 텍스트(`:429`)도 `displayAptName(r.apt_name, { umdNm: r.umd_nm })`.
- `regionPage.js:288` 링크 텍스트, `briefing.js:165` TOP5 이름: 같은 헬퍼(브리핑은 `p.displayName || displayAptName(p.aptName, {umdNm:p.umdNm})`).

## Step 3 — 프론트 적용 지점(표시만)
`_dispAptName` 헬퍼 추가 후: 자동완성 `:12065` 표시 텍스트·aria-label, 마커 라벨 `:11775~11776`(`_nm` 을 `p.displayName || _dispAptName(p.aptName, p.umdNm)`), 모달 제목 `:7574`·`:7606`, 목록 `:7020`, 관심단지 `:9490`(`_dispAptName(b.aptName, b.umdNm)`), 브리핑 TOP5 `:5573`. **`p.aptName` 을 API 호출·키·저장에 쓰는 코드는 그대로.**

## Step 4 — 테스트 `backend/test/apt-display-name.test.js`
- `displayAptName('(50-5)', {umdNm:'공항동'})` → `공항동 50-5번지 단지 (이름 미등록)` · `('807-41',{umdNm:'구로동'})` → `구로동 807-41번지 단지 (이름 미등록)` · `('(807-1)',{umdNm:'구로동',kaptName:'구로금호어울림'})` → `구로금호어울림` · `('충무주공(872)')` → `충무주공 (872번지)` · `('한진(609-1)')` → `한진 (609-1번지)` · `('공릉풍림아이원')` → 그대로 · `('풍림아파트A')` → 그대로(괄호 없음) · `('(해오름)')` → `단지 (이름 미등록)`(지번 없음).
- `isUnnamedApt`: `'(50-5)'` true · `'탑'` true(1자) · `'e편한세상부평그랑힐스'` false.
- 인기: `buildPopularResults` 를 스텁 admin 으로 실행해 `(50-5)` 행이 결과에서 빠지고 나머지가 limit 을 채우는지(기존 popular 테스트 하네스 `backend/test/*popular*` 를 찾아 재사용).
- 드리프트: `frontend/index.html` 에 두 정규식 리터럴 포함 단언.
- 공개 페이지: `apt-page.test.js` 하네스로 인덱스 행 `apt_name:'(50-5)', umd_nm:'공항동'` 일 때 h1 이 `공항동 50-5번지 단지 (이름 미등록) 실거래가` 인지.

## 검증·완료 기준
- `npm run verify` `fail 0`(392 + 신규 ≥ 8).
- 회귀 주입: 인기 필터 제거 → 인기 테스트 fail · 프론트 정규식 리터럴을 바꾸면 드리프트 테스트 fail.
- 리뷰어 라이브: `/api/search/popular` 에 이름 미등록 단지 0건 + `displayName` 필드 · `/apt/11500-10189` h1 · `/api/search/apt?q=충무주공` 의 `displayName` `충무주공 (872번지)` · 챗 "충무주공 시세" 응답 첫 줄.
- 커밋: `feat(단지명): 표시 이름 정책 — 이름 미등록 단지 라벨·지번 괄호 명시·인기 순위 제외 (Plan 090)`.

## STOP 조건
- 프론트 6지점 중 `p.aptName` 이 표시와 키를 **한 표현식에서 겸용**하는 곳(예: `data-apt="${p.aptName}"` 와 텍스트가 같은 템플릿)은 텍스트만 바꾸고 속성은 유지 — 분리가 불가능한 구조면 그 지점만 보고하고 건너뛴다(STOP 아님).
- 인기 스냅샷 하네스가 없어 인기 테스트를 못 쓴다 → 단위 테스트(필터 함수 분리)로 대체하고 보고.
