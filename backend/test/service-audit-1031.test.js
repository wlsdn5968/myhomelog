/**
 * 2026-10-31 서비스 전체 점검(운영 화면을 처음부터 눌러 본 결과)에서 고친 것들의 회귀 검사.
 * ① 도우미 답의 조사: "잠실엘스"을 → 를 ② 검색으로 연 단지 상세의 끝나지 않는 "분석 대기" 표시 제거
 * ③ 목록 카드: 결과 영역이 좁으면(창 800~1024px) 단지 이름 칸이 0~31px 로 눌리던 배치
 * ④ 필요 현금 하한이 (매매가 − 대출)보다 낮던 계산은 regulation-tax.test.js 가 프론트·백엔드 실행값으로 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

test('도우미: 끝 글자 받침으로 을/를을 고른다', () => {
  const { _eulReul: j } = require('../services/chatDataRouter');
  assert.equal(j('잠실엘스'), '를');
  assert.equal(j('상계주공7단지'), '를');
  assert.equal(j('공덕동'), '을');
  assert.equal(j('삼성1'), '을');
  assert.equal(j('삼성2'), '를');
  assert.equal(j('N-Suite'), '을(를)');
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  assert.doesNotMatch(src, /"\$\{displayName\}"을 검색/);
});

test('단지 상세 요약줄: 점수가 없으면 "분석 대기"를 붙이지 않는다', () => {
  const i = html.indexOf("_ass.innerHTML =");
  const block = html.slice(i, i + 1200);
  assert.ok(i > 0);
  assert.doesNotMatch(block, /lvl unknown/);
});

test('목록 카드: 결과 영역 폭에 맞춰 두 줄·세 줄로 다시 놓는다(휴대폰 규칙은 별도)', () => {
  assert.match(html, /\.ld-list\{container-type:inline-size\}/);
  assert.match(html, /@container \(max-width:879px\)\{\s*\.ld-card\{grid-template-columns:minmax\(0,1fr\) 150px 132px;grid-template-areas:"apt avg cmp" "pyg loan cmp"/);
  assert.match(html, /@container \(max-width:559px\)\{\s*\.ld-card\{grid-template-columns:minmax\(0,1fr\) auto;/);
});

test('요청 제한: Upstash 가 예외(월 한도 초과)를 내면 fail-open 범위는 메모리 제한으로 대체(429), 비용 범위는 503', async () => {
  const http = require('http');
  const express = require('express');
  const stub = (rel, ex) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: ex }; };
  const rlPath = require.resolve('../middleware/rateLimit');
  const saved = { rl: require.cache[require.resolve('@upstash/ratelimit')], redis: require.cache[require.resolve('../redis')] };
  delete require.cache[rlPath];
  stub('@upstash/ratelimit', { Ratelimit: class { limit() { return Promise.reject(new Error('ERR max requests limit exceeded')); } static slidingWindow() { return {}; } } });
  stub('../redis', { getRedis: () => ({}) });
  try {
    const { makeRateLimiter } = require('../middleware/rateLimit');
    const app = express();
    app.get('/g', makeRateLimiter({ limit: 2, windowSec: 60, scope: 'general', message: 'm' }), (q, s) => s.json({ ok: 1 }));
    app.get('/c', makeRateLimiter({ limit: 2, windowSec: 60, scope: 'chat', message: 'm' }), (q, s) => s.json({ ok: 1 }));
    const srv = app.listen(0); const port = srv.address().port;
    const get = (p) => new Promise((res) => http.get({ port, path: p }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }));
    try {
      assert.deepEqual([await get('/g'), await get('/g'), await get('/g')], [200, 200, 429]);
      assert.equal(await get('/c'), 503);
    } finally { srv.close(); }
  } finally {
    delete require.cache[rlPath];
    for (const [k, v] of [['@upstash/ratelimit', saved.rl], ['../redis', saved.redis]]) { const p = require.resolve(k); if (v) require.cache[p] = v; else delete require.cache[p]; }
  }
});
