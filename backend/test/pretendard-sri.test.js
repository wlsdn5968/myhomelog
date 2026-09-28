/**
 * backend/test/pretendard-sri.test.js
 *
 * SRI-2026-09-28 (Plan 127): Pretendard 웹폰트 CSS 에 SRI 검증.
 * 5개 페이지의 외부 Pretendard 스타일시트 링크에 Subresource Integrity 추가.
 * 계획서: plans/127-pretendard-css-sri.md
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

// SRI 해시 (jsDelivr 원본 바이트 526B와 일치 확인됨)
const PRETENDARD_INTEGRITY = 'sha384-5BlC3z5PiUASCwi5iNqbsXbtE1SBi8nn1Upz4JWJg2upbZKNNDXLRPKEcn79qArn';
const CROSSORIGIN = 'anonymous';

// 5개 파일
const FILES = [
  'frontend/index.html',
  'frontend/billing.html',
  'frontend/privacy.html',
  'frontend/refund.html',
  'frontend/terms.html',
];

FILES.forEach(file => {
  const html = fs.readFileSync(path.join(__dirname, `../../${file}`), 'utf8');

  test(`[${file}] pretendardvariable.css 링크가 정확히 2개 (preload + stylesheet)`, () => {
    // href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.css" 를 찾기
    const count = (html.match(/href="https:\/\/cdn\.jsdelivr\.net\/gh\/orioncactus\/pretendard@v1\.3\.9\/dist\/web\/variable\/pretendardvariable\.css"/g) || []).length;
    assert.equal(count, 2, `[${file}] pretendardvariable.css href 가 ${count}개여야 함 (preload 1 + stylesheet 1)`);
  });

  test(`[${file}] preload 링크가 integrity 를 가짐`, () => {
    const match = html.match(/<link rel="preload" as="style" href="[^"]*pretendardvariable\.css"[^>]*>/);
    assert.ok(match, `[${file}] preload 링크를 찾을 수 없음`);
    const tag = match[0];
    assert.ok(
      tag.includes(`integrity="${PRETENDARD_INTEGRITY}"`),
      `[${file}] preload 링크가 올바른 integrity 를 갖지 않음`
    );
  });

  test(`[${file}] preload 링크가 crossorigin="anonymous" 를 가짐`, () => {
    const match = html.match(/<link rel="preload" as="style" href="[^"]*pretendardvariable\.css"[^>]*>/);
    assert.ok(match, `[${file}] preload 링크를 찾을 수 없음`);
    const tag = match[0];
    assert.ok(
      tag.includes(`crossorigin="${CROSSORIGIN}"`),
      `[${file}] preload 링크가 crossorigin 을 갖지 않음`
    );
  });

  test(`[${file}] stylesheet 링크가 integrity 를 가짐`, () => {
    const match = html.match(/<link rel="stylesheet" href="[^"]*pretendardvariable\.css"[^>]*>/);
    assert.ok(match, `[${file}] stylesheet 링크를 찾을 수 없음`);
    const tag = match[0];
    assert.ok(
      tag.includes(`integrity="${PRETENDARD_INTEGRITY}"`),
      `[${file}] stylesheet 링크가 올바른 integrity 를 갖지 않음`
    );
  });

  test(`[${file}] stylesheet 링크가 crossorigin="anonymous" 를 가짐`, () => {
    const match = html.match(/<link rel="stylesheet" href="[^"]*pretendardvariable\.css"[^>]*>/);
    assert.ok(match, `[${file}] stylesheet 링크를 찾을 수 없음`);
    const tag = match[0];
    assert.ok(
      tag.includes(`crossorigin="${CROSSORIGIN}"`),
      `[${file}] stylesheet 링크가 crossorigin 을 갖지 않음`
    );
  });
});
