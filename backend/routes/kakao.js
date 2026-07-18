/**
 * 카카오톡 알림 연결 OAuth 라우트 — Sprint FFFFFF (portai 패턴 포팅)
 *
 * portai 와의 구조 차이 (근본 이유 포함):
 *   portai 는 NextAuth 세션 쿠키라 callback(브라우저 GET 리다이렉트)에서 유저 식별 가능.
 *   우리는 Supabase JWT 를 Authorization 헤더로만 보내는 구조 → 카카오가 리다이렉트한 callback 요청엔
 *   토큰이 없음. 해결: authorize-url 단계(Bearer 인증)에서 user_id 를 HMAC 서명한 일회성 쿠키에 담아
 *   callback 이 쿠키로 유저를 복원. (state 쿠키 CSRF 방어는 portai 와 동일)
 *
 * 엔드포인트:
 *   GET  /api/kakao/status         (auth) — { configured, linked }
 *   POST /api/kakao/authorize-url  (auth) — { url } + Set-Cookie(서명 state)
 *   GET  /api/kakao/callback       (쿠키) — code 교환 → kakao_notify_tokens upsert → '/?kakao=...' 리다이렉트
 *   POST /api/kakao/items          (auth) — 관심단지 스냅샷 갱신 (북마크 변경 시)
 *   POST /api/kakao/disconnect     (auth) — 연결 해제(토큰 삭제)
 *
 * 게이트: KAKAO_REST_API_KEY(이미 존재) + 카카오 콘솔(로그인 활성화·Redirect URI·talk_message 선택동의)
 *        + kakao_notify_tokens 테이블(운영자 SQL). 미충족 시 status.configured=false → 프론트 버튼 숨김.
 */
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');
const { isKakaoConfigured, exchangeKakaoCode } = require('../services/kakaoMemoService');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const CANONICAL_HOST = 'https://myhomelog.vercel.app';
const STATE_COOKIE = 'mhl_kko_st';
const STATE_TTL_MS = 10 * 60 * 1000;

function dbClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// HMAC 키 — 별도 env 없이 service key 에서 파생 (용도 문자열로 분리)
function stateHmacKey() {
  return crypto.createHash('sha256').update(`mhl-kakao-state|${SERVICE_KEY || 'no-key'}`).digest();
}
function signState(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateHmacKey()).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyState(cookieVal) {
  try {
    const [data, sig] = String(cookieVal || '').split('.');
    if (!data || !sig) return null;
    const expect = crypto.createHmac('sha256', stateHmacKey()).update(data).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (_) { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const MAX_ITEMS = 30;
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).map(it => ({
    aptName: String(it?.aptName || '').slice(0, 60),
    lawdCd: /^\d{5}$/.test(String(it?.lawdCd || '')) ? String(it.lawdCd) : null,
    sigungu: String(it?.sigungu || '').slice(0, 20),
    umdNm: String(it?.umdNm || '').slice(0, 20),
  })).filter(it => it.aptName && it.lawdCd);
}

// ── 연결 상태 ──
router.get('/status', requireAuth, async (req, res) => {
  try {
    if (!isKakaoConfigured()) return res.json({ configured: false, linked: false });
    const admin = dbClient();
    if (!admin) return res.json({ configured: false, linked: false });
    const { data, error } = await admin.from('kakao_notify_tokens').select('user_id, linked_at').eq('user_id', req.user.id).maybeSingle();
    if (error) {
      if (String(error.code) === '42P01') return res.json({ configured: false, linked: false, gate: 'table' });
      throw new Error(error.message);
    }
    return res.json({ configured: true, linked: !!data, linkedAt: data?.linked_at || null });
  } catch (e) {
    logger.warn({ err: e.message }, 'kakao status 실패');
    return res.json({ configured: false, linked: false });
  }
});

// ── OAuth 시작 — 서명 쿠키 + authorize URL 반환 (프론트가 location.href 이동) ──
router.post('/authorize-url', requireAuth, (req, res) => {
  if (!isKakaoConfigured()) return res.status(503).json({ error: '카카오 알림이 아직 활성화되지 않았어요.' });
  const state = crypto.randomBytes(24).toString('base64url');
  const cookieVal = signState({ state, uid: req.user.id, exp: Date.now() + STATE_TTL_MS });
  const redirectUri = `${CANONICAL_HOST}/api/kakao/callback`;
  const u = new URL('https://kauth.kakao.com/oauth/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', process.env.KAKAO_REST_API_KEY);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  // 선택 동의 scope 는 명시해야 동의화면에 노출 (portai 실증)
  u.searchParams.set('scope', 'talk_message');
  res.setHeader('Set-Cookie',
    `${STATE_COOKIE}=${encodeURIComponent(cookieVal)}; Path=/api/kakao; Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
  return res.json({ url: u.toString() });
});

// ── OAuth callback (카카오 → 브라우저 리다이렉트, 인증 헤더 없음 — 서명 쿠키로 유저 복원) ──
router.get('/callback', async (req, res) => {
  const back = q => res.redirect(`/?kakao=${q}`);
  try {
    const { code, state, error: kkoErr } = req.query;
    if (kkoErr) return back('denied');
    const parsed = verifyState(readCookie(req, STATE_COOKIE));
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/api/kakao; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    if (!code || !state || !parsed || parsed.state !== state) return back('error');
    const ex = await exchangeKakaoCode(String(code), `${CANONICAL_HOST}/api/kakao/callback`);
    if (!ex.ok) { logger.warn({ err: ex.error }, 'kakao 토큰 교환 실패'); return back('error'); }
    // talk_message 동의 확인 — 미동의 시 저장하지 않고 재동의 유도 (portai 동일)
    if (!/\btalk_message\b/.test(ex.scope)) return back('no_scope');
    const admin = dbClient();
    if (!admin) return back('error');
    const { error } = await admin.from('kakao_notify_tokens').upsert({
      user_id: parsed.uid,
      access_token: ex.accessToken,
      refresh_token: ex.refreshToken || null,
      expires_at: ex.expiresIn ? new Date(Date.now() + ex.expiresIn * 1000).toISOString() : null,
      linked_at: new Date().toISOString(),
      fail_count: 0,
    }, { onConflict: 'user_id' });
    if (error) {
      if (String(error.code) === '42P01') { logger.warn('kakao_notify_tokens 미생성 — 운영자 SQL 대기'); return back('gate'); }
      throw new Error(error.message);
    }
    return back('linked');
  } catch (e) {
    logger.warn({ err: e.message }, 'kakao callback 실패');
    require('../utils/captureError').captureRouteError(e, 'kakao');
    return back('error');
  }
});

// ── 관심단지 스냅샷 갱신 (연결된 유저만 의미 있음) ──
router.post('/items', requireAuth, async (req, res) => {
  try {
    const admin = dbClient();
    if (!admin) return res.json({ ok: true });
    const items = sanitizeItems(req.body?.items);
    const { error } = await admin.from('kakao_notify_tokens').update({ items, updated_at: new Date().toISOString() }).eq('user_id', req.user.id);
    if (error && String(error.code) !== '42P01') throw new Error(error.message);
    return res.json({ ok: true, items: items.length });
  } catch (e) {
    logger.warn({ err: e.message }, 'kakao items 갱신 실패');
    return res.status(500).json({ error: '갱신 실패' });
  }
});

// ── 연결 해제 ──
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const admin = dbClient();
    if (admin) await admin.from('kakao_notify_tokens').delete().eq('user_id', req.user.id);
    return res.json({ ok: true });
  } catch (_) { return res.json({ ok: true }); }
});

module.exports = router;
