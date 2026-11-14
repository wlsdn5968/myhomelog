/**
 * ROWS-NOCLONE-2026-11-14: 거래 목록 캐시는 깊은 복제 대신 행마다 얕은 복사로 넣고 꺼낸다.
 *   지키는 것: 호출자끼리 행 객체를 공유하지 않는다(고쳐도 캐시가 오염되지 않는다), null 과 빈 배열 의미 유지,
 *   같은 인스턴스라 del·flushAll 이 그대로 지운다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = require('../cache');

const row = (i) => ({ aptName: '상계주공7(고층)', umdNm: '상계동', excluUseAr: 45.55, dealYear: 2026, dealMonth: 1, dealDay: i + 1, dealAmount: 36000 + i, aptSeq: '11350-41', jibun: '' });

test('setRows/getRows: 값은 같고, 넣은 배열과 꺼낸 배열과 그 행은 서로 다른 객체다', () => {
  const src = [row(0), row(1)];
  cache.setRows('t1114:a', src, 60);
  src[0].dealAmount = 1; // 넣은 뒤 원본을 고쳐도
  const a = cache.getRows('t1114:a');
  assert.equal(a[0].dealAmount, 36000, '넣은 뒤 원본 수정이 캐시에 들어갔다');
  a[1].dealAmount = 2; a.push(row(9)); // 꺼낸 것을 고쳐도
  const b = cache.getRows('t1114:a');
  assert.equal(b.length, 2);
  assert.equal(b[1].dealAmount, 36001, '꺼낸 값 수정이 캐시를 오염시켰다');
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(b, [row(0), row(1)]);
});

test('setRows/getRows: null 과 빈 배열, 없는 키는 지금과 같은 뜻이다', () => {
  cache.setRows('t1114:n', null, 60);
  assert.equal(cache.getRows('t1114:n'), null);
  cache.setRows('t1114:e', [], 60);
  assert.deepEqual(cache.getRows('t1114:e'), []);
  assert.equal(cache.getRows('t1114:none'), undefined);
});

test('setRows 로 넣은 키도 del 과 flushAll 로 지워진다(같은 인스턴스)', () => {
  cache.setRows('t1114:d', [row(0)], 60);
  cache.del('t1114:d');
  assert.equal(cache.getRows('t1114:d'), undefined);
  cache.setRows('t1114:f', [row(0)], 60);
  cache.flushAll();
  assert.equal(cache.getRows('t1114:f'), undefined);
});

test('거래 서비스의 거래 목록 캐시는 모두 getRows/setRows 를 쓴다', () => {
  const s = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  // 거래 목록 키 변수(ck, cacheKey)로 일반 get/set 을 하면 깊은 복제로 돌아간다(다른 이름의 키는 이 검사 밖)
  assert.equal((s.match(/cache\.(get|set)\((ck|cacheKey)/g) || []).length, 0, '거래 목록 키에 깊은 복제 경로가 남았다');
  for (const k of ['`txregion:', '`tx:', '`txapt:v2:', '`txseq:v2:']) assert.ok(s.includes(k), k);
  assert.equal((s.match(/cache\.getRows\((ck|cacheKey)\)/g) || []).length, 4, '네 키의 읽기가 모두 getRows 여야 한다');
});
