/**
 * DB/Supabase 클라이언트 싱글톤
 *
 * 1) `supabaseAdmin` — service_role 키 사용. RLS 우회 가능 (서버 사이드 only).
 * 2) `supabasePublic` — publishable(anon) 키 사용. RLS 적용. 로그인 사용자 컨텍스트 주입 가능.
 *
 * 참고:
 *   - Drizzle ORM 인스턴스(getDb)는 이전 설계에선 export 했으나 현재 어떤 라우터도
 *     사용하지 않음(전부 Supabase 클라이언트만 사용) → 부팅 타임 connection 낭비를
 *     줄이기 위해 제거. drizzle-orm 패키지 자체는 db/schema.js 의 SSOT 정의용으로
 *     여전히 사용되며, drizzle-kit 이 이걸 읽어 SQL 마이그레이션을 생성한다.
 *
 * Vercel 서버리스 호환:
 *   - 각 함수 인스턴스에서 createClient 호출은 가벼움 (HTTP 기반)
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const schema = require('./schema');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
// Vercel env 가 'service_role' 짧은 이름으로 추가될 수 있어 fallback (D1 ETL 운영 호환)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

let _admin = null;
let _public = null;

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

module.exports = {
  getSupabaseAdmin,
  getSupabasePublic,
  schema,
};
