/**
 * BUDGET-OFF-1118 (plans/210): health 가 쌓이지 않는 월 예산을 DB 에서 읽지 않는다.
 * 실행: cd backend && TZ=UTC node --test test/health-no-budget-1118.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFrontend } = require('../testSupport/readFrontend');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('health 는 월 예산을 조회하지 않고 응답에도 싣지 않는다', () => {
  assert.ok(!/budgetService\.checkBudget\(/.test(server));
  assert.ok(!/require\('\.\/services\/budgetService'\)/.test(server));
  assert.ok(!/^\s*monthlyBudget,\s*$/m.test(server));
});

test('화면은 월 예산 칸을 읽지 않는다', () => {
  assert.ok(!readFrontend().includes('monthlyBudget'));
});

test('사용량을 적는 함수를 부르는 곳이 생기면 이 조회를 되살릴지 다시 정한다', () => {
  // recordUsage 를 부르는 코드가 생겼다면 값이 다시 쌓인다는 뜻이다. 그때는 이 계획의 전제가 바뀐다.
  const dir = (p) => fs.readdirSync(path.join(__dirname, '..', p)).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, '..', p, f));
  const files = [path.join(__dirname, '../server.js'), ...dir('routes'), ...dir('services'), ...dir('jobs'), ...dir('middleware')];
  const callers = files.filter((f) => !f.endsWith('budgetService.js') && /recordUsage\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(callers.map((f) => path.basename(f)), []);
});
