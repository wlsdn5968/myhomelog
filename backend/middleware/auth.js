/**
 * Supabase JWT 검증 미들웨어
 *
 * 동작:
 *   - Authorization: Bearer <jwt> 헤더 파싱
 *   - Supabase 의 getUser(token) 으로 JWT 검증 + 유저 조회
 *   - req.user = { id, email } 주입
 *
 * 두 가지 모드:
 *   - requireAuth: 토큰 없거나 무효면 401
 *   - optionalAuth: 토큰 없어도 통과, 유효하면 req.user 주입
 *
 * RLS 호환:
 *   - 라우트가 supabase-js 클라이언트를 만들 때 토큰 주입하면
 *     `(select auth.uid()) = user_id` RLS 정책이 자동 적용됨.
 *   - Drizzle 직결의 경우 req.user.id 를 명시적으로 WHERE 에 포함 필수.
 *
 * 캐시:
 *   - 토큰별 1분 마이크로캐시 (서버리스 함수당) — Supabase getUser 라운드트립 절감
 */
const { getSupabasePublic } = require('../db/client');
const logger = require('../logger');

const TOKEN_CACHE = new Map(); // token -> { user, expiresAt }
const TTL_MS = 60 * 1000;

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

async function verifyToken(token) {
  // micro-cache
  const cached = TOKEN_CACHE.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const sb = getSupabasePublic();
  if (!sb) return null; // Supabase 미설정 — auth 비활성

  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return null;
    const user = { id: data.user.id, email: data.user.email };
    TOKEN_CACHE.set(token, { user, expiresAt: Date.now() + TTL_MS });
    // 캐시 폭주 방지 — 1000 초과 시 절반 정리
    if (TOKEN_CACHE.size > 1000) {
      const cutoff = Date.now();
      for (const [k, v] of TOKEN_CACHE) {
        if (v.expiresAt < cutoff) TOKEN_CACHE.delete(k);
      }
    }
    return user;
  } catch (e) {
    logger.warn({ err: e.message }, 'JWT 검증 실패');
    return null;
  }
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });

  verifyToken(token).then((user) => {
    if (!user) return res.status(401).json({ error: '세션이 만료되었거나 유효하지 않습니다.' });
    req.user = user;
    req.accessToken = token;
    next();
  }).catch((e) => {
    logger.error({ err: e }, 'requireAuth 예외');
    res.status(500).json({ error: '인증 처리 중 오류' });
  });
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  verifyToken(token).then((user) => {
    if (user) {
      req.user = user;
      req.accessToken = token;
    }
    next();
  }).catch(() => next());
}

module.exports = { requireAuth, optionalAuth, verifyToken };
