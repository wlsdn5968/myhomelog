# 137 — 의존성 9종 갱신(dependabot #78 대체) + Sentry 브라우저 CDN 10.76.2 + satori 0.44 OG 카드 회귀 수정

**작성 기준 커밋**: `29d7391` 후보 → `56db77f` 위에 적용 (그 사이 master 변경은 문서 3개뿐) · **원 PR**: wlsdn5968/myhomelog#78 (dependabot, CI 실패)
**계획자 사전 검증**: 저장소 밖 복제본(`scratchpad/pr78`, 브랜치 `cand137` 커밋 f13a6a8)에서 루트·backend `npm ci` 후 `npm run verify` 621/621 · OG PNG 3종 픽셀 비교 · SRI 직접 재계산.

## 1. 사실 (2026-10-14 실측)
- PR #78 CI 실패 = `backend/test/components-guard.test.js:59` 1건 — `@sentry/node` 만 10.76.2 로 오르고 `frontend/index.html` 의 브라우저 CDN 은 10.75.3 이라 "같은 SDK 버전" 가드가 막음(복제본 재현, 나머지 607 통과).
- lockfile 변경 26개 판: 레지스트리 `dist.integrity` 와 전부 일치 · install/postinstall 스크립트 0 · 게시자는 이전 판과 같은 주체(GitHub Actions OIDC·sentry-bot·메인테이너). `real-require` 0.2.0→1.0.0 은 게시자 변경(둘 다 메인테이너), pino 10.4.0 릴리스 노트에 해당 갱신 명시. 루트·backend `npm audit` 0건.
- **satori 0.33.5 → 0.44.0 회귀**: 0.44 는 루트 `height:'100%'` + `padding` 을 content-box 로 계산해 카드가 630px 를 넘쳐 하단(통계 둘째 줄·출처 푸터)이 잘린다(계획자 PNG 육안 확인). 루트에 `boxSizing: 'border-box'` 를 넣으면 0.33 결과와 같다(다른 픽셀 115/59/97 / 75만, 최대 차이 57 — 글자 가장자리). 세 카드(단지·지역·브리핑) 모두 `ogImageService.renderCard` 한 곳을 쓴다. 0.44 는 hb.wasm 을 읽지 않는다(`vercel.json` includeFiles 항목은 무해, 그대로).
- **Sentry CDN 10.76.2 SRI** `sha384-BqXQi3B9SFi6WiAcbDTLzqa9A2e7ZDXDn8xcqqAmznB00bkKr7PmxAR1S0/sM1pl` — 계획자가 CDN 바이트(149,159B)로 직접 계산한 값 = getsentry/sentry-release-registry `packages/npm/@sentry/browser/10.76.2.json` 공식값. CDN `Access-Control-Allow-Origin: *`.
- @anthropic-ai/sdk 0.131.0 의 "deprecate sonnet 4.5" 는 타입 표시 chore — `aiService.js:238` 기본 모델 문자열과 겹치나 동작 변경 없음(런타임 미실측, 유료 경로라 호출하지 않음).

## 2. 변경 (실행자) — 패치 적용
`git apply --exclude=CLAUDE.md --exclude=frontend/billing.html <scratchpad>/p137/0001-…patch` (sha256 `90240b3c…05eb`). 제외 이유: CLAUDE.md 는 같은 줄이 master 에서 이미 바뀜(계획자가 따로 갱신) · billing.html 은 결제 페이지 — Plan 126 이 결제 쪽 스크립트를 범위에서 뺀 결정을 유지(그 페이지 Sentry 10.69.0·SRI 없음은 §4 발견 사항).
적용 결과 8개 파일의 저장소 형식(LF) 해시가 후보 커밋 f13a6a8 과 같아야 한다: package.json `39edc5d0bcfe0b02…` · package-lock.json `96194ca43f8a5f85…` · backend/package.json `6b4d1d911fe8e7fa…` · backend/package-lock.json `7ab19c77a7b816f1…` · frontend/index.html `7aa478d7a995d8aa…` · backend/services/ogImageService.js `c1b4ade354c14ed8…` · backend/test/og-image.test.js `213cb66887af0978…` · backend/test/components-guard.test.js `0bbc54b8c757150f…`.

## 3. 배포 뒤 확인
- 브라우저에서 Sentry 번들이 SRI 오류 없이 로드(`window.Sentry.SDK_VERSION === '10.76.2'`, 콘솔 integrity 오류 0).
- `/api/og/apt/<seq>`·`/api/og/region/<code>` PNG 1200×630 하단 출처 줄 보임.
- dependabot PR #78 은 이 커밋으로 대체 — 닫기는 GitHub 로그인이 필요해 운영자(또는 dependabot 이 master 변경을 감지해 자동 종료).

## 4. 발견 사항(조치 없음)
- `frontend/billing.html` 의 Sentry CDN 이 10.69.0 이고 integrity 가 없다(백엔드 10.76.2 와 불일치). 결제 페이지라 운영자가 결제 주제를 꺼낼 때 함께 처리.
