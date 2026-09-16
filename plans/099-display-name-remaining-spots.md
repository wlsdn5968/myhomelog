# 099 — 표시 이름 정책(090)이 빠진 프론트 5지점: 리스크 탭 제목·단지 비교 헤더·단지정보 "단지명" 행·지도 마커 팝업 2종·유사 단지 목록

**작성 기준 커밋**: `68ad892` (2026-09-16) · 우선순위 P2(표시 일관성, 라이브 실측) · 작업량 XS · 의존: 090(병합·배포됨)

## 전제 확인 (계획자가 라이브·코드로 확인)
- 라이브(배포 68ad892) 상세 모달 리스크 탭: `종합 리스크: 충무주공(872) 조건(…)` / `(50-5) 조건(…)` — 모달 제목은 `충무주공 (872번지)`·`공항동 50-5번지 단지 (이름 미등록)` 인데 리스크 문장만 원문. 단지 비교 모달 헤더도 `충무주공(872)`.
- 헬퍼 `frontend/index.html:12963` `function _dispAptName(name, umdNm, kaptName)` — 함수 선언이라 파일 어디서든 호출 가능(090 에서 6지점에 이미 사용).
- 남은 원문 표시 지점(모두 **표시 텍스트**이며 키·API 인자가 아님):
  | # | 줄 | 현재 | 용도 |
  |---|---|---|---|
  | 1 | `:11356` | ``summary:`${p.aptName||'이 단지'} 조건(연식·세대수·규제 여부)을 반영한 …` `` | 리스크 탭 제목 문장 |
  | 2 | `:7329` | `<div class="cmp-apt">${_escHtml(r.aptName||'')}</div>` | 단지 비교 헤더 |
  | 3 | `:8097` | `<tr><td>단지명</td><td>${_v(p.aptName)}</td></tr>` | 단지정보(KAPT) 표 첫 행 |
  | 4 | `:11818` | `<div style="font-weight:700">${_escHtml(p.aptName)}</div>` | 네이버 지도 인기 마커 InfoWindow |
  | 5 | `:11852` | `<div style="font-weight:700">${_escHtml(p.aptName)}</div>` | Leaflet 폴백 마커 팝업 |
  | 6 | `:12062` | `<b>${_escHtml(r.aptName)}</b>` | 검색 "비슷한 이름" 목록(클릭은 `goSearchResult(r)` 객체 전달 — 텍스트만 바꿔도 안전) |
- 인기 마커 객체 `p` 는 `/api/search/popular` 행이라 `displayName` 이 있다(090). 검색 행 `r` 도 `displayName` 이 있다. 리스크·단지정보의 `p` 는 상세 모달의 현재 단지 객체(`umdNm` 보유).

## 범위
- 수정: `frontend/index.html` 6줄(위 표), `backend/test/frontend-contracts.test.js` test 1개 추가. 그 외 금지. `p.aptName` 을 키·API 호출에 쓰는 코드는 손대지 않는다.

## Step 1 — 6지점 치환 (각각 해당 줄만)
1. `:11356` → ``summary:`${_dispAptName(p.aptName, p.umdNm)||'이 단지'} 조건(연식·세대수·규제 여부)을 반영한 일반 리스크 정리예요 — 매수 판단이 아닌 확인 목록입니다.`,``
2. `:7329` → `<div class="cmp-apt">${_escHtml(r.displayName || _dispAptName(r.aptName, r.umdNm) || '')}</div>`
3. `:8097` → `<tr><td>단지명</td><td>${_v(_dispAptName(p.aptName, p.umdNm))}</td></tr>`
4. `:11818` → `<div style="font-weight:700">${_escHtml(p.displayName || _dispAptName(p.aptName, p.umdNm))}</div>`
5. `:11852` → 4 와 동일 치환.
6. `:12062` → `<b>${_escHtml(r.displayName || _dispAptName(r.aptName, r.umdNm))}</b>`
각 줄 끝(또는 바로 위 줄)에 주석 `// DISP-NAME-2026-09-16 (Plan 099)` 는 **템플릿 문자열 안에는 넣지 말 것**(HTML 로 새어 나간다) — 1번(JS 객체 리터럴)에만 위 줄 주석으로 붙이고 나머지는 주석 없이 치환한다.

## Step 2 — 계약 테스트 (`frontend-contracts.test.js` 파일 끝)
```js
test('Plan 099 — 표시 이름 정책이 리스크 제목·비교 헤더·단지정보 단지명·마커 팝업·유사 단지 목록에도 적용된다', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.ok(html.includes("summary:`${_dispAptName(p.aptName, p.umdNm)||'이 단지'} 조건(연식·세대수·규제 여부)"), '리스크 탭 제목이 원문 단지명을 쓴다');
  assert.ok(html.includes('<div class="cmp-apt">${_escHtml(r.displayName || _dispAptName(r.aptName, r.umdNm) || \'\')}</div>'), '단지 비교 헤더가 원문 단지명을 쓴다');
  assert.ok(html.includes('<tr><td>단지명</td><td>${_v(_dispAptName(p.aptName, p.umdNm))}</td></tr>'), '단지정보 표 단지명이 원문을 쓴다');
  assert.equal((html.match(/<div style="font-weight:700">\$\{_escHtml\(p\.displayName \|\| _dispAptName\(p\.aptName, p\.umdNm\)\)\}<\/div>/g) || []).length, 2, '마커 팝업 2종(네이버·Leaflet)이 표시 이름을 써야 한다');
  assert.ok(html.includes('<b>${_escHtml(r.displayName || _dispAptName(r.aptName, r.umdNm))}</b>'), '유사 단지 목록이 원문을 쓴다');
  assert.equal((html.match(/<div style="font-weight:700">\$\{_escHtml\(p\.aptName\)\}<\/div>/g) || []).length, 0, '원문 단지명 팝업이 남아 있다');
});
```

## 검증·완료 기준
- `npm run verify` → `fail 0`, 테스트 422 + 1(lint 가 인라인 JS 를 검사하므로 `_dispAptName` 미정의 같은 실수는 no-undef 로 잡힌다).
- 회귀 주입(수행 후 원복): 4번 줄을 원문(`_escHtml(p.aptName)`)으로 되돌리면 test fail.
- 리뷰어 라이브: 상세 모달 리스크 탭 `종합 리스크: 충무주공 (872번지) 조건…`, 비교 헤더 `충무주공 (872번지)`.
- 커밋 1개: `fix(단지명): 표시 이름 정책 잔여 6지점 — 리스크 제목·비교 헤더·단지정보·마커 팝업·유사 목록 (Plan 099)`.

## STOP 조건
- 위 6줄 중 현재 코드가 표의 "현재" 와 다르다 → 그 줄을 보고하고 STOP(다른 줄은 진행).
