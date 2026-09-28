# 127 — Pretendard 웹폰트 CSS 에 SRI (126 의 인벤토리 누락분)

**작성 기준 커밋**: `da57316` (2026-09-28) · **출처**: Plan 126 라이브 검증 중 리소스 목록에서 발견(인벤토리가 `<script>`·동적 로드만 봐서 `<link rel=stylesheet>` 외부 CSS 를 놓쳤다) · **운영자 요청 2026-09-28** "구성요소 전부 최신·보안 확인" 범위
**성격**: HTML 속성 XS(5파일 10태그) + 신규 테스트 1. 버전 변경 0(v1.3.9 가 최신 릴리스 — GitHub API `releases/latest` = v1.3.9, 2023-11-05).

## 사실 (계획자 실측)
- 같은 두 줄이 5개 파일에 있다: `frontend/index.html:87-88`, `frontend/billing.html:60-61`, `frontend/privacy.html:12-13`, `frontend/refund.html:12-13`, `frontend/terms.html:12-13`
  ```html
  <link rel="preload" as="style" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.css">
  ```
- SRI: `sha384-5BlC3z5PiUASCwi5iNqbsXbtE1SBi8nn1Upz4JWJg2upbZKNNDXLRPKEcn79qArn` — jsDelivr 바이트(526B)와 GitHub 원본 `raw.githubusercontent.com/orioncactus/pretendard/v1.3.9/dist/web/variable/pretendardvariable.css`(526B)가 **바이트 동일**, 두 출처에서 같은 해시. jsDelivr 응답 `access-control-allow-origin: *`, `immutable`.
- Google Fonts CSS(`fonts.googleapis.com/css2?...`)는 브라우저(UA)마다 내용이 달라 SRI 를 붙일 수 없다 — 범위 밖.

## 변경 (실행자)
10개 태그 각각에 `integrity="<위 값>" crossorigin="anonymous"` 를 `href="…"` 뒤에 추가. preload 와 stylesheet **둘 다**(preload 는 같은 integrity·crossorigin 이어야 재사용된다). 다른 속성·다른 줄 변경 금지. 주석 추가 금지(HTML head 는 그대로 짧게).

## 테스트 `backend/test/pretendard-sri.test.js` (신규)
5개 파일 각각: `pretendardvariable.css` 를 가리키는 `<link` 태그가 정확히 2개이고, 둘 다 `integrity="sha384-5BlC3z5PiUASCwi5iNqbsXbtE1SBi8nn1Upz4JWJg2upbZKNNDXLRPKEcn79qArn"` 와 `crossorigin="anonymous"` 를 가진다.

## 하지 말 것 / STOP
- Pretendard 버전 변경 금지. Google Fonts 링크 변경 금지. billing.html 의 다른 부분 변경 금지. 줄 끝(CRLF/LF) 변경 금지 — 편집 뒤 파일별 `git diff --stat` 가 2줄씩이어야 정상.

## 완료 기준
`npm run verify` 전부 통과(563 + 신규). 배포 후 리뷰어 라이브: 5개 페이지 콘솔에 SRI 차단 0 · 폰트 적용(`document.fonts.check('16px "Pretendard Variable"')`).
