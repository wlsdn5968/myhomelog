/**
 * Plan 183: 로컬 백업(scripts/backup-db.js)에서 결제 키와 푸시 구독 키를 뺀다.
 * 스크립트는 환경변수가 없으면 바로 끝나므로 require 하지 않고 파일을 문자열로 읽어 확인한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'backup-db.js'), 'utf8');

function secretColumns() {
  const start = src.indexOf('SECRET_COLUMNS = {');
  assert.ok(start >= 0, 'SECRET_COLUMNS 선언을 찾지 못했다');
  const objStart = src.indexOf('{', start);
  const end = src.indexOf('};', objStart);
  assert.ok(end > objStart, 'SECRET_COLUMNS 끝을 찾지 못했다');
  return new Function('return ' + src.slice(objStart, end + 1))();
}

function tableNames() {
  const start = src.indexOf('const TABLES = {');
  const end = src.indexOf('};', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/([a-z_]+):\s*'/g)].map((m) => m[1]);
}

test('백업에서 빼는 비밀 열이 결제·푸시·카카오 표를 모두 덮는다', () => {
  const sc = secretColumns();
  const expected = {
    kakao_notify_tokens: ['access_token', 'refresh_token'],
    push_subscriptions: ['p256dh', 'auth'],
    user_billing: ['toss_billing_key', 'toss_customer_key'],
    payments: ['toss_payment_key', 'raw_response'],
  };
  for (const [table, cols] of Object.entries(expected)) {
    assert.ok(sc[table], `${table} 가 SECRET_COLUMNS 에 없다`);
    for (const c of cols) assert.ok(sc[table].includes(c), `${table}.${c} 가 빠져 있다`);
  }
  const tables = tableNames();
  for (const t of Object.keys(expected)) {
    assert.ok(tables.includes(t), `${t} 가 TABLES 에서 보이지 않는다(파서 점검)`);
    assert.ok(sc[t], `${t} 는 백업 대상인데 SECRET_COLUMNS 에 없다`);
  }
});
