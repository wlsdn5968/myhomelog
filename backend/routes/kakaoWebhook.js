/**
 * 카카오 연결 해제 웹훅 수신 — Sprint NNNNNNN-22
 *
 * 왜 필요한가 (2026-08-25 콘솔 실측):
 *   사용자가 카카오계정 페이지·카카오톡의 [연결된 서비스 관리]에서 우리 앱 연결을 끊거나 카카오계정을
 *   탈퇴하면, 우리 서비스는 그 사실을 알 방법이 전혀 없어 개인정보가 그대로 남는다(PIPA 파기 의무 누락 소지).
 *   카카오 콘솔 [앱]>[웹훅] 도 같은 경고를 띄우는데, 실측 결과 웹훅 3종이 **전부 미등록**이었고
 *   백엔드에도 수신 엔드포인트가 없었다(grep 0건).
 *
 * 공식 스펙 (developers.kakao.com/docs/ko/kakaologin/callback — 2026-08-25 직접 확인):
 *   - 메서드: GET 또는 POST (POST 는 application/x-www-form-urlencoded)
 *   - 인증:   Authorization: KakaoAK ${PRIMARY_ADMIN_KEY}  (대표 어드민 키)
 *   - 파라미터: app_id, user_id(카카오 회원번호), referrer_type[, group_user_token]
 *   - 응답:   3초 내 200 OK — 사용자를 못 찾거나 내부 오류여도 200 이어야 한다.
 *            (비-200 이 연속되면 카카오가 재전송하다 웹훅을 비활성화한다)
 *   - 서비스가 연결 해제 API 를 직접 호출한 경우엔 발송되지 않는다.
 *
 * 왜 '계정 상태 변경 웹훅' 이 아니라 이것인가:
 *   콘솔 경고 문구가 "계정 상태 변경 웹훅(User Unlinked) **또는** 연결 해제 웹훅"이라 둘 중 하나면 된다.
 *   전자는 SSF/SET(JWT) 규격에 202/400 응답 규격까지 요구해 구현·검증 비용이 훨씬 크다.
 *
 * 처리 정책:
 *   - 카카오가 유일한 로그인 수단인 계정 → 자체 탈퇴와 동일하게 30일 유예 등록
 *     (account_deletion_requests.pending → jobs/retention.js 가 파기 실행).
 *     즉시 파기하지 않는 이유: 오발송·오조작 복구 여지를 남기고, 자체 탈퇴 정책(GRACE_DAYS=30)과 일관되게.
 *   - 구글·이메일 등 다른 로그인 수단이 함께 있는 계정 → 계정은 유지하고 카카오 알림 토큰만 파기
 *     (카카오 연결이 끊겼으므로 그 토큰은 이미 무효 + 보관 근거가 사라진다).
 *
 * ⚠ 게이트: KAKAO_ADMIN_KEY(Vercel env) 미설정 시 인증 검증이 원리적으로 불가능하므로 **아무 처리도 하지 않는다**.
 *   검증 없이 처리하면 아무나 임의 user_id 로 남의 계정 탈퇴를 예약시킬 수 있다. 200 은 규격대로 반환하고
 *   경고 로그만 남긴다(카카오가 웹훅을 비활성화하지 않도록).
 */
const express = require('express');
const crypto = require('crypto');
const logger = require('../logger');
const { getSupabaseAdmin } = require('../db/client');
const { writeSystemAudit } = require('../middleware/auditLog');

const router = express.Router();

// 카카오 POST 는 x-www-form-urlencoded 로 온다 — server.js 는 express.json() 만 쓰므로 이 라우트에만 붙인다.
router.use(express.urlencoded({ extended: false, limit: '10kb' }));

const GRACE_DAYS = 30; // routes/account.js 와 동일 — 자체 탈퇴 정책과 일관
const KAKAO_APP_ID = process.env.KAKAO_APP_ID || '1434932'; // 콘솔 실측값(내집로그)
const ADMIN_KEY = process.env.KAKAO_ADMIN_KEY || null;

/** Authorization: KakaoAK <key> 검증 — 길이 노출 없이 상수시간 비교 */
function verifyKakaoAdmin(req) {
  if (!ADMIN_KEY) return { ok: false, reason: 'no_admin_key' };
  const raw = String(req.headers.authorization || '');
  const m = /^KakaoAK\s+(.+)$/i.exec(raw.trim());
  if (!m) return { ok: false, reason: 'bad_scheme' };
  const got = Buffer.from(m[1].trim());
  const want = Buffer.from(ADMIN_KEY);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, reason: 'bad_key' };
  }
  return { ok: true };
}

/**
 * 카카오 회원번호 → 우리 사용자.
 * Supabase JS 는 auth 스키마를 REST 로 조회할 수 없어 GoTrue admin API 로 순회한다.
 * ⚠ 가입자가 수천 명 규모가 되면 3초 응답 제한 안에 못 끝난다 → 그 시점엔 provider_id 매핑 테이블이나
 *   SECURITY DEFINER RPC 로 전환할 것. (2026-08-25 기준 가입자 7명 — 1페이지로 끝난다)
 */
async function findUserByKakaoId(admin, kakaoUserId) {
  const PER_PAGE = 200, MAX_PAGES = 25;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw error;
    const users = (data && data.users) || [];
    for (const u of users) {
      for (const idt of (u.identities || [])) {
        if (idt.provider !== 'kakao') continue;
        // GoTrue 가 provider_id 를 노출하는 필드명이 버전마다 달라 후보를 모두 본다(값 자체는 동일한 회원번호).
        const cands = [idt.id, idt.provider_id, idt.identity_data && idt.identity_data.sub,
          idt.identity_data && idt.identity_data.provider_id];
        if (cands.some(v => v != null && String(v) === kakaoUserId)) return u;
      }
    }
    if (users.length < PER_PAGE) break; // 마지막 페이지
  }
  return null;
}

async function handleUnlink(req, res) {
  // 규격상 무슨 일이 있어도 200 — 처리 실패는 로그/Sentry 로만 드러낸다.
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const appId = String(src.app_id || '');
  const kakaoUserId = String(src.user_id || '');
  const referrer = String(src.referrer_type || '').slice(0, 40);

  const auth = verifyKakaoAdmin(req);
  if (!auth.ok) {
    logger.warn({ reason: auth.reason, appId, referrer }, '카카오 연결해제 웹훅 인증 실패 — 처리 생략');
    return res.status(200).json({ ok: true });
  }
  if (KAKAO_APP_ID && appId && appId !== String(KAKAO_APP_ID)) {
    logger.warn({ appId, expected: KAKAO_APP_ID }, '카카오 연결해제 웹훅 app_id 불일치 — 처리 생략');
    return res.status(200).json({ ok: true });
  }
  if (!/^\d+$/.test(kakaoUserId)) {
    logger.warn({ referrer }, '카카오 연결해제 웹훅 user_id 형식 오류 — 처리 생략');
    return res.status(200).json({ ok: true });
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) {
      logger.error('카카오 연결해제 웹훅 — service role 미설정으로 처리 불가');
      return res.status(200).json({ ok: true });
    }

    const user = await findUserByKakaoId(admin, kakaoUserId);
    if (!user) {
      // 이미 파기됐거나 우리 서비스 가입자가 아닌 경우 — 정상 흐름이다.
      logger.info({ referrer }, '카카오 연결해제 웹훅 — 대상 사용자 없음(이미 파기 또는 미가입)');
      await writeSystemAudit('account.kakao_unlink.no_match', 'user', null, { referrer });
      return res.status(200).json({ ok: true });
    }

    const userId = user.id;
    const providers = (user.identities || []).map(i => i.provider);
    const hasOther = providers.some(p => p !== 'kakao');

    // 카카오 알림 토큰은 어느 경우든 파기 — 카카오 연결이 끊긴 시점에 이미 무효이고 보관 근거도 사라진다.
    let tokenDeleted = 0;
    try {
      const { count } = await admin.from('kakao_notify_tokens').delete({ count: 'exact' }).eq('user_id', userId);
      tokenDeleted = count ?? 0;
    } catch (e) {
      logger.warn({ err: e.message, userId }, '카카오 알림 토큰 파기 실패');
    }

    if (hasOther) {
      logger.info({ userId, providers, referrer }, '카카오 연결해제 — 다른 로그인 수단 있어 계정 유지');
      await writeSystemAudit('account.kakao_unlink.keep', 'user', userId, { userId, referrer, providers, tokenDeleted });
      return res.status(200).json({ ok: true });
    }

    // 카카오가 유일한 로그인 수단 → 30일 유예 탈퇴 등록(기존 pending 이면 덮어쓰지 않는다)
    const { data: existing } = await admin
      .from('account_deletion_requests')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing && existing.status === 'pending') {
      logger.info({ userId, referrer }, '카카오 연결해제 — 이미 탈퇴 예약됨(유지)');
      await writeSystemAudit('account.kakao_unlink.already_pending', 'user', userId, { userId, referrer, tokenDeleted });
      return res.status(200).json({ ok: true });
    }

    const now = new Date();
    const scheduled = new Date(now.getTime() + GRACE_DAYS * 24 * 3600 * 1000);
    const { error: upErr } = await admin.from('account_deletion_requests').upsert({
      user_id: userId,
      requested_at: now.toISOString(),
      scheduled_hard_delete_at: scheduled.toISOString(),
      status: 'pending',
      restored_at: null,
      hard_deleted_at: null,
      reason: `kakao_unlink:${referrer || 'UNKNOWN'}`,
      email_at_request: user.email || null,
      ip_masked: null,
      user_agent: 'kakao-unlink-webhook',
    }, { onConflict: 'user_id' });
    if (upErr) throw upErr;

    logger.info({ userId, referrer, scheduled: scheduled.toISOString() }, '카카오 연결해제 — 30일 유예 탈퇴 예약');
    // ⚠ action 이름은 일부러 자체 탈퇴와 같은 'account.delete.request' 다. jobs/auditPrune.js 의 영구보관
    //   화이트리스트(RETAIN_ACTIONS)와 DB 함수 prune_audit_log() 의 배열이 "정확히 동일" 해야 하는 구조라,
    //   새 action 을 만들면 DDL(운영자 승인 필요)까지 동반해야 하고 한쪽만 갱신되면 탈퇴 이력이 90일 뒤
    //   조용히 삭제된다. 발생 경로는 meta.source 로 구분한다.
    await writeSystemAudit('account.delete.request', 'user', userId, {
      userId, source: 'kakao_unlink_webhook', referrer, tokenDeleted,
      scheduled_hard_delete_at: scheduled.toISOString(),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    // 실패해도 200 — 카카오가 웹훅을 비활성화하지 않도록. 추적은 로그/Sentry 로.
    logger.error({ err: e.message, referrer }, '카카오 연결해제 웹훅 처리 실패');
    return res.status(200).json({ ok: true });
  }
}

router.get('/', handleUnlink);
router.post('/', handleUnlink);

module.exports = router;
