/**
 * backend/test/plan167-data-basis.test.js
 *
 * plans/167 §1 — ① 기준일/수집 시각 이중 표기(앱 상세 히어로 · 서버 렌더 단지/지역 페이지) ② /data-sources 출처 페이지.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fmtKst } = require('../utils/fmtKst');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('fmtKst: ISO → YYYY.MM.DD HH:mm(KST), 잘못된 입력은 빈 문자열', () => {
  assert.equal(fmtKst('2026-10-17T17:45:06.722+00:00'), '2026.10.18 02:45');
  assert.equal(fmtKst('2026-12-31T15:00:00Z'), '2027.01.01 00:00');
  assert.equal(fmtKst(''), ''); assert.equal(fmtKst(null), ''); assert.equal(fmtKst('not-a-date'), '');
});

test('서버 렌더: 단지 페이지는 최근 거래일 아래 "실거래 수집 … 기준" 행, 지역 페이지는 태그 줄 — 못 읽으면 줄을 뺀다', () => {
  const apt = read('../routes/aptPage.js');
  assert.match(apt, /const \{ fmtKst \} = require\('\.\.\/utils\/fmtKst'\);/);
  assert.match(apt, /let syncKst = '';\r?\n\s*try \{ const \{ readDataCounts \} = require\('\.\.\/services\/healthCounts'\); const dc = await readDataCounts\(\); syncKst = fmtKst\(dc && dc\.lastIngestedAt\); \} catch \(_\) \{ syncKst = ''; \}/);
  assert.match(apt, /최근 거래일<\/span><span class="num">\$\{esc\(String\(stat\.recentDeal\)\)\}<\/span><\/div>\r?\n\s*\$\{syncKst \? `<div class="row"><span class="k">실거래 수집<\/span><span class="num">\$\{esc\(syncKst\)\} 기준<\/span><\/div>` : ''\}/);
  const reg = read('../routes/regionPage.js');
  assert.match(reg, /<div class="tag">국토교통부 실거래 신고 자료 정리\$\{syncKst \? ` · 실거래 수집 \$\{esc\(syncKst\)\} 기준` : ''\}<\/div>/);
});

test('앱 상세 히어로: 수집 시각 한 줄(lastIngestedAt 우선, 없으면 띠의 kst, 둘 다 없으면 생략) + 지연 안내 문구', () => {
  const html = read('../../frontend/index.html');
  assert.match(html, /const _t0SyncIso=\(window\._dataCounts&&window\._dataCounts\.lastIngestedAt\)\|\|null;/);
  assert.match(html, /const _t0SyncTxt=_t0SyncIso\?_fmtKstFull\(_t0SyncIso\):\(\(window\._syncData&&window\._syncData\.kst\)\|\|''\);/);
  assert.match(html, /\$\{_t0SyncTxt\?`<div class="t0h-src">실거래 수집 \$\{_escHtml\(_t0SyncTxt\)\} 기준 · 국토교통부 신고 자료라 계약 뒤 30일 안 신고분은 늦게 반영될 수 있어요<\/div>`:''\}/);
  assert.match(html, /\.t0-hero \.t0h-src\{margin-top:7px;font-size:12px;color:var\(--t3\)/);
  // 프런트 포맷 함수는 서버와 같은 결과
  const fn = html.match(/function _fmtKstFull\(iso\)\{[^\n]*\n/)[0];
  const f = new Function(`${fn}; return _fmtKstFull;`)();
  assert.equal(f('2026-10-17T17:45:06.722+00:00'), fmtKst('2026-10-17T17:45:06.722+00:00'));
  assert.equal(f(''), '');
});

test('/data-sources: 라우터가 출처 목록·원칙·robots index 를 내고, 수집 시각을 못 읽어도 200', async () => {
  const router = require('../routes/dataSources');
  const layer = router.stack.find((l) => l.route && l.route.path === '/');
  assert.ok(layer, '/data-sources 라우트 없음');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, type() { return this; }, send(b) { this.body = b; return this; }, status() { return this; } };
  await handle({}, res);
  assert.equal(typeof res.body, 'string');
  assert.match(res.body, /<title>데이터 출처와 갱신 주기 — 내집로그<\/title>/);
  assert.match(res.body, /<meta name="robots" content="index, follow">/);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/myhomelog\.vercel\.app\/data-sources">/);
  for (const name of ['국토교통부', '한국부동산원 K-apt', '금융위원회', '한국은행 ECOS', '한국주택금융공사', 'KOSIS', '카카오', '나이스 교육정보 개방 포털']) {
    assert.ok(res.body.includes(name), `출처 누락: ${name}`);
  }
  assert.match(res.body, /값이 없으면 추정하지 않고 비워 둬요/);
  assert.match(res.body, /매수·매도 추천이 아니고/);
  assert.doesNotMatch(res.body, /공공누리/, '이용허락 유형은 저장소 근거가 없어 적지 않는다');
  // 갱신 주기 문구는 vercel.json cron 과 맞아야 한다(실거래 17:00~17:30 UTC = 새벽 2시대 KST · 단지 목록 월 20:00 UTC = 월요일 새벽 5시 KST · 알림 22:30 UTC = 07:30 KST)
  const crons = JSON.parse(read('../../vercel.json')).crons.map((c) => `${c.path} ${c.schedule}`).join('\n');
  assert.match(crons, /molit-ingest\?slot=0&slotCount=3 0 17 \* \* \*/);
  assert.match(crons, /apt-master-sync 0 20 \* \* 1/);
  const S = router._SOURCES;
  assert.match(S.find((s) => s.what.startsWith('아파트 매매 실거래가')).cycle, /새벽 2시대/);
  assert.match(S.find((s) => s.what.startsWith('공동주택 기본 정보')).cycle, /월요일 새벽 5시/);
});

test('/data-sources 배선: vercel.json 라우트(404 규칙 앞) · server.js 마운트 · 사이트맵 정적 목록', () => {
  const v = JSON.parse(read('../../vercel.json'));
  const idx = v.routes.findIndex((r) => r.src === '/data-sources' && r.dest === '/api/index.js');
  const last = v.routes.length - 1;
  assert.ok(idx > -1, 'vercel.json 에 /data-sources 라우트 없음');
  assert.ok(idx < last && v.routes[last].src === '/(.*)' && v.routes[last].status === 404, '404 규칙보다 앞에 있어야 한다');
  assert.match(read('../server.js'), /app\.use\('\/data-sources', require\('\.\/routes\/dataSources'\)\);/);
  assert.match(read('../routes/sitemap.js'), /\{ loc: '\/data-sources', lastmod: '2026-10-19', changefreq: 'monthly', priority: '0\.4' \}/);
});
