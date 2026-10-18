/**
 * backend/test/plan166-dead-ends.test.js
 *
 * plans/166 3-1 — "이미 있는데 닿지 않는 기능" 6건 + 3-5 health 중복 호출.
 *   A1 FN-PULL      임장 노트를 서버에서 받아온다(종전 PUT 만 — "모든 기기에서 자동으로 동기화" 안내가 거짓)
 *   A2 NOTIFY-DEEPLINK 알림 도착지: 단지 1곳이면 그 단지 딥링크, 서비스 워커는 열린 창을 그 주소로 이동
 *   A3 SHARE-OG     공유 링크에 seq 가 있으면 단지별 OG 카드를 미리보기 이미지로
 *   A4 HIST-CLICK   검색 이력을 눌러 다시 검색
 *   A5 CMP-KEEP     비교 담기를 세션에 기억하고 같은 결과가 오면 복원
 *   A8 ENTER-PENDING 결과 도착 전 Enter 안내 + 도착 시 첫 결과 열기
 *   3-5 HEALTH-AUTH-DEDUP 로그인 사용자 health 20초 캐시
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');

test('A1: 임장 노트를 서버에서 받아와 더 새 것이면 로컬에 덮어쓴다', () => {
  assert.match(html, /async function _pullFieldNote\(aptName\)\{/);
  assert.match(html, /fetch\(`\$\{CFG\.api\}\/field-notes\/\$\{encodeURIComponent\(aptName\)\}`, \{ headers: await _authHdr\(\{\}\)/);
  assert.match(html, /if \(!\(srvAt > \(Number\(local\.savedAt\) \|\| 0\)\)\) return;/);
  assert.match(html, /function renderFieldNote\(p\)\{\n  const n=p\.aptName;\n  _pullFieldNote\(n\);/);
});

test('A2: 알림 URL 은 단지 1곳이면 ?apt=&area= 딥링크, 여럿이면 첫 화면 · 항목에 area 가 담긴다', () => {
  const m = require('../jobs/pushNotify');
  assert.equal(m._notifyUrl([{ name: '은마', area: '강남구 대치동' }], ''), '/?apt=%EC%9D%80%EB%A7%88&area=%EA%B0%95%EB%82%A8%EA%B5%AC%20%EB%8C%80%EC%B9%98%EB%8F%99');
  assert.equal(m._notifyUrl([{ name: 'a' }, { name: 'b' }], 'https://x.test'), 'https://x.test/');
  assert.equal(m._notifyUrl([], ''), '/');
  const rows = [{ ingested_at: '2026-10-18T10:00:00Z', apt_name: '공릉풍림아이원', umd_nm: '공릉동', lawd_cd: '11350', deal_amount: 31000 }];
  const e = m._matchItems([{ aptName: '공릉풍림아이원', lawdCd: '11350', sigungu: '노원구', umdNm: '공릉동' }], rows, new Map(), new Date('2026-10-17T00:00:00Z'));
  // TARGET-NOTIFY-2026-10-19: minMan 추가(목표가 판정용) — targetEok 가 없으면 targetEok/hit 필드는 생기지 않는다
  assert.deepEqual(e, [{ name: '공릉풍림아이원', count: 1, maxMan: 31000, minMan: 31000, area: '노원구 공릉동' }]);
  const src = read('../jobs/pushNotify.js');
  assert.match(src, /url: notifyUrl\(entries, ''\)/);
  assert.match(src, /webUrl: notifyUrl\(entries, 'https:\/\/myhomelog\.vercel\.app'\)/);
  assert.doesNotMatch(src, /url: '\/' \}\)/);
});

test('A2: 서비스 워커는 열린 창을 알림 주소로 이동시킨다', () => {
  const sw = read('../../frontend/sw.js');
  assert.match(sw, /if \('navigate' in w && url && url !== '\/'\) \{ try \{ await w\.navigate\(url\); \} catch \(_\) \{\} \}/);
});

test('A3: 공유 링크 seq → 단지별 OG 이미지(단지 분기에서만, 형식 검증)', () => {
  const sh = read('../routes/share.js');
  assert.match(sh, /const seq = \/\^\\d\{5\}-\\d\+\$\/\.test\(String\(req\.query\.seq \|\| ''\)\) \? String\(req\.query\.seq\) : '';/);
  assert.match(sh, /const ogImg = seq \? escapeHtml\(`\$\{origin\}\/api\/og\/apt\/\$\{seq\}`\) : '';/);
  assert.equal((sh.match(/property="og:image" content="\[\^"\]\*"/g) || []).length, 1, 'og:image 치환은 단지 분기 1곳');
  assert.match(sh, /if \(ogImg\) \{\n\s*rewritten = rewritten\n\s*\.replace\(\/<meta property="og:image"/);
  assert.match(html, /if\(\/\^\\d\{5\}-\\d\+\$\/\.test\(String\(currentDetail\.aptSeq\|\|''\)\)\) u\.searchParams\.set\('seq', String\(currentDetail\.aptSeq\)\);/);
});

test('A4: 검색 이력 항목은 버튼이고 누르면 다시 검색한다', () => {
  assert.match(html, /class="um-hist-item" onclick="_rerunSearch\(\$\{_escHtml\(JSON\.stringify\(h\.query\|\|''\)\)\}\)"/);
  assert.match(html, /function _rerunSearch\(q\)\{[\s\S]*?closeUserMenu\(\);[\s\S]*?onHeaderSearchInput\(q\);/);
  assert.match(html, /function closeUserMenu\(\)/);
});

test('A5: 비교 담기는 단지 키로 세션에 기억하고 결과가 오면 복원한다', () => {
  assert.match(html, /const CMP_KEEP_KEY = 'mhl_cmp_keep';/);
  assert.match(html, /function _cmpKeyOf\(p\)\{ return p \? `\$\{p\.aptName \|\| ''\}\|\$\{p\.lawdCd \|\| ''\}\|\$\{p\.umdNm \|\| ''\}` : ''; \}/);
  assert.match(html, /try\{ _cmpRemember\(\); \}catch\(_\)\{\}\n  renderCmpBar\(\);\n\}/);
  assert.match(html, /try\{ _cmpRestore\(\); \}catch\(_\)\{\}\n    renderPList\(\);/);
  assert.match(html, /function clearCmp\(\)\{\n  cmpSel\.clear\(\);\n  try \{ sessionStorage\.removeItem\(CMP_KEEP_KEY\); \} catch\(_\)\{\}/);
});

test('A8: 결과 도착 전 Enter 는 안내하고, 도착하면 첫 결과를 연다', () => {
  assert.match(html, /if \(q\.length >= 2\) \{ e\.preventDefault\(\); window\._hEnterPending = q; toast\('검색 결과를 불러오는 중이에요'\); \}/);
  assert.match(html, /if \(window\._hEnterPending && window\._hEnterPending === q\) \{ window\._hEnterPending = null; if \(results\.length\) \{ goSearchResult\(results\[0\]\); return; \} \}/);
});

test('3-5: 로그인 사용자 health 도 20초 캐시·진행 중 합치기', () => {
  assert.match(html, /function _healthAuthJson\(headers\)\{/);
  assert.match(html, /if \(_hlthAuthVal && \(Date\.now\(\) - _hlthAuthAt\) < HEALTH_TTL_MS\) return Promise\.resolve\(_hlthAuthVal\);/);
  assert.match(html, /\? await _healthAuthJson\(headers\)\n      : await healthJson\(5000\);/);
  assert.doesNotMatch(html, /\? await fetch\(`\$\{CFG\.api\}\/health`,\{headers, signal:AbortSignal\.timeout\(5000\)\}\)/);
});
