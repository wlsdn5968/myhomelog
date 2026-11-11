# 194 우리 서비스에 맞는 GitHub 도구 조사 (2026-11-11)

확인 방법: GitHub 공개 API 로 60개 저장소의 별 수, 라이선스, 마지막 갱신일, 보관 여부를 조회했다(2026-11-11). 추천 후보 12개는 저장소에 공개된 보안 권고 건수도 조회했다. 패키지 크기와 최신 판은 npm 등록 정보다.
확인하지 않은 것: 각 도구의 소스 코드를 직접 감사하지는 않았다. "보안 권고 0건"은 공개된 권고가 없다는 뜻이지 결함이 없다는 뜻이 아니다.

## 1. 우리 서비스 (이번 세션에서 잰 사실)

- 무엇: 국토교통부 실거래가를 정리해 보여 주는 정보 서비스. 매수와 매도 추천은 하지 않는다.
- 구성: Node 24 와 Express 5 한 함수(Vercel Hobby), Supabase Postgres(무료 500MB), Upstash Redis(무료), 화면은 16,000줄 한 파일(1.28MB).
- 지금 쓰는 도구: helmet, express-rate-limit, @upstash/ratelimit, pino, Sentry, eslint, gitleaks(CI), dependabot, node:test 검사 1,085건.
- 약점(잰 값)
  1. CPU: 팀 한도 4시간에 내집로그만 30일 3시간 16분. 서버 시작이 요청 CPU 의 약 43%(590ms 중 모듈 읽기 475ms).
  2. 정규식 지연: 감사에서 세 번 나왔다(채팅 개인정보 검사, 측정 미들웨어, 단지 이름 비교). 전부 사람이 찾았다.
  3. 화면 검증: 높이, 겹침, 명암비를 손으로 재고 있다. 자동 검사가 없다.
  4. 화면 파일: 인라인 스타일 1,294곳, 직접 쓴 색 379개. 사용하지 않는 규칙을 가려낼 장치가 없다.
  5. CI: 액션 중 커밋 고정은 gitleaks 하나뿐이다(감사 run-2).
  6. 의존성: @sentry/node 가 dependencies 에 남아 있는데 코드에서 부르는 곳이 없다(grep 0건. 설치 용량만 차지).

## 2. 도입을 권하는 후보 (개발과 CI 에서만 돌고 운영 서버에는 들어가지 않는다)

| 도구 | 별 | 라이선스 | 마지막 갱신 | 공개 권고 | 크기 | 메우는 약점 |
|---|---|---|---|---|---|---|
| ota-meshi/eslint-plugin-regexp | 780 | MIT | 2026-11-11 | 0건 | 0.52MB | 2번. 느려질 수 있는 정규식을 린트로 잡는다 |
| zizmorcore/zizmor | 6,967 | MIT | 2026-11-11 | 1건(중간, 디버그 로그에 인증 정보 출력) | 실행 파일(Rust) | 5번. GitHub Actions 설정 점검 |
| evanw/esbuild | 40,132 | MIT | 2026-08-09 | 3건(높음 1, 중간 1, 낮음 1) | 0.14MB + 플랫폼 실행 파일 | 1번. 서버 코드를 한 파일로 묶어 시작 시간을 줄인다 |
| dequelabs/axe-core | 7,797 | MPL-2.0 | 2026-11-11 | 0건 | 3.27MB | 3번. 접근성 자동 검사 |
| microsoft/playwright | 99,852 | Apache-2.0 | 2026-11-11 | 0건 | 4.83MB + 브라우저 수백 MB | 3번. 화면 높이와 겹침을 자동으로 잰다 |
| GoogleChrome/lighthouse-ci | 7,139 | Apache-2.0 | 2026-11-03 | 0건 | 0.09MB + 의존성 | 4번. 화면 파일 크기와 성능 상한 |
| mcollina/autocannon | 8,537 | MIT | 2026-11-06 | 0건 | 0.58MB | 1번. 요청당 CPU 를 로컬에서 잰다 |
| google/osv-scanner | 11,493 | Apache-2.0 | 2026-11-11 | 0건 | 실행 파일(Go) | 의존성 취약점 점검(지금은 npm audit) |
| eslint-community/eslint-plugin-security | 2,379 | Apache-2.0 | 2026-10-30 | 0건 | 0.16MB | 위험한 코드 패턴 린트 |

권하는 순서
1. eslint-plugin-regexp: 가장 싸고 효과가 분명하다. 같은 종류의 결함을 세 번 사람이 찾았다.
2. zizmor: 한 번 돌려 CI 설정을 고친다. 설치 없이 실행 파일로 돈다.
3. esbuild: CPU 에 가장 큰 효과가 날 수 있다. 다만 배포 방식이 바뀌고 공개 권고 3건의 해당 판을 확인해야 한다. 따로 계획을 세워 로컬 측정부터 한다.
4. playwright 와 axe-core: 오늘 손으로 잰 것(목록 행 수, 버튼 겹침, 명암비)을 검사로 남긴다. 브라우저 내려받기가 커서 로컬 전용으로 시작한다.

## 3. 이미 쓰고 있거나 같은 일을 하는 것이 있어 필요 없는 것

- gitleaks(30,907), dependabot(5,843), helmet(10,748), express-rate-limit(3,315), upstash/ratelimit-js(2,052), pino(18,297): 이미 사용 중.
- renovate(23,084): dependabot 과 역할이 겹친다.
- trufflehog(29,201, AGPL-3.0): gitleaks 와 역할이 겹친다.
- node-rate-limiter-flexible(3,601), zod(44,321): 지금 구조로 충분하다. 입력 검증을 전면 개편할 때 다시 본다.

## 4. 맞지 않는 것과 이유

- uptime-kuma(93,505), umami(40,062), plausible(29,823), pghero(8,950): 따로 서버를 띄워야 한다. 유료 금지 방침과 운영 부담에 맞지 않는다.
- upptime(17,199): GitHub Actions 로 사이트를 주기적으로 부른다. 가동 감시는 이미 있고, 감시 요청이 CPU 를 쓴 것이 이번 문제였다.
- pgbadger(4,074): DB 로그 파일이 필요한데 Supabase 무료에서 로그 파일 접근은 미확인.
- pg_repack(2,326): 표 본문을 줄이는 확장. Supabase 에서 쓸 수 있는지 미확인. 지금은 인덱스 재구축으로 충분했다.
- supabase/splinter(288), index_advisor(1,709): Supabase 대시보드의 점검 기능으로 이미 제공된다.
- semgrep(17,605, LGPL-2.1), codeql(10,342), trivy(39,235), ossf/scorecard(5,821): 쓸 수 있지만 지금 규모에서는 감사 스킬과 겹친다. 저장소가 공개인지 비공개인지에 따라 무료 여부가 달라진다(미확인).
- purgecss(8,054), stylelint(11,548), HTMLHint(3,320), html-minifier-terser(481): 화면 코드 정리(4단계)를 할 때 후보. 지금 도입하면 한 파일 구조에서 오탐이 많을 수 있다(미확인).

## 5. 공격 도구로 분류한 것 (후보에서 제외)

| 도구 | 별 | 성격 |
|---|---|---|
| sqlmapproject/sqlmap | 38,926 | DB 주입 공격 자동화 |
| projectdiscovery/nuclei | 32,791 | 취약점 탐색 요청을 대량으로 보냄 |
| zaproxy/zaproxy | 16,168 | 웹 공격 대행 프록시 |
| sullo/nikto | 10,848 | 웹 서버 취약점 탐색 |

- 악성 코드는 아니고 보안 점검에 쓰는 공개 도구다. 다만 대상 사이트에 공격성 요청을 보낸다.
- 우리 운영 사이트에 돌리면 CPU 와 Kakao, 국토부 호출 한도를 깎고, Vercel 이용 정책에 걸릴 수 있다. 시험 환경이 따로 없어서 쓰지 않는다.
- 2절의 추천 후보에는 공격 도구가 없다. 전부 우리 코드나 설정을 읽는 도구이거나 로컬에서 도는 도구다.

## 6. 참고로 본 것

- cloudflare/security-audit-skill(69,930, MIT): 이번에 세 번 썼다.
- epoko77-ai/im-not-ai(6,510, MIT): 문구 정리에 썼다.
- OWASP/CheatSheetSeries(34,019): 문서 모음.

## 7. 진행 결과 (2026-11-11, 운영자 기준: 서비스에 문제를 만들 수 있는 것은 제외)

| 항목 | 결정 | 이유와 확인 |
|---|---|---|
| eslint-plugin-regexp 3.3.3 | 도입 | 개발 의존성. 기존 코드에서 106건(운영 코드 74건)이 걸려 오류로 켜지 않고 기준선 방식으로 넣었다. scripts/check-regexp-ratchet.js 가 파일별 건수를 scripts/regexp-baseline.json 과 비교해 늘면 실패한다. 채팅 사고와 같은 정규식을 넣어 막히는 것을 확인했다. verify 와 CI 에 연결. |
| CI 액션 커밋 고정 | 진행 | zizmor 를 받는 대신 직접 했다. actions/checkout v7 은 3d3c42e, actions/setup-node v7 은 949feb2 (git ls-remote 로 조회). dependabot 의 github-actions 설정이 주간으로 갱신한다. |
| follow-redirects 1.16.1 -> 1.16.3 | 진행(조사 중 발견) | npm audit 에 높음 1건(GHSA-mrwp-f3q8-3g9p, axios 의 전이 의존성). 두 잠금 파일 모두 올렸고 운영 의존성 취약점 0건. 서버 로드 확인. |
| esbuild | 제외 | 배포 방식이 바뀌고 공개 권고에 높음 등급이 있다. |
| zizmor | 제외 | 받은 실행 파일을 돌려야 하고 공개 권고가 1건 있다. |
| playwright, axe-core | 제외 | 브라우저 수백 MB 내려받기. 지금은 앱 내 미리보기로 재고 있다. |
| @sentry/node 제거 | 제외 | 보안 검사(components-guard)가 그 의존성의 판 번호를 기준으로 삼는다. 운영 의존성 목록이 바뀌는데 CPU 나 DB 이득이 없다. |
| lighthouse-ci, autocannon, osv-scanner, eslint-plugin-security | 보류 | 지금 필요가 분명하지 않다. |

남은 일: 기준선 74건을 입력 길이가 묶여 있는지 파일별로 확인해 줄인다(백엔드 23개 파일, 화면 스크립트 1개).

## 8. 기준선 74건 분류 결과 (2026-11-11)

- 분류: 고침 권고 3건(수정 지점 2곳), 낮음 64건, 해당 없음 7건. 건별 기록은 세션 임시 폴더의 classification.json 에 있었고 요지는 아래와 같다.
- 고친 것
  - 단지 검색어(GET /api/search/apt 의 q): 길이 상한이 없었다. 가운데 공백이 긴 16KB 검색어가 요청당 약 95ms(로컬 재현). 100자로 자른다.
  - 채팅 말풍선의 제목 변환 정규식(화면): 자기 브라우저만 멈추는 문제. 20,000자 공백에 342ms 였고 0.1ms 가 됐다. 예시 8개의 출력이 같음을 확인했다.
- 낮음으로 둔 이유(대표): 메시지 1,000자 상한, 이름 100자 상한, 지역 40자 상한이 앞에서 걸리거나, DB 값과 외부 API 응답, 예약 작업 내부 값이다.
- 미확인: Sentry 로 보내는 문자열 정리(sentry.js:164)에 들어가는 문자열 길이, DB 와 외부 응답의 이름 길이 상한, 채팅 session 문자열의 개별 상한(공백 축약으로 지연은 막았다).
- 기준선은 73건이 됐다.
