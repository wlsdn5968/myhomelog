/**
 * Plan 197: 지도 영역 집계가 DB 오류를 삼키지 않고, 빠진 결과는 캐시하지 않는다(소스 계약 검사).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'search.js'), 'utf8');
const body = src.slice(src.indexOf("router.get('/in-bounds'"), src.indexOf("router.get('/facility'"));

test('in-bounds: 거래 페이지 조회는 error 를 받고 값만 받는 패턴이 없다', () => {
  assert.ok(body.length > 1000);
  assert.equal((body.match(/const \{ data: _page \} = await/g) || []).length, 0);
  assert.match(body, /const \{ data: _page, error: _pe \} = await _q/);
  assert.match(body, /const \{ data: _mp, error: _mpe \} = await admin/);
});

test('in-bounds: 거래와 별칭 조회 오류는 던져서 no-store 500 으로 간다', () => {
  assert.match(body, /if \(_pe\) throw _pe;/);
  assert.match(body, /if \(_mpe\) throw _mpe;/);
});

test('in-bounds: 본체 좌표 조회가 실패하면 캐시 헤더와 서버 메모 둘 다 건너뛴다', () => {
  assert.match(body, /if \(out\.length && !_ibNoCache\) res\.set\('Cache-Control', 'public/);
  assert.match(body, /if \(out\.length && !_ibNoCache\) \{/);
  assert.match(body, /if \(_krErr\) \{ _ibNoCache = true;/);
});
