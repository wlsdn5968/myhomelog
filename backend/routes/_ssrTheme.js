/**
 * backend/routes/_ssrTheme.js — 서버가 그리는 공개 페이지(단지·지역·브리핑) 공용 테마
 *
 * [Plan 145] plans/design-spec-v2-2026-10-14.md §1(색)·§6(글꼴) 의 값만 쓴다.
 *   - 예전엔 aptPage·regionPage·briefing 이 어두운 남색 팔레트(--bg:#080E18 …)를 각자 복사해 갖고 있었다.
 *   - 이제 한 곳에서 §1 토큰을 정의한다: 기본은 밝은 값, 사용자 기기가 다크면 prefers-color-scheme 으로 다크 값.
 *   - 글꼴 <link> 는 frontend/index.html 의 Pretendard 스타일시트와 URL·integrity·crossorigin 이 같다
 *     (테스트 pretendard-sri.test.js 가 SRI 값을 고정한다 — 새 SRI 를 만들지 않는다).
 *   - CSP: server.js helmet 의 styleSrc·fontSrc 에 https://cdn.jsdelivr.net 이 이미 있다.
 */
'use strict';

// 토큰 이름은 §1 표 그대로(bg·sf·sf2·line·line2·ink·ink2·ink3·pri·prit·onpri·map).
const THEME_CSS = `:root{--bg:#F5F5F2;--sf:#FFFFFF;--sf2:#EFEFEB;--line:#E2E1DC;--line2:#CFCEC7;--ink:#15191F;--ink2:#4A515C;--ink3:#69707B;--pri:#173A63;--prit:#E7EDF4;--onpri:#FFFFFF;--map:#E8EAE5}
  @media (prefers-color-scheme:dark){:root{--bg:#0E1520;--sf:#151E2B;--sf2:#1C2736;--line:#263345;--line2:#34445A;--ink:#E8ECF1;--ink2:#B3BDCA;--ink3:#8C97A6;--pri:#8DB3E2;--prit:#1E3150;--onpri:#0E1520;--map:#18222F}}`;

// §6: Pretendard Variable → system-ui → sans-serif
const FONT_STACK = "Pretendard,system-ui,sans-serif";

// frontend/index.html 의 stylesheet 링크와 동일(URL·integrity·crossorigin 그대로).
const FONT_LINK = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.css" integrity="sha384-5BlC3z5PiUASCwi5iNqbsXbtE1SBi8nn1Upz4JWJg2upbZKNNDXLRPKEcn79qArn" crossorigin="anonymous">';

module.exports = { THEME_CSS, FONT_STACK, FONT_LINK };
