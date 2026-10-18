/**
 * backend/test/plan166-list-share.test.js
 *
 * plans/166 3-2 — "공유해서 바로 같이 보기".
 *   LIST-SHARE   관심 단지 묶음(≤30)을 /share?list=<b64url JSON> 로 공유 — 서버는 크롤러 미리보기 제목만 치환,
 *                복원은 클라이언트 handleListUrl → 목록 시트(열기 · 내 관심 단지에 모두 담기).
 *   KAKAO-SHARE  카카오톡 공유는 <meta name="kakao-js-key"> 가 비어 있지 않을 때만 — SDK 2.8.3 + SRI, CSP script-src 허용.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { _shareHandler, _shareMockRes } = require('../testSupport/_helpers');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');
const b64url = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('LIST-SHARE 서버: ?list= 는 단지 이름으로 제목·설명을 만들고 noindex 를 붙인다', () => {
  const handle = _shareHandler();
  const list = b64url([{ aptName: '은마', lawdCd: '11680' }, { aptName: '래미안대치팰리스' }, { aptName: '<b>x</b>' }, { aptName: '개포주공' }, { nope: 1 }]);
  const req = { query: { apt: '', list }, protocol: 'https', get: () => 'myhomelog.example' };
  const res = _shareMockRes();
  handle(req, res);
  assert.equal(typeof res.body, 'string');
  assert.match(res.body, /<title>관심 단지 4곳 — 내집로그<\/title>/);
  assert.match(res.body, /<meta property="og:title" content="관심 단지 4곳 — 내집로그">/);
  assert.match(res.body, /<meta property="og:description" content="은마, 래미안대치팰리스, &lt;b&gt;x&lt;\/b&gt; 외 1곳 — 함께 보는 관심 단지 목록이에요/);
  assert.match(res.body, /<meta name="robots" content="noindex, follow">/);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/myhomelog.example\/share\?list=/);
  assert.doesNotMatch(res.body, /<b>x<\/b>/, '단지 이름이 이스케이프 없이 들어갔다');
});

test('LIST-SHARE 서버: 깨진 list 도 200 으로 일반 제목을 주고, apt 가 있으면 apt 분기가 우선한다', () => {
  const handle = _shareHandler();
  let res = _shareMockRes();
  handle({ query: { apt: '', list: '%%%not-base64' }, protocol: 'https', get: () => 'h' }, res);
  assert.match(res.body, /<title>관심 단지 — 내집로그<\/title>/);
  res = _shareMockRes();
  handle({ query: { apt: '', list: b64url({ aptName: '객체' }) }, protocol: 'https', get: () => 'h' }, res);
  assert.match(res.body, /<title>관심 단지 — 내집로그<\/title>/, '배열이 아니면 이름 0');
  res = _shareMockRes();
  handle({ query: { apt: '반포자이', list: b64url([{ aptName: '은마' }]) }, protocol: 'https', get: () => 'h' }, res);
  assert.match(res.body, /<title>반포자이[^<]*<\/title>/);
});

test('LIST-SHARE 서버: 이름 31개 이상은 30개까지만 세고, 응답 길이가 증폭되지 않는다', () => {
  const originalLen = html.length;
  const handle = _shareHandler();
  const arr = Array.from({ length: 45 }, (_, i) => ({ aptName: `단지${i}` }));
  const res = _shareMockRes();
  handle({ query: { apt: '', list: b64url(arr) }, protocol: 'https', get: () => 'h' }, res);
  assert.match(res.body, /<title>관심 단지 30곳 — 내집로그<\/title>/);
  assert.ok(res.body.length <= originalLen + 4096);
});

test('LIST-SHARE 프런트: 직렬화는 30개 상한·형식 검증(lawdCd 5자리·aptSeq 5-N)·이름 필수', () => {
  const m = html.match(/function _listShareItems\(arr\)\{[\s\S]*?\n\}/);
  assert.ok(m, '_listShareItems 없음');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(m[0] + '\nconst LIST_SHARE_MAX = 30; this.f = _listShareItems;', ctx);
  const out = ctx.f([
    { aptName: '은마', sigungu: '강남구', umdNm: '대치동', lawdCd: '11680', aptSeq: '11680-123', kaptCode: 'A13583507' },
    { aptName: '', lawdCd: '11680' },
    { aptName: 'x'.repeat(60), lawdCd: 'abcde', aptSeq: 'bad', kaptCode: 'bad code!' },
    null,
  ]);
  // vm 컨텍스트의 Object 는 다른 realm 이라 프로토타입이 달라 JSON 왕복으로 비교한다
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    { aptName: '은마', sigungu: '강남구', umdNm: '대치동', lawdCd: '11680', aptSeq: '11680-123', kaptCode: 'A13583507' },
    { aptName: 'x'.repeat(40), sigungu: '', umdNm: '', lawdCd: '', aptSeq: '', kaptCode: '' },
  ]);
  assert.equal(ctx.f(Array.from({ length: 50 }, (_, i) => ({ aptName: `a${i}` }))).length, 30);
});

test('LIST-SHARE 프런트: 진입 시 handleListUrl 이 불리고, 목록 시트에 열기·모두 담기가 있고, 담기는 _bkIndex 로 중복을 거른다', () => {
  assert.match(html, /setTimeout\(handleCompareUrl, 350\);\r?\n[^\n]*\r?\n  setTimeout\(handleListUrl, 350\);/);
  assert.match(html, /function handleListUrl\(\)\{[\s\S]*?sp\.get\('list'\)[\s\S]*?_openSharedListModal\(items\);/);
  assert.match(html, /onclick="_openSharedListItem\(\$\{i\}\)"/);
  assert.match(html, /onclick="_addSharedListToBookmarks\(\)"/);
  assert.match(html, /function _addSharedListToBookmarks\(\)\{[\s\S]*?if \(_bkIndex\(bks, p\) >= 0 \|\| bks\.some\(b => b\.aptName === p\.aptName[\s\S]*?saveBookmarks\(bks\);/);
  // 저장 키는 단지 코드·단지 번호만(합성 키 금지 — 상세의 키와 어긋나 중복 저장됐던 실측)
  assert.match(html, /const key = a\.kaptCode \|\| a\.aptSeq \|\| '';\r?\n\s*bks\.unshift\(\{ aptKey: key, kaptCode: a\.kaptCode \|\| null,/);
  // 관심 단지 패널 버튼(비교 버튼 앞)
  assert.match(html, /el\.innerHTML=_pushBtnHtml\(\) \+ _kkoBtnHtml\(\) \+ _bkShareBtn \+ _bkCmpBtn \+ bks\.map/);
  assert.match(html, /onclick="shareBookmarkList\(\)"/);
  // 시트 문구는 매수 추천이 아님을 밝힌다
  assert.match(html, /매수·매도 추천이 아니에요\.<\/div>\r?\n\s*<ul/);
});

test('KAKAO-SHARE: 키 메타가 비어 있으면 꺼지고, SDK 는 고정 버전+SRI, 메타가 비면 SDK 를 로드하지 않는다', () => {
  assert.match(html, /<meta name="kakao-js-key" content="">/);
  assert.match(html, /const KAKAO_SDK_SRC = 'https:\/\/t1\.kakaocdn\.net\/kakao_js_sdk\/2\.8\.3\/kakao\.min\.js';/);
  assert.match(html, /const KAKAO_SDK_SRI = 'sha384-[A-Za-z0-9+/=]{64}';/);
  assert.match(html, /el\.integrity = KAKAO_SDK_SRI; el\.crossOrigin = 'anonymous';/);
  assert.match(html, /const key = _kakaoKey\(\); if \(!key\) return false;/);
  // 실행 값: 메타가 비면 _kakaoReady 는 네트워크 없이 false
  const ready = html.match(/async function _kakaoReady\(\)\{[\s\S]*?\n\}/)[0];
  const keyFn = html.match(/function _kakaoKey\(\)\{[^\n]*\n/)[0];
  const ctx = { document: { querySelector: () => ({ content: '  ' }), createElement() { throw new Error('SDK 를 로드하면 안 된다'); } }, window: {} };
  vm.createContext(ctx);
  vm.runInContext(keyFn + ready + '\nthis.p = _kakaoReady();', ctx);
  return ctx.p.then((v) => assert.equal(v, false));
});

test('KAKAO-SHARE: shareCurrent·shareCompare·shareBookmarkList 모두 _kakaoShare → navigator.share → 클립보드 순', () => {
  for (const name of ['shareCurrent', 'shareCompare', 'shareBookmarkList']) {
    const fn = html.match(new RegExp(`async function ${name}\\(\\)\\{[\\s\\S]*?\\n\\}`))[0];
    const k = fn.indexOf('await _kakaoShare('), n = fn.indexOf('navigator.share'), c = fn.indexOf('navigator.clipboard');
    assert.ok(k > -1 && n > k && c > n, `${name}: 순서가 kakao(${k}) → share(${n}) → clipboard(${c}) 가 아니다`);
  }
  // 단지 상세 공유는 단지 OG 카드를 이미지로(형식 검증 뒤)
  assert.match(html, /imageUrl: _seqOk \? `\$\{location\.origin\}\/api\/og\/apt\/\$\{currentDetail\.aptSeq\}` : undefined/);
});

test('KAKAO-SHARE CSP: vercel.json 정적 라우트 6곳과 helmet 에 t1.kakaocdn.net (상위집합 계약 frontend-contracts 와 같은 이유)', () => {
  // 결제 페이지 CSP 는 보고 전용(2026-09-02 결정)이라 동작 영향 없음 — helmet 호스트 상위집합 계약 때문에 같이 넣는다.
  const v = read('../../vercel.json');
  const srcs = [...v.matchAll(/script-src [^;]*/g)].map((m) => m[0]);
  assert.equal(srcs.length, 6);
  for (const s of srcs) assert.ok(s.includes('https://t1.kakaocdn.net'), s);
  assert.match(read('../server.js'), /'https:\/\/t1\.kakaocdn\.net', \/\/ KAKAO-SHARE-2026-10-18/);
});
