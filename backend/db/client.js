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

// ── SSOT-2026-08-09 (Plan 007): 자체 createClient 24개 파일 산재 → 아래 팩토리로 통합 ──
//   실장애 근거: 458ddd4(NODE-2) — regulationsAiCheck 만 SUPABASE_SECRET_KEY 라는 자기만의
//   env 를 읽어 cron 매 실행 실패. 생성 지점이 하나면 env명 드리프트가 원리적으로 재발 불가.
//   새 파일에서 createClient 직접 호출 금지 — 반드시 이 모듈의 팩토리를 쓸 것.

/** admin env 존재 여부만 판정 — DB_ENABLED/DB_FIRST 류 모듈 게이트 계산용 */
function hasAdminEnv() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

/** admin 필수 경로용(ETL·회원탈퇴 등) — 미설정이면 throw (구 파일별 throw형 가드 표준화) */
function requireSupabaseAdmin(context) {
  const c = getSupabaseAdmin();
  if (!c) throw new Error(`Supabase 미설정${context ? ' — ' + context : ''}`);
  return c;
}

/** 공개 읽기용 키 선택 — 순수 함수(특성화 테스트 고정용 export).
 *  publishable 우선(defense in depth): RLS 적용 키를 우선 사용하고, 공개읽기 RLS 가 열려있는
 *  테이블만 조회하는 경로라 service_role 폴백도 동작상 안전 — 구 regulationsService 의도 주석 이전. */
function _pickReadonlyKey(env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY
      || env.SUPABASE_SERVICE_ROLE_KEY || env.service_role || null;
}

let _readonly = null;
/** 공개 데이터 읽기용(검색 자동완성·인기 단지·규제 스냅샷 등) — 미설정 시 null */
function getSupabaseReadonly() {
  if (_readonly) return _readonly;
  const key = _pickReadonlyKey(process.env);
  if (!SUPABASE_URL || !key) {
    logger.warn('SUPABASE_URL/공개키 미설정 — supabaseReadonly 비활성');
    return null;
  }
  _readonly = createClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _readonly;
}

/** 로그인 사용자 RLS 컨텍스트(auth.uid() 주입) — 토큰별이므로 per-request 생성, 싱글톤 금지 */
function getUserScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = {
  getSupabaseAdmin,
  getSupabasePublic,
  getSupabaseReadonly,
  getUserScopedClient,
  requireSupabaseAdmin,
  hasAdminEnv,
  _pickReadonlyKey,
  schema,
};
