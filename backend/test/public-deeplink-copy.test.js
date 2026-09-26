/**
 * backend/test/public-deeplink-copy.test.js
 *
 * Plan 115 — 공개 페이지 → 앱 맥락 유지 딥링크(Step 1) + 사실과 다른 문구 4곳 중 3곳(Step 2·3·4) 회귀 고정.
 * (Step 2 의 "AI 특약 초안" 문구·Step 3 의 하드코딩 날짜는 frontend/index.html 을 직접 읽어 정적으로
 *  단언한다 — 이 저장소에 index.html 전용 실행 환경이 없어 apt-page.test.js 류의 렌더 방식을 쓸 수 없다.)
 *
 * ⚠ 이 파일은 apt-page-links.test.js·apt-page.test.js·share-ssr.test.js 를 수정하지 않고 새로
 *   추가한다(운영자 지시) — 공용 헬퍼는 기존 규칙대로 ../testSupport/_helpers 에서만 가져온다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _P063_STAT, _p063Idx, _p063Run } = require('../testSupport/_helpers');

const INDEX_HTML_PATH = path.join(__dirname, '../../frontend/index.html');
const REGION_JS_PATH = path.join(__dirname, '../routes/region.js');

// ── Step 1: 단지 페이지 CTA 가 맥락 유지 딥링크(?apt=&area=)로 간다 ──────────────────────────
test('PUBLIC-DEEPLINK — 단지 페이지 CTA 가 /?apt=&area= 딥링크로 가고, 루트 단독 CTA 는 없다 (Plan 115 Step 1)', async () => {
  const aptName = '딥링크확인아파트';
  // _p063Idx 는 lawd_cd='11680'(강남구) 로 고정 — regionLabel('11680','강남구') = '서울 강남구'(구 이름 포함 보장).
  const res = await _p063Run({ aptMasterRows: [], idxRow: _p063Idx(aptName), statFixture: _P063_STAT });
  assert.equal(res.statusCode, 200);
  const expectedHref = `href="https://myhomelog.vercel.app/?apt=${encodeURIComponent(aptName)}&area=${encodeURIComponent('서울 강남구')}"`;
  assert.ok(res.body.includes(expectedHref),
    `CTA href 가 예상한 딥링크 형식이 아니다. 기대: ${expectedHref} / 실제 CTA: ${(res.body.match(/<a class="cta"[^>]*>/) || [])[0]}`);
  assert.ok(!res.body.includes('<a class="cta" href="https://myhomelog.vercel.app/">'),
    'CTA 가 여전히 맥락 없는 루트(href="${ORIGIN}/") 단독 링크다 — 구글에서 온 방문자가 단지를 잊은 랜딩에 떨어진다');
});

test('PUBLIC-DEEPLINK — aptPage.js 소스에도 딥링크 템플릿이 있다 (렌더 검증의 보강)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/aptPage.js'), 'utf8');
  assert.ok(src.includes('href="${ORIGIN}/?apt=${encodeURIComponent(aptName)}&area=${encodeURIComponent(region)}"'),
    'aptPage.js 에 딥링크 CTA 템플릿 문자열이 없다');
  assert.ok(!/class="cta" href="\$\{ORIGIN\}\/">/.test(src),
    'aptPage.js 에 여전히 맥락 없는 루트 단독 CTA(href="${ORIGIN}/") 가 남아 있다');
});

// ── Step 2: "AI 특약 초안" — 없는 능력을 주장하지 않는다 ────────────────────────────────────
test('PUBLIC-DEEPLINK-COPY — index.html 에 "AI 특약 초안" 문구가 남아있지 않다 (Plan 115 Step 2)', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const count = (html.match(/AI 특약 초안/g) || []).length;
  assert.equal(count, 0,
    `"AI 특약 초안" 이 ${count}회 남아 있다 — 무료 경로는 규칙 엔진 템플릿(clause.js 는 pro/admin 외 403)이라 AI 라고 쓰면 안 된다`);
  // 약관의 AI 면책(:3136-3138 부근)은 "AI가 잘못된 …·AI 환각으로…" 형태라 위 문자열과 겹치지 않는다 — 그대로 유지돼야 한다.
  assert.ok(html.includes('AI 환각으로 발생한 잘못된 특약 문구'),
    '약관의 AI 면책 문구(보고서는 실제 LLM 사용 — 사실)가 사라졌다. 이 문구는 Plan 115 범위 밖이라 건드리면 안 된다');
  // COPY-FACT-2026-09-26 (코디네이터 지적, Plan 115 추가분): exportClausePDF() 는 같은 무료 규칙 엔진
  //   템플릿 결과를 PDF 로 내보낼 뿐인데 워터마크·면책에서 "AI 가 만들었다"고 말했다 — P4-① 과 동일 오류.
  //   함수 구간만 잘라 확인한다(:3143 약관 "AI가 생성한 모든 콘텐츠…"는 보고서 LLM 을 덮는 문구라 범위 밖).
  const fnStart = html.indexOf('function exportClausePDF(');
  assert.ok(fnStart >= 0, 'exportClausePDF 함수를 못 찾았다 — 소스가 옮겨졌다');
  const fnEnd = html.indexOf('\nfunction ', fnStart + 1);
  assert.ok(fnEnd > fnStart, 'exportClausePDF 다음 function 경계를 못 찾았다 — 구간 추출이 틀렸을 수 있다');
  const fnBody = html.slice(fnStart, fnEnd);
  for (const needle of ['AI 생성 초안', 'AI 가 생성한', 'AI가 생성한']) {
    assert.ok(!fnBody.includes(needle),
      `exportClausePDF() 안에 "${needle}" 이 남아 있다 — 무료 템플릿 결과인데 AI 가 만들었다고 주장한다`);
  }
  // COPY-FACT-2026-09-26 (코디네이터 지적 2차): "자동 생성 초안"이라 부른 바로 아래에서 "환각"을
  //   말하면 앞뒤가 안 맞는다(무료 템플릿 경로는 AI 를 안 거치니 환각 위험 자체가 없다).
  assert.ok(!fnBody.includes('환각'),
    'exportClausePDF() 안에 "환각" 이 남아 있다 — "자동 생성 초안" 문구와 앞뒤가 안 맞는다');
});

// ── Step 3: 하드코딩 날짜 제거 ────────────────────────────────────────────────────────
test('PUBLIC-DEEPLINK-COPY — index.html 에 "2025.05 이후" 하드코딩 문구가 없다 (Plan 115 Step 3)', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const count = (html.match(/2025\.05 이후/g) || []).length;
  assert.equal(count, 0,
    `"2025.05 이후" 가 ${count}회 남아 있다 — 장기 추세(Plan 102)는 2020-09 부터라 이미 사실과 다르다`);
});

// ── Step 4: 지역 페이지 규제 상태 문구 — "확인 필요"(결손처럼 읽힘) 제거 ──────────────────────
test('PUBLIC-DEEPLINK-COPY — region.js 의 규제 상태 문구가 "확인 필요" 에서 "고시된 규제지역 목록에 없음" 으로 바뀌었다 (Plan 115 Step 4)', () => {
  const src = fs.readFileSync(REGION_JS_PATH, 'utf8');
  const staleCount = (src.match(/'확인 필요'/g) || []).length;
  assert.equal(staleCount, 0, `region.js 에 '확인 필요' 리터럴이 ${staleCount}회 남아 있다`);
  const newCount = (src.match(/'고시된 규제지역 목록에 없음'/g) || []).length;
  assert.equal(newCount, 1, `region.js 에 '고시된 규제지역 목록에 없음' 이 ${newCount}회다(1회여야 한다)`);
});
