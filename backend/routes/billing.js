/**
 * 결제/구독 API — Toss Payments 연동
 *
 * 플로우 (일반 결제):
 *   1) 클라: GET /billing/plans — 요금제 목록
 *   2) 클라: POST /billing/checkout — orderId 발급 (서버가 DB 에 payments row 생성, status=requested)
 *   3) 클라: Toss Widget 으로 결제 진행 (orderId, amount, customerKey 주입)
 *   4) Toss 리다이렉트: 성공/실패 URL 로 paymentKey·orderId·amount 반환
 *   5) 클라: POST /billing/confirm — paymentKey·orderId·amount 서버로 전달
 *   6) 서버: Toss API /v1/payments/confirm 호출 → 성공 시 user_billing 업데이트
 *
 * 보안:
 *   - confirm 은 반드시 서버-서버 호출 (TOSS_SECRET_KEY 는 백엔드 전용)
 *   - orderId 는 UUID v4 → 예측 불가
 *   - amount 는 DB 의 값과 Toss 응답 amount 가 일치할 때만 성공 처리 (조작 방지)
 *   - RLS: 본인 row 만 SELECT 가능 — 쓰기는 service_role 만
 *
 * 현재 상태: 스캐폴드 (TOSS_SECRET_KEY 없으면 confirm 은 501)
 *   → 실 배포 전에 Toss 콘솔에서 키 발급 후 Vercel env 에 추가.
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const { getSupabaseAdmin } = require('../db/client');
const logger = require('../logger');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;       // 서버 전용 (test_sk_* / live_sk_*)
const TOSS_API_BASE = 'https://api.tosspayments.com';

function userScopedClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase 미설정');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── GET /billing/plans — 공개 (인증 불필요) ───────────────
// 요금제 메타는 RLS 로 공개 SELECT 허용되어 있으므로 publishable 키로 충분
router.get('/plans', async (req, res, next) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb
      .from('billing_plans')
      .select('id, name, price_krw, features')
      .eq('active', true)
      .order('price_krw', { ascending: true });
    if (error) throw error;
    res.json({ plans: data || [] });
  } catch (e) { next(e); }
});

// 이하 엔드포인트는 전부 인증 필요
router.use(requireAuth);

// ── GET /billing/me — 내 현재 구독 상태 ────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const sb = userScopedClient(req.accessToken);
    const { data, error } = await sb
      .from('user_billing')
      .select('plan, status, current_period_start, current_period_end, canceled_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    // 구독 기록 없으면 무료 플랜 기본값 반환
    res.json(data || { plan: 'free', status: 'active' });
  } catch (e) { next(e); }
});

// ── POST /billing/checkout — 주문 생성 ────────────────────
// body: { plan: 'pro'|'team' }
// returns: { orderId, amount, customerKey, planName }
router.post('/checkout', async (req, res, next) => {
  try {
    const { plan } = req.body || {};
    if (!plan || !['pro', 'team'].includes(plan)) {
      return res.status(400).json({ error: '유효하지 않은 플랜' });
    }

    // admin 으로 플랜 가격 조회 (사용자가 price 를 위조하지 못하도록 서버가 결정)
    const admin = getSupabaseAdmin();
    if (!admin) {
      return res.status(503).json({ error: '결제 시스템 초기화 중 (관리자 설정 필요)' });
    }
    const { data: planRow, error: planErr } = await admin
      .from('billing_plans')
      .select('id, name, price_krw, active')
      .eq('id', plan)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!planRow || !planRow.active || planRow.price_krw <= 0) {
      return res.status(400).json({ error: '선택할 수 없는 플랜' });
    }

    // 주문번호 — UUID v4 (예측 불가 + Toss 멱등성 키로 동시 재사용)
    const orderId = 'mhl_' + crypto.randomUUID();

    const { error: insErr } = await admin
      .from('payments')
      .insert({
        user_id: req.user.id,
        order_id: orderId,
        amount: planRow.price_krw,
        plan: plan,
        status: 'requested',
      });
    if (insErr) throw insErr;

    // Toss 의 customerKey — 사용자별 고유값. 빌링키 재사용에 씀.
    // 내부 user_id 그대로 쓰지 않고 해시 (유출 시 매핑 방지 최소한의 장벽)
    const customerKey = crypto
      .createHash('sha256')
      .update(`mhl:${req.user.id}`)
      .digest('hex')
      .slice(0, 32);

    res.json({
      orderId,
      amount: planRow.price_krw,
      customerKey,
      planName: planRow.name,
    });
  } catch (e) { next(e); }
});

// ── POST /billing/confirm — 결제 승인 ─────────────────────
// body: { paymentKey, orderId, amount }
// Toss 성공 리다이렉트에서 받은 값을 그대로 전달. 서버가 Toss API 재확인.
router.post('/confirm', async (req, res, next) => {
  try {
    const { paymentKey, orderId, amount } = req.body || {};
    if (!paymentKey || !orderId || typeof amount !== 'number') {
      return res.status(400).json({ error: 'paymentKey, orderId, amount 필수' });
    }
    if (!TOSS_SECRET_KEY) {
      return res.status(501).json({
        error: '결제 시스템 설정 미완료',
        hint: '관리자에게 문의 — TOSS_SECRET_KEY 미설정',
      });
    }

    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: '결제 시스템 초기화 중' });

    // 1) DB 에서 원 주문 조회 — amount 위조 탐지
    const { data: pay, error: payErr } = await admin
      .from('payments')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (payErr) throw payErr;
    if (!pay) return res.status(404).json({ error: '주문을 찾을 수 없음' });
    if (pay.status === 'captured') {
      return res.json({ status: 'captured', plan: pay.plan }); // 멱등
    }
    if (Number(pay.amount) !== Number(amount)) {
      logger.warn({ userId: req.user.id, orderId, expected: pay.amount, got: amount },
        '결제 금액 불일치 — 위조 가능성');
      return res.status(400).json({ error: '결제 금액 불일치' });
    }

    // 2) Toss API 로 승인 요청 — Basic auth (secret key + ':')
    const basic = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    let tossData;
    try {
      const r = await axios.post(
        `${TOSS_API_BASE}/v1/payments/confirm`,
        { paymentKey, orderId, amount },
        {
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': orderId, // 멱등성 보장
          },
          timeout: 10000,
        }
      );
      tossData = r.data;
    } catch (err) {
      const status = err.response?.status || 502;
      const data = err.response?.data || {};
      await admin.from('payments')
        .update({ status: 'failed', failure_reason: data.message || err.message, raw_response: data })
        .eq('order_id', orderId);
      logger.error({ userId: req.user.id, orderId, status, data }, 'Toss confirm 실패');
      return res.status(status).json({ error: data.message || '결제 승인 실패', code: data.code });
    }

    // 3) payments row 업데이트
    await admin.from('payments').update({
      status: 'captured',
      toss_payment_key: paymentKey,
      method: tossData.method || null,
      approved_at: tossData.approvedAt || new Date().toISOString(),
      raw_response: tossData,
    }).eq('order_id', orderId);

    // 4) user_billing upsert — 한 달 구독 (MVP)
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await admin.from('user_billing').upsert({
      user_id: req.user.id,
      plan: pay.plan,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      canceled_at: null,
    }, { onConflict: 'user_id' });

    logger.info({ userId: req.user.id, plan: pay.plan, orderId }, '결제 승인 완료');
    res.json({ status: 'captured', plan: pay.plan });
  } catch (e) { next(e); }
});

// ── POST /billing/cancel — 구독 해지 (다음 결제일까지 유효) ──
router.post('/cancel', async (req, res, next) => {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return res.status(503).json({ error: '결제 시스템 초기화 중' });
    const { error } = await admin.from('user_billing').update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    }).eq('user_id', req.user.id);
    if (error) throw error;
    logger.info({ userId: req.user.id }, '구독 해지');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
