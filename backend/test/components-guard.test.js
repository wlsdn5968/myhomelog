/**
 * backend/test/components-guard.test.js
 *
 * Plan 126 (2026-09-28) — 구성요소 최신화 + CDN 무결성(SRI) + 런타임 고정 + HSTS 1년.
 * 이 변경은 코드 로직 0(버전 range·CDN URL·SRI 속성·HSTS 헤더 값만) — 그래서 테스트도
 * "지금 값이 맞다"가 아니라 "누가 나중에 무심코 되돌리거나 위험한 방향으로 더 올리면
 * 여기서 막히는가"를 고정한다.
 *
 *   - engines.node 가 열린 범위(">=22" 등)로 되돌아가면, Vercel 은 engines 를 프로젝트 설정보다
 *     우선시키고 열린 범위는 "지원하는 최고 메이저"로 해석한다 — Vercel 이 새 메이저를 추가하는
 *     순간 무검증 자동 승격 위험이 생긴다(계획 §1).
 *   - @sentry/node 11.0.0 은 `sendDefaultPii` 가 제거되고 `dataCollection` 미설정 시
 *     IP·쿠키·요청/응답 본문·DB 쿼리를 **기본 수집**한다(공식 MIGRATION.md). 지금은 10.75.3 까지만
 *     고정했지만, 나중에 누가 버전만 올리고 dataCollection 이전을 빠뜨리면 여기서 걸려야 한다.
 *   - 브라우저 CDN 스크립트 4곳(Sentry·supabase·Leaflet js·Leaflet css)은 SRI 없이 로드되면
 *     변조된 CDN 응답을 그대로 실행하게 된다 — integrity 가 비어있는 채로 되돌아가면 안 된다.
 *   - vercel.json 의 정적 HSTS 가 180일로 되돌아가면 API(helmet 기본값 1년)와 다시 갈린다.
 *   - overrides.satori.fflate 가 빠지면 GHSA-px8p-9vwx-vf98 가 재발한다(Plan 075 에서 고정한 값).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const backendPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const billingHtml = fs.readFileSync(path.join(ROOT, 'frontend', 'billing.html'), 'utf8');
const sentryJs = fs.readFileSync(path.join(ROOT, 'backend', 'sentry.js'), 'utf8');
const vercelJsonRaw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');

// range("^10.75.3") → { major: 10, base: "10.75.3" }
function parseRange(range, what) {
  const m = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(m, `${what} 에서 semver 를 찾지 못했다: ${range}`);
  return { major: Number(m[1]), base: m[0] };
}



test('engines.node 가 두 package.json 에서 24.x 로 고정돼 있다', () => {
  assert.equal(rootPkg.engines && rootPkg.engines.node, '24.x',
    '루트 package.json engines.node 가 24.x 가 아니다 — 열린 범위로 되돌아가면 Vercel 이 새 메이저를 무검증 승격한다');
  assert.equal(backendPkg.engines && backendPkg.engines.node, '24.x',
    'backend/package.json engines.node 가 24.x 가 아니다');
});



test('overrides.satori.fflate 가 두 package.json 에서 0.7.5 로 고정돼 있다 (GHSA-px8p-9vwx-vf98, Plan 075)', () => {
  assert.equal(rootPkg.overrides?.satori?.fflate, '0.7.5', '루트 overrides.satori.fflate 가 0.7.5 가 아니다');
  assert.equal(backendPkg.overrides?.satori?.fflate, '0.7.5', 'backend overrides.satori.fflate 가 0.7.5 가 아니다');
});



test('index.html 의 Sentry CDN 버전이 루트 package.json 의 @sentry/node 기준 버전과 같다', () => {
  const m = html.match(/https:\/\/browser\.sentry-cdn\.com\/(\d+\.\d+\.\d+)\/bundle\.tracing\.min\.js/);
  assert.ok(m, 'index.html 에서 Sentry CDN URL 을 찾지 못했다');
  const { base: pkgVersion } = parseRange(rootPkg.dependencies['@sentry/node'], "루트 package.json 의 @sentry/node");
  assert.equal(m[1], pkgVersion,
    `index.html Sentry CDN(${m[1]}) 이 backend @sentry/node(${pkgVersion}) 와 버전이 다르다 — 둘은 같은 SDK 버전이어야 한다`);
});



// SENTRY-11-GUARD (Plan 126): 오늘(2026-09-28) 기준 두 값 모두 10대라 아래 두 분기는 트리거되지
// 않는다 — 그게 정상이다. 누가 나중에 11 로 올리는 순간 이 테스트가 dataCollection 부재를 잡는다.
test('Sentry 11 가드 — 메이저가 11 이상이면 dataCollection 설정이 있어야 한다 (PII 기본 수집 방지)', () => {
  const backendRange = parseRange(rootPkg.dependencies['@sentry/node'], "루트 package.json 의 @sentry/node");
  if (backendRange.major >= 11) {
    assert.match(sentryJs, /dataCollection/,
      '@sentry/node 가 11 이상으로 올라갔는데 backend/sentry.js 에 dataCollection 설정이 없다 — ' +
      'v11 은 dataCollection 미설정 시 IP·쿠키·요청/응답 본문·DB 쿼리를 기본 수집한다(공식 MIGRATION.md)');
  }

  const cdnMatch = html.match(/https:\/\/browser\.sentry-cdn\.com\/(\d+)\.\d+\.\d+\/bundle\.tracing\.min\.js/);
  assert.ok(cdnMatch, 'index.html 에서 Sentry CDN 메이저 버전을 찾지 못했다');
  if (Number(cdnMatch[1]) >= 11) {
    const initBlock = html.match(/window\.Sentry\.init\(\{[\s\S]*?\n\s*\}\);/);
    assert.ok(initBlock, 'index.html 에서 Sentry.init 블록을 찾지 못했다');
    assert.match(initBlock[0], /dataCollection/,
      'index.html 의 Sentry CDN 이 11 이상인데 Sentry.init 블록에 dataCollection 이 없다');
  }
});



// 주석 길이가 바뀌어도 안 깨지도록, "정규식 한방"이 아니라 앵커 문자열로 블록을 잘라낸 뒤
// 그 블록 안에서 속성을 찾는다(주석 텍스트는 이 계약의 일부가 아니다 — 값만 계약이다).
function sliceFrom(text, anchor, span, what) {
  const idx = text.indexOf(anchor);
  assert.ok(idx !== -1, `${what} 를 찾지 못했다 (앵커: ${anchor})`);
  return text.slice(idx, idx + span);
}

test('index.html CDN 스크립트 4곳(Sentry·supabase·Leaflet js·Leaflet css) 모두 비어있지 않은 sha384 SRI 를 갖는다', () => {
  const sentryBlock = sliceFrom(html, "s.src = 'https://browser.sentry-cdn.com/", 400, 'Sentry CDN src');
  assert.match(sentryBlock, /s\.crossOrigin = 'anonymous';/, 'Sentry 블록에 crossOrigin=anonymous 가 없다');
  const sentryIntegrity = sentryBlock.match(/s\.integrity = '([^']*)';/);
  assert.ok(sentryIntegrity, 'Sentry 블록에서 integrity 를 찾지 못했다');
  assert.match(sentryIntegrity[1], /^sha384-.+/, `Sentry CDN integrity 가 비어있거나 sha384 가 아니다: '${sentryIntegrity[1]}'`);

  const supabaseBlock = sliceFrom(html, "s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@", 400, 'supabase CDN src');
  assert.match(supabaseBlock, /^[^\n]*dist\/umd\/supabase\.js';/,
    'supabase src 가 jsDelivr 자동 압축본(.min.js)으로 되돌아갔다 — npm 원본(dist/umd/supabase.js) 이어야 한다');
  assert.match(supabaseBlock, /s\.crossOrigin = 'anonymous';/, 'supabase 블록에 crossOrigin=anonymous 가 없다');
  const supabaseIntegrity = supabaseBlock.match(/s\.integrity = '([^']*)';/);
  assert.ok(supabaseIntegrity, 'supabase 블록에서 integrity 를 찾지 못했다');
  assert.match(supabaseIntegrity[1], /^sha384-.+/, `supabase CDN integrity 가 비어있거나 sha384 가 아니다: '${supabaseIntegrity[1]}'`);

  const leafletCssBlock = sliceFrom(html, "lk.href='https://unpkg.com/leaflet@", 300, 'Leaflet CSS href');
  const leafletCssIntegrity = leafletCssBlock.match(/lk\.integrity='([^']*)';/);
  assert.ok(leafletCssIntegrity, 'Leaflet CSS 블록에서 integrity 를 찾지 못했다');
  assert.match(leafletCssIntegrity[1], /^sha384-.+/, `Leaflet CSS integrity 가 비어있거나 sha384 가 아니다: '${leafletCssIntegrity[1]}'`);
  assert.match(leafletCssBlock, /lk\.crossOrigin='anonymous';/, 'Leaflet CSS 블록에 crossOrigin=anonymous 가 없다');

  const leafletJsBlock = sliceFrom(html, "sc.src='https://unpkg.com/leaflet@", 300, 'Leaflet JS src');
  const leafletJsIntegrity = leafletJsBlock.match(/sc\.integrity='([^']*)';/);
  assert.ok(leafletJsIntegrity, 'Leaflet JS 블록에서 integrity 를 찾지 못했다');
  assert.match(leafletJsIntegrity[1], /^sha384-.+/, `Leaflet JS integrity 가 비어있거나 sha384 가 아니다: '${leafletJsIntegrity[1]}'`);
  assert.match(leafletJsBlock, /sc\.crossOrigin='anonymous';/, 'Leaflet JS 블록에 crossOrigin=anonymous 가 없다');

  // 절대 금지 — SRI 없이 CDN 스크립트를 로드하는 옛 패턴(`s.integrity = '';`)이 되돌아오지 않았는지.
  assert.equal((html.match(/integrity\s*=\s*''/g) || []).length, 0,
    "index.html 에 integrity = '' (빈 SRI) 가 남아있다 — 무결성 검증 없이 CDN 스크립트가 로드된다");
});



test('billing.html 의 supabase 스크립트 태그에 SRI·crossorigin 이 있고, 결제 스크립트는 그대로다', () => {
  assert.match(billingHtml,
    /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[\d.]+\/dist\/umd\/supabase\.js" integrity="sha384-[^"]+" crossorigin="anonymous"><\/script>/,
    'billing.html 의 supabase 스크립트 태그에 integrity="sha384-…" crossorigin="anonymous" 가 없다');
  // 이 계획은 billing.html 의 supabase <script> 태그 외 다른 어떤 것도 건드리지 않는다 —
  // 결제 SDK(Toss v2)와 그 로드 방식이 그대로인지 함께 못박는다(회귀 시 결제 자체가 깨진다).
  assert.match(billingHtml, /<script src="https:\/\/js\.tosspayments\.com\/v2\/standard"><\/script>/,
    'Toss Payments Widget SDK v2 스크립트 태그가 바뀌었다 — 이 계획의 범위 밖이다');
});



test('vercel.json 의 정적 HSTS 가 1년(31536000)으로 통일되고 옛 180일 값이 남아있지 않다', () => {
  assert.equal((vercelJsonRaw.match(/max-age=15552000/g) || []).length, 0,
    'vercel.json 에 180일(15552000) HSTS 가 남아있다 — API(helmet 기본값 1년)와 다시 갈린다');
  const oneYearCount = (vercelJsonRaw.match(/max-age=31536000; includeSubDomains/g) || []).length;
  assert.equal(oneYearCount, 5, `vercel.json 의 정적 라우트 5곳이 모두 31536000 이어야 하는데 ${oneYearCount}곳만 그렇다`);
});
