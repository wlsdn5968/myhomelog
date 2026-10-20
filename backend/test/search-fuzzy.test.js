/**
 * backend/test/search-fuzzy.test.js — FUZZY-RETRY-2026-10-21: 구글 서치 콘솔 실제 검색어 중 0건이던 것들의 보조 패턴.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const f = require('../routes/search')._fuzzyPatterns;

test('끝말(시세·가격·아파트) 제거 + 글자 순서 패턴', () => {
  assert.deepEqual(f('반포리체 시세'), ['%반%포%리%체%']);
  assert.deepEqual(f('동탄 롯데캐슬 가격'), ['%동%탄%롯%데%캐%슬%']);
  assert.deepEqual(f('병점아이파크캐슬'), ['%병%점%아%이%파%크%캐%슬%']);
  assert.deepEqual(f('금화마을3단지'), ['%금%화%마%을%3%']);
  assert.deepEqual(f('갑천2 트리 풀 시티 엘리 프 시세'), ['%갑%천%2%트%리%풀%시%티%엘%리%프%']);
});

test('역 이름: 먼저 "역"만 떼고, 그다음 역 낱말을 빼고 · 와일드카드 문자는 지운다 · 3글자 미만은 패턴 없음', () => {
  assert.deepEqual(f('안양역 삼성래미안'), ['%안%양%역%삼%성%래%미%안%', '%안%양%삼%성%래%미%안%', '%삼%성%래%미%안%']);
  assert.deepEqual(f('장지역 송파해링턴타워').slice(-1), ['%송%파%해%링%턴%타%워%']);
  assert.deepEqual(f('목련'), []);
  assert.deepEqual(f('%%_목련공원'), ['%목%련%공%원%']);
});

test('배선: 보조 검색은 앞 두 단계가 모두 0건일 때만', () => {
  const s = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(s, /\/\/ FUZZY-RETRY-2026-10-21: 구글 서치 콘솔[\s\S]*?if \(!molitRows\.length && !\(\(masterRes\.data \|\| \[\]\)\.length\)\) \{\r?\n\s*for \(const pat of fuzzyPatterns\(qApt\)\) \{/);
});
