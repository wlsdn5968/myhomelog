/**
 * 2026-11-08 Vercel Hobby Active CPU 초과(팀 정지) 후속. 매번 새로 계산하던 경로에 공유 캐시를 붙인다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('지도 영역 조회: 결과가 있을 때만 5분 공유 캐시, 빈 결과와 실패는 저장하지 않는다', () => {
  const s = read('../routes/search.js');
  const body = s.slice(s.indexOf("router.get('/in-bounds'"), s.indexOf("router.get('/facility'"));
  assert.match(body, /if \(out\.length && !_ibNoCache\) res\.set\('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=1800'\);\s*else res\.set\('Cache-Control', 'no-store'\);/);
  assert.match(body, /res\.set\('Cache-Control', 'no-store'\);\s*res\.status\(500\)/);
});

test('지도 영역 조회 주소는 소수 셋째 자리로 바깥쪽으로 맞춘다(같은 영역 = 같은 주소)', () => {
  const html = read('../../frontend/index.html');
  const i = html.indexOf('async function loadAptsInBounds(');
  const f = html.slice(i, i + 900);
  assert.match(f, /Math\.floor\(Number\(v\) \* 1000\) \/ 1000/);
  assert.match(f, /south=\$\{_f\(south\)\}&west=\$\{_f\(west\)\}&north=\$\{_c\(north\)\}&east=\$\{_c\(east\)\}/);
  const _f = v => Math.floor(Number(v) * 1000) / 1000, _c = v => Math.ceil(Number(v) * 1000) / 1000;
  assert.ok(_f(37.61234) <= 37.61234 && _c(37.63456) >= 37.63456, '영역이 줄면 가장자리 단지가 빠진다');
});

test('쿼리 없는 공유 주소도 공유 캐시', () => {
  assert.match(read('../routes/share.js'), /res\.set\('Cache-Control', 'public, max-age=300, s-maxage=300'\);/);
});
