# 126 — 구성요소 최신화(2026-09-28) + CDN 무결성(SRI) + 런타임 고정 + HSTS 1년

**작성 기준 커밋**: `78901fb` (2026-09-28) · **운영자 요청 2026-09-28**: "우리 서비스를 구성하고 있는 구성요소들을 다 업데이트 해줘. 보안적으로도 문제 없는지 제대로 확인해주고, 가장 최신 시스템으로"
**성격**: 의존성·설정 S~M. 코드 로직 변경 0(버전·URL·헤더·SRI 속성만). 신규 테스트 1.

## 1. 전수 점검 결과 (계획자 실측·공식 출처 교차 확인, 2026-09-28)
| 구성요소 | 현재 | 최신 | 판단 |
|---|---|---|---|
| @anthropic-ai/sdk | 0.125.0 | 0.128.0 | 올림 — 0.126~0.128 CHANGELOG breaking 0, 사용 표면(`new Anthropic`·`messages.create`) 불변 |
| @sentry/node | 10.74.0 | 10.75.3 / 11.0.0 | **10.75.3 까지** — 11.0.0(2026-09-23, 패치 0건)은 `sendDefaultPii` 제거 + `dataCollection` 미설정 시 IP·쿠키·요청/응답 본문·DB 쿼리 **기본 수집**(공식 MIGRATION.md 표). 별도 계획으로 |
| @supabase/supabase-js | 2.116.0 | 2.117.2 | 올림 — breaking 0, `createClient` 옵션 불변 |
| @upstash/ratelimit | 2.0.8 | 2.2.0 | 올림 — `slidingWindow`·`limit()` 반환 불변(수정은 cachedFixedWindow·tokenBucket) |
| @upstash/redis | 1.38.4 | 1.39.0 | 올림 — 신규 명령 추가뿐 |
| dotenv | 17.4.2 | 18.0.4 | 올림(메이저) — 제거된 것(프리로드 `dotenv/config`·`.env.vault`)을 우리는 안 쓴다. 사용처는 `require('dotenv').config({quiet:true})` 뿐(`backend/server.js:13·19`, `backend/drizzle.config.js:13`) |
| drizzle-orm | 0.45.2 | 0.45.3 | 올림 |
| satori | 0.33.4 | 0.33.5 | 올림 — **`overrides.satori.fflate = "0.7.5"` 유지 필수**(0.33.5 도 fflate 0.7.3 고정 — GHSA-px8p-9vwx-vf98, `plans/075`) |
| eslint(dev, 루트) | 10.10.0 | 10.11.0 | 올림 |
| drizzle-kit(dev, backend) | 0.31.10 | 0.31.11 | 올림 — audit 중간 4건(esbuild 개발 서버 GHSA-67mh-4wv8-2f99·GHSA-g7r4-m6w7-qqqr)은 **상류 수정판 없음**, 개발 서버를 켤 때만 성립, 배포(루트 package.json)에 없음, CI 운영 감사(`--omit=dev`) 0건 → 수용·기록 |
| Node 런타임 | engines `>=22`, Vercel 설정 24.x | 24.x(Active LTS) | **engines 를 `24.x` 로 고정** — Vercel 문서: engines 가 프로젝트 설정보다 우선, 열린 범위는 지원 최고 메이저로 해석 → Vercel 이 26.x 를 추가하는 순간 무검증 자동 승격 위험. 26.x 는 2026-10-28 LTS 전환 후 별도 |
| 브라우저 Sentry(CDN) | 10.69.0, SRI 없음 | 10.75.3 | 백엔드와 같은 10.75.3 + SRI |
| 브라우저 supabase-js(CDN) | 2.105.4 `dist/umd/supabase.min.js`(jsDelivr **자동 압축본** — npm 원본 아님), SRI 없음 | 2.117.2 | npm 원본 `dist/umd/supabase.js`(이미 압축됨) + SRI |
| Leaflet(CDN, 지도 폴백) | 1.9.4, SRI 없음 | 1.9.4(최신) | 버전 유지 + js·css SRI |
| HSTS | 정적 경로 180일(`vercel.json`), API 1년(helmet) | — | 정적도 1년으로 통일 |
| CI 액션 | checkout v7·setup-node v7·gitleaks v3.0.0(SHA 고정, 태그 일치) | 동일 | 변경 없음 |
| Postgres | 17.6(Supabase 이미지 17.6.1.105), 확장 8개 전부 최신 | — | Supabase 관리형 — 운영자 대시보드에서 업그레이드 제공 여부 확인(별도) |

## 2. SRI 값 (계획자 계산·검증 — 글자 그대로 쓸 것)
- `@supabase/supabase-js@2.117.2/dist/umd/supabase.js` → `sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok` (npm tarball sha512 무결성 검증 → 파일 추출 → jsDelivr 바이트와 일치 217,945B)
- `leaflet@1.9.4/dist/leaflet.js` → `sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH` (같은 방식, unpkg 일치 147,552B)
- `leaflet@1.9.4/dist/leaflet.css` → `sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H` (14,806B)
- `browser.sentry-cdn.com/10.75.3/bundle.tracing.min.js` → `sha384-ENViSvvjnFnHdP3y+sWEP8HvdBvPRNPHZiqJRjV8Sdf7Ya0dURGrhZTi9ZD3Q02p` (Sentry CDN 바이트 149,147B — 이 번들은 npm 에 없다. 같은 계산으로 얻은 11.0.0 값이 Sentry 공식 게시값과 글자까지 일치해 계산 방식 검증)
- 세 CDN 모두 `Access-Control-Allow-Origin: *`(SRI 에 필요) 실측.

## 3. 변경 (실행자)
**워크트리 준비**: 이 계획은 의존성을 설치하므로 `node_modules` **정션을 쓰지 않는다**. 워크트리 루트와 `backend/` 에서 먼저 `npm ci` 로 기준선을 만든 뒤 작업한다.
1. `package.json`·`backend/package.json` 의 버전 범위(두 파일 **같은 값** — `scripts/check-deps-sync.js` 가 검사): `@anthropic-ai/sdk ^0.128.0` · `@sentry/node ^10.75.3` · `@supabase/supabase-js ^2.117.2` · `@upstash/ratelimit ^2.2.0` · `@upstash/redis ^1.39.0` · `dotenv ^18.0.4` · `drizzle-orm ^0.45.3` · `satori ^0.33.5` · 루트 dev `eslint ^10.11.0` · backend dev `drizzle-kit ^0.31.11` · 두 파일 `engines.node` → `"24.x"`. `overrides` 는 그대로.
2. 루트와 `backend/` 각각 `npm install` → `npm update`(범위 안 하위 의존성 최신화) → `npm audit --omit=dev`(0 기대) · `npm audit`(backend 는 drizzle-kit 경유 중간 4건만 남아야 정상, 그 외 발견 시 STOP) · `npm ls fflate`(0.7.5 하나) · `npm ls @sentry/node`(10.75.3).
3. `frontend/index.html`:
   - `:114` Sentry: URL 을 `https://browser.sentry-cdn.com/10.75.3/bundle.tracing.min.js` 로, 주석 끝을 `backend @sentry/node 10.75.3 과 버전 정합 (COMPONENTS-2026-09-28, Plan 126)` 로, `:116` `s.integrity = '';` 와 그 주석을 `s.integrity = '<§2 값>'; // SRI-2026-09-28 (Plan 126): CDN 바이트 sha384 — 버전을 바꾸면 이 값도 같이 바꿔야 로드된다`.
   - `:184` supabase: URL 을 `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js` 로, 바로 다음 줄에 `s.integrity = '<§2 값>';` 추가(주석 한 줄: jsDelivr 자동 압축본(.min.js)은 npm 원본이 아니라 원본 파일로 바꿨다).
   - `loadLeaflet()`(`:6432` 부근): css `lk` 에 `lk.integrity='<§2 css 값>';lk.crossOrigin='anonymous';`, js `sc` 에 `sc.integrity='<§2 js 값>';sc.crossOrigin='anonymous';`.
4. `frontend/billing.html:242` supabase `<script>`: 같은 URL 로, `integrity="<§2 값>" crossorigin="anonymous"` 속성(이미 있는 속성은 유지). **이 파일의 다른 스크립트·로직은 건드리지 않는다.**
5. `vercel.json`: `"Strict-Transport-Security": "max-age=15552000; includeSubDomains"` 5곳 → `"max-age=31536000; includeSubDomains"`(helmet 이 API 에 주는 값과 같게).
6. 신규 테스트 `backend/test/components-guard.test.js`:
   - 두 package.json `engines.node === '24.x'`.
   - **Sentry 11 가드**: `@sentry/node` 범위의 메이저가 11 이상이면 `backend/sentry.js` 에 `dataCollection` 이 있어야 한다 · index.html Sentry CDN URL 의 메이저가 11 이상이면 index.html 의 `Sentry.init` 블록에 `dataCollection` 이 있어야 한다(지금은 10 이라 통과 — 누가 무심코 11 로 올리면 여기서 막힌다).
   - index.html 의 Sentry CDN 버전 문자열 == 루트 package.json `@sentry/node` 범위의 기준 버전(`^10.75.3` → `10.75.3`).
   - index.html 의 CDN 로드 4곳(Sentry·supabase·leaflet js·leaflet css) 각각 `integrity` 가 `sha384-` 로 시작하는 비어 있지 않은 값 · `s.integrity = ''` 0회 · billing.html supabase 태그에 `integrity="sha384-` 와 `crossorigin="anonymous"`.
   - `vercel.json` 에 `max-age=15552000` 0회.
   - `overrides.satori.fflate === '0.7.5'`(두 파일).

## 4. 하지 말 것 / STOP
- `@sentry/node`·브라우저 번들을 11 로 올리지 마라. Node 26 금지. `overrides` 변경 금지. drizzle-kit 제거 금지.
- 코드 로직 변경 금지(`backend/sentry.js` 포함). billing.html 의 결제 관련 스크립트·로직 변경 금지.
- `npm audit` 에서 §1 에 없는 취약점이 나오거나 `npm run verify` 가 실패하면 고치려 들지 말고 STOP 보고.

## 5. 완료 기준
- `npm run verify` 전부 통과(현재 547 + 신규, 124·125 병합 후면 그 수 + 신규).
- lockfile 두 개 갱신, `git diff master --stat` = package.json·backend/package.json·두 lockfile·frontend/index.html·frontend/billing.html·vercel.json·신규 테스트·plans/126 사본.
- 배포 후 리뷰어 라이브: 브라우저로 홈 로드 → 콘솔에 SRI 차단 오류 0 · `window.Sentry.SDK_VERSION === '10.75.3'` · `window.supabase` 존재 · 로그인 버튼 동작(세션 복원) · `/api/health` 응답 헤더 · 정적 페이지 `Strict-Transport-Security: max-age=31536000` · Sentry 신규 0.

## 6. 남는 것(이번 범위 밖, 다음 계획)
- **Sentry 11 전환**: 11.0.x 패치가 1회 이상 나오고(오늘 0건) 2주 경과 뒤. 선행: `dataCollection` v10 동등 설정(공식 MIGRATION.md 예시), `enableLogs`·`profilesSampleRate` 죽은 키 제거, `setupExpressErrorHandler` 와 자동 캡처 중복 확인.
- **Node 26**: 2026-10-28 Active LTS 전환 + Vercel 지원 추가 뒤.
- **Postgres**: 운영자 대시보드(Project Settings → Infrastructure)에서 업그레이드 제공 여부 확인 — 제공되면 다운타임이 있어 운영자 일정으로.
