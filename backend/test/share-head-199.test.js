/**
 * Plan 199: /share 는 HTML 머리(</head> 앞)만 치환하고 뒤를 이어 붙인다.
 * 옛 방식(전체 문자열에 같은 치환을 이어 붙임)의 결과와 바이트 단위로 같아야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _SHARE_EXPAND_PAIR, _shareHandler, _shareMockRes } = require('../testSupport/_helpers');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const lit = (s) => () => s;
const esc = (s) => String(s == null ? '' : s).replace(/[<>"'&$]/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;', '$': '&#36;',
}[c]));

// 옛 방식: 전체 문자열에 치환을 이어 붙인다
function oldRewrite(t, d, u, ogImg) {
  let r = HTML
    .replace(/<title>[^<]*<\/title>/, lit(`<title>${t}</title>`))
    .replace(/<meta name="description" content="[^"]*">/, lit(`<meta name="description" content="${d}">`))
    .replace(/<meta property="og:title" content="[^"]*">/, lit(`<meta property="og:title" content="${t}">`))
    .replace(/<meta property="og:description" content="[^"]*">/, lit(`<meta property="og:description" content="${d}">`))
    .replace(/<meta property="og:url" content="[^"]*">/, lit(`<meta property="og:url" content="${u}">`))
    .replace(/<meta name="twitter:title" content="[^"]*">/, lit(`<meta name="twitter:title" content="${t}">`))
    .replace(/<meta name="twitter:description" content="[^"]*">/, lit(`<meta name="twitter:description" content="${d}">`))
    .replace(/<link rel="canonical" href="[^"]*">/, lit(`<link rel="canonical" href="${u}">`))
    .replace(/<meta name="robots" content="[^"]*">/, lit(`<meta name="robots" content="noindex, follow">`));
  if (ogImg) {
    r = r
      .replace(/<meta property="og:image" content="[^"]*">/, lit(`<meta property="og:image" content="${ogImg}">`))
      .replace(/<meta name="twitter:image" content="[^"]*">/, lit(`<meta name="twitter:image" content="${ogImg}">`));
  }
  return r;
}

function run(query) {
  const res = _shareMockRes();
  const req = { query, protocol: 'https', get: () => 'example.test' };
  _shareHandler()(req, res);
  return res;
}
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('Plan 199: ?apt= 응답이 옛 방식과 바이트 단위로 같다', () => {
  const apt = '래미안', area = '노원구';
  const t = esc(`${apt} · ${area} | 내집로그`);
  const d = esc(`${apt} (${area}) 국토교통부 실거래로 정리한 평균가, 평형별 시세, 점수 요약. 매수 추천이 아니에요.`);
  const u = esc(`https://example.test/share?apt=${encodeURIComponent(apt)}&area=${encodeURIComponent(area)}`);
  assert.equal(run({ apt, area }).body, oldRewrite(t, d, u, ''));
});

test('Plan 199: ?apt=&seq= (OG 이미지 갈래)가 옛 방식과 같다', () => {
  const apt = 'x', seq = '11350-41';
  const t = esc(`${apt} | 내집로그`);
  const d = esc(`${apt} 국토교통부 실거래로 정리한 평균가, 평형별 시세, 점수 요약. 매수 추천이 아니에요.`);
  const u = esc(`https://example.test/share?apt=x&seq=${encodeURIComponent(seq)}`);
  const og = esc(`https://example.test/api/og/apt/${seq}`);
  const body = run({ apt, seq }).body;
  assert.equal(body, oldRewrite(t, d, u, og));
  assert.ok(body.includes(`property="og:image" content="${og}"`));
});

test('Plan 199: ?cmp= 응답이 옛 방식과 같다', () => {
  const cmp = b64([{ aptName: '가단지' }, { aptName: '나단지' }]);
  const label = '가단지 vs 나단지';
  const t = esc(`${label} 평당가 비교 | 내집로그`);
  const d = esc(`${label} 전용면적 기준 평당가와 단지정보 비교(국토교통부 실거래). 매수 추천이 아니에요.`);
  const u = esc(`https://example.test/share?cmp=${encodeURIComponent(cmp)}`);
  assert.equal(run({ cmp }).body, oldRewrite(t, d, u, ''));
});

test('Plan 199: ?list= 응답이 옛 방식과 같다', () => {
  const list = b64([{ aptName: 'A단지' }, { aptName: 'B단지' }, { aptName: 'C단지' }]);
  const t = esc('관심 단지 3곳 | 내집로그');
  const d = esc('A단지, B단지, C단지. 함께 보는 관심 단지 목록이에요(국토교통부 실거래). 매수 추천이 아니에요.');
  const u = esc(`https://example.test/share?list=${encodeURIComponent(list)}`);
  assert.equal(run({ list }).body, oldRewrite(t, d, u, ''));
});

test('Plan 199: 확장 패턴을 10번 이어 붙인 apt 이름도 다시 펼쳐지지 않는다', () => {
  const apt = _SHARE_EXPAND_PAIR.repeat(10);
  const body = run({ apt }).body;
  assert.ok(body.length <= HTML.length + 2000, `응답 길이 ${body.length} > 원본 ${HTML.length} + 2000`);
});

test('Plan 199: 치환 대상 11개 태그가 모두 첫 </head> 앞에 있다', () => {
  const end = HTML.indexOf('</head>');
  assert.ok(end > 0);
  const targets = [
    /<title>[^<]*<\/title>/,
    /<meta name="description" content="[^"]*">/,
    /<meta property="og:title" content="[^"]*">/,
    /<meta property="og:description" content="[^"]*">/,
    /<meta property="og:url" content="[^"]*">/,
    /<meta name="twitter:title" content="[^"]*">/,
    /<meta name="twitter:description" content="[^"]*">/,
    /<link rel="canonical" href="[^"]*">/,
    /<meta name="robots" content="[^"]*">/,
    /<meta property="og:image" content="[^"]*">/,
    /<meta name="twitter:image" content="[^"]*">/,
  ];
  for (const re of targets) {
    const pos = HTML.search(re);
    assert.ok(pos >= 0 && pos < end, `${re} 위치 ${pos} 가 </head>(${end}) 앞이 아니다`);
  }
});
