/**
 * backend/test/audit-retention-1y.test.js
 *
 * plans/164 B1 (2026-10-18): 이용 기록(audit_log) 일반 행은 365일 미만으로 지우지 않는다 —
 * 처리방침 "개인정보 처리 시스템 접근 기록 1년 이상 보관"과 맞춘다(종전 90일 삭제가 어긋났다).
 * JS(Vercel cron)와 DB(pg_cron prune_audit_log) 두 곳이 같은 기준·같은 영구 보관 목록이어야 한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadWithEnv(v) {
  const p = require.resolve('../jobs/auditPrune');
  delete require.cache[p];
  const saved = process.env.AUDIT_LOG_RETENTION_DAYS;
  if (v === undefined) delete process.env.AUDIT_LOG_RETENTION_DAYS; else process.env.AUDIT_LOG_RETENTION_DAYS = v;
  try { return require('../jobs/auditPrune').RETENTION_DAYS; }
  finally {
    if (saved === undefined) delete process.env.AUDIT_LOG_RETENTION_DAYS; else process.env.AUDIT_LOG_RETENTION_DAYS = saved;
    delete require.cache[p];
  }
}

test('보관 일수는 기본 365, 환경변수가 더 작거나 이상해도 365 미만이 되지 않는다', () => {
  assert.equal(loadWithEnv(undefined), 365);
  assert.equal(loadWithEnv('90'), 365);
  assert.equal(loadWithEnv('abc'), 365);
  assert.equal(loadWithEnv('730'), 730);
});

test('DB 함수 SQL 은 365일이고 영구 보관 목록이 JS RETAIN_ACTIONS 와 같다', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261018_audit_log_retain_1y.sql'), 'utf8');
  assert.match(sql, /INTERVAL '365 days'/);
  assert.doesNotMatch(sql, /INTERVAL '90 days'/);
  const js = fs.readFileSync(path.join(__dirname, '../jobs/auditPrune.js'), 'utf8');
  const jsList = [...(js.match(/const RETAIN_ACTIONS = \[([\s\S]*?)\];/) || [])[1].matchAll(/'([a-z_.]+)'/g)].map(m => m[1]).sort();
  const sqlList = [...(sql.match(/ARRAY\[([\s\S]*?)\]/) || [])[1].matchAll(/'([a-z_.]+)'/g)].map(m => m[1]).sort();
  assert.ok(jsList.length >= 9);
  assert.deepEqual(sqlList, jsList);
});
