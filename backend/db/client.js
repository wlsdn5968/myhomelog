/**
 * DB/Supabase 클라이언트 싱글톤
 *
 * 1) `supabaseAdmin` — service_role 키 사용. RLS 우회 가능 (서버 사이드 only).
 * 2) `supabasePublic` — publishable(anon) 키 사용. RLS 적용. 로그인 사용자 컨텍스트 주입 가능.
 * 3) `db` — Drizzle ORM 인스턴스 (postgres-js 드라이버). Service-role 과 동일 권한으로 DB 에 직결.
 *    → RLS 를 우회하므로 반드시 라우터 레이어에서 `userId` 검증을 명시적으로 걸어야 함.
 *
 * Vercel 서버리스 호환:
 *   - postgres-js 의 `prepare: false` + `max: 1` — 함수 인스턴스당 단일 연결
 *   - Supabase pooler (6543, transaction mode) 엔드포인트 사용 권장
 */
const { createClient } = require('@supabase/supabase-js');
const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const logger = require('../logger');
const schema = require('./schema');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

let _admin = null;
let _public = null;
let _db = null;
let _sql = null;

function getSupabaseAdmin() {
  if (_admin) return _admin;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn('SUPABASE_URL/SERVICE_ROLE_KEY 미설정 — supabaseAdmin 비활성');
    return null;
  }
  _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

function getSupabasePublic() {
  if (_public) return _public;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    logger.warn('SUPABASE_URL/PUBLISHABLE_KEY 미설정 — supabasePublic 비활성');
    return null;
  }
  _public = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _public;
}

function getDb() {
  if (_db) return _db;
  if (!DATABASE_URL) {
    logger.warn('DATABASE_URL 미설정 — Drizzle 비활성');
    return null;
  }
  _sql = postgres(DATABASE_URL, {
    prepare: false, // Supabase pooler (transaction mode) 호환
    max: 1,         // 서버리스 함수당 단일 연결
    idle_timeout: 20,
    connect_timeout: 10,
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}

module.exports = {
  getSupabaseAdmin,
  getSupabasePublic,
  getDb,
  closeDb,
  schema,
};
