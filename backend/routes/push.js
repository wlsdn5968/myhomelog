/**
 * 웹푸시 구독 API — 관심단지 신규 실거래 알림 (Sprint EEEEEE)
 *
 * 설계:
 *   - 익명 동작: 구독은 브라우저 endpoint 단위, 관심단지 목록(items)을 스냅샷으로 함께 저장
 *     (익명 사용자의 북마크는 localStorage 에만 있어 서버가 조인할 수 없음)
 *   - 게이트 2종 — 하나라도 없으면 완전 no-op (503/키 null):
 *     ① VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env  ② push_subscriptions 테이블(운영자 SQL 승인)
 *   - 발송은 cron(jobs/pushNotify.js)이 담당 — 이 라우트는 구독 CRUD 만
 *
 * 엔드포인트:
 *   GET  /api/push/key          — VAPID 공개키 (미설정 시 {key:null} → 프론트가 UI 숨김)
 *   POST /api/push/subscribe    — { subscription:{endpoint,keys:{p256dh,auth}}, items:[...] } upsert
 *   POST /api/push/unsubscribe  — { endpoint } 삭제
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.service_role;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;

function dbClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const MAX_ITEMS = 30;

/** 관심단지 항목 정제 — 프론트 입력을 그대로 믿지 않음 */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).map(it => ({
    aptName: String(it?.aptName || '').slice(0, 60),
    lawdCd: /^\d{5}$/.test(String(it?.lawdCd || '')) ? String(it.lawdCd) : null,
    sigungu: String(it?.sigungu || '').slice(0, 20),
    umdNm: String(it?.umdNm || '').slice(0, 20),
  })).filter(it => it.aptName && it.lawdCd);
}

router.get('/key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

router.post('/subscribe', async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: '푸시 알림이 아직 활성화되지 않았어요.' });
    const admin = dbClient();
    if (!admin) return res.status(503).json({ error: '서버 설정 미완료' });

    const sub = req.body?.subscription;
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    if (!endpoint.startsWith('https://') || endpoint.length > 700 || !p256dh || !auth) {
      return res.status(400).json({ error: '유효하지 않은 구독 정보' });
    }
    const items = sanitizeItems(req.body?.items);
    if (!items.length) return res.status(400).json({ error: '알림 받을 관심단지가 없어요. 관심단지를 먼저 추가해주세요.' });

    const { error } = await admin.from('push_subscriptions').upsert({
      endpoint, p256dh, auth,
      items,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (error) {
      // 테이블 미생성(42P01) — 게이트 미승인 상태를 명확히 구분
      if (['42P01','PGRST205'].includes(String(error.code))) {
        logger.warn('push_subscriptions 테이블 미생성 — 운영자 SQL 승인 대기');
        return res.status(503).json({ error: '푸시 알림이 아직 활성화되지 않았어요.' });
      }
      throw new Error(error.message);
    }
    return res.json({ ok: true, items: items.length });
  } catch (e) {
    logger.warn({ err: e.message }, 'push subscribe 실패');
    require('../utils/captureError').captureRouteError(e, 'push');
    return res.status(500).json({ error: '구독 저장에 실패했어요. 잠시 후 다시 시도해주세요.' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const admin = dbClient();
    const endpoint = String(req.body?.endpoint || '');
    if (!admin || !endpoint) return res.json({ ok: true });
    await admin.from('push_subscriptions').delete().eq('endpoint', endpoint);
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true }); // 해지는 최선노력 — 실패해도 사용자 흐름 차단 안 함
  }
});

module.exports = router;
