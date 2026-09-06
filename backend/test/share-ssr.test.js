/**
 * backend/test/share-ssr.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _SHARE_EXPAND_PAIR, _shareHandler, _shareMockRes } = require('../testSupport/_helpers');



test('공유링크 거래 건수 — 같은 6개월 응답을 3번 합산하지 않는다 (Sprint MMMMMMM-4)', () => {
  // 백엔드는 aptName 이 있으면 dealYm 을 무시하고 6개월치 전량을 준다
  //   (routes/transactions.js:35-37 → transactionService.getTransactionsByApt(…, monthsBack = 6)).
  //   프론트가 3개월을 각각 호출해 합치면 **정확히 3배**가 된다 — 공유링크 "최근 6개월 실거래 N건",
  //   관심단지 "새 거래 N건" 이 전부 부풀어 있었다.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // 전제 고정 — 이 시그니처가 바뀌면 위 판단의 근거가 사라진다
  assert.match(svc, /async function getTransactionsByApt\(lawdCd, aptName, monthsBack = 6\)/,
    'getTransactionsByApt 시그니처가 바뀌었다 — 6개월 전량 반환 전제를 다시 확인할 것');

  const m = html.match(/async function fetchRecentTx\(lawdCd, aptName\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'fetchRecentTx 를 찾지 못했다');
  const fn = m[0];
  assert.match(fn, /if\(aptName\)\{/, 'aptName 단축 경로가 없다 — 3배 합산이 되돌아왔다');
  // 단축 경로 안에서는 prevYm 을 한 번만 쓴다(월 3회 루프로 되돌아가지 않았는지)
  const short = fn.slice(fn.indexOf('if(aptName){'), fn.indexOf('const months='));
  assert.equal((short.match(/prevYm\(/g) || []).length, 1,
    'aptName 경로가 다시 여러 달을 호출한다');
  assert.equal(/aptName\]/.test(short) || /aptName,\s*$/.test(short), false);
});



// ── SHARE-ZERO-2026-09-02 (감사 P0-5) ──────────────────────────────────────
//   [왜] `/share?apt=...` 로 들어온 신규 방문자에게 "현재 평균가 0.00억 · 가격 범위 0.0~0.0억" 이
//     떴다(라이브 실측). handleShareUrl 이 실거래 조회에 실패하면 **그냥 return** 해서
//     avgPrice:0 stub 이 화면에 남았고, 렌더러는 `(p.minPrice||0).toFixed(1)` 로 그 0 을 값으로 찍었다.
//     공유 링크는 첫인상이라 0 원 표기의 파급이 크다. [[unknown-treated-as-value]] 의 전형.
//   [무엇을 고정하나] "모름"을 0 으로 찍던 raw 패턴의 재유입과, 실패 경로의 조용한 return.
test('공유 링크: 가격 미확인 상태를 0 으로 표시하지 않는다 (raw 패턴 재유입 차단)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 유효성 게이트가 존재해야 한다 (avgPrice 가 0 이하면 숫자 대신 상태 문구)
  // T0-HERO-2026-09-05: rg2 카드가 히어로로 대체되며 게이트가 if (Number(p.avgPrice) > 0) {...} else {상태 문구} 형태가 됐다.
  assert.ok(html.indexOf('if (Number(p.avgPrice) > 0) {') >= 0,
    '가격 유효성 게이트가 사라졌다 — 0 원이 다시 값으로 표시된다');

  // ② 0 을 가격 범위로 찍던 raw 패턴이 돌아오면 실패
  const RAW_RANGE = '(p.minPrice||0).toFixed(1)}~${(p.maxPrice||0).toFixed(1)}억';
  assert.equal(html.indexOf(RAW_RANGE), -1, `0 원 가격범위 raw 패턴이 재유입됐다: ${RAW_RANGE}`);

  // ③ 공유 텍스트도 0 을 내보내면 안 된다
  assert.equal(html.indexOf('평균 ${(currentDetail.avgPrice||0).toFixed(2)}억'), -1,
    '외부 공유 문구가 다시 "평균 0.00억" 을 내보낸다');
});



test('공유 링크: 실거래 조회 실패 경로가 조용히 return 하지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const from = html.indexOf('async function handleShareUrl()');
  assert.ok(from > 0, 'handleShareUrl 을 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(from, from + 3000);

  // 실패 3경로(지역 미해석·거래 0건·예외)가 전부 화면을 다시 그려야 한다
  assert.equal(body.indexOf('if(!lawdCd)return;'), -1, '지역 미해석 시 조용히 return 하고 있다');
  assert.equal(body.indexOf('if(!items.length)return;'), -1, '거래 0건일 때 조용히 return 하고 있다');
  assert.equal(body.indexOf('조용히 실패 — stub 유지'), -1, 'catch 가 여전히 조용히 삼킨다');
  // 호출 3곳(지역 미해석·거래 0건·예외). 정의는 `_reshow=` 라 이 정규식에 잡히지 않는다.
  const reshow = (body.match(/_reshow\(\{/g) || []).length;
  assert.ok(reshow >= 3, `실패 경로 재렌더가 ${reshow}회뿐 — 3경로 모두 다시 그려야 한다`);
  assert.ok(body.indexOf('const _reshow=') >= 0, '_reshow 헬퍼 정의가 사라졌다');
});



test('SEO: /share 는 크롤 가능하되 색인은 막는다 (링크 미리보기 유지 + 중복 색인 방지)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const robots = fs2.readFileSync(path2.join(__dirname, '../../frontend/robots.txt'), 'utf8');
  const share = fs2.readFileSync(path2.join(__dirname, '../routes/share.js'), 'utf8');

  // robots.txt 의 "Disallow: /share" 는 주석(#)이 아닌 실제 지시문일 때만 문제다.
  const active = robots.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  const blocked = active.some((l) => /^\s*Disallow:\s*\/share/i.test(l));
  assert.equal(blocked, false, 'robots.txt 가 /share 를 다시 막았다 — 카카오톡·X 링크 미리보기가 깨진다');

  assert.ok(/noindex,\s*follow/.test(share),
    '/share 가 noindex 를 내려주지 않는다 — 크롤 허용과 함께라면 SPA 중복 색인이 생긴다');
});



test('/share?apt= — 확장 패턴 입력이 응답 길이를 증폭시키지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const originalLen = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8').length;
  const handle = _shareHandler();
  const evil = _SHARE_EXPAND_PAIR.repeat(10); // 20자 — 계획 실측과 같은 강도, apt 상한(60자) 이내
  const req = { query: { apt: evil, area: '' }, protocol: 'https', get: () => 'myhomelog.example' };
  const res = _shareMockRes();
  handle(req, res);
  assert.equal(typeof res.body, 'string', '응답 본문이 문자열이 아니다');
  assert.ok(res.body.length <= originalLen + 4096,
    `치환이 증폭됐다 — 원본 ${originalLen}자, 응답 ${res.body.length}자 (상한 ${originalLen + 4096}자)`);
});



test('/share?apt= — 정상 입력에서는 치환이 여전히 동작한다 (회귀 방지)', () => {
  const handle = _shareHandler();
  const req = { query: { apt: '반포자이', area: '' }, protocol: 'https', get: () => 'myhomelog.example' };
  const res = _shareMockRes();
  handle(req, res);
  assert.equal(typeof res.body, 'string');
  assert.match(res.body, /<title>반포자이[^<]*<\/title>/, 'apt 값이 <title> 에 반영되지 않았다 — 치환이 깨졌다');
});



test('/share?cmp= — 비교 공유 분기도 같은 길이 상한을 지킨다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const originalLen = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8').length;
  const handle = _shareHandler();
  const evil = _SHARE_EXPAND_PAIR.repeat(10); // aptName 상한 40자 이내
  const arr = [{ aptName: evil }, { aptName: evil }];
  const cmp = Buffer.from(JSON.stringify(arr), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const req = { query: { apt: '', cmp }, protocol: 'https', get: () => 'myhomelog.example' };
  const res = _shareMockRes();
  handle(req, res);
  assert.equal(typeof res.body, 'string', '응답 본문이 문자열이 아니다');
  assert.ok(res.body.length <= originalLen + 4096,
    `cmp 분기 치환이 증폭됐다 — 원본 ${originalLen}자, 응답 ${res.body.length}자 (상한 ${originalLen + 4096}자)`);
});



// ── Plan 035 후속 (2026-09-06): 방어층 "존재" 자체를 배선 계약으로 고정 ──────────────
//   [왜] 위 3개 테스트는 "증폭이 일어나지 않는다"는 결과만 본다. 그런데 layer①(lit 함수형
//   치환)과 layer②(escapeHtml 의 $ 이스케이프)는 어느 한쪽만 남아도 그 결과를 만족시킨다 —
//   리뷰어 실측: lit() 만 제거해도 escapeHtml 이 이미 $ 를 지워버려 기존 테스트는 fail 0,
//   두 겹을 전부 제거해야 fail 2 로 드러난다. 결과만 보면 두 방어 중 하나가 조용히 사라져도
//   아무도 모른다 — 그래서 결과가 아니라 "두 방어가 각각 소스에 존재하는가" 를 직접 고정한다.
//   배선/부재 계약이라 소스 문자열 검사가 맞는 도구다(이 저장소의 확립된 판단 기준).
//   ⚠ 검사 대상 리터럴은 문자 코드로 조립한다 — 자기 문서를 잡는 자충수가 이 저장소에서
//   6회 재발했다(위 _SHARE_EXPAND_PAIR 와 같은 이유).
test('share.js 방어 배선 — lit() 함수형 치환과 escapeHtml $ 이스케이프가 각각 소스에 남아 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/share.js'), 'utf8');

  // ── 방어층 ①: HTML 태그 치환(.replace(/<..., ...)) 은 전부 lit() 로 감싸져야 한다.
  //    (base64 문자 치환 .replace(/-/g,'+') 류는 정규식이 '<' 로 시작하지 않아 범위 밖이고,
  //     escapeHtml 자신의 .replace(/[<>"'&$]/g, c => ...) 도 대괄호로 시작해 범위 밖이다 — 오탐 아님)
  const TAG_REPLACE_RE = /\.replace\(\/<(?:\\.|[^\\/])*\/[a-z]*\s*,\s*(lit\()?/g;
  const calls = [...src.matchAll(TAG_REPLACE_RE)];
  assert.ok(calls.length >= 18,
    `HTML 태그 치환(.replace(/<...)) 호출이 ${calls.length}건뿐이다 — 기대 18건(분기 2개 × 9치환). `
    + '치환 블록 자체가 줄었다면 이 기대치부터 갱신하고 원인을 확인할 것.');
  const bare = calls.filter((m) => !m[1]).length;
  assert.equal(bare, 0,
    `.replace(/<...) 호출 ${calls.length}건 중 ${bare}건이 lit() 로 감싸지지 않았다 — `
    + 'replacement 가 문자열/템플릿 리터럴로 되돌아가면 $ 확장 재스캔 방어(층①)가 그 자리에서 사라진다. '
    + 'escapeHtml 의 $ 이스케이프(층②)가 아직 살아 있는 동안은 증폭이 재현되지 않아 결과 기반 테스트로는 '
    + '못 잡는다(리뷰어 실측: lit() 만 제거 → 기존 테스트 fail 0) — 그래서 이 배선 자체를 고정한다.');

  const litRefs = (src.match(/\blit\(/g) || []).length;
  assert.ok(litRefs >= 19,
    `lit( 참조가 ${litRefs}건 — 기대 19건 이상(치환 18 + 헬퍼 정의/주석 참조). `
    + '줄었다면 어딘가의 lit(...) 호출이 문자열 치환으로 되돌아간 것이다.');

  // lit 헬퍼 자신이 "인자 없는 함수를 반환하는 함수" 모양이어야 한다 — 호출부가 전부
  // lit(...) 를 쓰고 있어도 lit 자신이 (s) => s 처럼 문자열을 그대로 반환해 버리면
  // 호출부 표기(lit(...))는 그대로 남은 채로 재스캔 방어만 조용히 무효화된다.
  assert.match(src, /const lit\s*=\s*\([^()]*\)\s*=>\s*\(\)\s*=>\s*[^;]+;/,
    'lit 헬퍼가 "인자 없는 함수를 반환하는" 모양이 아니다 — lit(s) 의 반환값이 함수여야 '
    + '.replace() 가 그 반환값을 재스캔하지 않는다. 헬퍼가 문자열을 직접 반환하도록 바뀌면 '
    + '호출부의 lit(...) 표기만으로는 이 회귀를 알아챌 수 없다.');

  // ── 방어층 ②: escapeHtml 이 '$' 를 이스케이프하는지 — 문자 클래스 + 매핑 객체 둘 다 확인.
  //    (하나만 확인하면 "문자 클래스엔 있는데 매핑 테이블에서만 빠짐" 같은 절반 회귀를 놓친다)
  const fnStart = src.indexOf('function escapeHtml(');
  assert.ok(fnStart >= 0, 'share.js 에서 escapeHtml 함수를 찾지 못했다 — 이름이 바뀌었으면 이 테스트도 갱신할 것');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));

  const D = String.fromCharCode(36); // '$' — 소스에 리터럴로 안 쓰고 조립(자충수 방지, _SHARE_EXPAND_PAIR 와 같은 이유)
  const classRe = new RegExp('\\[[^\\]]*\\' + D + '[^\\]]*\\]');
  assert.match(fnBody, classRe,
    `escapeHtml 의 정규식 문자 클래스에 ${D} 이스케이프 대상이 없다 — 이스케이프 대상에서 빠지면 `
    + `layer① 이 지워졌을 때 되돌아갈 안전망(층②)이 없는 상태가 된다.`);

  const mapRe = new RegExp("['\"]\\" + D + "['\"]\\s*:\\s*['\"]&#36;['\"]");
  assert.match(fnBody, mapRe,
    `escapeHtml 매핑 객체에 ${D} → &#36; 항목이 없다 — 문자 클래스에서 매치돼도 변환표가 없으면 `
    + `undefined 로 치환돼 조용히 깨지거나, 실제로는 원문 ${D} 가 그대로 새어나간다.`);

  // ── GATE-CALLSITE-2026-09-06 (Plan 060 ①): **호출부** 실행 검증.
  //   [왜] 위 두 검사는 escapeHtml "정의" 만 본다 — `const t = escapeHtml(title)` 를
  //   `const t = title` 로(호출부 삭제) 바꿔도 위 단언은 전부 그대로 통과한다(감사자 실측).
  //   그 상태에서 실제 핸들러를 호출하면 응답에 `</title><script>alert(1)</script>` 가
  //   원문 그대로 실린다 — /share 는 인증·레이트리밋이 없는 공개 SSR 경로이고 server.js 의
  //   CSP scriptSrc 에 'unsafe-inline' 이 있어 브라우저에서 실제 실행된다.
  //   [방식] 소스 문자열이 아니라 실제 라우터 핸들러(_shareHandler)를 그대로 실행해 응답
  //   본문을 확인한다 — 변수명·공백을 바꾸는 의미 보존 리팩터로는 절대 fail 하지 않는다.
  const handle = _shareHandler();
  const evilApt = '</title><script>alert(1)</script>';
  const req = { query: { apt: evilApt, area: '' }, protocol: 'https', get: () => 'myhomelog.example' };
  const res = _shareMockRes();
  handle(req, res);
  assert.equal(typeof res.body, 'string', '/share 응답 본문이 문자열이 아니다');
  assert.ok(!res.body.includes('<script>alert(1)</script>'),
    '/share 가 apt 값을 이스케이프 없이 그대로 응답에 실었다 — escapeHtml 호출부가 사라지면 '
    + '이 문자열이 원문 그대로 새어나간다(XSS, /share 는 인증·레이트리밋 없는 공개 경로)');
  assert.ok(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    '/share 응답에서 이스케이프된 형태(&lt;script&gt;…)를 찾지 못했다 — escapeHtml 호출부가 '
    + '사라졌거나 title 이 이스케이프를 거치지 않고 응답에 실렸을 가능성이 있다');
});
