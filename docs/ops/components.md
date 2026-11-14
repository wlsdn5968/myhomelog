# 구성요소 버전 정책과 점검

> 2026-11-14 에 저장소 CLAUDE.md 의 "진행 중 / 운영자 결정 대기" 구역에서 원문 그대로 옮겼다(내용 변경 없음).
> 경고와 금지 문장은 CLAUDE.md 에도 남아 있다. 새 기록은 이 파일에 덧붙이고, 새 경고는 CLAUDE.md 에도 한 줄 적는다.

### 구성요소 버전 정책 (2026-09-28, Plan 126)
- **Node**: 두 package.json `engines.node = "24.x"` 고정 — Vercel 은 engines 가 프로젝트 설정보다 우선이고 열린 범위(`>=22`)는 지원 최고 메이저로 해석해 26.x 추가 시 무검증 자동 승격된다. 24.x 는 2026-10-20 Maintenance LTS(지원 종료 2028-04-30), 26.x 는 2026-10-28 Active LTS 전환(v26.13.0) — **2026-10-29 재확인: Vercel 지원 목록은 24.x(기본)·22.x 뿐 → 24.x 유지**. Vercel 이 26.x 를 추가한 뒤 별도 계획으로 옮긴다.
- **Sentry**: 10.76.2(Plan 137, 백엔드·index.html CDN 같은 버전 — `frontend/billing.html` 만 10.69.0·SRI 없음, 결제 페이지라 보류). v10 줄 유지보수 중, 11 은 09-23 이후 3주간 minor 7개. **11 전환 착수 기준(운영자 "권고대로" 2026-10-14)**: 11.x 최신 minor 가 14일 이상 유지되거나 v10 유지보수 종료가 공식 공지되면 — 11-07 재확인. **11 로 올릴 때는 `dataCollection` 을 v10 동등(제한)으로 명시 필수** — v11 은 설정을 비우면 userInfo·cookies·요청/응답 본문·DB 쿼리를 기본 수집한다(공식 MIGRATION.md). `backend/test/components-guard.test.js` 가 메이저 11 이상인데 `dataCollection:` 옵션이 없으면 막는다. 브라우저 CDN 번들 버전은 백엔드와 같게.
- **백엔드 Sentry 는 `@sentry/node-core/light` 10.76.2 고정**(2026-11-10, plans/188): 시작 CPU 절감(로컬 중앙값 1,022ms 에서 609ms). 오류 수집만, 성능 추적 없음. 일반 node-core 는 OpenTelemetry 없이 요청 분리가 없어 태그가 섞인다(backend/test/sentry-light-isolation.test.js 가 막는다). 백엔드 코드는 `@sentry/node` 를 직접 부르지 말고 `../sentry` 를 부른다.
- **Sentry 로 나가는 데이터는 `backend/sentry.js` 의 `scrubEvent` 가 오류(beforeSend)·성능(beforeSendTransaction) 모두 거른다**(Plan 128, 2026-09-28): `sendDefaultPii:false` 만으로는 요청 본문·쿠키가 나갔고, 성능 표본에는 beforeSend 가 안 걸려 Authorization·OIDC 토큰·클라이언트 IP 까지 나갔다(운영 30일 93,230건 실측). 규칙: 본문·쿠키 삭제 · 헤더 허용목록 · 클라이언트 주소 삭제 · 환경변수 비밀값·PostgREST 필터 값·UUID 치환. ⚠ **11 은 성능 데이터를 span 항목으로 보내 beforeSendTransaction 을 우회**(실측) — `backend/test/sentry-scrub.test.js` 의 실제 SDK E2E 가 막는다. 새 외부 API 키 환경변수는 이름에 KEY/SECRET/TOKEN/PASSWORD 를 넣어야 자동 치환된다.
- **express 5.3.0(2026-10-29, 9d6282a)**: 2주 관찰 뒤 적용 — 우리 코드가 쓰는 변경은 res.redirect HTML 본문뿐. 같은 날 운영 감사 새 공지 3건(body-parser DoS high·ip-address·qs) 을 범위 안 패치로 해소(21edfbe). 운영 감사는 0건이 정상 — 새 공지는 수시로 나오므로 점검 때마다 `npm audit --omit=dev`(루트·backend 둘 다).
- **CDN 스크립트·스타일은 SRI 필수**: 버전을 바꾸면 integrity 도 같이 바꿔야 로드된다. 해시는 npm tarball(sha512 무결성 검증) 또는 공식 게시값과 대조해 계산. jsDelivr 의 `.min.js` 자동 압축본은 npm 원본이 아니다 — 원본 파일 경로를 쓴다.
- **drizzle-kit(dev) 중간 4건**: esbuild 개발 서버 권고 — 상류 수정판 없음, 배포 제외, 운영 감사(`--omit=dev`) 0건 → 수용. `overrides.satori.fflate = 0.7.5` 는 satori 가 계속 취약 버전을 고정하므로 유지.
- **결제 페이지 CSP 는 보고 전용**(2026-09-02 c8e6137 결정 — 결제 게이트 해제 전 위젯 호스트 측정 불가). 운영자가 결제 주제를 꺼내기 전에는 변경하지 않는다.


### 구성요소 점검 (2026-10-14) — `plans/audit-components-2026-10-14.md`
- 버려진 대용량 DB 데이터 없음(79% 가 원본·이력, 즉시 회수 가능 0.5MB) · 버전 대체로 최신(미사용 의존성 0, 운영 감사 0) · 최대 문제는 Redis 쓰기 실패(10-05~). 139(Redis 명령 절감)·140(cron·지역 페이지)·141(패치 갱신) 진행.
