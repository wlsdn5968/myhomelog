/**
 * backend/test/schema-sql-prod-sync.test.js
 *
 * SCHEMA-SYNC-2026-09-28 (Plan 120) — schema.sql 을 운영 DB 와 일치시킨다.
 *
 * 운영 카탈로그 전수 대조에서 발견된 불일치 4건:
 * 1. 452행 인덱스 정의가 운영 값과 다름 (옛 이름, INCLUDE 절 누락)
 * 2. apt_dim_recovery_queue 테이블이 schema.sql·migrations 어디에도 없음 (Plan 117 적용 기록 파일 미작성)
 * 3. 함수 2개(prune_molit_ingest_runs·upsert_hist_peaks_for_month)의 표기가 운영 본문과 다름
 * 4. 적용 기록 파일 20260926_apt_dim_recovery_queue.sql 이 없음
 *
 * 운영 값은 2026-09-28 pg_catalog 실측 — 운영 함수가 바뀌면 이 테스트도 같은 커밋에서 갱신.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const _schemaSrc = () => fs.readFileSync(path.join(__dirname, '../../supabase/schema.sql'), 'utf8');

/**
 * 블록(CREATE OR REPLACE FUNCTION부터 두 번째 $function$까지)을 추출하고
 * 공백 무시 md5를 계산한다.
 */
function _extractFunctionBlockAndMd5(schema, functionName) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  if (start < 0) {
    return { found: false, md5: null };
  }
  const firstClose = schema.indexOf('$function$', start);
  const secondClose = schema.indexOf('$function$', firstClose + 1);
  const block = schema.substring(start, secondClose + 10); // +10 for "$function$"
  const normalized = block.replace(/\s+/g, ' ').trim();
  const md5 = crypto.createHash('md5').update(normalized).digest('hex');
  return { found: true, md5, block };
}

// ══════════════════════════════════════════════════════════════════════════
// 단언 1: 인덱스 정의 교체 확인
// ══════════════════════════════════════════════════════════════════════════
test('schema.sql 단언 1 — idx_molit_aptseq_area_date(옛 이름) 0회, _amt(INCLUDE deal_amount) 1회', () => {
  const schema = _schemaSrc();

  // 옛 인덱스 정의(접미사 없음, INCLUDE 없음) 0회
  const oldIndexMatches = (schema.match(/CREATE INDEX idx_molit_aptseq_area_date ON public\.molit_transactions/g) || []);
  assert.equal(oldIndexMatches.length, 0,
    '옛 인덱스 이름(idx_molit_aptseq_area_date, 접미사 없음)이 여전히 정의로 있다');

  // 새 인덱스 정의(_amt, INCLUDE deal_amount) 1회
  const fullDef = 'CREATE INDEX idx_molit_aptseq_area_date_amt ON public.molit_transactions USING btree (apt_seq, exclu_use_ar, deal_date) INCLUDE (deal_amount) WHERE (apt_seq IS NOT NULL);';
  assert.match(schema, new RegExp(fullDef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '새 인덱스 정의(_amt, INCLUDE deal_amount 포함)가 정확히 없다 — 운영 값으로 교체 필요');
});

// ══════════════════════════════════════════════════════════════════════════
// 단언 2: apt_dim_recovery_queue 테이블 및 RLS 활성화 확인
// ══════════════════════════════════════════════════════════════════════════
test('schema.sql 단언 2 — apt_dim_recovery_queue 테이블 정의 1회, RLS enable 1회', () => {
  const schema = _schemaSrc();

  // 테이블 정의 1회
  const tableMatches = (schema.match(/create table if not exists public\.apt_dim_recovery_queue/gi) || []);
  assert.equal(tableMatches.length, 1,
    'apt_dim_recovery_queue 테이블 정의가 정확히 1번 있어야 한다');

  // RLS enable 1회
  const rlsMatches = (schema.match(/alter table public\.apt_dim_recovery_queue enable row level security/gi) || []);
  assert.equal(rlsMatches.length, 1,
    'apt_dim_recovery_queue RLS 활성화가 정확히 1번 있어야 한다');

  // 테이블 뒤에 RLS 문이 와야 한다(순서 확인)
  const tableIdx = schema.indexOf('create table if not exists public.apt_dim_recovery_queue');
  const rlsIdx = schema.indexOf('alter table public.apt_dim_recovery_queue enable row level security', tableIdx);
  assert.ok(rlsIdx > tableIdx,
    'RLS enable 문이 테이블 정의보다 뒤에 와야 한다');
});

// ══════════════════════════════════════════════════════════════════════════
// 단언 3: 함수 2개의 공백 무시 md5 일치 확인
// ══════════════════════════════════════════════════════════════════════════
test('schema.sql 단언 3 — prune_molit_ingest_runs 함수 공백 무시 md5 = fe8ffe690a5b52a9303876765905ebad (운영 값)', () => {
  const schema = _schemaSrc();
  const { found, md5 } = _extractFunctionBlockAndMd5(schema, 'prune_molit_ingest_runs');
  assert.ok(found, 'prune_molit_ingest_runs 함수를 찾을 수 없다');
  assert.equal(md5, 'fe8ffe690a5b52a9303876765905ebad',
    `prune_molit_ingest_runs 공백 무시 md5 불일치: ${md5} (운영 값과 다름)`);
});

test('schema.sql 단언 3 — upsert_hist_peaks_for_month 함수 공백 무시 md5 = b1eb1c062004763027929c065b4552d7 (운영 값)', () => {
  const schema = _schemaSrc();
  const { found, md5 } = _extractFunctionBlockAndMd5(schema, 'upsert_hist_peaks_for_month');
  assert.ok(found, 'upsert_hist_peaks_for_month 함수를 찾을 수 없다');
  assert.equal(md5, 'b1eb1c062004763027929c065b4552d7',
    `upsert_hist_peaks_for_month 공백 무시 md5 불일치: ${md5} (운영 값과 다름)`);
});

// ══════════════════════════════════════════════════════════════════════════
// 단언 4: 적용 기록 파일 존재 및 테이블 정의 포함 확인
// ══════════════════════════════════════════════════════════════════════════
test('migrations 단언 4 — 20260926_apt_dim_recovery_queue.sql 파일 존재 및 테이블 정의 포함', () => {
  const filePath = path.join(__dirname, '../../supabase/migrations/20260926_apt_dim_recovery_queue.sql');
  assert.ok(fs.existsSync(filePath),
    `적용 기록 파일이 없다: ${filePath}`);

  const content = fs.readFileSync(filePath, 'utf8');
  assert.match(content, /create table if not exists public\.apt_dim_recovery_queue/i,
    '적용 기록 파일에 apt_dim_recovery_queue 테이블 정의가 없다');
});
