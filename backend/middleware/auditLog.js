/**
 * 공용 감사 로그 미들웨어 / 헬퍼
 *
 * 존재 이유 (PIPA 제29조 + GDPR Art.30):
 *   - 개인정보·계정에 대한 모든 "상태 변경 행위" 를 서버 측 audit_log 에 기록.
 *   - 클라이언트 위조 불가 — service_role 로만 INSERT.
 *   - IP 는 /24 로 마스킹 (pino logger 와 동일 정책).
 *
 * 사용법:
 *   const { writeAudit } = require('../middleware/auditLog');
 *   await writeAudit(req, 'payment.succeeded', 'payment', paymentId, { amount });
 *
 * action 네이밍 규약 (검색·보존 정책에서 참조):
 *   <entity>.<verb>
 *   예) account.delete.request, account.restore, payment.succeeded, consent.accept
 *
 * 장애 허용:
 *   - audit_log INSERT 실패가 원래 요청을 막으면 안 됨 → try/catch 후 warn 만.
 *   - 실패 로그는 pino 가 Sentry 로 올려줌 → 운영자가 사후 확인 가능.
 */
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');
const { maskIp } = require('../logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service_role 미설정 — audit_log 기록 불가');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * audit_log INSERT (service_role) — 요청 컨텍스트 자동 수집.
 * @param {import('express').Request} req
 * @param {string} action  — '<entity>.<verb>' 형식
 * @param {string} targetType  — 'account' | 'payment' | 'consent' | ...
 * @param {string|number|null} targetId
 * @param {object} meta  — 자유 JSON. 민감정보 금지 (결제번호 OK, 카드번호 X)
 * @returns {Promise<void>}
 */
async function writeAudit(req, action, targetType, targetId, meta = {}) {
  try {
    const admin = adminClient();
    const ip = req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null;
    await admin.from('audit_log').insert({
      user_id: req?.user?.id || null,
      actor: 'user',
      action,
      target_type: targetType,
      target_id: targetId ? String(targetId) : null,
      meta,
      ip_masked: ip ? maskIp(ip) : null,
      user_agent: (req?.headers?.['user-agent'] || '').slice(0, 200),
    });
  } catch (e) {
    logger.warn({ err: e.message, action, userId: req?.user?.id }, 'audit_log INSERT 실패');
  }
}

/**
 * 서버 배치·크론 경로에서 호출 (req 없이). actor 를 'system' 으로 고정.
 */
async function writeSystemAudit(action, targetType, targetId, meta = {}) {
  try {
    const admin = adminClient();
    await admin.from('audit_log').insert({
      user_id: meta?.userId || null,
      actor: 'system',
      action,
      target_type: targetType,
      target_id: targetId ? String(targetId) : null,
      meta,
      ip_masked: null,
      user_agent: 'system/cron',
    });
  } catch (e) {
    logger.warn({ err: e.message, action }, 'system audit_log INSERT 실패');
  }
}

module.exports = { writeAudit, writeSystemAudit };
