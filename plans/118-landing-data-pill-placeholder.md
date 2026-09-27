# 118 — 랜딩 정적 건수 "277K · 10K · 27만 · 1만" 을 사실인 하한 표기로 (XS)

**작성 기준 커밋**: `5d53022` (2026-09-27) · **출처**: `plans/114-direction-review-2026-09-26.md` F4(사실과 다른 문구) 잔여 항목 · **운영자 승인 2026-09-27**("권고대로 진행해줘" — 후속표 3번)
**성격**: 코드 XS(정적 문자열 6개 + 주석 1줄) + 신규 테스트 1파일. DB 변경 0. 실행자: haiku.

## 사실 (계획자 실측 2026-09-27)
- `frontend/index.html` 에 실거래·단지 건수가 **정적으로** 박힌 곳 3줄:
  - `:1825`(랜딩 `hero-tag`)·`:2990`(앱 `lv-tag`): `DATA · <span class="jstxk">277K</span> · <span class="japtk">10K</span> · DAILY`
  - `:2992`(랜딩 부제): `국토부 실거래 <span class="jstxm">27만</span>건 + KAPT <span class="japtm">1만</span> 단지 + …`
- 실제 값은 `/api/health.dataCounts` = `tx 1,766,831 / apt 14,682`(2026-09-27). 렌더 뒤 `_applyStatTags()`(`index.html:12751` 부근)가 `window._dataCounts` 로 `.jstxk/.japtk` 를 `K()`(→ `1767K`/`15K`), `.jstxm/.japtm` 를 `M()`(→ `176만`/`1만`) 으로 덮어쓴다.
- `_applyStatTags` 는 `c.tx` 가 없으면 **아무것도 하지 않는다** → health 실패·느린 네트워크·JS 실행 전 첫 페인트·크롤러에게는 **6배 작은 옛 숫자**(277K·27만)가 그대로 보인다. 주석 "실패 시 정적 fallback 유지" 가 그 설계인데 그 fallback 이 사실과 다르다(114 F4 유형).

## 결정 — "—" 가 아니라 **사실인 하한(lower bound)** 을 정적 값으로
- 실거래 누적은 단조 증가(원본+이력 합계, 자르기는 합계를 바꾸지 않는다)·단지 수는 14,682 로 1만 이상. 따라서 `1.7M+`·`170만+` 은 앞으로도 사실이고, `10K+`·`1만+` 은 단지 수가 1만 아래로 떨어지지 않는 한 사실이다. JS 가 살아 있으면 정확한 값으로 덮어쓴다.
- 부제에 "—건" 이 보이는 것보다 낫고, 유지보수 비용 0(하한이라 갱신 불필요).

## 변경 (파일 2개)
1. `frontend/index.html` 정적 값 6개 — span·class·주변 텍스트는 그대로, 텍스트만:
   - `:1825` 와 `:2990` 두 곳: `<span class="jstxk">277K</span>` → `<span class="jstxk">1.7M+</span>` · `<span class="japtk">10K</span>` → `<span class="japtk">10K+</span>`
   - `:2992`: `<span class="jstxm">27만</span>` → `<span class="jstxm">170만+</span>` · `<span class="japtm">1만</span>` → `<span class="japtm">1만+</span>`
2. `frontend/index.html` — `_applyStatTags` 위 주석 한 줄:
   `// DATA-COUNTS-2026-06-14: /api/health.dataCounts 로 랜딩/배너 건수 동적 채움(하드코딩 stale 방지). 실패 시 정적 fallback 유지.` →
   `// DATA-COUNTS-2026-06-14: /api/health.dataCounts 로 랜딩/배너 건수 동적 채움. PLACEHOLDER-2026-09-27 (Plan 118): 실패 시 남는 정적 값은 "1.7M+ / 10K+ / 170만+ / 1만+" 하한 표기 — 옛 277K·27만 은 실제 1,767K·176만 과 달랐다(사실과 다른 숫자를 남기지 않는다).`
3. 신규 테스트 `backend/test/landing-data-pill-placeholder.test.js`(패턴: `backend/test/mobile-tools-sheet.test.js` — `node:test` + `fs.readFileSync` 로 `frontend/index.html` 을 읽어 문자열 계수):
   `277K` 0회 · `27만</span>` 0회 · `<span class="jstxk">1.7M+</span>` 정확히 2회 · `<span class="japtk">10K+</span>` 정확히 2회 · `<span class="jstxm">170만+</span>` 1회 · `<span class="japtm">1만+</span>` 1회 · `PLACEHOLDER-2026-09-27` 1회 · `function _applyStatTags` 1회.

## 하지 말 것 / STOP
- `_applyStatTags` 의 로직·`K()`/`M()` 변경 금지. 위 3줄 외에 `jstxk/japtk/jstxm/japtm` 에 정적 숫자가 박힌 곳이 더 있으면 바꾸지 말고 STOP 보고.
- `277K`·`27만` 이 index.html 밖(OG 이미지 라우트·문서)에 또 있으면 바꾸지 말고 보고.

## 완료 기준
- `npm run verify` 전부 통과, backend test **510 pass**(509 + 신규 1).
- 병합·배포 후 리뷰어 라이브: `curl -s https://myhomelog.vercel.app/ | grep -c "277K\|27만"` → 0 · 렌더 후 `.jstxk` 텍스트 `1767K`, `.jstxm` `176만`(health 정상 시).

## 유지보수 메모
- 정확한 숫자를 정적으로 다시 넣지 말 것 — 숫자의 출처는 `/api/health.dataCounts` 뿐이다. 정적 값은 하한("+")만 허용.

## 실행 기록 (2026-09-27)
- DONE a627f36 — haiku 실행자, verify **517 pass**(신규 테스트 파일이 단언 8개를 별도 `test` 로 두어 509+8). 실행자가 **계획서 모순을 잡았다**: 주석에 "옛 277K·27만" 을 쓰라고 하면서 테스트는 `277K` 0회를 요구 → 주석을 "이전 정적값(약 1/6 수준)" 으로 바꿔 해결(계획자 오류, 승인). 라이브 확인은 README 118 행.
