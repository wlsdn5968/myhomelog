#!/usr/bin/env node
/**
 * scripts/backup-db.js — Supabase 무료 요금제는 자동 백업이 없다(plans/168). 운영자 PC 에서 주 1회.
 *
 * [왜 이 방식인가 — 2026-10-21 정정] 처음 안내한 `npx supabase db dump` 는 공식 문서상 "컨테이너 안에서 pg_dump 를 실행"하므로
 *   Docker 가 필요한데, 운영자 PC 에는 Docker·psql 이 없다(실측). 그래서 이미 설치된 Node 와 @supabase/supabase-js 만으로 표 데이터를 내보낸다.
 *   표 구조(스키마)는 저장소의 supabase/schema.sql·migrations 가 원본이다.
 *
 * 사용법(PowerShell, 저장소 루트):
 *   $env:SUPABASE_URL = "https://brxorvxdfrbxcavufspe.supabase.co"
 *   $env:SUPABASE_SECRET_KEY = "<대시보드 Settings > API Keys 의 secret 키>"   # 채팅·파일에 붙여 넣지 말 것
 *   node scripts/backup-db.js              # 원본 거래(국토부에서 다시 받을 수 있음)·이력 제외 — 주 1회
 *   node scripts/backup-db.js --with-hist  # + 이력 거래 136만 행(약 10분) — 월 1회
 *
 * 결과: .local-backups/YYYYMMDD/<표>.ndjson.gz + manifest.json(표별 DB 행 수·내보낸 행 수·일치 여부). 90일 지난 폴더는 지운다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let createClient;
try { ({ createClient } = require('@supabase/supabase-js')); }
catch (_) { ({ createClient } = require(path.join(__dirname, '..', 'backend', 'node_modules', '@supabase', 'supabase-js'))); }

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('환경변수 SUPABASE_URL 과 SUPABASE_SECRET_KEY 를 먼저 넣어 주세요(plans/168 §2).');
  process.exit(1);
}
const WITH_HIST = process.argv.includes('--with-hist');
const db = createClient(URL, KEY, { auth: { persistSession: false } });

// 표 → 페이지 순서(기본 키). molit_transactions 는 국토부 API 로 다시 받을 수 있어 제외한다.
const TABLES = {
  apt_master: 'kapt_code', apt_geocache: 'id', apt_amenities: 'cache_key', apt_schools: 'apt_key',
  building_register: 'id', molit_apt_dim: 'apt_seq', molit_hist_peaks: 'apt_seq,exclu_use_ar',
  molit_hist_runs: 'lawd_cd,deal_ym', molit_ingest_runs: 'id', apt_dim_recovery_queue: 'lawd_cd,deal_ym',
  computed_snapshots: 'key', briefing_snapshots: 'day', popular_apts_snapshot: 'id', regulations_snapshot: 'id',
  billing_plans: 'id', visit_attribution: 'id',
  // 회원 데이터 — 다시 만들 수 없다
  bookmarks: 'id', field_notes: 'user_id,apt_name', search_history: 'id', chat_sessions: 'id', chat_messages: 'id',
  push_subscriptions: 'id', kakao_notify_tokens: 'user_id', activity_counters: 'user_id,year,kind', user_budget: 'user_id,month',
  user_billing: 'user_id', payments: 'id', account_deletion_requests: 'user_id', ai_feedback: 'id', data_error_reports: 'id',
  audit_log: 'id',
};

const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const root = path.join(__dirname, '..', '.local-backups');
const dir = path.join(root, day);
fs.mkdirSync(dir, { recursive: true });

async function countRows(table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table} 개수 조회 실패: ${error.message}`);
  return count;
}

// 적대 리뷰 2026-10-30: 카카오 OAuth 토큰이 로컬 백업에 평문으로 남았다 — 재연결로 다시 받을 수 있으므로 백업에서 뺀다.
const SECRET_COLUMNS = { kakao_notify_tokens: ['access_token', 'refresh_token'] };
function _omitSecrets(table, row) {
  const cols = SECRET_COLUMNS[table];
  if (!cols) return row;
  const copy = { ...row };
  for (const c of cols) delete copy[c];
  return copy;
}

async function dumpTable(table, order) {
  const out = zlib.createGzip();
  const file = fs.createWriteStream(path.join(dir, `${table}.ndjson.gz`));
  out.pipe(file);
  let n = 0;
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select('*');
    for (const col of order.split(',')) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table} 읽기 실패(${from}~): ${error.message}`);
    for (const row of data) out.write(JSON.stringify(_omitSecrets(table, row)) + '\n');
    n += data.length;
    if (data.length < 1000) break;
  }
  await new Promise((res) => { file.on('finish', res); out.end(); });
  return n;
}

// 이력 거래: 기본 키가 없다. 단지 번호(apt_seq, 인덱스 있음) 기준으로 "마지막 번호 다음부터" 1,000행씩 읽되,
//   페이지 끝에 걸친 마지막 단지는 버리고 그 단지만 따로 통째로 읽는다(한 단지가 두 페이지에 쪼개져 빠지거나 겹치지 않게).
//   단지 목록(molit_apt_dim)에 없는 이력 644행(2026-10-21 실측)도 빠지지 않는다.
async function dumpHist() {
  const out = zlib.createGzip();
  const file = fs.createWriteStream(path.join(dir, 'molit_transactions_hist.ndjson.gz'));
  out.pipe(file);
  const put = (rows) => { for (const row of rows) out.write(JSON.stringify(row) + '\n'); return rows.length; };
  const ord = (q) => q.order('apt_seq').order('deal_date').order('exclu_use_ar').order('deal_amount').order('floor', { nullsFirst: true });
  let n = 0, last = null, pages = 0;
  for (;;) {
    let q = db.from('molit_transactions_hist').select('*');
    if (last !== null) q = q.gt('apt_seq', last);
    const { data, error } = await ord(q).limit(1000);
    if (error) throw new Error(`이력 읽기 실패: ${error.message}`);
    if (data.length < 1000) { n += put(data); break; }
    const edge = data[data.length - 1].apt_seq;
    n += put(data.filter((r) => r.apt_seq !== edge));
    for (let from = 0; ; from += 1000) { // 경계 단지는 따로 통째로
      const r = await ord(db.from('molit_transactions_hist').select('*').eq('apt_seq', edge)).range(from, from + 999);
      if (r.error) throw new Error(`이력 읽기 실패(${edge}): ${r.error.message}`);
      n += put(r.data);
      if (r.data.length < 1000) break;
    }
    last = edge;
    if (++pages % 50 === 0) process.stdout.write(`  이력 ${n.toLocaleString()}행…\r`);
  }
  await new Promise((res) => { file.on('finish', res); out.end(); });
  return n;
}

(async () => {
  const manifest = { day, startedAt: new Date().toISOString(), withHist: WITH_HIST, tables: {} };
  let bad = 0;
  for (const [table, order] of Object.entries(TABLES)) {
    try {
      const expected = await countRows(table);
      const got = await dumpTable(table, order);
      const ok = got === expected;
      if (!ok) bad++;
      manifest.tables[table] = { expected, got, ok };
      console.log(`${ok ? '✔' : '✖'} ${table}: ${got}/${expected}`);
    } catch (e) { bad++; manifest.tables[table] = { error: e.message }; console.log(`✖ ${table}: ${e.message}`); }
  }
  if (WITH_HIST) {
    try {
      const expected = await countRows('molit_transactions_hist');
      const got = await dumpHist();
      manifest.tables.molit_transactions_hist = { expected, got, ok: got === expected };
      if (got !== expected) bad++;
      console.log(`${got === expected ? '✔' : '✖'} molit_transactions_hist: ${got}/${expected}`);
    } catch (e) { bad++; manifest.tables.molit_transactions_hist = { error: e.message }; console.log(`✖ 이력: ${e.message}`); }
  }
  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // 90일 지난 백업 폴더 정리
  for (const d of fs.readdirSync(root)) {
    if (/^\d{8}$/.test(d) && d < new Date(Date.now() - 90 * 86400e3 + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')) {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
  }
  console.log(bad ? `\n완료 — 문제 ${bad}건(위 ✖ 줄과 ${path.join(dir, 'manifest.json')} 를 계획자에게 알려 주세요)` : `\n완료 — 모든 표 행 수 일치. 폴더: ${dir}`);
  process.exit(bad ? 1 : 0);
})();
