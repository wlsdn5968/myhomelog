/**
 * Plan 177 (2026-10-30, 운영자 승인 "권고대로"): 별칭 갱신 함수 실행 시간 단축.
 * v8 99초(v7 도 35~102초)가 주간 작업의 30초 끊기에 걸렸다 → v9 임시 표 방식(운영 실측 11~17초, 규칙 동일·바뀐 단지 0).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

test('v9 본체: 원본 한 번 집계·임시 표·인덱스, 권한은 service_role 만', () => {
  const sql = read('../../supabase/migrations/20261030_refresh_molit_aliases_v9_temp.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\._refresh_molit_aliases_core\(p_apply boolean\)/);
  assert.equal((sql.match(/FROM molit_transactions/g) || []).length, 1, '거래 원본은 한 번만 읽는다');
  assert.match(sql, /CREATE TEMP TABLE _ma_acc0 ON COMMIT DROP AS/);
  assert.match(sql, /CREATE INDEX ON pg_temp\._ma_mj/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\._refresh_molit_aliases_core\(boolean\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\._refresh_molit_aliases_core\(boolean\) TO service_role;/);
  assert.match(sql, /RETURN public\._refresh_molit_aliases_core\(true\);/, '기존 함수 이름(호출 코드)은 그대로');
  const schema = read('../../supabase/schema.sql');
  assert.ok(schema.lastIndexOf('RETURN public._refresh_molit_aliases_core(true);') > schema.lastIndexOf('CREATE OR REPLACE FUNCTION public.refresh_molit_aliases()'));
});

test('v9 규칙 문장은 v8 과 같다(판정 조건·보정표·거부 연결만 제거)', () => {
  const v8 = strip(read('../../supabase/migrations/20261030_alias_overrides_refresh_v8.sql'));
  const v9 = strip(read('../../supabase/migrations/20261030_refresh_molit_aliases_v9_temp.sql'));
  for (const frag of [
    "WHERE (by_jibun OR (by_name AND digits_ok)) AND molit !~ '상가|근린|근생|판매시설|오피스텔'",
    "(i.nn <> '' AND m.nn <> '' AND (m.nn=i.nn OR starts_with(i.nn,m.nn) OR starts_with(m.nn,i.nn))",
    "WHERE NOT EXISTS (SELECT 1 FROM apt_alias_overrides o WHERE o.action='remove' AND o.kapt_code=fin.kapt_code AND o.molit_name=fin.molit)",
    'SELECT kapt_code, molit FROM cur EXCEPT SELECT kapt_code, molit FROM fin2',
    'AND a.molit_aliases IS DISTINCT FROM t.aliases',
  ]) {
    assert.ok(v8.includes(frag.replace('t.aliases', 'tgt.aliases')) || v8.includes(frag), `v8 에 있어야: ${frag}`);
    assert.ok(v9.includes(frag), `v9 에 있어야: ${frag}`);
  }
});

test('주간 작업: 별칭 갱신 끊기 시간은 남은 예산 기준(최대 120초, 300초 한도 안)', () => {
  const s = read('../jobs/aptMasterSync.js');
  assert.match(s, /\.abortSignal\(AbortSignal\.timeout\(aliasRefreshAbortMs\(Date\.now\(\) - started\)\)\)/);
  const fn = new Function(`${s.slice(s.indexOf('const ALIAS_REFRESH_MAX_MS'), s.indexOf('function aliasRefreshAbortMs'))}
    ${s.slice(s.indexOf('function aliasRefreshAbortMs'), s.indexOf('}', s.indexOf('function aliasRefreshAbortMs')) + 1)}; return aliasRefreshAbortMs;`)();
  assert.equal(fn(10000), 120000, '여유가 많으면 120초');
  assert.equal(fn(250000), 45000, '지역 루프가 마감까지 썼으면 남은 45초만');
  assert.equal(fn(294000), 5000, '최소 5초');
});
