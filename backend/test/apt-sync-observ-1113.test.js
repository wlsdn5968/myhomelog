/**
 * APT-SYNC-OBSERV-2026-11-13: 11-09 apt-master-sync 회차가 125개 중 35개 지역만 돌고(remaining 90)
 * inserted 0, unchanged 0 으로 끝났다. health 에는 받은 행 수, 실패 지역 수, 429 횟수가 없어 원인을 못 봤고
 * Hobby 런타임 로그는 1시간만 남는다. 다음 회차부터 health 에서 원인을 읽을 수 있어야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _pick } = require('../services/cronStats');
const { _firstFetchError } = require('../jobs/aptMasterSync');

test('health 요약이 받은 행 수, 실패 지역 수, 429 횟수, 간격, 실패 사유를 남긴다', () => {
  const out = _pick({
    fetched: 0, inserted: 0, unchanged: 0, errors: 35, throttleHits: 12, intervalMs: 4000,
    remaining: 90, elapsedMs: 295291, failedLawds: ['11110'], fetchErrorSample: 'timeout of 8000ms exceeded',
  });
  assert.equal(out.fetched, 0);
  assert.equal(out.errors, 35);
  assert.equal(out.throttleHits, 12);
  assert.equal(out.intervalMs, 4000);
  assert.equal(out.remaining, 90);
  assert.equal(out.fetchErrorSample, 'timeout of 8000ms exceeded');
  assert.ok(!('failedLawds' in out), '배열은 그대로 싣지 않는다');
});

test('실패 사유에서 키=값 모양(serviceKey 등)을 지운다', () => {
  const s = _firstFetchError([{ lawdCd: '1', fetched: 3 }, { lawdCd: '2', fetchError: 'bad url ?serviceKey=abc%2Fdef&pageNo=1 failed' }]);
  assert.ok(!s.includes('abc'), s);
  assert.ok(s.includes('failed'));
  assert.equal(_firstFetchError([{ fetched: 1 }]), null);
});
