/**
 * 계정 데이터 자기결정권 API (GDPR Art.15/17, PIPA 제35·36조)
 *
 * 한국·EU 양 법 모두 사용자에게 다음 권리를 보장:
 *   - 열람권 (자신의 개인정보를 받아볼 권리)               → GET  /api/account/export
 *   - 삭제권/잊혀질 권리 (계정 + 부속 데이터 영구 삭제)     → POST /api/account/delete
 *   - 회복권 (유예기간 내 철회)                            → POST /api/account/restore
 *   - 삭제 상태 조회                                        → GET  /api/account/deletion-status
 *
 * 삭제 정책 — 30일 유예 소프트 삭제 (Phase 5.2 회귀 수정):
 *   - /delete 호출 시점엔 데이터 **보존** — 즉시 삭제 X
 *     → account_deletion_requests INSERT + 모든 세션 전역 signOut
 *     → requireAuth 미들웨어가 pending 상태면 /restore 외 모든 요청 차단
 *   - 30일 내 재로그인 후 /restore 호출 → status='restored' 전환 → 즉시 복구
 *   - 30일 경과 시 backend/jobs/retention.js 가 실제 cascade + 익명화 + auth.users 삭제
 *
 * 법적 근거:
 *   - PIPA 제36조 "지체없이" 의 해석: 유예기간 사전고지 + 기한 내 집행이면 위반 아님
 *   - GDPR Art.17 / EDPB Guideline: "undue delay" 에 grace period 인정
 *   - 전자상거래법 제6조 결제 5년 보관: payments.user_id 는 유지, raw_response 만 익명화
 *
 * 설계 원칙:
 *   - 모든 엔드포인트 requireAuth (본인 한정)
 *   - /delete 는 confirm:"DELETE" 필수 (오클릭 차단)
 *   - audit_log 에 모든 행위 기록 (PIPA 제29조)
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const { writeAudit } = require('../middleware/auditLog');
const logger = require('../logger');
// MOB-AUDIT-2026-05-03: maskIp import 누락 — line 154 호출 시 ReferenceError → 회원 탈퇴 500 → P0
const { maskIp } = require('../logger');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;

const GRACE_DAYS = 30;

function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service_role 미설정 — 계정 관리 비활성');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// writeAudit: 공용 미들웨어 (backend/middleware/auditLog.js) 사용

// ── POST /api/account/consent ──────────────────────────────
// PIPA 제29조 / GDPR Art.30 — 동의 시점·항목·버전 서버 audit trail
//
// 배경 (CONSENT-AUDIT-2026-05-10):
//   - frontend `_checkConsent()` 가 4개 필수 동의 (만 14세 / 이용약관 / 개인정보 / 국외이전)
//     를 검증하고 localStorage 에만 저장 → 분쟁 시 client-only 증빙은 위·변조 가능.
//   - 본 endpoint 는 동일 4 flag 를 서버 audit_log 에 기록 (consent.accept).
//   - OAuth 시작 *전* 시점이라 비로그인 호출 (Authorization 헤더 X) → user_id=null 가능.
//     audit_log 스키마는 user_id NULLABLE (anonymous 허용) — migration 20260424000002 line 17.
//   - 보존: prune_audit_log() 화이트리스트에 'consent.accept' 포함 (migration ...000004 line 38).
//     JS fallback (jobs/auditPrune.js) 도 본 작업에서 동일 예외 적용.
//
// 정책:
//   - 4 flag 모두 true 가 아니면 400 — frontend 가 검증 통과 후에만 호출하도록 설계되었지만
//     서버에서도 신뢰 X (인젝션 방어).
//   - audit 기록 실패는 fail-open — 사용자 OAuth 흐름 막으면 비즈니스 critical.
//     baseline 은 서버 기록 0 → 실패해도 baseline 보다 나쁘지 않음.
//
// 의도적으로 router.use(requireAuth) **앞에** 정의 — consent 는 OAuth 시작 전 시점 호출.
router.post('/consent', async (req, res) => {
  const { age14Plus, terms, privacy, intlTransfer, version, ts } = req.body || {};
  if (age14Plus !== true || terms !== true || privacy !== true || intlTransfer !== true) {
    return res.status(400).json({
      error: '필수 동의 항목이 누락되었습니다.',
      code: 'invalid_consent',
    });
  }
  const meta = {
    age14Plus: true,
    terms: true,
    privacy: true,
    intlTransfer: true,
    version: typeof version === 'string' ? version.slice(0, 32) : null,
    clientTs: typeof ts === 'string' ? ts.slice(0, 64) : null,
    serverTs: new Date().toISOString(),
  };
  // writeAudit 가 user_id (req.user?.id || null) · ip_masked · user_agent 자동 수집.
  // 인증 미들웨어 부재 → req.user 는 undefined → user_id null 기록 (anonymous, IP+UA 로 식별).
  await writeAudit(req, 'consent.accept', 'consent', null, meta);
  res.json({ ok: true });
});

router.use(requireAuth);

// ── GET /api/account/export ────────────────────────────────
// PIPA 제35조 열람권 — 본인 데이터 전체 JSON 다운로드
router.get('/export', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const userId = req.user.id;

    const [bookmarks, searchHistory, chatSessions, chatMessages, billing, payments, fieldNotes] = await Promise.all([
      sb.from('bookmarks').select('*').then((r) => r.data || []),
      sb.from('search_history').select('*').then((r) => r.data || []),
      sb.from('chat_sessions').select('*').then((r) => r.data || []),
      sb.from('chat_messages').select('id, session_id, role, content, meta, created_at').then((r) => r.data || []),
      sb.from('user_billing').select('*').then((r) => r.data || []),
      sb.from('payments').select('id, order_id, amount, currency, status, plan, method, created_at, approved_at').then((r) => r.data || []),
      sb.from('field_notes').select('*').then((r) => r.data || []),
    ]);

    const payload = {
      _meta: {
        exportedAt: new Date().toISOString(),
        userId,
        userEmail: req.user.email,
        notice: 'PIPA 제35조 / GDPR Art.15 — 본인 데이터 전부 (결제 raw_response 등 일부 민감 필드는 보안상 제외)',
      },
      bookmarks,
      search_history: searchHistory,
      chat_sessions: chatSessions,
      chat_messages: chatMessages,
      user_billing: billing,
      payments,
      field_notes: fieldNotes,
    };

    await writeAudit(req, 'account.export', 'user', userId, {
      counts: {
        bookmarks: bookmarks.length,
        searchHistory: searchHistory.length,
        chatSessions: chatSessions.length,
        chatMessages: chatMessages.length,
        payments: payments.length,
        fieldNotes: fieldNotes.length,
      },
    });

    const fname = `myhomelog_export_${userId}_${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    next(e);
  }
});

// ── GET /api/account/deletion-status ────────────────────────
// UI 에서 "삭제 예약 N일 남음 / 복구 가능" 표시용
router.get('/deletion-status', async (req, res, next) => {
  try {
    const admin = adminClient();
    const { data, error } = await admin
      .from('account_deletion_requests')
      .select('requested_at, scheduled_hard_delete_at, status, restored_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ ok: true, request: data || null });
  } catch (e) {
    next(e);
  }
});

// ── POST /api/account/delete ───────────────────────────────
// 소프트 삭제 — 30일 유예 후 실행
//
// 동작:
//   1) audit_log 기록 (account.delete.request)
//   2) account_deletion_requests INSERT (또는 기존 pending 이면 ON CONFLICT 갱신)
//   3) 전역 signOut — 모든 디바이스 세션 만료
//   4) 사용자 응답: "30일 뒤 영구 삭제 예정, 언제까지 복구 가능"
//
// 주의:
//   - 데이터 자체는 건드리지 않음 (복구 시 100% 원복 위해)
//   - requireAuth 미들웨어가 이후 모든 요청에서 /restore 외 차단
router.post('/delete', async (req, res, next) => {
  try {
    const { confirm, reason } = req.body || {};
    if (confirm !== 'DELETE') {
      return res.status(400).json({
        error: '계정 삭제는 본문 { "confirm": "DELETE" } 가 필요합니다.',
      });
    }

    const userId = req.user.id;
    const userEmail = req.user.email;
    const admin = adminClient();
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
    const ipMasked = ip ? maskIp(ip) : null;
    const userAgent = (req.headers['user-agent'] || '').slice(0, 200);

    // 이미 pending 이면 재요청 허용 (스케줄만 초기화하지 않음 — 원래 요청 시점 기준)
    const { data: existing } = await admin
      .from('account_deletion_requests')
      .select('status, scheduled_hard_delete_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing && existing.status === 'pending') {
      return res.json({
        ok: true,
        alreadyPending: true,
        scheduled_hard_delete_at: existing.scheduled_hard_delete_at,
        message: '이미 계정 삭제가 예약되어 있습니다.',
      });
    }

    // upsert — restored/hard_deleted 이후 재요청도 처리 (복구 후 재탈퇴 등)
    const now = new Date();
    const scheduled = new Date(now.getTime() + GRACE_DAYS * 24 * 3600 * 1000);
    const { data: adrRow, error: adrErr } = await admin
      .from('account_deletion_requests')
      .upsert({
        user_id: userId,
        requested_at: now.toISOString(),
        scheduled_hard_delete_at: scheduled.toISOString(),
        status: 'pending',
        restored_at: null,
        hard_deleted_at: null,
        reason: reason ? String(reason).slice(0, 500) : null,
        email_at_request: userEmail || null,
        ip_masked: ipMasked,
        user_agent: userAgent,
      }, { onConflict: 'user_id' })
      .select()
      .single();
    if (adrErr) throw adrErr;

    await writeAudit(req, 'account.delete.request', 'user', userId, {
      email: userEmail,
      scheduled_hard_delete_at: adrRow.scheduled_hard_delete_at,
      reason: reason || null,
    });

    // 전역 signOut — 모든 디바이스 세션 무효화 (탈취 대비)
    let signedOut = false;
    try {
      // Supabase JS v2: admin.auth.admin.signOut(jti | accessToken, scope)
      // userId 기반이 아닌 accessToken 기반이므로 현재 세션만 즉시 차단.
      // 완전 차단은 다음 요청부터 middleware 가 담당.
      await admin.auth.admin.signOut(req.accessToken, 'global');
      signedOut = true;
    } catch (e) {
      logger.warn({ err: e.message, userId }, '전역 signOut 실패 — middleware 가 차단 담당');
    }

    logger.info({ userId, email: userEmail, scheduled: adrRow.scheduled_hard_delete_at }, '계정 삭제 요청 (유예 시작)');

    res.json({
      ok: true,
      scheduled_hard_delete_at: adrRow.scheduled_hard_delete_at,
      graceDays: GRACE_DAYS,
      signedOut,
      message: `계정 삭제가 예약되었습니다. ${GRACE_DAYS}일 내 재로그인 후 '복구' 를 누르면 즉시 철회할 수 있습니다. 유예기간 종료 시 데이터는 영구 삭제되며, 결제 이력은 전자상거래법상 5년간 익명 상태로 보관됩니다.`,
    });
  } catch (e) {
    next(e);
  }
});

// ── POST /api/account/restore ──────────────────────────────
// 유예기간 내 철회 — 즉시 로그인 정상화
router.post('/restore', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const admin = adminClient();

    const { data: existing, error: selErr } = await admin
      .from('account_deletion_requests')
      .select('status, scheduled_hard_delete_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) throw selErr;

    if (!existing) {
      return res.status(404).json({ error: '삭제 요청 기록이 없습니다.' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({
        error: `현재 상태(${existing.status})에서는 복구할 수 없습니다.`,
      });
    }
    if (new Date(existing.scheduled_hard_delete_at).getTime() < Date.now()) {
      return res.status(410).json({
        error: '유예기간이 만료되었습니다. 복구할 수 없습니다.',
      });
    }

    const { error: updErr } = await admin
      .from('account_deletion_requests')
      .update({
        status: 'restored',
        restored_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    if (updErr) throw updErr;

    await writeAudit(req, 'account.restore', 'user', userId, {
      originallyScheduled: existing.scheduled_hard_delete_at,
    });

    logger.info({ userId }, '계정 삭제 철회 (복구)');

    res.json({
      ok: true,
      message: '계정이 복구되었습니다. 모든 데이터가 그대로 유지되며, 정상 이용이 가능합니다.',
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
