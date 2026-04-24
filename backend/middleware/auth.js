/**
 * Supabase JWT 검증 미들웨어
 *
 * 동작:
 *   - Authorization: Bearer <jwt> 헤더 파싱
 *   - Supabase 의 getUser(token) 으로 JWT 검증 + 유저 조회
 *   - req.user = { id, email } 주입
 *   - account_deletion_requests.status='pending' 이면 /restore·/deletion-status 외 모두 차단 (HTTP 423)
 *
 * 두 가지 모드:
 *   - requireAuth: 토큰 없거나 무효면 401
 *   - optionalAuth: 토큰 없어도 통과, 유효하면 req.user 주입
 *
 * RLS 호환:
 *   - 라우트가 supabase-js 클라이언트를 만들 때 토큰 주입하면
 *     `(select auth.uid()) = user_id` RLS 정책이 자동 적용됨.
 *
 * 캐시:
 *   - 토큰별 5초 마이크로캐시 — Supabase getUser 라운드트립 절감
 *   - 삭제 pending 상태도 같은 TTL 내 캐시 (재로그인 후 /restore 하면 즉시 반영되도록 5s 로 짧게)
 */
const { getSupabasePublic, getSupabaseAdmin } = require('../db/client');
const logger = require('../logger');

const TOKEN_CACHE = new Map(); // token -> { user, deletionPending, expiresAt }
const TTL_MS = 5 * 1000;

// pending 상태에서도 허용되는 경로 — 복구 + 상태 조회만
const DELETION_ALLOWED_PATHS = new Set([
  '/api/account/restore',
  '/api/account/deletion-status',
]);

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

async function checkDeletionPending(userId) {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return false; // service_role 미설정 시 차단 불가 — 로그만 남김
    const { data, error } = await admin
      .from('account_deletion_requests')
      .select('status, scheduled_hard_delete_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error.message, userId }, 'deletion-pending 조회 실패 — 통과 처리');
      return false;
    }
    if (!data || data.status !== 'pending') return false;
    // 유예기간 만료는 여기서 별도 처리 안 함 — retention job 이 상태 전환 책임
    return true;
  } catch (e) {
    logger.warn({ err: e.message, userId }, 'deletion-pending 확인 예외');
    return false;
  }
}

async function verifyToken(token) {
  const cached = TOKEN_CACHE.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { user: cached.user, deletionPending: cached.deletionPending };
  }

  const sb = getSupabasePublic();
  if (!sb) return { user: null, deletionPending: false };

  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return { user: null, deletionPending: false };
    const user = { id: data.user.id, email: data.user.email };
    const deletionPending = await checkDeletionPending(user.id);

    TOKEN_CACHE.set(token, { user, deletionPending, expiresAt: Date.now() + TTL_MS });
    if (TOKEN_CACHE.size > 1000) {
      const cutoff = Date.now();
      for (const [k, v] of TOKEN_CACHE) {
        if (v.expiresAt < cutoff) TOKEN_CACHE.delete(k);
      }
    }
    return { user, deletionPending };
  } catch (e) {
    logger.warn({ err: e.message }, 'JWT 검증 실패');
    return { user: null, deletionPending: false };
  }
}

function isDeletionAllowed(req) {
  // originalUrl 은 미들웨어 마운트 지점 이후의 경로가 아닌 전체 경로
  const p = (req.originalUrl || req.url || '').split('?')[0];
  return DELETION_ALLOWED_PATHS.has(p);
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });

  verifyToken(token).then(({ user, deletionPending }) => {
    if (!user) return res.status(401).json({ error: '세션이 만료되었거나 유효하지 않습니다.' });
    req.user = user;
    req.accessToken = token;

    if (deletionPending && !isDeletionAllowed(req)) {
      return res.status(423).json({
        error: '계정 삭제가 예약된 상태입니다. /api/account/restore 로 복구하거나 유예기간 종료를 기다려주세요.',
        code: 'account_deletion_pending',
      });
    }
    next();
  }).catch((e) => {
    logger.error({ err: e }, 'requireAuth 예외');
    res.status(500).json({ error: '인증 처리 중 오류' });
  });
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  verifyToken(token).then(({ user, deletionPending }) => {
    if (user) {
      req.user = user;
      req.accessToken = token;
      req.deletionPending = deletionPending;
    }
    next();
  }).catch(() => next());
}

module.exports = { requireAuth, optionalAuth, verifyToken };
