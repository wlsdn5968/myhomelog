# backend/test — 테스트 배치 규칙 (Plan 066)

`characterization.test.js`(10,056줄·327 test 단일 파일)를 도메인별로 분할했다(Plan 066, 2026-09-06).
**분할은 이동이다 — 동작·테스트 이름·개수는 하나도 바뀌지 않았다.**

## 왜 나눴는가

단일 파일에 여러 세션이 동시에 "파일 끝에 추가"하는 패턴이 반복되면서, 어떤 라운드는
**머지 14회 중 14회가 충돌**했다(같은 꼬리 `});` 를 공유). 도메인별로 나누면 서로 다른
주제를 다루는 세션끼리는 다른 파일을 건드리게 되어 충돌 표면이 줄어든다.

## 새 테스트를 추가할 때

1. 주제가 아래 기존 파일 중 하나와 맞으면 **그 파일 끝에 추가**한다.
2. 맞는 파일이 없으면 **새 `<topic>.test.js` 파일을 만든다** — 파일 끝에 계속 이어붙이지 말 것.
   `node --test`(backend/package.json 의 `"test": "node --test"`)는 `backend/test/` 안의
   테스트 파일을 자동 탐색하므로, 새 파일을 만들기만 하면 별도 등록 없이 실행된다.
3. 여러 파일에서 함께 쓰는 목/스텁/픽스처 헬퍼(예: `_mockRes`, `_withBillingStub`,
   `_shareHandler`, `_withRecStubs` 같은 것)는 `../testSupport/_helpers.js` 에 추가하고
   `const { 이름 } = require('../testSupport/_helpers');` 로 가져다 쓴다. 한 파일에서만
   쓰는 헬퍼는 그 파일 안에 그대로 둬도 된다.

## 현재 도메인 파일

| 파일 | 주제 |
|---|---|
| `regulation-tax.test.js` | LTV·취득세·규제지역 판정 (computeLTV·calcTotalCost 핵심 + 프론트 계약) |
| `billing.test.js` | 결제(confirm·webhook·refund·payments·config·checkout) |
| `auth.test.js` | JWT·삭제유예·카카오 OAuth·admin 판정 |
| `cron-observability.test.js` | cron 배선·인증·관측 기록·stale 경보 |
| `molit-ingest.test.js` | MOLIT 파싱·데이터고커 릴레이·지역 라벨 |
| `geocode.test.js` | 지오코드 캡·본번 추출·호출 배선 |
| `facility.test.js` | KAPT/건축물대장 facility·세대수·주차·부속시설 |
| `search-chat.test.js` | chatDataRouter·AI 도우미 시세·검색 자동완성·splitRegionName |
| `recommend.test.js` | 추천 필터·점수·후보 컷·광역 검색·관심도 |
| `share-ssr.test.js` | `/share` 서버사이드 치환·XSS 방어 |
| `report.test.js` | 보고서 후보풀·워터마크·대표평형·대출계산 |
| `og-image.test.js` | OG 카드·폰트·렌더·라우트 |
| `popular.test.js` | 인기 단지 집계 창·스냅샷 |
| `transactions-window.test.js` | KST 시간 경계·거래 창 계산 |
| `rent-jeonse.test.js` | 전월세 실거래 조회·캐시·예열 cron |
| `apt-page.test.js` | 공개 단지 페이지(단지정보 카드·desc·label) |
| `frontend-contracts.test.js` | 위 주제에 깔끔히 안 들어가는 프론트·품질·보안헤더·SEO·PWA 등 계약 테스트 |

## `../testSupport/_helpers.js` 가 왜 `test/` 밖에 있는가

Node 의 `node --test`(인자 없이 실행 시 재귀 탐색)는 **디렉터리 이름이 정확히 `test`인
곳 아래의 모든 `.js` 파일**을 테스트로 간주한다(하위 디렉터리 포함, 파일명이 `*.test.js`
가 아니어도, 밑줄로 시작해도 무관). 실측: `backend/test/_helpers.js` 를 그대로 두면
`node --test` 결과가 328(327 실제 테스트 + `_helpers.js` 자신이 "test\_helpers.js" 라는
빈 통과 항목으로 잡힘)로 나온다. `backend/testSupport/_helpers.js` 로 옮기면 327 로
정확히 맞고, `--test-reporter=tap` 출력에 `_helpers`/`testSupport` 언급이 전혀 없다
(실측 확인 완료). **헬퍼 파일은 앞으로도 `backend/test/` 안에 두지 말 것.**
